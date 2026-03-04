import { escapeHtml, findCueIndexAt, findNextBoundary, detectFPS } from './utils.js';

export class SubtitleEngine {
  constructor(state) {
    this.state = state;
  }

  getNextCueBoundary(t) {
    return findNextBoundary(this.state.mappedCues, t);
  }

  renderMappedCues(t) {
    if (!this.state.customOverlay) return;
    
    const idx = findCueIndexAt(this.state.mappedCues, t);
    let html = "";
    
    if (idx !== -1) {
      // Issue: Liquid Glass Subtitle Styling
      // Pill-shaped glass backing behind active lines
      html = `
        <div style="
          background: rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-radius: 8px;
          padding: 4px 12px;
          color: #fff;
          font-size: min(3.2vw, 32px);
          line-height: 1.4;
          font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif;
          font-weight: 500;
          text-shadow: 0 0 8px #000, 1px 1px 3px #000;
          display: inline-block;
        ">
          ${escapeHtml(this.state.mappedCues[idx].text)}
        </div>
      `;
    }
    
    if (this.state.customOverlay.innerHTML !== html) {
      this.state.customOverlay.innerHTML = html;
    }
  }

  scheduleCueRender(t) {
    clearTimeout(this.state.nextCueTimeout);
    if (!this.state.video || this.state.video.paused || !this.state.mappedCues.length) return;

    this.renderMappedCues(t);

    const next = this.getNextCueBoundary(t);
    if (next === null) return;

    const delay = Math.max(0, (next - this.state.video.currentTime) * 1000);
    this.state.nextCueTimeout = setTimeout(() => {
      if (this.state.video && !this.state.video.paused) {
        this.renderMappedCues(this.state.video.currentTime);
        this.scheduleCueRender(this.state.video.currentTime);
      }
    }, delay + 16);
  }

  computeSubtitleGapSequence(cues) {
    const g = [];
    for (let i = 1; i < cues.length; i++) {
      g.push(cues[i].start - cues[i - 1].end);
    }
    return g;
  }

  applyFPSNormalization(cues) {
    const ratio = detectFPS(cues);
    if (ratio === 1.0) return cues;
    return cues.map(c => ({
      ...c,
      start: c.start * ratio,
      end: c.end * ratio
    }));
  }

  rebuildMappedCues() {
    this.state.mappedCues = this.state.originalCues.map((cue) => {
      let ms = this.state.globalA * cue.start + this.state.globalB;
      let me = this.state.globalA * cue.end + this.state.globalB;
      return { ...cue, start: ms, end: me };
    });
  }

  applyMapping(newAnchors) {
    if (!newAnchors || newAnchors.length === 0) return;

    if (newAnchors.length === 1) {
      this.state.globalB =
        newAnchors[0].audioTime - newAnchors[0].subtitleCenter;
      this.state.globalA = 1.0;
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
      this.state.globalA = Math.max(
        0.85,
        Math.min(1.15, denom !== 0 ? (n * sxy - sx * sy) / denom : 1)
      );
      this.state.globalB = (sy - this.state.globalA * sx) / n;
    }

    this.rebuildMappedCues();
    if (this.state.video) this.scheduleCueRender(this.state.video.currentTime);
  }
}
