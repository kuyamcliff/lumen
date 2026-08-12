# Lumen

**Beautiful. Simple. Unbreakable. Lightweight.**

Lumen is a web-first, framework-agnostic video player built as a native
Web Component. Drop in one tag, get HLS + progressive MP4/WebM playback, a
premium default UI, deep subtitle customization, and a clean TypeScript API
— with a core bundle under **17 kB gzipped**.

```html
<script type="module" src="https://unpkg.com/@lumen/player/dist/lumen.js"></script>
<lumen-player src="https://example.com/video.m3u8" poster="poster.jpg"></lumen-player>
```

Or from npm:

```bash
npm install @lumen/player
```

```js
import "@lumen/player";
```

```html
<lumen-player id="player" src="video.mp4"></lumen-player>
<script type="module">
  const player = document.getElementById("player");
  player.on("play", () => console.log("playing"));
</script>
```

## Why Lumen

- **Tiny core.** ~16.5 kB gzipped with zero required runtime dependencies.
  HLS support (`hls.js`) and the resilient-MP4 fallback (`mp4box`) are
  optional, lazily-loaded layers — pages that don't need them never pay for
  them.
- **Beautiful by default.** A dark-first, premium control surface that needs
  zero configuration, plus a light theme and full CSS custom-property
  theming for everything else.
- **Resilient.** Network blips and partial/incomplete files trigger
  automatic, backed-off recovery instead of a dead black box with a cryptic
  browser error.
- **Real subtitle support.** Auto-detected tracks, a styling panel (size,
  color, background, edge, position, timing offset), and persisted user
  preferences — rendered through Lumen's own overlay so styling isn't at
  the mercy of the browser's native caption box.
- **A real Web Component.** Works from plain HTML/JS, and in React, Vue,
  Svelte, or anything else, without a wrapper.

## Features

| Area | Status |
| --- | --- |
| Native progressive MP4/WebM/Ogg playback | ✅ |
| HLS (VOD + live) via `hls.js`, with native fallback on Safari/iOS | ✅ |
| Automatic + manual quality selection | ✅ |
| Playback rate control (0.25×–2×) | ✅ |
| Keyboard shortcuts, full a11y (ARIA, focus rings, screen-reader status) | ✅ |
| Picture-in-Picture, fullscreen, double-click-to-fullscreen | ✅ |
| Auto-detected subtitles/captions, styling panel, persisted prefs | ✅ |
| Scrub-bar preview (time tooltip; thumbnail sprite via WebVTT if provided) | ✅ |
| CSS custom-property theming, dark/light/system themes | ✅ |
| Network/decode error recovery with backoff, calm error UI | ✅ (see [Resilience](#resilience)) |
| Best-effort playback of truncated/corrupt progressive MP4s via `mp4box.js` + MSE | ✅ (see [Resilience](#resilience)) |
| Chapters, playlists, multi-audio-track, casting | 🚧 not yet — tracked as v1.x |
| DASH, DRM, ads | ⬜ intentionally out of scope for the MIT core (future optional modules) |

## Quick start

```html
<lumen-player
  src="https://example.com/video.m3u8"
  poster="https://example.com/poster.jpg"
  theme="dark"
>
  <track kind="subtitles" src="en.vtt" srclang="en" label="English" default />
</lumen-player>
```

Multiple sources (Lumen picks the best one; an explicit HLS source wins if
the browser can play it):

```html
<lumen-player>
  <source src="video.m3u8" data-lumen-type="hls" />
  <source src="video.mp4" data-lumen-type="mp4" />
</lumen-player>
```

See `examples/` for runnable pages: `basic.html`, `hls.html`,
`subtitles.html`, `theming.html`, `resilience.html`. Run `npm run dev` and
open them from the printed local URL.

> `resilience.html` needs a real H.264/AAC-capable browser (regular Chrome,
> Edge, Firefox, Safari). Minimal open-source Chromium builds — including
> the one Playwright downloads by default — ship without licensed H.264/AAC
> decoders, so `MediaSource.isTypeSupported()` correctly reports the codec
> as unsupported there and the demo falls through to the calm error UI
> instead of playing. That's the codec check working as intended, not a bug
> in the fallback itself — see `test/ResilientMp4Engine.pipeline.test.ts`,
> which exercises the real mp4box.js segmentation pipeline end-to-end
> against a fake `MediaSource` to verify that independently of codec
> support.

## JavaScript API

```ts
const player = document.querySelector("lumen-player");

// Playback
player.play();
player.pause();
player.seek(30);
player.currentTime = 30;
player.volume = 0.5;
player.muted = true;
player.playbackRate = 1.5;

// Loading
await player.load({ src: "https://example.com/video.m3u8" });
await player.load([{ src: "a.m3u8" }, { src: "b.mp4" }]);

// Quality (HLS)
player.qualityLevels;      // LumenQualityLevel[]
player.currentQuality;     // LumenQualityLevel | null
player.setQuality("auto"); // or a level id

// Subtitles
player.textTracks;                       // TextTrack[]
player.addTextTrack({ src: "fr.vtt", label: "Français", srclang: "fr" });
player.setSubtitlePrefs({ fontSize: 1.3, edge: "outline", offsetSeconds: 0.5 });

// Events
const off = player.on("timeupdate", ({ currentTime, duration }) => { /* ... */ });
player.once("ready", () => console.log("mounted"));
off();

// Fullscreen / PiP
player.requestFullscreen();
player.requestPictureInPicture();

player.destroy(); // tear down engine + listeners
```

### Events

`play`, `pause`, `ended`, `timeupdate`, `progress`, `volumechange`,
`ratechange`, `waiting`, `playing`, `canplay`, `seeking`, `seeked`, `error`,
`qualitychange`, `qualitieschange`, `texttrackchange`, `enterfullscreen`,
`exitfullscreen`, `enterpip`, `leavepip`, `loadedmetadata`, `ready`,
`destroy`. Full payload types are in `src/types.ts`.

### Attributes

`src`, `poster`, `autoplay`, `loop`, `muted`, `crossorigin`, `preload`,
`theme` (`dark` | `light` | `system`), `aspect-ratio` (e.g. `16/9`),
`object-fit` (e.g. `contain` | `cover`), `thumbnails` (URL to a WebVTT
sprite sheet, the format used by Mux/Bunny/Vimeo-style scrub previews).

## Theming

Every visual token is a CSS custom property with a self-referencing
fallback (`var(--lumen-color-accent, #eab54c)`), so you can override any of
them from page-level CSS without piercing the shadow root:

```css
lumen-player {
  --lumen-color-accent: #7c5cff;
  --lumen-radius: 20px;
  --lumen-font-family: "Georgia", serif;
}
```

`theme="light"` and `theme="system"` (follows `prefers-color-scheme`) are
built in. See `examples/theming.html` and `src/styles/player.css` for the
full token list.

## CORS & Range requests (R2, B2, Bunny, self-hosted)

Progressive "watch while downloading" and seeking both rely on HTTP Range
requests, and cross-origin playback needs CORS headers. Make sure your
origin serves:

- `Access-Control-Allow-Origin` (and `Access-Control-Allow-Methods: GET,
  HEAD, OPTIONS`) for any origin the player is embedded on.
- `Accept-Ranges: bytes` and honors `Range` request headers with `206
  Partial Content` responses.
- `Access-Control-Expose-Headers: Content-Length, Content-Range,
  Accept-Ranges` so the browser's media pipeline can read them.

Cloudflare R2, Backblaze B2, and Bunny Storage/Stream all support this —
enable CORS on the bucket/pull zone and Range requests come for free from
the underlying object storage. If you set `crossorigin`, the player mirrors
it onto the underlying `<video>` element (needed for canvas/WebGL post-
processing or reading `TextTrack` cues cross-origin). The `mp4box.js`
resilience fallback (see below) fetches the file itself via `fetch()`, so
it needs the same CORS headers — no extra configuration beyond the above.

## Resilience

Two layers, applied in order, before Lumen ever shows an error:

1. **Retry/backoff.** Native `<video>` and `hls.js` error events are
   intercepted: transient network errors reconnect automatically, decode
   errors trigger a reload-in-place at the same `currentTime`, with a
   short backoff between attempts (500ms/1.5s/4s). This alone handles most
   real-world blips — flaky wifi, a CDN hiccup, a mid-download server
   restart.

2. **`mp4box.js` + MSE fallback (progressive MP4 only).** If retries are
   exhausted (or the browser rejects the file outright as
   `SRC_NOT_SUPPORTED` — common when a `moov` atom is missing or truncated
   because an upload was interrupted), Lumen makes one more attempt: it
   streams the file itself via `fetch()`, feeds the bytes into
   `mp4box.js` incrementally as they arrive, remuxes them into fragmented
   MP4 segments, and appends those directly to a `MediaSource`
   `SourceBuffer` — bypassing the browser's own (stricter) built-in MP4
   parser entirely. Because mp4box.js processes boxes as they arrive, a
   file that's truncated or has a broken tail still plays everything
   before the break, instead of refusing to play at all.

   This is a genuine, working fallback, not a stub — but it's honestly
   scoped: MP4 only (mp4box.js doesn't handle WebM/Ogg), audio+video are
   muxed into a single combined `SourceBuffer`, and seeking is clamped to
   whatever's already buffered (arbitrary random-access seeking into
   unbuffered regions would require re-fetching with a `Range` request at
   a byte offset mp4box.js hasn't parsed yet — out of scope for this
   pass). It also needs `mp4box` present the same way `hls.js` is: `npm
   install mp4box` for bundler consumers, or `window.MP4Box` set manually
   for plain-script-tag pages (mp4box.js doesn't ship a CDN-friendly UMD
   global build the way hls.js does).

Only if both layers fail does Lumen show the calm error UI with a retry
button — never a raw `MediaError`.

## Architecture

```
src/
  core/
    EventEmitter.ts       tiny typed pub/sub (internal + public `on`/`off`)
    PlaybackEngine.ts      native / native-HLS / hls.js selection, ABR, retry
    ResilientMp4Engine.ts  mp4box.js + MSE last-resort fallback for broken MP4s
  subtitles/
    SubtitleManager.ts     track discovery, switching, styling, persistence
  ui/
    template.ts             shadow-DOM shell
    ControlsController.ts   all interaction wiring (the biggest module)
    icons.ts, Thumbnails.ts
  styles/player.css        design tokens + component styles (inlined into JS)
  LumenPlayer.ts            the <lumen-player> custom element + public API
  index.ts                  registers the element, re-exports types
```

Playback and UI are deliberately decoupled: `PlaybackEngine` and
`SubtitleManager` know nothing about the DOM controls, and
`ControlsController` only talks to them through the public engine/manager
API and the shared `EventEmitter`. That seam is where a headless build or
alternate UI skin would plug in.

## Development

```bash
npm install
npm run dev        # Vite dev server — open /examples/basic.html etc.
npm test           # vitest
npm run typecheck
npm run build       # emits dist/lumen.js (ESM), dist/lumen.umd.cjs, dist/types
npm run size         # build + enforce the gzip budget
```

## Roadmap

Following the PRD's phase plan:

- **Phase 0–1 (this release):** project foundation, design tokens, native +
  HLS playback, responsive/keyboard-accessible controls. ✅
- **Phase 2 (mostly done):** subtitle system is complete; incomplete/corrupt
  MP4 resilience is implemented via `mp4box.js` + MSE (see
  [Resilience](#resilience)) with documented limits (MP4 only, seeking
  clamped to buffered ranges).
- **Phase 3 (mostly done):** default theme, micro-interactions, loading/
  error states, a11y, mobile touch, scrub preview (thumbnails supported,
  sprite-sheet only).
- **Phase 4 (partial):** public API/events/types are stable; a full docs
  site, expanded automated test coverage (visual regression, real-device
  matrix), and npm/CDN release automation are follow-up work.
- **Phase 5 (not started):** playlists, chapters, casting, framework
  wrappers, DASH/DRM/ads as optional modules.

## License

MIT
