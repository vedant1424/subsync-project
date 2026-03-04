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
