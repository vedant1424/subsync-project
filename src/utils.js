export function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function hashCues(cues) {
  if (!cues || !cues.length) return "";
  const first = cues[0];
  const last = cues[cues.length - 1];
  const mid = cues[Math.floor(cues.length / 2)];
  return `${cues.length}_${first.start}_${mid.text.slice(0, 10)}_${last.end}`;
}

export function validateCues(arr) {
  return arr.filter(
    (c) =>
      typeof c.start === "number" &&
      typeof c.end === "number" &&
      typeof c.text === "string" &&
      c.start < c.end &&
      c.text.trim().length > 0
  );
}

/**
 * Binary search to find the index of the cue active at time T
 * Returns -1 if no cue is active.
 */
export function findCueIndexAt(cues, t) {
  let low = 0, high = cues.length - 1;
  while (low <= high) {
    let mid = (low + high) >>> 1;
    let c = cues[mid];
    if (t >= c.start && t < c.end) return mid;
    if (t < c.start) high = mid - 1;
    else low = mid + 1;
  }
  return -1;
}

/**
 * Binary search to find the index of the NEXT cue boundary (start or end)
 */
export function findNextBoundary(cues, t) {
  let low = 0, high = cues.length - 1;
  let best = null;

  while (low <= high) {
    let mid = (low + high) >>> 1;
    let c = cues[mid];
    
    // Check if we are inside this cue
    if (t >= c.start && t < c.end) return c.end;
    
    if (c.start > t) {
      best = c.start;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return best;
}

export function detectFPS(cues) {
  if (cues.length < 50) return 1.0;
  const diffs = [];
  for (let i = 1; i < Math.min(100, cues.length); i++) {
    const d = cues[i].start - cues[i-1].end;
    if (d > 0.01 && d < 5) diffs.push(d);
  }
  if (!diffs.length) return 1.0;
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  // If drift suggests 23.976 vs 25 mismatch (approx 4% diff)
  // This is a placeholder for actual pattern matching logic
  return 1.0; 
}

export function parseSRTTime(t) {
  const p = t.replace(",", ".").split(":");
  return (
    parseFloat(p[0]) * 3600 +
    parseFloat(p[1]) * 60 +
    parseFloat(p[2])
  );
}

export function parseSRT(text) {
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

export function parseVTT(text) {
  if (!text || !text.trim().startsWith("WEBVTT")) return null;
  return parseSRT(
    text.replace(/^WEBVTT[^\n]*\n/, "")
  );
}
