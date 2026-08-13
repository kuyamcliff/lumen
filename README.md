# Lumen

**Beautiful. Simple. Unbreakable. Lightweight.**

Lumen is a web-first, framework-agnostic video player built as a native
Web Component. Drop in one tag and it plays **MP4, MOV, MKV, WebM, Ogg,
FLV, MPEG-TS, HLS and DASH** — including formats no browser supports
natively — with a premium default UI, deep subtitle customization, DRM,
ads, and a clean TypeScript API, from a core bundle under **26 kB
gzipped**.

📖 **[Documentation](docs/index.html)** · 🎬 **[Live examples](examples/index.html)**

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

- **Plays what other players won't.** MKV, MOV and MPEG-TS are rejected by
  every browser's `<video>` element. Lumen identifies a file by its bytes
  and, where the container is the only obstacle, rebuilds it as fragmented
  MP4 in JavaScript — no transcoding, no WASM decoder, no quality loss.
- **Tiny core.** ~26 kB gzipped with zero required runtime dependencies.
  HLS (`hls.js`), DASH (`dashjs`), the corrupt-MP4 fallback (`mp4box`),
  the MKV and FLV remuxers, the ads plugin and the framework wrappers are
  all separate lazily-loaded chunks — pages that don't need them never
  download them, and CI enforces the budget.
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

## Format support

Lumen sniffs the first bytes of a file to identify its container, so a
`.mkv` renamed to `.mp4`, or a signed CDN URL with no extension at all,
still routes correctly. Extensions and `Content-Type` headers are hints,
never the deciding factor.

| Container | How it plays | Notes |
| --- | --- | --- |
| **MP4 / M4V** | Native | Fast path — no sniffing round trip |
| **WebM** | Native | |
| **Ogg / OGV** | Native | |
| **HLS** (`.m3u8`) | Native on Safari, else `hls.js` | ABR + quality menu |
| **MOV / QuickTime** | Native, else remuxed | Browsers reject the `video/quicktime` MIME even when they can decode the contents; Lumen remuxes rather than giving up |
| **MKV / Matroska** | Remuxed to fragmented MP4 | No browser plays MKV natively. Embedded subtitles are extracted too |
| **MPEG-TS** (`.ts`, `.m2ts`) | `hls.js` transmuxer | Reuses hls.js's TS support instead of duplicating a demuxer |
| **DASH** (`.mpd`) | `dash.js` | ABR + quality menu |
| **FLV** | Remuxed to fragmented MP4 | Carries H.264/AAC directly, so it's a copy |
| **Truncated / corrupt MP4** | `mp4box.js` + MSE | See [Resilience](#resilience) |
| **AVI, WMV/ASF, MPEG-PS** | ❌ Detected, not played | Reported as `CONTAINER_UNSUPPORTED` with a message telling the viewer what to do, instead of a blank player |

### Remuxing, and what limits it

Playing a video needs two things: a **container** the player can parse, and
**codecs** the browser can decode. Those fail independently, and conflating
them is why players usually say nothing more useful than "format not
supported".

Containers are just packaging, so Lumen rebuilds them in JavaScript: an MKV
is demuxed and rewritten as fragmented MP4 for Media Source Extensions,
with the compressed frames copied across untouched. It's fast, lossless,
and streams while downloading.

Codecs are the hard limit. Lumen can't decode what the browser can't, so it
asks (`MediaSource.isTypeSupported`) before committing and degrades in
useful steps:

| Source codec | Result |
| --- | --- |
| H.264, HEVC, VP9, AV1 video | Remuxed and played (subject to browser/OS support) |
| AAC, Opus, FLAC, MP3 audio | Remuxed and played |
| **AC-3, DTS, TrueHD audio** | Audio track dropped, **video still plays**, viewer told why |
| Undecodable video codec | Clear message naming the fix, rather than a dead player |

That AC-3 case matters more than it sounds: it's the single most common
reason an MKV "won't play", and dropping one track beats refusing the file.

Transcoding between codecs is deliberately out of scope — doing it in the
browser means shipping a multi-megabyte WASM decoder, which would cost more
than the rest of the player combined. For those files, convert server-side
and use the `CONTAINER_UNSUPPORTED` error to prompt for it.

## Features

| Area | Status |
| --- | --- |
| Native progressive MP4/WebM/Ogg playback | ✅ |
| MKV/Matroska via built-in JS demuxer + fMP4 remuxer | ✅ (see [Format support](#format-support)) |
| MOV/QuickTime and MPEG-TS | ✅ |
| Container detection by magic bytes, not file extension | ✅ |
| Embedded MKV subtitles (SRT-style and ASS/SSA) surfaced as text tracks | ✅ |
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
| Chapters — progress-bar markers, scrub titles, jump menu | ✅ |
| Playlists with auto-advance and next/previous controls | ✅ |
| Audio track selection (HLS, native, and MKV) | ✅ |
| Casting — AirPlay and the Remote Playback API | ✅ |
| Full internationalization of every UI string | ✅ |
| MPEG-DASH via `dashjs` | ✅ |
| DRM — Widevine, PlayReady, FairPlay | ✅ |
| VAST 2–4 linear ads (pre/mid/post-roll) as an optional plugin | ✅ |
| FLV playback via built-in demuxer + fMP4 remuxer | ✅ |
| Plugin architecture, ambient mode | ✅ |
| Offline/PWA helpers (Cache API + range-aware service worker) | ✅ |
| React, Vue and Svelte wrappers | ✅ |

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
`subtitles.html`, `theming.html`, `formats.html`, `resilience.html`,
`playlist.html`, `i18n.html` — or open `examples/index.html` for an index
of all of them. Run `npm run dev` and open it from the printed local URL.

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

// Audio tracks (HLS, native, or MKV)
player.audioTracks;            // LumenAudioTrack[]
player.setAudioTrack("fr");

// Chapters
player.chapters;               // LumenChapter[]
player.currentChapter;         // LumenChapter | null
player.setChapters([{ start: 0, end: 60, title: "Intro" }]);

// Playlists — auto-advances when each item ends
player.playlist = [
  { src: "one.mkv", title: "First", chapters: "one.vtt" },
  { src: "two.mp4", title: "Second", poster: "two.jpg" },
];
player.next();
player.previous();
player.playItem(1);
player.playlistIndex;

// Casting (AirPlay / Remote Playback)
player.isCastAvailable;
await player.requestCast();

// Translation — omitted keys fall back to English
player.setTranslations({ play: "Lecture", settings: "Réglages" });

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
`qualitychange`, `qualitieschange`, `texttrackchange`,
`embeddedtexttrack`, `chapterschange`, `chapterchange`,
`audiotrackschange`, `audiotrackchange`, `playlistchange`,
`playlistitemchange`, `castavailabilitychange`, `enterfullscreen`,
`exitfullscreen`, `enterpip`, `leavepip`, `loadedmetadata`, `ready`,
`destroy`. Full payload types are in `src/types.ts`.

### Attributes

`src`, `poster`, `autoplay`, `loop`, `muted`, `crossorigin`, `preload`,
`theme` (`dark` | `light` | `system`), `aspect-ratio` (e.g. `16/9`),
`object-fit` (e.g. `contain` | `cover`), `thumbnails` (URL to a WebVTT
sprite sheet, the format used by Mux/Bunny/Vimeo-style scrub previews),
`chapters` (URL to a WebVTT chapters file).

### Internationalization

Every control label, menu entry, screen-reader announcement and error
message resolves through one string table, so the player can be translated
without forking it or reaching into the shadow DOM:

```js
player.setTranslations({
  play: "再生",
  pause: "一時停止",
  settings: "設定",
});
```

Any key you leave out keeps its English default, so a partial translation
degrades to mixed language rather than blank buttons. The full key list is
the `LumenStrings` interface in `src/i18n.ts`.

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
    EventEmitter.ts        tiny typed pub/sub (internal + public `on`/`off`)
    containers.ts          magic-byte container sniffing
    PlaybackEngine.ts      routing: native / hls.js / remux, ABR, retry
    ResilientMp4Engine.ts  mp4box.js + MSE fallback for broken MP4s
  remux/                   ← lazy-loaded; absent from the core bundle
    MseSink.ts             shared MediaSource + SourceBuffer queueing
    MatroskaRemuxEngine.ts MKV demux → fMP4 mux → MSE, track selection
    matroska/
      ebml.ts              EBML variable-length integers + element IDs
      MatroskaDemuxer.ts   streaming Matroska parser
    mp4/
      boxes.ts             ISO-BMFF box-writing primitives
      Mp4Muxer.ts          fMP4 init + media segment generation
      sampleEntries.ts     codec → sample entry + RFC 6381 codec string
  media/
    ChapterManager.ts      WebVTT chapters, markers, jump targets
    CastController.ts      AirPlay + Remote Playback availability
  subtitles/
    SubtitleManager.ts     track discovery, switching, styling, persistence
  i18n.ts                  every user-visible string, with fallbacks
  ui/
    template.ts             shadow-DOM shell
    ControlsController.ts   all interaction wiring (the biggest module)
    icons.ts, Thumbnails.ts
  styles/player.css        design tokens + component styles (inlined into JS)
  LumenPlayer.ts            the <lumen-player> custom element + public API
  index.ts                  registers the element, re-exports types
```

`src/remux/` is reached only through a dynamic `import()`, so it builds as
a separate chunk and a page that never opens an MKV never downloads it.
That's what keeps broad format support from taxing the size budget.

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

Everything in the PRD is built. What remains is genuinely optional:

- **Visual-regression tests and a real-device matrix.** CI runs unit tests
  plus a real-Chromium smoke suite; screenshot diffing and a device farm
  would go further.
- **WASM soft-decoding** for codecs no browser ships (DivX, MPEG-2, AC-3).
  Deliberately not done: a decoder would cost more bytes than the entire
  player, so those files are detected and reported instead.
- **Bitmap subtitles** (VOBSUB, PGS) in MKV need an image-rendering path;
  only text-based tracks become text tracks today.
- **A native core with language bindings**, per the PRD's long-term
  section — out of scope for a web player.

### Known limits, stated plainly

- Seeking a remuxed MKV uses the file's Cues index; files muxed without
  one fall back to seeking within buffered ranges.
- MKV audio-track switching rebuilds the MediaSource, which re-reads the
  file. HLS/DASH switching is cheap; this isn't.
- VP9-in-MKV synthesizes its `vpcC` with profile-0 / 8-bit / 4:2:0
  defaults, since Matroska usually stores no CodecPrivate for VP9.
- The ads plugin covers linear VAST only — no VPAID (it executes
  third-party code in your page), companions, or non-linear overlays.

## License

MIT
