import { parseSRT, parseVTT } from './utils.js';

export function installInterceptors(onCuesFound) {
  try {
    const _fetch = window.fetch;
    if (typeof _fetch === "function") {
      window.fetch = async function (...args) {
        const res = await _fetch.apply(this, args);
        try {
          const url = (typeof args[0] === "string" ? args[0] : args[0]?.url) || "";
          const ct = res.headers?.get?.("content-type") || "";
          
          // Issue 12: Better detection
          const looksLikeSub = /\.(srt|vtt|ass|ssa)(\?|$)/i.test(url) || 
                               ct.includes("text/vtt");
          
          if (looksLikeSub || ct.includes("text/plain")) {
            const text = await res.clone().text();
            
            // Validate content if it's text/plain (Issue 12)
            if (ct.includes("text/plain") && !text.includes("-->") && !text.startsWith("WEBVTT")) {
                return res; 
            }

            const cues = parseSRT(text) || parseVTT(text);
            if (cues && cues.length > 5) {
              onCuesFound(cues, url);
            }
          }
        } catch (_) {}
        return res;
      };
    }

    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (m, url, ...rest) {
      this._subsync_url = String(url || "");
      return _open.call(this, m, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...a) {
      this.addEventListener("load", function () {
        try {
          const ct = this.getResponseHeader("content-type") || "";
          if (/\.(srt|vtt|ass|ssa)(\?|$)/i.test(this._subsync_url || "") || ct.includes("text/vtt") || ct.includes("text/plain")) {
            const text = this.responseText;
            if (ct.includes("text/plain") && !text.includes("-->") && !text.startsWith("WEBVTT")) {
                return;
            }
            const cues = parseSRT(text) || parseVTT(text);
            if (cues && cues.length > 5) {
              onCuesFound(cues, this._subsync_url);
            }
          }
        } catch (_) {}
      });
      return _send.apply(this, a);
    };
  } catch (e) {
    console.warn("[SubSync] interceptor failed:", e);
  }
}
