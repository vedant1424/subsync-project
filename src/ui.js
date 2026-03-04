import { formatTime, escapeHtml, findCueIndexAt } from './utils.js';

const COLORS = {
  accent: "#0A84FF",
  textPrimary: "rgba(255, 255, 255, 0.95)",
  textSecondary: "rgba(255, 255, 255, 0.5)",
  glassBase: "rgba(255, 255, 255, 0.12)",
  glassBorder: "rgba(255, 255, 255, 0.25)",
  sheetBackground: "rgba(28, 28, 30, 0.75)"
};

const FONTS = {
  system: '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif',
  mono: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace'
};

const GLASS_STYLE = `
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid ${COLORS.glassBorder};
  box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.3);
`;

export function createStatusBadge(state, onShowUI) {
  if (state.statusBadge) state.statusBadge.remove();
  state.statusBadge = document.createElement("div");
  state.statusBadge.id = "subsync-badge";
  state.statusBadge.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    padding: 6px 14px;
    border-radius: 100px;
    font-family: ${FONTS.system};
    font-size: 12px;
    color: ${COLORS.textPrimary};
    z-index: 2147483646;
    cursor: pointer;
    transition: opacity 0.4s ease, transform 0.2s ease;
    display: flex;
    align-items: center;
    gap: 8px;
    ${GLASS_STYLE}
  `;
  
  const dot = document.createElement("span");
  dot.id = "subsync-dot";
  dot.style.cssText = `
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255,255,255,0.3);
    transition: background 0.3s ease;
  `;
  
  const text = document.createElement("span");
  text.textContent = "SubSync";
  
  state.statusBadge.appendChild(dot);
  state.statusBadge.appendChild(text);
  document.body.appendChild(state.statusBadge);

  state.statusBadge.addEventListener("click", () => {
    if (state.originalCues.length) onShowUI();
    else updateStatus(state, "No subtitles detected");
  });

  state.statusBadge.addEventListener("mouseenter", () => {
    state.statusBadge.style.opacity = "1";
    state.statusBadge.style.transform = "translateY(-1px)";
    clearTimeout(state.badgeDimTimer);
  });
  state.statusBadge.addEventListener("mouseleave", () => {
    state.statusBadge.style.transform = "translateY(0)";
    state.badgeDimTimer = setTimeout(() => {
      state.statusBadge.style.opacity = "0.7";
    }, 2000);
  });
}

export function updateStatus(state, msg) {
  if (!state.statusBadge) return;
  const text = state.statusBadge.querySelector("span:last-child");
  const dot = state.statusBadge.querySelector("#subsync-dot");
  
  text.textContent = msg;
  state.statusBadge.style.opacity = "1";
  dot.style.background = COLORS.accent;
  
  clearTimeout(state.badgeDimTimer);
  state.badgeDimTimer = setTimeout(() => {
    if (state.statusBadge) {
      state.statusBadge.style.opacity = "0.7";
      dot.style.background = "rgba(255,255,255,0.3)";
    }
  }, 5000);
}

export function showGhostPreview(state) {
  if (!state.ghostOverlay || !state.video || !state.originalCues[state.selectedCueIndex]) {
    if (state.ghostOverlay) state.ghostOverlay.style.display = "none";
    return;
  }

  const idx = state.selectedCueIndex;
  const cues = state.mappedCues.length ? state.mappedCues : state.originalCues;

  // Issue 9: Predict where CURRENT audio time is relative to selected cue
  // This helps user see "if I set anchor here, what will show up"
  // We use the current mapping (cues) to ensure drift/scale is accounted for
  const predOffset =
    state.video.currentTime -
    (cues[idx].start + cues[idx].end) / 2;

  const active = cues.filter(
    (c) =>
      c.start + predOffset <= state.video.currentTime &&
      c.end + predOffset > state.video.currentTime
  );

  state.ghostOverlay.innerHTML = active
    .map((c) => `<div>${escapeHtml(c.text)}</div>`)
    .join("");
    
  state.ghostOverlay.style.cssText += `
    display: ${active.length ? "block" : "none"};
    color: rgba(255, 255, 255, 0.4);
    font-family: ${FONTS.system};
  `;
}

export function showCylinderUI(state, engine, onSetAnchor, onUndo, onHideUI) {
  if (state.cylinderUI) return;

  const t = state.video?.currentTime || 0;
  let nearestIdx = findCueIndexAt(state.originalCues, t);
  if (nearestIdx === -1) {
    let minD = Infinity;
    state.originalCues.forEach((c, i) => {
      const d = Math.abs((c.start + c.end) / 2 - t);
      if (d < minD) { minD = d; nearestIdx = i; }
    });
  }
  state.selectedCueIndex = nearestIdx;

  const offMs = Math.round(state.globalB * 1000);
  const sign = offMs >= 0 ? "+" : "";

  state.cylinderBackdrop = document.createElement("div");
  state.cylinderBackdrop.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    z-index: 2147483648;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.28s ease;
  `;

  state.cylinderUI = document.createElement("div");
  state.cylinderUI.style.cssText = `
    background: ${COLORS.sheetBackground};
    backdrop-filter: blur(60px) saturate(200%);
    -webkit-backdrop-filter: blur(60px) saturate(200%);
    border-radius: 20px;
    width: 480px;
    max-width: 92vw;
    padding: 24px;
    color: ${COLORS.textPrimary};
    display: flex;
    flex-direction: column;
    gap: 16px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.2);
    font-family: ${FONTS.system};
    transform: scale(0.96);
    transition: transform 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  `;

  state.cylinderUI.innerHTML = `
    <div style="text-align: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 16px;">
      <div style="font-size: 15px; font-weight: 600; color: ${COLORS.textPrimary}; letter-spacing: 0.02em;">Subtitle Sync</div>
      <div style="font-size: 12px; color: ${COLORS.textSecondary}; margin-top: 6px;">
        Offset <span style="color:rgba(255,255,255,0.75)">${sign}${offMs}ms</span>
        &nbsp;·&nbsp; Scale <span style="color:rgba(255,255,255,0.75)">${state.globalA.toFixed(4)}</span>
        &nbsp;·&nbsp; Anchors <span style="color:rgba(255,255,255,0.75)">${state.anchors.filter(a => a.source === "user").length}</span>
      </div>
    </div>
    
    <div style="font-size: 12px; color: ${COLORS.textSecondary}; text-align: center; line-height: 1.7;">
      Find the subtitle line you can <span style="color: rgba(255,255,255,0.75); font-weight: 500;">currently hear</span>.<br>
      Click to select, then press Set Anchor.
    </div>

    <div id="scp-scroll" style="flex: 1; overflow-y: auto; max-height: 340px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; scroll-snap-type: y mandatory; scrollbar-width: none;"></div>

    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px;">
      <button id="scp-set" style="padding: 12px; background: rgba(10, 132, 255, 0.85); border: 1px solid ${COLORS.accent}; border-radius: 12px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; box-shadow: 0 4px 16px rgba(10, 132, 255, 0.35);">Set Anchor</button>
      <button id="scp-undo" style="padding: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: rgba(255,255,255,0.6); font-size: 13px; cursor: pointer; transition: all 0.15s ease;">Undo</button>
      <button id="scp-close" style="padding: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: rgba(255,255,255,0.6); font-size: 13px; cursor: pointer; transition: all 0.15s ease;">Close</button>
    </div>

    <div id="scp-drift-row" style="display: flex; align-items: center; justify-content: center; gap: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); cursor: pointer;">
      <div id="scp-toggle" style="width: 32px; height: 20px; border-radius: 100px; background: ${state.driftEnabled ? COLORS.accent : "rgba(255,255,255,0.15)"}; position: relative; transition: background 0.2s ease;">
        <div id="scp-thumb" style="width: 16px; height: 16px; border-radius: 50%; background: white; position: absolute; top: 2px; left: 2px; transition: transform 0.2s ease; transform: translateX(${state.driftEnabled ? "12px" : "0px"}); box-shadow: 0 1px 4px rgba(0,0,0,0.3);"></div>
      </div>
      <span style="font-size: 12px; color: ${COLORS.textSecondary};">Auto-drift correction</span>
    </div>
  `;

  state.cylinderBackdrop.appendChild(state.cylinderUI);
  document.body.appendChild(state.cylinderBackdrop);

  const scroll = state.cylinderUI.querySelector("#scp-scroll");
  
  const updateSelectionUI = (newIdx) => {
    state.selectedCueIndex = newIdx;
    scroll.querySelectorAll("[data-idx]").forEach((x) => {
      const isSel = parseInt(x.dataset.idx, 10) === newIdx;
      x.style.background = isSel ? "rgba(10, 132, 255, 0.18)" : "transparent";
      x.style.border = isSel ? "1px solid rgba(10, 132, 255, 0.4)" : "none";
      x.querySelector(".scp-ts").style.color = isSel ? "rgba(10, 132, 255, 0.7)" : "rgba(255,255,255,0.3)";
      x.querySelector(".scp-txt").style.color = isSel ? COLORS.textPrimary : "rgba(255,255,255,0.6)";
      if (isSel) x.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    showGhostPreview(state);
  };

  state.originalCues.forEach((cue, i) => {
    const el = document.createElement("div");
    el.dataset.idx = String(i);
    el.className = "scp-row";
    el.style.cssText = "padding: 10px 14px; border-radius: 10px; cursor: pointer; transition: background 0.15s ease; scroll-snap-align: start;";
    el.innerHTML = `
      <div class="scp-ts" style="font-family: ${FONTS.mono}; font-size: 10px; margin-bottom: 2px;">${formatTime(cue.start)}</div>
      <div class="scp-txt" style="font-size: 12px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(cue.text.substring(0, 90))}</div>
    `;
    el.addEventListener("click", () => updateSelectionUI(i));
    el.addEventListener("mouseenter", () => {
        if (state.selectedCueIndex !== i) el.style.background = "rgba(255,255,255,0.06)";
    });
    el.addEventListener("mouseleave", () => {
        if (state.selectedCueIndex !== i) el.style.background = "transparent";
    });
    scroll.appendChild(el);
  });

  updateSelectionUI(state.selectedCueIndex);

  // Animations
  requestAnimationFrame(() => {
    state.cylinderBackdrop.style.opacity = "1";
    state.cylinderUI.style.transform = "scale(1)";
  });

  // Controls
  const setupBtn = (id, action) => {
      const btn = state.cylinderUI.querySelector(`#${id}`);
      btn.onmousedown = () => btn.style.transform = "scale(0.97)";
      btn.onmouseup = () => btn.style.transform = "scale(1)";
      btn.onclick = action;
  };

  setupBtn("scp-set", () => onSetAnchor(state.selectedCueIndex));
  setupBtn("scp-undo", onUndo);
  setupBtn("scp-close", onHideUI);

  // Toggle switch logic
  state.cylinderUI.querySelector("#scp-drift-row").onclick = () => {
      state.driftEnabled = !state.driftEnabled;
      const track = state.cylinderUI.querySelector("#scp-toggle");
      const thumb = state.cylinderUI.querySelector("#scp-thumb");
      track.style.background = state.driftEnabled ? COLORS.accent : "rgba(255,255,255,0.15)";
      thumb.style.transform = `translateX(${state.driftEnabled ? "12px" : "0px"})`;
      updateStatus(state, state.driftEnabled ? "Auto-drift: ON" : "Auto-drift: OFF");
  };

  // Keyboard
  const handleKey = (e) => {
    if (e.key === "Escape") onHideUI();
    if (e.key === "ArrowDown") { e.preventDefault(); updateSelectionUI(Math.min(state.originalCues.length - 1, state.selectedCueIndex + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); updateSelectionUI(Math.max(0, state.selectedCueIndex - 1)); }
    if (e.key === "Enter") { e.preventDefault(); onSetAnchor(state.selectedCueIndex); }
  };

  ["wheel", "keydown", "mousedown", "touchstart"].forEach((ev) =>
    state.cylinderBackdrop.addEventListener(ev, (e) => {
      if (ev === "keydown") handleKey(e);
      if (e.target === state.cylinderBackdrop && ev === "mousedown") onHideUI();
      e.stopImmediatePropagation();
    }, { capture: true })
  );

  if (state.video) {
    const syncToTime = () => {
      if (!state.cylinderUI) return;
      const nearest = findCueIndexAt(state.originalCues, state.video.currentTime);
      if (nearest !== -1 && nearest !== state.selectedCueIndex) updateSelectionUI(nearest);
    };
    state.video.addEventListener("timeupdate", syncToTime, { signal: state.controller.signal });
  }
}
