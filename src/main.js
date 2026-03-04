import { SubtitleEngine } from './engine.js';
import { createStatusBadge, updateStatus, showCylinderUI } from './ui.js';
import { installInterceptors } from './interceptor.js';
import { createWorker, initAudioCapture } from './audio.js';
import { validateCues, hashCues, formatTime } from './utils.js';

console.log("[SubSync v3.1] Initializing Modular...");

const state = {
  video: null,
  customOverlay: null,
  vadWorker: null,
  controller: new AbortController(),
  statusBadge: null,
  originalCues: [],
  mappedCues: [],
  subtitleGapSequence: [],
  anchors: [],
  globalA: 1.0,
  globalB: 0.0,
  driftEnabled: false,
  lastSubUrl: "",
  nextCueTimeout: null,
  subtitleObserver: null,
  trackObserver: null,
  audioCtx: null,
  analyser: null,
  playerRoot: null,
  cylinderUI: null,
  cylinderBackdrop: null,
  pcmIntervalId: null,
  selectedCueIndex: 0,
  nativeSubtitleEl: null,
  trackChangeThrottle: null,
  cuePollingId: null,
  lastCueCount: 0,
  lastCueHash: "",
  pendingCues: null,
  settingUp: false,
  badgeDimTimer: null,
  videoPoller: null,
  lastFetchedCues: []
};

const engine = new SubtitleEngine(state);

/* ══════════════════════════════════════════════
   CORE LOGIC
══════════════════════════════════════════════ */

function setupSubtitleSystem(rawCues) {
  if (state.settingUp) return;
  state.settingUp = true;
  try {
    state.originalCues = rawCues.map((c) => ({ ...c }));
    state.subtitleGapSequence = engine.computeSubtitleGapSequence(state.originalCues);
    state.anchors = [];
    state.globalA = 1.0;
    state.globalB = 0.0;
    state.mappedCues = state.originalCues.map((c) => ({ ...c }));
    
    if (state.vadWorker) state.vadWorker.terminate();
    state.vadWorker = createWorker();
    if (state.vadWorker) {
      state.vadWorker.postMessage({ type: "init", subtitleGaps: state.subtitleGapSequence });
      state.vadWorker.onmessage = handleWorkerMessage;
    }

    hideNativeSubtitles();
    if (state.video) engine.scheduleCueRender(state.video.currentTime);
    updateStatus(state, `SubSync ✓ ${state.originalCues.length} cues loaded`);
  } finally {
    state.settingUp = false;
  }
}

function handleWorkerMessage(e) {
  if (e.data.type !== "match" || !state.driftEnabled) return;
  const conf = e.data.confidence;
  if (conf < 0.75) return;

  const resolved = (e.data.candidateAnchors || [])
    .filter((a) => a.subGapIndex < state.originalCues.length)
    .map((a) => ({
      ...a,
      subtitleCenter: (state.originalCues[a.subGapIndex].start + state.originalCues[a.subGapIndex].end) / 2,
      confidence: conf
    }));

  if (resolved.length >= 2) {
    engine.applyMapping([...state.anchors.filter((a) => a.source === "user"), ...resolved]);
    updateStatus(state, `SubSync: auto ✓ ${Math.round(conf * 100)}%`);
  }
}

/* ══════════════════════════════════════════════
   UI HANDLERS
══════════════════════════════════════════════ */

function handleShowUI() {
  showCylinderUI(state, engine, setUserAnchor, doUndo, hideCylinderUI);
}

function setUserAnchor(idx) {
  if (!state.originalCues[idx] || !state.video) return;
  const at = state.video.currentTime;
  const sc = (state.originalCues[idx].start + state.originalCues[idx].end) / 2;

  state.anchors.push({
    subtitleIndex: idx,
    subtitleCenter: sc,
    audioTime: at,
    confidence: 1.0,
    source: "user"
  });

  engine.applyMapping(state.anchors);
  hideCylinderUI();
  updateStatus(state, `Anchor set @ ${formatTime(at)} → offset ${Math.round(state.globalB * 1000)}ms`);
}

function doUndo() {
  const user = state.anchors.filter((a) => a.source === "user");
  if (!user.length) {
    hideCylinderUI();
    return;
  }
  state.anchors = [...state.anchors.filter((a) => a.source !== "user"), ...user.slice(0, -1)];
  if (!state.anchors.length) {
    state.globalA = 1.0;
    state.globalB = 0.0;
    engine.rebuildMappedCues();
    if (state.video) engine.scheduleCueRender(state.video.currentTime);
  } else {
    engine.applyMapping(state.anchors);
  }
  updateStatus(state, "Last anchor removed");
  hideCylinderUI();
}

function hideCylinderUI() {
  if (state.cylinderBackdrop) state.cylinderBackdrop.remove();
  state.cylinderUI = null;
  state.cylinderBackdrop = null;
}

/* ══════════════════════════════════════════════
   PLAYER INTEGRATION
══════════════════════════════════════════════ */

function onVideoReady(v) {
  if (state.video === v) return;
  state.video = v;
  initAudioCapture(state.video, state);
  
  if (state.pendingCues) {
    setupSubtitleSystem(state.pendingCues);
    state.pendingCues = null;
  }

  const resume = () => {
    if (state.audioCtx?.state === "suspended") {
      state.audioCtx.resume().then(() => {
        if (state.audioCtx.state === "running") updateStatus(state, "SubSync: audio analysis active ✓");
      });
    }
  };

  ["seeked", "playing"].forEach((ev) => v.addEventListener(ev, resume, { signal: state.controller.signal }));
  document.addEventListener("click", resume, { once: true, signal: state.controller.signal });
  
  v.addEventListener("playing", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  v.addEventListener("seeked", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  v.addEventListener("pause", () => clearTimeout(state.nextCueTimeout), { signal: state.controller.signal });

  startCuePolling();
}

function startCuePolling() {
  if (state.cuePollingId) clearInterval(state.cuePollingId);
  state.cuePollingId = setInterval(() => {
    const cues = getInternalCues();
    if (cues.length > 0) {
      const hash = hashCues(cues);
      if (hash !== state.lastCueHash) {
        state.lastCueHash = hash;
        setupSubtitleSystem(cues);
      }
    }
  }, 800);
}

function getInternalCues() {
  if (state.lastFetchedCues.length > 0) return validateCues(state.lastFetchedCues);
  // textTrack fallback here if needed...
  return [];
}

function hideNativeSubtitles() {
  const el = document.querySelector(".player-subtitle-layer") || document.querySelector('[data-testid*="subtitle"]');
  if (el) el.style.visibility = "hidden";
}

// Initialization
createStatusBadge(state, handleShowUI);
installInterceptors((cues) => {
  state.lastFetchedCues = cues;
  if (state.video) setupSubtitleSystem(cues);
  else state.pendingCues = cues;
});

state.videoPoller = setInterval(() => {
  const v = document.querySelector("video");
  if (v && v !== state.video) onVideoReady(v);
}, 500);

document.addEventListener("keydown", (e) => {
  if (e.key === "`" || (e.altKey && e.key.toLowerCase() === "s")) {
    if (state.video) handleShowUI();
  }
}, { capture: true });

window.subtitleCorrector = {
  showUI: handleShowUI,
  setOffset: (ms) => {
    state.globalB = ms / 1000;
    engine.rebuildMappedCues();
    if (state.video) engine.scheduleCueRender(state.video.currentTime);
  }
};
