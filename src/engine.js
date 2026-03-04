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
      html = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
          <div style="
            font-size: 9px; 
            color: rgba(10, 132, 255, 0.8); 
            font-weight: 600; 
            text-transform: uppercase; 
            letter-spacing: 0.1em;
            font-family: -apple-system, system-ui, sans-serif;
          ">SubSync Active</div>
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

  /* ══════════════════════════════════════════════
     SMART SNAP ENGINE (Phase 2)
  ══════════════════════════════════════════════ */
  
  /**
   * Finds the best speech segment in history relative to a target time.
   * Prioritizes segments that just ended or are currently active.
   */
  findSnapSegment(targetTime) {
    if (!this.state.vadHistory.length) return null;
    
    // 1. Check if we are currently inside a speech segment
    const current = this.state.vadHistory.find(s => targetTime >= s.start && targetTime <= s.end);
    if (current) return current;

    // 2. Find the segment that ended most recently before targetTime
    // (User usually clicks right after hearing the start or end of a line)
    let best = null;
    let minDiff = 1/0;

    for (const seg of this.state.vadHistory) {
        // We look for segments that ended within 3 seconds of the click
        const diff = Math.abs(targetTime - seg.end);
        if (diff < 3 && diff < minDiff) {
            minDiff = diff;
            best = seg;
        }
    }
    
    return best;
  }

  /**
   * Automatically aligns a subtitle cue to the detected audio rhythm.
   */
  smartSnapCue(idx) {
    if (!this.state.originalCues[idx] || !this.state.video) return false;
    
    const targetTime = this.state.video.currentTime;
    const segment = this.findSnapSegment(targetTime);
    
    // If no clear audio segment is found in history, fallback to current time
    const audioAnchor = segment ? (segment.start + segment.end) / 2 : targetTime;
    const subCenter = (this.state.originalCues[idx].start + this.state.originalCues[idx].end) / 2;

    // Add as a user anchor
    this.state.anchors.push({
      subtitleIndex: idx,
      subtitleCenter: subCenter,
      audioTime: audioAnchor,
      confidence: segment ? 1.0 : 0.5,
      source: "user"
    });

    // Limit to 3 manual anchors to keep math stable and responsive
    if (this.state.anchors.length > 3) {
        this.state.anchors = this.state.anchors.filter(a => a.source !== 'user').concat(
            this.state.anchors.filter(a => a.source === 'user').slice(-3)
        );
    }

    this.applyMapping(this.state.anchors);
    return !!segment; // Returns true if it was a 'Smart Snap' to audio
  }
}
