const WORKER_CODE = `
let segs = [], subGaps = [];
let lastMatchTime = 0;
let cadenceSignatures = [];
let hasPerformedCoarseSweep = false;

self.onmessage = function(e) {
  if (e.data.type === 'init') {
    subGaps = e.data.subtitleGaps || [];
    segs = [];
    hasPerformedCoarseSweep = false;
    cadenceSignatures = generateSignatures(subGaps);
    return;
  }
  if (e.data.type === 'pcm') {
    const pcm = e.data.data, ts = e.data.ts;
    let en = 0; for (let i = 0; i < pcm.length; i++) en += pcm[i] * pcm[i];
    en = Math.sqrt(en / pcm.length);
    this.smoothE = (this.smoothE || 0) * 0.88 + en * 0.12;
    const thr = Math.max(0.012, this.smoothE * 1.9);
    const now = en > thr;

    if (now && !this.inSpeech) {
      this.inSpeech = true;
      this.speechStart = ts;
    } else if (!now && this.inSpeech) {
      this.inSpeech = false;
      const dur = ts - this.speechStart;
      if (dur >= 0.18) {
        const seg = { start: this.speechStart, end: ts };
        segs.push(seg);
        if (segs.length > 200) segs.shift();
        
        // Phase 1: Report every segment to the main thread for the 'Smart Snap' history
        self.postMessage({ type: 'segment', segment: seg });

        // Coarse Sweep logic
        if (!hasPerformedCoarseSweep && segs.length >= 12) {
            performCoarseSweep();
        } else if (segs.length >= 8) {
            tryMatch();
        }
      }
    }
  }
};

function generateSignatures(gaps) {
  const sigs = [];
  for (let i = 0; i <= gaps.length - 6; i++) {
    const block = gaps.slice(i, i + 6);
    sigs.push({
      index: i,
      shape: normalizeRhythm(block),
      complexity: calculateComplexity(block)
    });
  }
  return sigs;
}

function normalizeRhythm(block) {
  const sum = block.reduce((a, b) => a + b, 0);
  if (sum === 0) return block.map(() => 0);
  return block.map(v => v / sum);
}

function calculateComplexity(block) {
  const avg = block.reduce((a, b) => a + b, 0) / block.length;
  return block.reduce((a, b) => a + Math.abs(b - avg), 0);
}

/**
 * Coarse Sweep: Searches a massive +/- 60s window to find initial sync
 */
function performCoarseSweep() {
    const audioGaps = [];
    for (let i = 1; i < segs.length; i++) audioGaps.push(segs[i].start - segs[i - 1].end);
    if (audioGaps.length < 10) return;

    const currentAudioSig = normalizeRhythm(audioGaps.slice(-10));
    let bestMatch = null;
    let minDiff = 1/0;

    // Sweep all signatures
    for (const sig of cadenceSignatures) {
        if (sig.complexity < 0.8) continue;
        // Compare larger 10-gap block for coarse accuracy
        let diff = 0;
        const subBlock = subGaps.slice(sig.index, sig.index + 10);
        if (subBlock.length < 10) continue;
        const subSig = normalizeRhythm(subBlock);
        
        for (let j = 0; j < 10; j++) diff += Math.abs(currentAudioSig[j] - subSig[j]);
        
        if (diff < minDiff) {
            minDiff = diff;
            bestMatch = sig;
        }
    }

    if (bestMatch && minDiff < 0.2) {
        hasPerformedCoarseSweep = true;
        const cands = [{
            subGapIndex: bestMatch.index + 5,
            audioTime: (segs[segs.length - 5].start + segs[segs.length - 5].end) / 2,
            source: 'auto'
        }];
        self.postMessage({ type: 'match', confidence: 0.95, isCoarse: true, candidateAnchors: cands });
    }
}

function tryMatch() {
  const nowTime = Date.now();
  if (nowTime - lastMatchTime < 2500) return; 

  const audioGaps = [];
  for (let i = 1; i < segs.length; i++) audioGaps.push(segs[i].start - segs[i - 1].end);
  
  if (audioGaps.length < 6) return;
  const currentAudioSig = normalizeRhythm(audioGaps.slice(-6));
  const complexity = calculateComplexity(audioGaps.slice(-6));
  
  if (complexity < 0.5) return;

  let bestMatch = null;
  let minDiff = 1/0;

  for (const sig of cadenceSignatures) {
    let diff = 0;
    for (let j = 0; j < 6; j++) diff += Math.abs(currentAudioSig[j] - sig.shape[j]);
    if (diff < minDiff) { minDiff = diff; bestMatch = sig; }
  }

  if (bestMatch && minDiff < 0.15) {
    lastMatchTime = nowTime;
    const confidence = Math.max(0, 1 - minDiff * 4);
    const cands = [{
      subGapIndex: bestMatch.index + 3, 
      audioTime: (segs[segs.length - 3].start + segs[segs.length - 3].end) / 2,
      source: 'auto'
    }];
    self.postMessage({ type: 'match', confidence: confidence, candidateAnchors: cands });
  }
}
`;

export function createWorker() {
  try {
    return new Worker(
      URL.createObjectURL(
        new Blob([WORKER_CODE], { type: "text/javascript" })
      )
    );
  } catch (e) {
    return null;
  }
}

export function initAudioCapture(v, state) {
  if (state.audioCtx) return;

  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = state.audioCtx.createMediaElementSource(v);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    src.connect(state.analyser);
    state.analyser.connect(state.audioCtx.destination);

    state.pcmIntervalId = setInterval(() => {
      if (!state.analyser || !state.vadWorker || !state.video || state.video.paused) return;
      const buf = new Float32Array(state.analyser.fftSize);
      state.analyser.getFloatTimeDomainData(buf);
      state.vadWorker.postMessage({
        type: "pcm",
        data: buf,
        ts: state.video.currentTime,
        chunkDuration:
          state.analyser.fftSize / (state.audioCtx.sampleRate || 44100)
      });
    }, 180);
  } catch (e) {
    console.warn("[SubSync] Audio capture failed:", e);
  }
}
