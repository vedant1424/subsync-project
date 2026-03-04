import { formatTime, escapeHtml } from './utils.js';

export function createStatusBadge(state, onShowUI) {
  if (state.statusBadge) state.statusBadge.remove();
  state.statusBadge = document.createElement("div");
  state.statusBadge.id = "subsync-badge";
  state.statusBadge.style.cssText = [
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
  state.statusBadge.textContent = "SubSync: starting...";
  state.statusBadge.title = "Click to open SubSync (or press ` backtick / Alt+S)";
  document.body.appendChild(state.statusBadge);

  state.statusBadge.addEventListener("click", () => {
    if (state.originalCues.length) {
      onShowUI();
    } else {
      updateStatus(state, "SubSync: subtitles not detected yet");
    }
  });
}

export function updateStatus(state, msg) {
  if (!state.statusBadge) return;
  state.statusBadge.textContent = msg;
  state.statusBadge.style.opacity = "1";
  clearTimeout(state.badgeDimTimer);
  state.badgeDimTimer = setTimeout(() => {
    if (state.statusBadge) state.statusBadge.style.opacity = "0.4";
  }, 5000);
}

export function showCylinderUI(state, engine, onSetAnchor, onUndo, onHideUI) {
  if (state.cylinderUI) return;

  const t = state.video?.currentTime || 0;
  let nearestIdx = 0;
  let minD = Infinity;

  state.originalCues.forEach((c, i) => {
    const d = Math.abs((c.start + c.end) / 2 - t);
    if (d < minD) {
      minD = d;
      nearestIdx = i;
    }
  });
  state.selectedCueIndex = nearestIdx;

  const offMs = Math.round(state.globalB * 1000);
  const sign = offMs >= 0 ? "+" : "";

  state.cylinderBackdrop = document.createElement("div");
  state.cylinderBackdrop.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:2147483648;display:flex;align-items:center;justify-content:center;";

  state.cylinderUI = document.createElement("div");
  state.cylinderUI.style.cssText = [
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

  state.cylinderUI.innerHTML = `
    <div style="text-align:center;padding-bottom:10px;border-bottom:1px solid #162b1e;">
      <div style="font-size:15px;font-weight:bold;color:#3f3;letter-spacing:2px;">⟳ SUBTITLE CORRECTOR</div>
      <div style="font-size:11px;color:#3a5940;margin-top:5px;">
        Offset <span style="color:#3f3">${sign}${offMs}ms</span>
        &nbsp;·&nbsp; Scale <span style="color:#3f3">${state.globalA.toFixed(4)}</span>
        &nbsp;·&nbsp; Manual anchors <span style="color:#3f3">${state.anchors.filter((a) => a.source === "user").length}</span>
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
      <input type="checkbox" id="scp-drift" ${state.driftEnabled ? "checked" : ""} style="accent-color:#0a5;width:13px;height:13px;">
      Continuous auto-drift correction (uses audio fingerprinting)
    </label>
  `;

  state.cylinderBackdrop.appendChild(state.cylinderUI);
  document.body.appendChild(state.cylinderBackdrop);

  const scroll = state.cylinderUI.querySelector("#scp-scroll");
  state.originalCues.forEach((cue, i) => {
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
      `background:${sel ? "rgba(0,140,70,0.15)" : "rgba(255,255,255,0.02)"}`
    ].join(";");
    el.innerHTML =
      `<span style="color:#2a4a30;font-size:10px;">${formatTime(cue.start)}</span>&nbsp;` +
      `<span style="color:${sel ? "#afa" : "#bbb"}">${escapeHtml(cue.text.substring(0, 95))}</span>`;

    el.addEventListener("click", () => {
      scroll.querySelectorAll("[data-idx]").forEach((x) => {
        x.style.border = "1px solid #162b1e";
        x.style.background = "rgba(255,255,255,0.02)";
        x.querySelector("span:last-child").style.color = "#bbb";
      });
      el.style.border = "1px solid #0a5";
      el.style.background = "rgba(0,140,70,0.15)";
      el.querySelector("span:last-child").style.color = "#afa";
      state.selectedCueIndex = parseInt(el.dataset.idx, 10);
    });

    scroll.appendChild(el);
    if (sel) {
      setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    }
  });

  state.cylinderUI.querySelector("#scp-set").onclick = () => onSetAnchor(state.selectedCueIndex);
  state.cylinderUI.querySelector("#scp-close").onclick = onHideUI;
  state.cylinderUI.querySelector("#scp-undo").onclick = onUndo;
  state.cylinderUI.querySelector("#scp-drift").onchange = (e) => {
    state.driftEnabled = e.target.checked;
    updateStatus(state, state.driftEnabled ? "Auto-drift: ON" : "Auto-drift: OFF");
  };

  ["wheel", "keydown", "mousedown", "touchstart"].forEach((ev) =>
    state.cylinderBackdrop.addEventListener(ev, (e) => {
      e.stopImmediatePropagation();
      if (ev === "keydown" && e.key === "Escape") onHideUI();
    }, { capture: true })
  );

  state.cylinderBackdrop.addEventListener("click", (e) => {
    if (e.target === state.cylinderBackdrop) onHideUI();
  });
}
