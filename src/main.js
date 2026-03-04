import { SubtitleEngine } from './engine.js';
import { createStatusBadge, updateStatus, showCylinderUI } from './ui.js';
import { installInterceptors } from './interceptor.js';
import { createWorker, initAudioCapture } from './audio.js';
import { validateCues, hashCues, formatTime } from './utils.js';

console.log("[SubSync v3.3] Initializing...");

const state = {
  isEnabled: localStorage.getItem('subsync_enabled') !== 'false', // Default to true
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
  lastFetchedCues: [],
  lastConfidence: 0
};

const engine = new SubtitleEngine(state);

/* ══════════════════════════════════════════════
   VISIBILITY & TOGGLE (NEW)
══════════════════════════════════════════════ */
function updatePluginState() {
    if (!state.isEnabled) {
        if (state.statusBadge) state.statusBadge.style.display = "none";
        if (state.customOverlay) state.customOverlay.style.display = "none";
        showNativeSubtitles();
        if (state.vadWorker) state.vadWorker.terminate();
        state.vadWorker = null;
    } else {
        if (state.statusBadge) state.statusBadge.style.display = "flex";
        if (state.customOverlay) state.customOverlay.style.display = "flex";
        if (state.originalCues.length) hideNativeSubtitles();
    }
}

function injectToggleIntoPlayer() {
    // Only inject if we are in the player and button doesn't exist
    if (document.getElementById("subsync-player-toggle")) return;
    
    // Look for Stremio's control bar (usually right side where settings/fullscreen are)
    const controls = document.querySelector('div[class*="extra-controls"]') || 
                     document.querySelector('div[class*="right-controls"]') ||
                     document.querySelector('.player-controls-container');
    
    if (!controls) return;

    const toggle = document.createElement("div");
    toggle.id = "subsync-player-toggle";
    toggle.title = "Toggle SubSync Plugin";
    toggle.style.cssText = `
        cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; 
        justify-content: center; margin: 0 8px; transition: opacity 0.2s;
        opacity: ${state.isEnabled ? "1" : "0.4"};
    `;
    
    // Modern iOS-style icon (Circle with arrows)
    toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>`;
    
    toggle.onclick = (e) => {
        e.stopPropagation();
        state.isEnabled = !state.isEnabled;
        localStorage.setItem('subsync_enabled', state.isEnabled);
        toggle.style.opacity = state.isEnabled ? "1" : "0.4";
        updatePluginState();
        updateStatus(state, state.isEnabled ? "SubSync Enabled" : "SubSync Disabled");
    };

    controls.insertBefore(toggle, controls.firstChild);
}

/* ══════════════════════════════════════════════
   NATIVE SUBTITLE HIDE/SHOW
══════════════════════════════════════════════ */
function injectNuclearStyles() {
  if (document.getElementById("subsync-nuclear-styles")) return;
  const style = document.createElement("style");
  style.id = "subsync-nuclear-styles";
  style.textContent = `
    .shaka-text-container, .player-subtitle-layer, [data-testid*="subtitle"], 
    div[class*="subtitle-container"], div[class*="subtitles-overlay"], video::cue {
      display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

function hideNativeSubtitles() {
  if (!state.isEnabled) return;
  injectNuclearStyles();
  state.nativeSubtitleEl = document.querySelector(".player-subtitle-layer") || document.querySelector('[data-testid*="subtitle"]') || document.querySelector('div[class*="subtitle-container"]') || document.querySelector('div[class*="subtitles"]');
  if (state.nativeSubtitleEl) state.nativeSubtitleEl.style.display = "none";
}

function showNativeSubtitles() {
  const nuclear = document.getElementById("subsync-nuclear-styles");
  if (nuclear) nuclear.remove();
  if (state.nativeSubtitleEl) state.nativeSubtitleEl.style.display = "";
}

function aggressiveHideNativeSubtitles() {
  const hideInTree = (root) => {
    if (!state.isEnabled || !root || !root.querySelectorAll) return;
    root.querySelectorAll('[class*="subtitle"], [class*="Subtitle"], [data-testid*="subtitle"], [data-testid*="Subtitle"]').forEach(i => i.style.visibility = "hidden");
  };
  const target = document.querySelector('div[class*="player"]') || document.body;
  hideInTree(target);
  if (state.subtitleObserver) state.subtitleObserver.disconnect();
  state.subtitleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(n => { if (n.nodeType === 1) hideInTree(n); });
  });
  state.subtitleObserver.observe(target, { childList: true, subtree: target !== document.body });
}

/* ══════════════════════════════════════════════
   CUSTOM OVERLAY & PLAYER SETUP
══════════════════════════════════════════════ */
function initCustomSubtitleRenderer() {
  if (state.customOverlay) state.customOverlay.remove();
  if (state.ghostOverlay) state.ghostOverlay.remove();
  state.customOverlay = document.createElement("div");
  state.customOverlay.style.cssText = `position:fixed;bottom:9%;left:50%;transform:translateX(-50%);text-align:center;z-index:2147483647;pointer-events:none;width:auto;max-width:94vw;display:flex;flex-direction:column;align-items:center;gap:8px;`;
  document.body.appendChild(state.customOverlay);
  state.ghostOverlay = document.createElement("div");
  state.ghostOverlay.style.cssText = `position:fixed;bottom:9%;left:50%;transform:translateX(-50%);text-align:center;z-index:2147483644;pointer-events:none;color:rgba(255,255,255,0.4);display:none;`;
  document.body.appendChild(state.ghostOverlay);
  updatePluginState();
}

function onVideoReady(v) {
  if (state.video === v) return;
  state.video = v;
  initAudioCapture(state.video, state);
  initCustomSubtitleRenderer();
  injectToggleIntoPlayer();
  if (state.pendingCues) { setupSubtitleSystem(state.pendingCues); state.pendingCues = null; }
  const resume = () => { if (state.isEnabled && state.audioCtx?.state === "suspended") state.audioCtx.resume(); };
  ["seeked", "playing"].forEach((ev) => v.addEventListener(ev, resume, { signal: state.controller.signal }));
  document.addEventListener("click", resume, { once: true, signal: state.controller.signal });
  v.addEventListener("playing", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  v.addEventListener("seeked", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  startCuePolling();
}

/* ══════════════════════════════════════════════
   REMAINDING LOGIC (Minified for brevity)
══════════════════════════════════════════════ */
function setupSubtitleSystem(rawCues) {
  if (state.settingUp) return; state.settingUp = true;
  try {
    state.originalCues = engine.applyFPSNormalization(rawCues.map(c => ({...c})));
    state.lastFetchedCues = []; state.subtitleGapSequence = engine.computeSubtitleGapSequence(state.originalCues);
    state.anchors = []; state.globalA = 1.0; state.globalB = 0.0;
    if (loadAnchors()) engine.rebuildMappedCues();
    else state.mappedCues = state.originalCues.map(c => ({...c}));
    if (state.vadWorker) state.vadWorker.terminate();
    state.vadWorker = createWorker();
    if (state.vadWorker) {
      state.vadWorker.postMessage({ type: "init", subtitleGaps: state.subtitleGapSequence });
      state.vadWorker.onmessage = handleWorkerMessage;
    }
    hideNativeSubtitles(); aggressiveHideNativeSubtitles();
    if (state.video) engine.scheduleCueRender(state.video.currentTime);
  } finally { state.settingUp = false; }
}

function handleWorkerMessage(e) {
  if (!state.isEnabled || e.data.type !== "match" || !state.driftEnabled) return;
  const conf = e.data.confidence;
  const resolved = (e.data.candidateAnchors || []).filter(a => a.subGapIndex < state.originalCues.length).map(a => ({...a, subtitleCenter: (state.originalCues[a.subGapIndex].start + state.originalCues[a.subGapIndex].end)/2, confidence: conf}));
  if (conf > 0.85 || (conf > 0.65 && state.lastConfidence > 0.65)) {
      engine.applyMapping([...state.anchors.filter(a => a.source === "user"), ...resolved]);
      updateStatus(state, `Auto ✓ ${Math.round(conf * 100)}%`);
  }
  state.lastConfidence = conf;
}

function loadAnchors() {
    try {
        const saved = localStorage.getItem(`subsync_anchors_${btoa(window.location.href.split('?')[0]).substring(0,16)}`);
        if (saved) {
            const data = JSON.parse(saved);
            if (Date.now() - data.ts < 7 * 86400000) { state.anchors = data.anchors; state.globalA = data.globalA; state.globalB = data.globalB; return true; }
        }
    } catch(e) {} return false;
}

function saveAnchors() {
    try { localStorage.setItem(`subsync_anchors_${btoa(window.location.href.split('?')[0]).substring(0,16)}`, JSON.stringify({anchors: state.anchors.filter(a => a.source === 'user'), globalA: state.globalA, globalB: state.globalB, ts: Date.now()})); } catch(e) {}
}

function startCuePolling() {
  if (state.cuePollingId) clearInterval(state.cuePollingId);
  state.cuePollingId = setInterval(() => {
    const cues = getInternalCues();
    if (cues.length > 0) {
      const hash = hashCues(cues);
      if (hash !== state.lastCueHash) { state.lastCueHash = hash; setupSubtitleSystem(cues); }
    }
  }, 800);
}

function getInternalCues() {
  if (state.lastFetchedCues.length > 0) return validateCues(state.lastFetchedCues);
  try {
    const v = state.video || document.querySelector("video");
    if (v?.textTracks?.length) for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i]; if (t.mode === "disabled") t.mode = "hidden";
      if (t.cues?.length) {
        const cues = Array.from(t.cues).map(c => ({start: c.startTime, end: c.endTime, text: (c.text || "").replace(/<[^>]+>/g, "").trim()}));
        if (cues.length) return validateCues(cues);
      }
    }
  } catch (_) {} return [];
}

const handleShowUI = () => { if (state.isEnabled) showCylinderUI(state, engine, setUserAnchor, doUndo, hideCylinderUI); };
const setUserAnchor = (idx) => { if (!state.originalCues[idx] || !state.video) return; state.anchors.push({subtitleIndex: idx, subtitleCenter: (state.originalCues[idx].start + state.originalCues[idx].end)/2, audioTime: state.video.currentTime, confidence: 1.0, source: "user"}); engine.applyMapping(state.anchors); saveAnchors(); hideCylinderUI(); updateStatus(state, "Anchor set"); };
const doUndo = () => { const user = state.anchors.filter(a => a.source === "user"); if (!user.length) return hideCylinderUI(); state.anchors = [...state.anchors.filter(a => a.source !== "user"), ...user.slice(0, -1)]; if (!state.anchors.length) { state.globalA = 1.0; state.globalB = 0.0; engine.rebuildMappedCues(); } else engine.applyMapping(state.anchors); saveAnchors(); hideCylinderUI(); };
const hideCylinderUI = () => { if (!state.cylinderBackdrop) return; state.cylinderBackdrop.style.opacity = "0"; state.cylinderUI.style.transform = "scale(0.96)"; setTimeout(() => { if (state.cylinderBackdrop) state.cylinderBackdrop.remove(); state.cylinderUI = null; state.cylinderBackdrop = null; }, 180); };

createStatusBadge(state, handleShowUI);
installInterceptors((cues) => { state.lastFetchedCues = cues; if (state.video) setupSubtitleSystem(cues); else state.pendingCues = cues; });

state.videoPoller = setInterval(() => {
  const v = document.querySelector("video");
  if (v) {
      if (v !== state.video) onVideoReady(v);
      injectToggleIntoPlayer();
  } else {
      // Not in player context
      if (state.statusBadge) state.statusBadge.style.display = "none";
      if (state.customOverlay) state.customOverlay.style.display = "none";
  }
}, 1000);

document.addEventListener("keydown", (e) => {
  if (!state.isEnabled) return;
  const isBacktick = e.key === "`" || e.key === "~";
  const isAltS = e.altKey && !e.ctrlKey && e.key.toLowerCase() === "s";
  if (isBacktick || isAltS) { e.preventDefault(); e.stopImmediatePropagation(); if (state.video) handleShowUI(); }
}, { capture: true });

window.subtitleCorrector = {
  showUI: handleShowUI,
  setEnabled: (val) => { state.isEnabled = val; localStorage.setItem('subsync_enabled', val); updatePluginState(); },
  debug: () => ({ isEnabled: state.isEnabled, video: !!state.video, originalCues: state.originalCues.length, globalA: state.globalA, globalB: state.globalB, anchors: state.anchors.length })
};
