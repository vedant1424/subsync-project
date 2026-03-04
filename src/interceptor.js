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
          const looksLikeSub = /\.(srt|vtt|ass|ssa)(\?|$)/i.test(url) || 
                               ct.includes("text/vtt") || 
                               ct.includes("text/plain");
          if (looksLikeSub) {
            const text = await res.clone().text();
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
          if (/\.(srt|vtt|ass|ssa)(\?|$)/i.test(this._subsync_url || "")) {
            const cues = parseSRT(this.responseText) || parseVTT(this.responseText);
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
