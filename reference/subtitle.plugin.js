"use strict";
/**
 * @name SubtitleCorrector
 * @description Real-time audio-gap subtitle sync with cylinder anchor UI
 * @version 3.0.0
 * @author Vedant
 *
 * HOW TO USE:
 *   1. Drop into stremio-enhanced plugins folder, enable in Settings → Plugins
 *   2. Play a video and load subtitles
 *   3. Click the green SubSync badge (top-right) or press backtick ` or Alt+S
 *   4. Scroll the list to the subtitle line you can currently HEAR
 *   5. Click it (turns green) → press Set Anchor → done
 *
 * CONSOLE DEBUG:
 *   subtitleCorrector.debug()        → shows current state
 *   subtitleCorrector.setOffset(ms)  → manually set offset e.g. setOffset(-2000)
 */

console.log("[SubSync v3.0] Loading...");

/* ══════════════════════════════════════════════
   MODULE STATE — single declarations
══════════════════════════════════════════════ */
let video               = null;
let customOverlay       = null;
let ghostOverlay        = null;
let vadWorker           = null;
let controller          = new AbortController();
let statusBadge         = null;
let originalCues        = [];
let mappedCues          = [];
let subtitleGapSequence = [];
let anchors             = [];
let globalA             = 1.0;
let globalB             = 0.0;
let driftEnabled        = false;
let lastSubUrl          = "";
let nextCueTimeout      = null;
let subtitleObserver    = null;
let trackObserver       = null;
let audioCtx            = null;
let analyser            = null;
let playerRoot          = null;
let cylinderUI          = null;
let cylinderBackdrop    = null;
let pcmIntervalId       = null;
let selectedCueIndex    = 0;
let nativeSubtitleEl    = null;
let trackChangeThrottle = null;
let cuePollingId        = null; // polls for cues until found
let lastCueCount        = 0;
let lastCueHash         = "";    // hash of current cues
let pendingCues         = null;  // cues intercepted before video was ready
let settingUp           = false; // guard against double setup
let badgeDimTimer       = null;  // dim timer for badge
let videoPoller         = null;  // interval for finding <video>
let lastFetchedCues     = [];    // populated by fetch/XHR interceptor

/* ══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
function hashCues(cues) {
  if (!cues || !cues.length) return "";
  // Hash using first/last cue times and a sample of text
  const first = cues[0];
  const last = cues[cues.length - 1];
  const mid = cues[Math.floor(cues.length / 2)];
  return `${cues.length}_${first.start}_${mid.text.slice(0, 10)}_${last.end}`;
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ══════════════════════════════════════════════
   FETCH / XHR INTERCEPTOR — CAPTURE RAW SUBS
   Runs immediately so we see subtitle downloads
══════════════════════════════════════════════ */
(function installFetchInterceptor() {
  try {
    const _fetch = window.fetch;
    if (typeof _fetch === "function") {
      window.fetch = async function (...args) {
        const res = await _fetch.apply(this, args);
        try {
          const url =
            (typeof args[0] === "string"
              ? args[0]
              : args[0]?.url) || "";
          const ct =
            res.headers?.get?.("content-type") || "";
          const looksLikeSub =
            /\.(srt|vtt|ass|ssa)(\?|$)/i.test(url) ||
            ct.includes("text/vtt") ||
            ct.includes("text/plain");
          if (looksLikeSub) {
            const text = await res.clone().text();
            const cues = parseSRT(text) || parseVTT(text);
            if (cues && cues.length > 5) {
              console.log(
                `[SubSync] Intercepted subtitle: ${cues.length} cues from ${
                  url.split("?")[0]
                }`
              );
              lastFetchedCues = cues;
              if (video) {
                setupSubtitleSystem(cues);
              } else {
                pendingCues = cues;
                console.log("[SubSync] Video not ready, cues queued.");
              }
            }
          }
        } catch (_) {}
        return res;
      };
    }

    // XHR fallback
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (m, url, ...rest) {
      this._subsync_url = String(url || "");
      return _open.call(this, m, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...a) {
      this.addEventListener("load", function () {
        try {
          if (
            /\.(srt|vtt|ass|ssa)(\?|$)/i.test(
              this._subsync_url || ""
            )
          ) {
            const cues =
              parseSRT(this.responseText) ||
              parseVTT(this.responseText);
            if (cues && cues.length > 5) {
              console.log(
                `[SubSync] Intercepted subtitle via XHR: ${cues.length} cues`
              );
              lastFetchedCues = cues;
              if (video) {
                setupSubtitleSystem(cues);
              } else {
                pendingCues = cues;
                console.log("[SubSync] Video not ready, cues queued.");
              }
            }
          }
        } catch (_) {}
      });
      return _send.apply(this, a);
    };
  } catch (e) {
    console.warn("[SubSync] fetch/XHR interceptor failed:", e);
  }
})();

function parseSRTTime(t) {
  const p = t.replace(",", ".").split(":");
  return (
    parseFloat(p[0]) * 3600 +
    parseFloat(p[1]) * 60 +
    parseFloat(p[2])
  );
}

function parseSRT(text) {
  if (!text || text.trim().length < 20) return null;
  const cues = [];
  const blocks = text.trim().split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const m = lines[ti].match(
      /(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})/
    );
    if (!m) continue;
    const start = parseSRTTime(m[1]);
    const end = parseSRTTime(m[2]);
    const txt = lines
      .slice(ti + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (txt && start < end) cues.push({ start, end, text: txt });
  }
  return cues.length ? cues : null;
}

function parseVTT(text) {
  if (!text || !text.trim().startsWith("WEBVTT")) return null;
  return parseSRT(
    text.replace(/^WEBVTT[^\n]*\n/, "")
  );
}

/* ══════════════════════════════════════════════
   STATUS BADGE
   Appears immediately on plugin load.
   Clicking it always opens cylinder (or retries).
══════════════════════════════════════════════ */
function createStatusBadge() {
  if (statusBadge) statusBadge.remove();
  statusBadge = document.createElement("div");
  statusBadge.id = "subsync-badge";
  statusBadge.style.cssText = [
    "position:fixed",
    "top:12px",
    "right:12px",
    "background:rgba(8,18,12,0.96)",
    "color:#3f3",
    "padding:7px 14px",
    "border-radius:7px",
    "font-size:12px",
    "font-family:monospace",
    "z-index:2147483646",
    "pointer-events:auto",
    "cursor:pointer",
    "transition:opacity 0.5s",
    "user-select:none",
    "border:1px solid rgba(0,180,70,0.4)",
    "box-shadow:0 2px 12px rgba(0,0,0,0.6)"
  ].join(";");
  statusBadge.textContent = "SubSync: starting...";
  statusBadge.title =
    "Click to open SubSync (or press ` backtick / Alt+S)";
  document.body.appendChild(statusBadge);

  statusBadge.addEventListener("click", () => {
    if (!video) {
      const v = document.querySelector("video");
      if (v) onVideoReady(v);
    }
    if (originalCues.length) {
      showCylinderUI();
    } else {
      updateStatus(
        "SubSync: subtitles not detected yet — try again in a moment"
      );
    }
  });

  clearTimeout(badgeDimTimer);
  badgeDimTimer = setTimeout(() => {
    if (statusBadge) statusBadge.style.opacity = "0.4";
  }, 6000);
}

function updateStatus(msg) {
  if (!statusBadge) return;
  statusBadge.textContent = msg;
  statusBadge.style.opacity = "1";
  clearTimeout(badgeDimTimer);
  badgeDimTimer = setTimeout(() => {
    if (statusBadge) statusBadge.style.opacity = "0.4";
  }, 5000);
}

/* ══════════════════════════════════════════════
   GET INTERNAL CUES
   Primary: fetch/XHR interceptor (lastFetchedCues)
   Fallback: HTML5 textTracks (forcing hidden mode)
   Returns validated array or [].
══════════════════════════════════════════════ */
function getInternalCues() {
  // 1) Primary source: raw cues from intercepted subtitle downloads
  if (lastFetchedCues.length > 0) {
    return validateCues(lastFetchedCues);
  }

  // 2) Last-resort fallback: HTML5 textTracks on <video>
  try {
    const v = video || document.querySelector("video");
    if (v?.textTracks?.length) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.mode === "disabled") t.mode = "hidden";
        if (t.cues?.length) {
          const cues = Array.from(t.cues).map((c) => ({
            start: c.startTime,
            end: c.endTime,
            text: (c.text || "")
              .replace(/<[^>]+>/g, "")
              .trim()
          }));
          if (cues.length) return validateCues(cues);
        }
      }
    }
  } catch (e) {
    console.warn("[SubSync] getInternalCues fallback error:", e);
  }

  return [];
}

function validateCues(arr) {
  return arr.filter(
    (c) =>
      typeof c.start === "number" &&
      typeof c.end === "number" &&
      typeof c.text === "string" &&
      c.start < c.end &&
      c.text.trim().length > 0
  );
}

/* ══════════════════════════════════════════════
   CUE POLLING
   After video is ready, polls every 800ms until
   cues appear. Stops attempts UI, but can keep
   running to detect track changes (via count).
══════════════════════════════════════════════ */
function startCuePolling() {
  if (cuePollingId) clearInterval(cuePollingId);

  let attempts = 0;

  cuePollingId = setInterval(() => {
    attempts++;
    const cues = getInternalCues();

    if (cues.length > 0) {
      const hash = hashCues(cues);
      if (hash !== lastCueHash) {
        lastCueHash = hash;
        lastCueCount = cues.length;
        setupSubtitleSystem(cues);
        return;
      }
    }

    if (attempts <= 20 && cues.length === 0) {
      updateStatus(
        `SubSync: waiting for subs... (${attempts})`
      );
    }

    // After 30s, stop attempts UI but keep one last status
    if (attempts > 150) {
      clearInterval(cuePollingId);
      cuePollingId = null;
      if (!originalCues.length) {
        updateStatus(
          "SubSync: no subs found — click badge after loading subs"
        );
      }
    }
  }, 800);
}

/* ══════════════════════════════════════════════
   NATIVE SUBTITLE HIDE/SHOW
══════════════════════════════════════════════ */
function hideNativeSubtitles() {
  nativeSubtitleEl =
    document.querySelector(".player-subtitle-layer") ||
    document.querySelector('[data-testid*="subtitle"]') ||
    document.querySelector('div[class*="subtitle-container"]') ||
    document.querySelector('div[class*="subtitles"]');
  if (nativeSubtitleEl) nativeSubtitleEl.style.visibility = "hidden";
}

function showNativeSubtitles() {
  if (nativeSubtitleEl) nativeSubtitleEl.style.visibility = "";
}

// Additional guard: continuously hide any DOM nodes that look like native subtitles.
function aggressiveHideNativeSubtitles() {
  const hideInTree = (root) => {
    if (!root || !root.querySelectorAll) return;
    const candidates = root.querySelectorAll(
      '[class*="subtitle"], [class*="Subtitle"], [data-testid*="subtitle"], [data-testid*="Subtitle"]'
    );
    candidates.forEach((el) => {
      el.style.visibility = "hidden";
    });
  };

  hideInTree(document.body);

  if (subtitleObserver) subtitleObserver.disconnect();
  subtitleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) hideInTree(n);
      });
    }
  });
  subtitleObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/* ══════════════════════════════════════════════
   CUSTOM OVERLAY
══════════════════════════════════════════════ */
function initCustomSubtitleRenderer() {
  if (customOverlay) customOverlay.remove();
  if (ghostOverlay) ghostOverlay.remove();

  customOverlay = document.createElement("div");
  customOverlay.style.cssText = [
    "position:fixed",
    "bottom:9%",
    "left:50%",
    "transform:translateX(-50%)",
    "text-align:center",
    "z-index:2147483647",
    "pointer-events:none",
    "width:94%",
    "max-width:94vw",
    "color:#fff",
    "font-size:min(3.2vw,32px)",
    "line-height:1.4",
    'font-family:"Segoe UI",Arial,sans-serif',
    "font-weight:500",
    "text-shadow:0 0 8px #000,1px 1px 3px #000,-1px -1px 3px #000"
  ].join(";");
  document.body.appendChild(customOverlay);

  ghostOverlay = document.createElement("div");
  ghostOverlay.style.cssText = [
    "position:fixed",
    "bottom:9%",
    "left:50%",
    "transform:translateX(-50%)",
    "text-align:center",
    "z-index:2147483644",
    "pointer-events:none",
    "width:94%",
    "max-width:94vw",
    "color:rgba(255,210,80,0.65)",
    "font-size:min(3.2vw,32px)",
    "line-height:1.4",
    'font-family:"Segoe UI",Arial,sans-serif',
    "text-shadow:0 0 8px #000",
    "display:none"
  ].join(";");
  document.body.appendChild(ghostOverlay);

  const reposition = () => {
    const fs = !!document.fullscreenElement;
    const b = fs ? "12%" : "9%";
    if (customOverlay) customOverlay.style.bottom = b;
    if (ghostOverlay) ghostOverlay.style.bottom = b;
  };

  document.addEventListener("fullscreenchange", reposition, {
    signal: controller.signal
  });
  window.addEventListener("resize", reposition, {
    signal: controller.signal
  });
}

/* ══════════════════════════════════════════════
   CUE SCHEDULER — fixed boundary logic
══════════════════════════════════════════════ */
function getNextCueBoundary(t) {
  for (let i = 0; i < mappedCues.length; i++) {
    const c = mappedCues[i];
    if (c.start <= t && c.end > t) return c.end;
    if (c.start > t) return c.start;
  }
  return null;
}

function renderMappedCues(t) {
  if (!customOverlay) return;
  const active = mappedCues.filter(
    (c) => c.start <= t && c.end > t
  );
  const html = active
    .map((c) => `<div>${escapeHtml(c.text)}</div>`)
    .join("");
  if (customOverlay.innerHTML !== html) {
    customOverlay.innerHTML = html;
  }
}

function scheduleCueRender(t) {
  clearTimeout(nextCueTimeout);
  if (!video || video.paused || !mappedCues.length) return;

  renderMappedCues(t);

  const next = getNextCueBoundary(t);
  if (next === null) return;

  const delay = Math.max(0, (next - video.currentTime) * 1000);
  nextCueTimeout = setTimeout(() => {
    if (video && !video.paused) {
      renderMappedCues(video.currentTime);
      scheduleCueRender(video.currentTime);
    }
  }, delay + 16);
}

/* ══════════════════════════════════════════════
   MAPPING ENGINE — all math in original domain
══════════════════════════════════════════════ */
function computeSubtitleGapSequence(cues) {
  const g = [];
  for (let i = 1; i < cues.length; i++) {
    g.push(cues[i].start - cues[i - 1].end);
  }
  return g;
}

function rebuildMappedCues() {
  mappedCues = originalCues.map((cue, i) => {
    let ms = globalA * cue.start + globalB;
    let me = globalA * cue.end + globalB;
    return { ...cue, start: ms, end: me };
  });
}

function applyMapping(newAnchors) {
  if (!newAnchors || newAnchors.length === 0) return;

  if (newAnchors.length === 1) {
    globalB =
      newAnchors[0].audioTime - newAnchors[0].subtitleCenter;
    globalA = 1.0;
  } else {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    const n = newAnchors.length;

    newAnchors.forEach((a) => {
      sx += a.subtitleCenter;
      sy += a.audioTime;
      sxy += a.subtitleCenter * a.audioTime;
      sxx += a.subtitleCenter * a.subtitleCenter;
    });

    const denom = n * sxx - sx * sx;
    globalA = Math.max(
      0.85,
      Math.min(1.15, denom !== 0 ? (n * sxy - sx * sy) / denom : 1)
    );
    globalB = (sy - globalA * sx) / n;
  }

  rebuildMappedCues();
  if (video) scheduleCueRender(video.currentTime);
}

/* ══════════════════════════════════════════════
   FPS NORMALIZATION
══════════════════════════════════════════════ */
function applyFPSNormalization(cues) {
  // NOTE: video.videoFrameRate is not standard on HTMLVideoElement in browsers.
  // For now, we skip FPS normalization and keep original timing.
  // TODO: infer FPS from subtitle timing patterns alone if needed.
  return cues;
}

/* ══════════════════════════════════════════════
   WORKER — VAD + DTW (accumulates across chunks)
══════════════════════════════════════════════ */
const WORKER_CODE = `
let segs=[],inSpeech=false,speechStart=0,smoothE=0,subGaps=[];
self.onmessage=function(e){
  if(e.data.type==='init'){subGaps=e.data.subtitleGaps||[];segs=[];inSpeech=false;smoothE=0;return;}
  if(e.data.type==='pcm'){
    const pcm=e.data.data,ts=e.data.ts;
    let en=0; for(let i=0;i<pcm.length;i++) en+=pcm[i]*pcm[i];
    en=Math.sqrt(en/pcm.length);
    smoothE=0.88*smoothE+0.12*en;
    const thr=Math.max(0.012,smoothE*1.9),now=en>thr;
    if(now&&!inSpeech){inSpeech=true;speechStart=ts;}
    else if(!now&&inSpeech){
      inSpeech=false;
      const dur=ts-speechStart;
      if(dur>=0.18){
        segs.push({start:speechStart,end:ts});
        if(segs.length>400)segs.shift();
        if(segs.length>=10)tryMatch();
      }
    }
  }
};
function tryMatch(){
  if(!subGaps.length||segs.length<8)return;
  const ag=[];for(let i=1;i<segs.length;i++)ag.push(segs[i].start-segs[i-1].end);
  const win=Math.min(40,Math.min(ag.length,subGaps.length));
  if(win<6)return;
  const aw=ag.slice(-win);
  let bestCost=Infinity,bestOff=0;
  for(let off=0;off<=subGaps.length-win;off++){
    const r=dtw(aw,subGaps.slice(off,off+win));
    if(r<bestCost){bestCost=r;bestOff=off;}
  }
  const avg=bestCost/win,mr=Math.max(0,1-avg/2);
  const cands=[];
  if(mr>0.6){
    for(let i=0;i<Math.min(6,win);i++){
      const si=segs.length-win+i;
      if(si>=0)cands.push({subGapIndex:bestOff+i,audioTime:(segs[si].start+segs[si].end)/2,source:'auto'});
    }
  }
  self.postMessage({type:'match',confidence:mr,avgRelativeError:avg,bestOffset:bestOff,candidateAnchors:cands});
}
function dtw(a,b){
  const n=a.length,m=b.length,band=Math.max(3,Math.floor(Math.max(n,m)*0.2)),INF=1e9;
  const dp=Array.from({length:n+1},()=>new Float32Array(m+1).fill(INF));
  dp[0][0]=0;
  for(let i=1;i<=n;i++){
    for(let j=Math.max(1,i-band);j<=Math.min(m,i+band);j++){
      const c=Math.abs(Math.log((a[i-1]||0.001))-Math.log((b[j-1]||0.001)));
      dp[i][j]=c+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
    }
  }
  return dp[n][m]===INF?999:dp[n][m];
}
`;

function createWorker() {
  try {
    return new Worker(
      URL.createObjectURL(
        new Blob([WORKER_CODE], { type: "text/javascript" })
      )
    );
  } catch (e) {
    updateStatus("SubSync: Manual-only (CSP blocks Worker)");
    return {
      postMessage: () => {},
      onmessage: null,
      terminate: () => {}
    };
  }
}

function initWorker(gaps) {
  if (vadWorker?.terminate) vadWorker.terminate();
  vadWorker = createWorker();
  vadWorker.postMessage({ type: "init", subtitleGaps: gaps });

  vadWorker.onmessage = (e) => {
    if (e.data.type !== "match" || !driftEnabled) return;
    const conf = e.data.confidence;
    if (conf < 0.75) {
      if (conf > 0.5) {
        updateStatus(
          `SubSync: calibrating… ${Math.round(conf * 100)}%`
        );
      }
      return;
    }

    const resolved = (e.data.candidateAnchors || [])
      .filter((a) => a.subGapIndex < originalCues.length)
      .map((a) => ({
        ...a,
        subtitleCenter:
          (originalCues[a.subGapIndex].start +
            originalCues[a.subGapIndex].end) /
          2,
        confidence: conf
      }));

    if (resolved.length >= 2) {
      applyMapping([
        ...anchors.filter((a) => a.source === "user"),
        ...resolved
      ]);
      updateStatus(
        `SubSync: auto ✓ ${Math.round(conf * 100)}%`
      );
    }
  };
}

/* ══════════════════════════════════════════════
   AUDIO CAPTURE
══════════════════════════════════════════════ */
function initAudioCapture(v) {
  if (audioCtx) return;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(v);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    analyser.connect(audioCtx.destination); // keep audio playing

    const resume = () => {
      if (audioCtx?.state === "suspended") {
        audioCtx.resume();
      }
    };

    ["seeked", "waiting", "playing", "loadedmetadata"].forEach(
      (ev) => v.addEventListener(ev, resume, { signal: controller.signal })
    );

    pcmIntervalId = setInterval(() => {
      if (!analyser || !vadWorker || !video || video.paused) return;
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      vadWorker.postMessage({
        type: "pcm",
        data: buf,
        ts: video.currentTime,
        chunkDuration:
          analyser.fftSize / (audioCtx.sampleRate || 44100)
      });
    }, 180);
  } catch (e) {
    console.warn("[SubSync] Audio capture failed:", e);
  }
}

/* ══════════════════════════════════════════════
   SUBTITLE SYSTEM SETUP
══════════════════════════════════════════════ */
function setupSubtitleSystem(rawCues) {
  if (settingUp) return;
  settingUp = true;
  try {
    originalCues = applyFPSNormalization(
      rawCues.map((c) => ({ ...c }))
    );
    subtitleGapSequence = computeSubtitleGapSequence(originalCues);
    anchors = [];
    globalA = 1.0;
    globalB = 0.0;
    mappedCues = originalCues.map((c) => ({ ...c }));
    initWorker(subtitleGapSequence);
    hideNativeSubtitles();
    aggressiveHideNativeSubtitles();
    if (video) scheduleCueRender(video.currentTime);
    updateStatus(
      `SubSync ✓  ${originalCues.length} cues loaded`
    );
    console.log(
      `[SubSync] ${originalCues.length} cues, ${subtitleGapSequence.length} gaps`
    );
  } finally {
    settingUp = false;
  }
}

/* ══════════════════════════════════════════════
   TRACK CHANGE WATCHER (throttled)
══════════════════════════════════════════════ */
function initTrackChangeWatcher() {
  if (trackObserver) trackObserver.disconnect();

  trackObserver = new MutationObserver(() => {
    if (trackChangeThrottle) return;
    trackChangeThrottle = setTimeout(() => {
      trackChangeThrottle = null;
      checkSubtitleChange();
    }, 700);
  });

  trackObserver.observe(playerRoot || document.body, {
    childList: true,
    subtree: true
  });
}

function checkSubtitleChange() {
  const cur =
    window.services?.core?.transport?.getState?.("player")
      ?.selectedSubtitle?.url ||
    window.core?.transport?.getState?.("player")
      ?.selectedSubtitle?.url ||
    "";

  if (!cur || cur === lastSubUrl) return;
  lastSubUrl = cur;

  if (vadWorker?.terminate) vadWorker.terminate();
  vadWorker = null;
  if (customOverlay) customOverlay.innerHTML = "";

  originalCues = [];
  mappedCues = [];
  subtitleGapSequence = [];
  anchors = [];
  globalA = 1.0;
  globalB = 0.0;
  lastCueCount = 0;
  lastFetchedCues = [];
  showNativeSubtitles();
  updateStatus("SubSync: new subtitle track detected…");

  // cuePolling loop will pick up the new cues automatically
  startCuePolling();
}

/* ══════════════════════════════════════════════
   CYLINDER UI
══════════════════════════════════════════════ */
function showCylinderUI() {
  if (cylinderUI) return;

  if (!originalCues.length) {
    updateStatus(
      "SubSync: no subtitles loaded yet — wait for subs to appear, then click again"
    );
    return;
  }

  const t = video?.currentTime || 0;
  let nearestIdx = 0;
  let minD = Infinity;

  originalCues.forEach((c, i) => {
    const d = Math.abs((c.start + c.end) / 2 - t);
    if (d < minD) {
      minD = d;
      nearestIdx = i;
    }
  });
  selectedCueIndex = nearestIdx;

  const offMs = Math.round(globalB * 1000);
  const sign = offMs >= 0 ? "+" : "";

  cylinderBackdrop = document.createElement("div");
  cylinderBackdrop.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:2147483648;display:flex;align-items:center;justify-content:center;";

  cylinderUI = document.createElement("div");
  cylinderUI.style.cssText = [
    "background:#09100d",
    "border-radius:14px",
    "width:500px",
    "max-height:80vh",
    "padding:18px",
    "color:white",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "box-shadow:0 0 80px rgba(0,180,70,0.12)",
    "border:1px solid rgba(0,180,70,0.25)",
    "font-family:monospace",
    "overflow:hidden"
  ].join(";");

  cylinderUI.innerHTML = `
    <div style="text-align:center;padding-bottom:10px;border-bottom:1px solid #162b1e;">
      <div style="font-size:15px;font-weight:bold;color:#3f3;letter-spacing:2px;">⟳ SUBTITLE CORRECTOR</div>
      <div style="font-size:11px;color:#3a5940;margin-top:5px;">
        Offset <span style="color:#3f3">${sign}${offMs}ms</span>
        &nbsp;·&nbsp; Scale <span style="color:#3f3">${globalA.toFixed(
          4
        )}</span>
        &nbsp;·&nbsp; Manual anchors <span style="color:#3f3">${anchors.filter(
          (a) => a.source === "user"
        ).length}</span>
      </div>
    </div>
    <div style="font-size:11px;color:#3a5940;text-align:center;line-height:1.6;">
      Find the subtitle line you can <em style="color:#6b9">currently hear</em>.<br>
      Click it to select (goes green) → press <strong style="color:#3f3">Set Anchor</strong>.
    </div>
    <div id="scp-scroll" style="flex:1;overflow-y:auto;max-height:340px;border:1px solid #162b1e;border-radius:8px;scroll-snap-type:y mandatory;"></div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;">
      <button id="scp-set"   style="padding:11px;background:#0a5;border:none;border-radius:8px;color:#fff;font-size:13px;cursor:pointer;font-family:monospace;font-weight:bold;">✓ Set Anchor</button>
      <button id="scp-undo"  style="padding:11px;background:#1c2e24;border:none;border-radius:8px;color:#8a8;font-size:12px;cursor:pointer;font-family:monospace;">↩ Undo</button>
      <button id="scp-close" style="padding:11px;background:#161e18;border:none;border-radius:8px;color:#666;font-size:12px;cursor:pointer;font-family:monospace;">✕ Close</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#3a5940;cursor:pointer;">
      <input type="checkbox" id="scp-drift" ${
        driftEnabled ? "checked" : ""
      } style="accent-color:#0a5;width:13px;height:13px;">
      Continuous auto-drift correction (uses audio fingerprinting)
    </label>
  `;

  cylinderBackdrop.appendChild(cylinderUI);
  document.body.appendChild(cylinderBackdrop);

  // Populate list around nearest cue by index
  const startI = 0;
  const endI = originalCues.length;
  const scroll = cylinderUI.querySelector("#scp-scroll");

  for (let i = startI; i < endI; i++) {
    const cue = originalCues[i];
    const sel = i === nearestIdx;
    const el = document.createElement("div");
    el.dataset.idx = String(i);
    el.style.cssText = [
      "padding:9px 13px",
      "margin:2px 3px",
      "border-radius:6px",
      "cursor:pointer",
      "scroll-snap-align:start",
      "font-size:11px",
      `border:1px solid ${sel ? "#0a5" : "#162b1e"}`,
      `background:${
        sel ? "rgba(0,140,70,0.15)" : "rgba(255,255,255,0.02)"
      }`
    ].join(";");
    el.innerHTML =
      `<span style="color:#2a4a30;font-size:10px;">${formatTime(
        cue.start
      )}</span>&nbsp;` +
      `<span style="color:${
        sel ? "#afa" : "#bbb"
      }">${escapeHtml(cue.text.substring(0, 95))}</span>`;

    el.addEventListener("click", () => {
      scroll
        .querySelectorAll("[data-idx]")
        .forEach((x) => {
          x.style.border = "1px solid #162b1e";
          x.style.background = "rgba(255,255,255,0.02)";
          x.querySelector("span:last-child").style.color = "#bbb";
        });
      el.style.border = "1px solid #0a5";
      el.style.background = "rgba(0,140,70,0.15)";
      el.querySelector("span:last-child").style.color = "#afa";
      selectedCueIndex = parseInt(el.dataset.idx, 10);
      showGhostPreview(selectedCueIndex);
    });

    scroll.appendChild(el);
    if (sel) {
      setTimeout(
        () =>
          el.scrollIntoView({
            block: "center",
            behavior: "smooth"
          }),
        80
      );
    }
  }

  cylinderUI.querySelector("#scp-set").onclick = () =>
    setUserAnchor(selectedCueIndex);
  cylinderUI.querySelector("#scp-close").onclick = hideCylinderUI;
  cylinderUI.querySelector("#scp-undo").onclick = doUndo;
  cylinderUI.querySelector("#scp-drift").onchange = (e) => {
    driftEnabled = e.target.checked;
    updateStatus(
      driftEnabled ? "Auto-drift: ON" : "Auto-drift: OFF"
    );
  };

  // Block Stremio's own key/mouse/scroll while UI is open
  ["wheel", "keydown", "mousedown", "touchstart"].forEach((ev) =>
    cylinderBackdrop.addEventListener(
      ev,
      (e) => {
        e.stopImmediatePropagation();
        if (ev === "keydown" && e.key === "Escape") {
          hideCylinderUI();
        }
      },
      { capture: true }
    )
  );

  cylinderBackdrop.addEventListener("click", (e) => {
    if (e.target === cylinderBackdrop) hideCylinderUI();
  });

  // While UI is open, keep the "currently here" line in sync with playback
  if (video) {
    const syncSelectionToTime = () => {
      if (!cylinderUI || !originalCues.length) return;
      const now = video.currentTime || 0;
      let nearest = selectedCueIndex;
      let best = Infinity;
      originalCues.forEach((c, i) => {
        const d = Math.abs((c.start + c.end) / 2 - now);
        if (d < best) {
          best = d;
          nearest = i;
        }
      });
      if (nearest === selectedCueIndex) return;
      selectedCueIndex = nearest;
      const selEl = scroll.querySelector(`[data-idx="${nearest}"]`);
      if (!selEl) return;
      scroll
        .querySelectorAll("[data-idx]")
        .forEach((x) => {
          x.style.border = "1px solid #162b1e";
          x.style.background = "rgba(255,255,255,0.02)";
          x.querySelector("span:last-child").style.color = "#bbb";
        });
      selEl.style.border = "1px solid #0a5";
      selEl.style.background = "rgba(0,140,70,0.15)";
      selEl.querySelector("span:last-child").style.color = "#afa";
      selEl.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    video.addEventListener("timeupdate", syncSelectionToTime, {
      signal: controller.signal
    });
  }
}

function showGhostPreview(idx) {
  if (!ghostOverlay || !video || !originalCues[idx]) return;

  const predOffset =
    video.currentTime -
    (originalCues[idx].start + originalCues[idx].end) / 2;
  const active = originalCues.filter(
    (c) =>
      c.start + predOffset <= video.currentTime &&
      c.end + predOffset > video.currentTime
  );

  ghostOverlay.innerHTML = active
    .map((c) => `<div>${escapeHtml(c.text)}</div>`)
    .join("");
  ghostOverlay.style.display = active.length ? "block" : "none";
}

function setUserAnchor(idx) {
  if (!originalCues[idx] || !video) return;
  const at = video.currentTime;
  const sc =
    (originalCues[idx].start + originalCues[idx].end) / 2;

  anchors.push({
    subtitleIndex: idx,
    subtitleCenter: sc,
    audioTime: at,
    confidence: 1.0,
    source: "user"
  });

  applyMapping(anchors);
  hideCylinderUI();
  updateStatus(
    `Anchor set @ ${formatTime(
      at
    )} → offset ${Math.round(globalB * 1000)}ms`
  );
}

function doUndo() {
  const user = anchors.filter((a) => a.source === "user");
  if (!user.length) {
    hideCylinderUI();
    return;
  }

  anchors = [
    ...anchors.filter((a) => a.source !== "user"),
    ...user.slice(0, -1)
  ];

  if (!anchors.length) {
    globalA = 1.0;
    globalB = 0.0;
    rebuildMappedCues();
    if (video) scheduleCueRender(video.currentTime);
  } else {
    applyMapping(anchors);
  }

  updateStatus("Last anchor removed");
  hideCylinderUI();
}

function hideCylinderUI() {
  if (cylinderBackdrop) cylinderBackdrop.remove();
  if (ghostOverlay) ghostOverlay.style.display = "none";
  cylinderUI = null;
  cylinderBackdrop = null;
}

/* ══════════════════════════════════════════════
   DESTROY — every resource
══════════════════════════════════════════════ */
function destroy() {
  controller.abort();
  controller = new AbortController();

  clearTimeout(nextCueTimeout);
  clearTimeout(trackChangeThrottle);
  clearTimeout(badgeDimTimer);
  clearInterval(pcmIntervalId);
  clearInterval(cuePollingId);
  clearInterval(videoPoller);
  pcmIntervalId = null;
  cuePollingId = null;
  videoPoller = null;
  trackChangeThrottle = null;

  if (vadWorker?.terminate) vadWorker.terminate();
  vadWorker = null;

  if (audioCtx) {
    try {
      audioCtx.close();
    } catch (_) {}
    audioCtx = null;
    analyser = null;
  }

  if (customOverlay) customOverlay.remove();
  if (ghostOverlay) ghostOverlay.remove();
  if (statusBadge) statusBadge.remove();
  if (cylinderBackdrop) cylinderBackdrop.remove();
  customOverlay = ghostOverlay = statusBadge = cylinderUI = cylinderBackdrop = null;

  if (subtitleObserver) {
    subtitleObserver.disconnect();
    subtitleObserver = null;
  }
  if (trackObserver) {
    trackObserver.disconnect();
    trackObserver = null;
  }

  showNativeSubtitles();

  originalCues = [];
  mappedCues = [];
  subtitleGapSequence = [];
  anchors = [];
  globalA = 1.0;
  globalB = 0.0;
  lastCueCount = 0;

  console.log("[SubSync] Destroyed");
}

/* ══════════════════════════════════════════════
   MAIN ENTRY
   1. Badge appears immediately
   2. Keyboard shortcut registered immediately
   3. Poll for video element
   4. Once video found, start polling for cues
══════════════════════════════════════════════ */

// Step 1: Badge — proves plugin is loaded
createStatusBadge();
updateStatus("SubSync: looking for player…");

// Step 2: Keyboard shortcuts (backtick or Alt+S)
document.addEventListener(
  "keydown",
  (e) => {
    const isBacktick = e.key === "`" || e.key === "~";
    const isAltS =
      e.altKey && !e.ctrlKey && e.key.toLowerCase() === "s";
    if (isBacktick || isAltS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (video) {
        showCylinderUI();
      } else {
        updateStatus(
          "SubSync: no video found yet — start playing first"
        );
      }
    }
  },
  { capture: true }
);

// Step 3: Find video element
function onVideoReady(v) {
  if (video === v) return; // already set up
  video = v;
  console.log("[SubSync] Video element found");

  playerRoot =
    document.querySelector('div[class*="player"]') ||
    document.querySelector('div[class*="Player"]') ||
    v.closest?.('div[role="region"]') ||
    v.parentElement?.parentElement ||
    document.body;

  initAudioCapture(video);
  initCustomSubtitleRenderer();
  initTrackChangeWatcher();

  // Issue 1: Process cues intercepted before video was ready
  if (pendingCues) {
    console.log("[SubSync] Processing pending cues");
    setupSubtitleSystem(pendingCues);
    pendingCues = null;
  }

  // Issue 4: Better AudioContext resume handling
  const resume = () => {
    if (audioCtx?.state === "suspended") {
      audioCtx.resume().then(() => {
        if (audioCtx.state === "running") {
          console.log("[SubSync] AudioContext active ✓");
          updateStatus("SubSync: audio analysis active ✓");
        }
      });
    }
  };

  ["seeked", "waiting", "playing", "loadedmetadata"].forEach(
    (ev) => v.addEventListener(ev, resume, { signal: controller.signal })
  );

  document.addEventListener("click", resume, { once: true, signal: controller.signal });

  video.addEventListener(
    "playing",
    () => scheduleCueRender(video.currentTime),
    { signal: controller.signal }
  );
  video.addEventListener(
    "seeked",
    () => scheduleCueRender(video.currentTime),
    { signal: controller.signal }
  );
  video.addEventListener(
    "pause",
    () => clearTimeout(nextCueTimeout),
    { signal: controller.signal }
  );

  updateStatus("SubSync: waiting for subtitles…");
  startCuePolling();
}

let videoCheckCount = 0;
videoPoller = setInterval(() => {
  videoCheckCount++;
  const v = document.querySelector("video");
  if (v && v !== video) onVideoReady(v);
  if (videoCheckCount > 600) clearInterval(videoPoller); // ~5 min
}, 500);

/* ══════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════ */
window.subtitleCorrector = {
  destroy,
  showUI: () => showCylinderUI(),
  setOffset: (ms) => {
    globalB = ms / 1000;
    rebuildMappedCues();
    if (video) scheduleCueRender(video.currentTime);
    updateStatus(
      `Offset set: ${ms > 0 ? "+" : ""}${ms}ms`
    );
  },
  debug: () => ({
    video: !!video,
    audioCtx: audioCtx?.state,
    originalCues: originalCues.length,
    mappedCues: mappedCues.length,
    globalA,
    globalB,
    anchors: anchors.length,
    driftEnabled,
    workerActive: !!vadWorker
  })
};
