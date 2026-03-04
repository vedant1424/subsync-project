import { SubtitleEngine } from './engine.js';
import { createStatusBadge, updateStatus, showCylinderUI } from './ui.js';
import { installInterceptors } from './interceptor.js';
import { createWorker, initAudioCapture } from './audio.js';
import { validateCues, hashCues, formatTime } from './utils.js';

console.log("[SubSync v3.1] Initializing Modular...");

const state = {
  video: null,
  customOverlay: null,
  ghostOverlay: null,
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
   NATIVE SUBTITLE HIDE/SHOW
══════════════════════════════════════════════ */
function hideNativeSubtitles() {
  state.nativeSubtitleEl =
    document.querySelector(".player-subtitle-layer") ||
    document.querySelector('[data-testid*="subtitle"]') ||
    document.querySelector('div[class*="subtitle-container"]') ||
    document.querySelector('div[class*="subtitles"]');
  if (state.nativeSubtitleEl) state.nativeSubtitleEl.style.visibility = "hidden";
}

function showNativeSubtitles() {
  if (state.nativeSubtitleEl) state.nativeSubtitleEl.style.visibility = "";
}

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

  if (state.subtitleObserver) state.subtitleObserver.disconnect();
  state.subtitleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) hideInTree(n);
      });
    }
  });
  state.subtitleObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/* ══════════════════════════════════════════════
   CUSTOM OVERLAY
══════════════════════════════════════════════ */
function initCustomSubtitleRenderer() {
  if (state.customOverlay) state.customOverlay.remove();
  if (state.ghostOverlay) state.ghostOverlay.remove();

  state.customOverlay = document.createElement("div");
  state.customOverlay.style.cssText = [
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
  document.body.appendChild(state.customOverlay);

  state.ghostOverlay = document.createElement("div");
  state.ghostOverlay.style.cssText = [
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
  document.body.appendChild(state.ghostOverlay);

  const reposition = () => {
    const fs = !!document.fullscreenElement;
    const b = fs ? "12%" : "9%";
    if (state.customOverlay) state.customOverlay.style.bottom = b;
    if (state.ghostOverlay) state.ghostOverlay.style.bottom = b;
  };

  document.addEventListener("fullscreenchange", reposition, {
    signal: state.controller.signal
  });
  window.addEventListener("resize", reposition, {
    signal: state.controller.signal
  });
}

/* ══════════════════════════════════════════════
   TRACK CHANGE WATCHER
══════════════════════════════════════════════ */
function initTrackChangeWatcher() {
  if (state.trackObserver) state.trackObserver.disconnect();

  state.trackObserver = new MutationObserver(() => {
    if (state.trackChangeThrottle) return;
    state.trackChangeThrottle = setTimeout(() => {
      state.trackChangeThrottle = null;
      checkSubtitleChange();
    }, 700);
  });

  state.trackObserver.observe(state.playerRoot || document.body, {
    childList: true,
    subtree: true
  });
}

function checkSubtitleChange() {
  const cur =
    window.services?.core?.transport?.getState?.("player")?.selectedSubtitle?.url ||
    window.core?.transport?.getState?.("player")?.selectedSubtitle?.url ||
    "";

  if (!cur || cur === state.lastSubUrl) return;
  state.lastSubUrl = cur;

  if (state.vadWorker?.terminate) state.vadWorker.terminate();
  state.vadWorker = null;
  if (state.customOverlay) state.customOverlay.innerHTML = "";

  state.originalCues = [];
  state.mappedCues = [];
  state.subtitleGapSequence = [];
  state.anchors = [];
  state.globalA = 1.0;
  state.globalB = 0.0;
  state.lastCueCount = 0;
  state.lastCueHash = "";
  state.lastFetchedCues = [];
  showNativeSubtitles();
  updateStatus(state, "SubSync: new subtitle track detected…");

  startCuePolling();
}

/* ══════════════════════════════════════════════
   CORE ENGINE LOGIC
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
    aggressiveHideNativeSubtitles();
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
  if (state.ghostOverlay) state.ghostOverlay.style.display = "none";
  state.cylinderUI = null;
  state.cylinderBackdrop = null;
}

/* ══════════════════════════════════════════════
   PLAYER INTEGRATION
══════════════════════════════════════════════ */

function onVideoReady(v) {
  if (state.video === v) return;
  state.video = v;

  state.playerRoot =
    document.querySelector('div[class*="player"]') ||
    document.querySelector('div[class*="Player"]') ||
    v.closest?.('div[role="region"]') ||
    v.parentElement?.parentElement ||
    document.body;

  initAudioCapture(state.video, state);
  initCustomSubtitleRenderer();
  initTrackChangeWatcher();
  
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

  ["seeked", "playing", "waiting", "loadedmetadata"].forEach((ev) => v.addEventListener(ev, resume, { signal: state.controller.signal }));
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
  // Fallback to textTracks
  try {
    const v = state.video || document.querySelector("video");
    if (v?.textTracks?.length) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.mode === "disabled") t.mode = "hidden";
        if (t.cues?.length) {
          const cues = Array.from(t.cues).map((c) => ({
            start: c.startTime,
            end: c.endTime,
            text: (c.text || "").replace(/<[^>]+>/g, "").trim()
          }));
          if (cues.length) return validateCues(cues);
        }
      }
    }
  } catch (_) {}
  return [];
}

function destroy() {
  state.controller.abort();
  state.controller = new AbortController();

  clearTimeout(state.nextCueTimeout);
  clearTimeout(state.trackChangeThrottle);
  clearTimeout(state.badgeDimTimer);
  clearInterval(state.pcmIntervalId);
  clearInterval(state.cuePollingId);
  clearInterval(state.videoPoller);
  
  if (state.vadWorker?.terminate) state.vadWorker.terminate();
  if (state.audioCtx) {
    try { state.audioCtx.close(); } catch (_) {}
  }

  if (state.customOverlay) state.customOverlay.remove();
  if (state.ghostOverlay) state.ghostOverlay.remove();
  if (state.statusBadge) state.statusBadge.remove();
  if (state.cylinderBackdrop) state.cylinderBackdrop.remove();

  if (state.subtitleObserver) state.subtitleObserver.disconnect();
  if (state.trackObserver) state.trackObserver.disconnect();

  showNativeSubtitles();
  console.log("[SubSync] Destroyed");
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
  const isBacktick = e.key === "`" || e.key === "~";
  const isAltS = e.altKey && !e.ctrlKey && e.key.toLowerCase() === "s";
  if (isBacktick || isAltS) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (state.video) handleShowUI();
    else updateStatus(state, "SubSync: no video found yet");
  }
}, { capture: true });

window.subtitleCorrector = {
  destroy,
  showUI: handleShowUI,
  setOffset: (ms) => {
    state.globalB = ms / 1000;
    engine.rebuildMappedCues();
    if (state.video) engine.scheduleCueRender(state.video.currentTime);
    updateStatus(state, `Offset set: ${ms}ms`);
  },
  debug: () => ({
    video: !!state.video,
    audioCtx: state.audioCtx?.state,
    originalCues: state.originalCues.length,
    globalA: state.globalA,
    globalB: state.globalB,
    anchors: state.anchors.length,
    driftEnabled: state.driftEnabled
  })
};
