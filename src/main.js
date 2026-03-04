import { SubtitleEngine } from './engine.js';
import { createStatusBadge, updateStatus, showCylinderUI } from './ui.js';
import { installInterceptors } from './interceptor.js';
import { createWorker, initAudioCapture } from './audio.js';
import { validateCues, hashCues, formatTime } from './utils.js';

console.log("[SubSync v3.3] Initializing Smart Snap & Vault Architecture...");

const state = {
  isEnabled: localStorage.getItem('subsync_enabled') !== 'false',
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
  lastConfidence: 0,
  vadHistory: [] // Phase 1: Sliding 30s buffer of speech segments
};

const engine = new SubtitleEngine(state);

/* ══════════════════════════════════════════════
   FLOATING OVERLAY TOGGLE
══════════════════════════════════════════════ */
function updatePluginState() {
    const toggle = document.getElementById("subsync-floating-toggle");
    if (!state.isEnabled) {
        if (state.statusBadge) state.statusBadge.style.display = "none";
        if (state.customOverlay) {
            state.customOverlay.innerHTML = "";
            state.customOverlay.style.display = "none";
        }
        if (toggle) toggle.style.opacity = "0.4";
        showNativeSubtitles();
        if (state.vadWorker) state.vadWorker.terminate();
        state.vadWorker = null;
    } else {
        if (state.statusBadge) state.statusBadge.style.display = "flex";
        if (state.customOverlay) state.customOverlay.style.display = "flex";
        if (toggle) toggle.style.opacity = "1";
        if (state.originalCues.length) hideNativeSubtitles();
    }
}

function injectFloatingToggle() {
    if (document.getElementById("subsync-floating-toggle")) return;
    const toggle = document.createElement("div");
    toggle.id = "subsync-floating-toggle";
    toggle.title = "Toggle SubSync Plugin";
    toggle.style.cssText = `position:fixed;bottom:24px;right:24px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.12);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border:1px solid rgba(255,255,255,0.25);box-shadow:0 8px 32px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483645;transition:all 0.3s cubic-bezier(0.4,0,0.2,1);opacity:${state.isEnabled ? "1" : "0.4"};`;
    toggle.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
    toggle.onclick = (e) => {
        e.stopPropagation();
        state.isEnabled = !state.isEnabled;
        localStorage.setItem('subsync_enabled', state.isEnabled);
        updatePluginState();
        updateStatus(state, state.isEnabled ? "SubSync Active" : "SubSync Disabled");
    };
    document.body.appendChild(toggle);
}

/* ══════════════════════════════════════════════
   NATIVE SUBTITLE HIDE/SHOW (The Nuclear Option)
══════════════════════════════════════════════ */
function injectNuclearStyles() {
  if (document.getElementById("subsync-nuclear-styles")) return;
  const style = document.createElement("style");
  style.id = "subsync-nuclear-styles";
  style.textContent = `.shaka-text-container, .player-subtitle-layer, [data-testid*="subtitle"], div[class*="subtitle-container"], div[class*="subtitles-overlay"], div[class*="Subtitle"], .libassjs-canvas-parent, .shaka-text-wrapper, video::cue, video::-webkit-media-text-track-display, video::-webkit-media-text-track-container, video::-webkit-media-text-track-background { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; height: 0 !important; width: 0 !important; }`;
  document.head.appendChild(style);
}

function hideNativeSubtitles() {
  if (!state.isEnabled) return;
  injectNuclearStyles();
  if (state.video?.textTracks) {
      for (let i = 0; i < state.video.textTracks.length; i++) { state.video.textTracks[i].mode = 'hidden'; }
  }
  state.nativeSubtitleEl = document.querySelector(".player-subtitle-layer") || document.querySelector('[data-testid*="subtitle"]') || document.querySelector('div[class*="subtitle-container"]') || document.querySelector('div[class*="subtitles"]');
  if (state.nativeSubtitleEl) state.nativeSubtitleEl.style.setProperty("display", "none", "important");
}

function showNativeSubtitles() {
  const nuclear = document.getElementById("subsync-nuclear-styles");
  if (nuclear) nuclear.remove();
  if (state.video?.textTracks) {
      for (let i = 0; i < state.video.textTracks.length; i++) { if (state.video.textTracks[i].mode === 'hidden') state.video.textTracks[i].mode = 'showing'; }
  }
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
   CORE ENGINE LOGIC
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
  if (!state.isEnabled) return;

  // Phase 1: Accumulate raw speech segments for Smart Snapping
  if (e.data.type === 'segment') {
      state.vadHistory.push(e.data.segment);
      const cutoff = state.video ? state.video.currentTime - 30 : 0;
      state.vadHistory = state.vadHistory.filter(s => s.end > cutoff);
      return;
  }

  if (e.data.type !== "match" || !state.driftEnabled) return;
  const conf = e.data.confidence;
  const resolved = (e.data.candidateAnchors || []).filter(a => a.subGapIndex < state.originalCues.length).map(a => ({...a, subtitleCenter: (state.originalCues[a.subGapIndex].start + state.originalCues[a.subGapIndex].end)/2, confidence: conf}));
  if (conf > 0.85 || (conf > 0.65 && state.lastConfidence > 0.65)) {
      engine.applyMapping([...state.anchors.filter(a => a.source === "user"), ...resolved]);
      updateStatus(state, `Auto ✓ ${Math.round(conf * 100)}%`);
  }
  state.lastConfidence = conf;
}

/* ══════════════════════════════════════════════
   UI & PERSISTENCE
══════════════════════════════════════════════ */
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

const handleShowUI = () => { 
    if (state.isEnabled) showCylinderUI(state, engine, (idx) => {
        const snapped = engine.smartSnapCue(idx);
        saveAnchors();
        updateStatus(state, snapped ? "Smart Snapped ✓" : "Sync Updated");
    }, doUndo, hideCylinderUI); 
};

const doUndo = () => { 
    const user = state.anchors.filter(a => a.source === "user"); 
    if (!user.length) return hideCylinderUI(); 
    state.anchors = [...state.anchors.filter(a => a.source !== "user"), ...user.slice(0, -1)]; 
    if (!state.anchors.length) { 
        state.globalA = 1.0; state.globalB = 0.0; engine.rebuildMappedCues(); 
    } else engine.applyMapping(state.anchors); 
    saveAnchors(); 
    updateStatus(state, "Undo: Sync reverted");
};
const hideCylinderUI = () => { if (!state.cylinderBackdrop) return; state.cylinderBackdrop.style.opacity = "0"; state.cylinderUI.style.transform = "scale(0.96)"; setTimeout(() => { if (state.cylinderBackdrop) state.cylinderBackdrop.remove(); state.cylinderUI = null; state.cylinderBackdrop = null; }, 180); };

/* ══════════════════════════════════════════════
   PLAYER INTEGRATION
══════════════════════════════════════════════ */
function onVideoReady(v) {
  if (state.video === v) return;
  state.video = v;
  initAudioCapture(state.video, state);
  if (state.customOverlay) state.customOverlay.remove();
  state.customOverlay = document.createElement("div");
  state.customOverlay.style.cssText = `position:fixed;bottom:9%;left:50%;transform:translateX(-50%);text-align:center;z-index:2147483647;pointer-events:none;width:auto;max-width:94vw;display:flex;flex-direction:column;align-items:center;gap:8px;`;
  document.body.appendChild(state.customOverlay);
  state.ghostOverlay = document.createElement("div");
  state.ghostOverlay.style.cssText = `position:fixed;bottom:9%;left:50%;transform:translateX(-50%);text-align:center;z-index:2147483644;pointer-events:none;color:rgba(255,255,255,0.4);display:none;`;
  document.body.appendChild(state.ghostOverlay);
  injectFloatingToggle(); updatePluginState();
  if (state.pendingCues) { setupSubtitleSystem(state.pendingCues); state.pendingCues = null; }
  const resume = () => { if (state.isEnabled && state.audioCtx?.state === "suspended") state.audioCtx.resume(); };
  ["seeked", "playing"].forEach((ev) => v.addEventListener(ev, resume, { signal: state.controller.signal }));
  v.addEventListener("playing", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  v.addEventListener("seeked", () => engine.scheduleCueRender(v.currentTime), { signal: state.controller.signal });
  startCuePolling();
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

createStatusBadge(state, handleShowUI);
installInterceptors((cues) => { state.lastFetchedCues = cues; if (state.video) setupSubtitleSystem(cues); else state.pendingCues = cues; });

state.videoPoller = setInterval(() => {
  const v = document.querySelector("video");
  if (v) {
      if (v !== state.video) onVideoReady(v);
      const toggle = document.getElementById("subsync-floating-toggle");
      if (toggle) toggle.style.display = "flex";
  } else {
      if (state.statusBadge) state.statusBadge.style.display = "none";
      if (state.customOverlay) state.customOverlay.style.display = "none";
      const toggle = document.getElementById("subsync-floating-toggle");
      if (toggle) toggle.style.display = "none";
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
  debug: () => ({ isEnabled: state.isEnabled, video: !!state.video, originalCues: state.originalCues.length, globalA: state.globalA, globalB: state.globalB, anchors: state.anchors.length, vadHistory: state.vadHistory.length })
};
