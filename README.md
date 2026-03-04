# ⟳ SubSync (SubtitleCorrector) v3.2

**SubSync** is a high-performance, real-time subtitle synchronization plugin for **Stremio Enhanced**. It combines manual "anchor-based" correction with advanced audio fingerprinting (VAD/DTW) to solve drift and offset issues in seconds.

---

## 🚀 What is SubSync?

Most subtitle sync tools only allow for a static offset (e.g., +2 seconds). **SubSync** is different. It recognizes that subtitles often drift over time due to FPS mismatches (23.976 vs 25 FPS) or different video edits (Director's Cut vs. Theatrical).

### Key Features:
*   **Cylinder UI**: A custom scrollable interface to pick the exact line you are hearing.
*   **Anchor System**: Set one anchor to fix offset; set two or more to automatically calculate and fix **linear drift** (scale).
*   **Auto-Drift Correction**: Uses a Web Worker to analyze audio PCM data and match it against subtitle gaps using **Dynamic Time Warping (DTW)**.
*   **Persistence**: Your sync settings are saved to `localStorage` per video. If you reload the page, your sync is restored.
*   **High Performance**: Uses binary search for cue lookups and throttled workers to ensure zero impact on video playback.

---

## 🛠 Installation

1.  **Build the plugin**:
    ```bash
    npm run build
    ```
2.  **Locate the output**: Copy `dist/subtitle.plugin.js`.
3.  **Install in Stremio**:
    *   Navigate to your Stremio Enhanced plugins folder:
        `~/Library/Application Support/stremio-enhanced/plugins/`
    *   Paste `subtitle.plugin.js` there.
4.  **Enable**: Restart Stremio Enhanced and enable the plugin in **Settings → Plugins**.

---

## 🎮 How to Use

### 1. The Manual "Anchor" Method (Recommended)
This is the fastest way to get perfect sync:
1.  Play a video and load subtitles.
2.  Wait for a line of dialogue. When you **hear** it, press **backtick (`)** or **Alt+S**.
3.  In the Cylinder UI, find the line you just heard.
4.  Click it (it turns green) and press **Set Anchor**.
5.  *Optional*: If the sync drifts later in the movie, set a second anchor. The plugin will calculate the perfect "Scale" (FPS) to fix the entire video.

### 2. Auto-Drift Correction
1.  Open the UI (backtick key).
2.  Toggle **"Continuous auto-drift correction"** at the bottom.
3.  The plugin will now "listen" to the audio gaps and attempt to align the subtitles automatically.
4.  Watch the green badge in the top-right; it will show `Auto ✓` when a match is found.

---

## ⌨️ Keyboard Shortcuts
| Key | Action |
|---|---|
| `` ` `` (Backtick) | Open / Close Cylinder UI |
| `Alt + S` | Alternative UI Shortcut |
| `Arrow Up / Down` | Navigate cues in UI |
| `Enter` | Set Anchor for selected cue |
| `Escape` | Close UI |

---

## 🧠 Technical Deep Dive

### The Math
SubSync uses **Linear Regression** on your anchors. 
*   `AudioTime = GlobalA * SubtitleTime + GlobalB`
*   `GlobalA` is the **Scale** (fixes drift/FPS).
*   `GlobalB` is the **Offset** (fixes delay).

### Audio Analysis
The plugin uses a `WebWorker` to avoid freezing the UI.
1.  **VAD (Voice Activity Detection)**: Detects when people are speaking.
2.  **Gap Analysis**: Measures the "silence duration" between spoken segments.
3.  **DTW (Dynamic Time Warping)**: Compares the audio silence pattern against the subtitle gap pattern to find the best mathematical fit.

---

## 👨‍💻 Developer Guide

### Project Structure
*   `src/main.js`: Orchestration, state management, and event listeners.
*   `src/engine.js`: The "brain" — handles math, scaling, and cue rendering.
*   `src/ui.js`: Custom DOM rendering for the Cylinder UI and Badge.
*   `src/audio.js`: AudioContext management and WebWorker integration.
*   `src/utils.js`: Binary search, parsers, and string helpers.

### Build Commands
*   **Production Build**: `npm run build` (Minified, optimized).
*   **Development**: `npm run dev` (Watches for changes and rebuilds automatically).

### Debugging
Open the browser console and type:
*   `subtitleCorrector.debug()`: Shows current state, anchors, and offsets.
*   `subtitleCorrector.testAudio()`: Verifies if the plugin can "hear" the video.
*   `subtitleCorrector.setOffset(ms)`: Manually nudge the offset (e.g., `setOffset(-500)`).
