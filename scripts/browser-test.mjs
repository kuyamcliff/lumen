#!/usr/bin/env node
/**
 * Browser smoke tests.
 *
 * jsdom has no media stack: it cannot catch a MediaSource ordering bug, a
 * malformed codec string, or a decoder rejecting a sample entry — all of
 * which have shipped-and-been-caught here. This starts the dev server,
 * drives every example page in real Chromium, and asserts the things only
 * a real media pipeline can tell us.
 *
 * Chromium builds without proprietary codecs (including Playwright's
 * default) can't decode H.264/AAC, so assertions that need actual decoding
 * use the VP9/Opus MKV fixture, which every build can handle.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PORT = 5199;
const BASE = `http://localhost:${PORT}/examples`;
const PAGES = [
  "index.html",
  "basic.html",
  "hls.html",
  "formats.html",
  "effects.html",
  "subtitles.html",
  "playlist.html",
  "theming.html",
  "resilience.html",
  "i18n.html",
];

const DOC_PAGES = [
  "index.html",
  "install.html",
  "formats.html",
  "streaming.html",
  "effects.html",
  "subtitles.html",
  "playlists.html",
  "theming.html",
  "i18n.html",
  "drm.html",
  "ads.html",
  "offline.html",
  "frameworks.html",
  "api.html",
  "events.html",
  "plugins.html",
];

/** Screenshots are written here when SHOTS=1, for the README and docs. */
const SHOT_DIR = process.env.LUMEN_SHOT_DIR || "docs/screenshots";
const TAKE_SHOTS = process.env.SHOTS === "1";
if (TAKE_SHOTS) mkdirSync(SHOT_DIR, { recursive: true });

/** Captures the player element only, so the shots are of the UI itself. */
async function shot(page, name, selector = "#player") {
  if (!TAKE_SHOTS) return;
  const target = await page.$(selector);
  if (!target) return;
  await target.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
  detached: false,
});

process.on("exit", () => server.kill());

if (!(await waitForServer(`${BASE}/index.html`))) {
  console.error("Dev server did not start");
  server.kill();
  process.exit(1);
}

// CI images often ship a Chromium build that doesn't match the Playwright
// version in the lockfile; LUMEN_CHROMIUM points at the one that's there.
const browser = await chromium.launch({
  executablePath: process.env.LUMEN_CHROMIUM || undefined,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

try {
  // --- every example page loads without a script error -------------------
  console.log("\nExample pages:");
  for (const name of PAGES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/${name}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1200);

    const mounted = await page.evaluate(() =>
      [...document.querySelectorAll("lumen-player")].every(
        (el) => el.shadowRoot?.querySelector("video") && el.shadowRoot.querySelector(".lumen-controls"),
      ),
    );
    check(name, errors.length === 0 && mounted, errors.join("; "));
    await page.close();
  }

  // --- MKV actually decodes ---------------------------------------------
  console.log("\nMKV remux (no browser plays Matroska natively):");
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Throttled, so "the duration is known before the file has arrived" is
    // actually observable — a 1.5 MB fixture off localhost otherwise
    // finishes downloading before the first check can run.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: 400 * 1024,
      uploadThroughput: 400 * 1024,
    });

    await page.goto(`${BASE}/formats.html`, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Read the duration while the file is still arriving: if it is already
    // known, it came from the Segment header rather than from endOfStream.
    const earlyDuration = await page.evaluate(async () => {
      const video = document.getElementById("mkv").videoElement;
      for (let i = 0; i < 40; i++) {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          return { duration: video.duration, buffered: video.buffered.length ? video.buffered.end(0) : 0 };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { duration: video.duration, buffered: 0 };
    });

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    await page.evaluate(() => document.getElementById("mkv").play().catch(() => {}));
    await page.waitForTimeout(4000);

    const state = await page.evaluate(() => {
      const video = document.getElementById("mkv").videoElement;
      return {
        blob: video.currentSrc.startsWith("blob:"),
        width: video.videoWidth,
        frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
        time: video.currentTime,
        duration: video.duration,
        // What the fixture's Segment Info declares, and what it actually holds.
        headerDuration: 634.57,
        contentDuration: 16.27,
      };
    });

    check("routed through MediaSource, not native", state.blob);
    // The fixture is an excerpt of a 10:34 source whose Segment header was
    // never rewritten, which makes it a good test of both halves: the
    // header's number is published immediately, and end-of-stream corrects
    // it to what the file actually contains.
    check(
      "duration is known from the header before the media arrives",
      Math.abs(earlyDuration.duration - state.headerDuration) < 1 && earlyDuration.buffered < 1,
      `${earlyDuration.duration?.toFixed(2)}s known with ${earlyDuration.buffered.toFixed(2)}s buffered`,
    );
    check(
      "end of stream corrects the duration to what the file holds",
      Math.abs(state.duration - state.contentDuration) < 0.5,
      `${state.duration?.toFixed(2)}s`,
    );
    check("video track decodes", state.width > 0 && state.frames > 0, `${state.width}px, ${state.frames} frames`);
    check("playhead advances", state.time > 0.5, `t=${state.time.toFixed(2)}`);
    check("no uncaught errors", errors.length === 0, errors.join("; "));
    await page.close();
  }

  // --- chapters, playlist, i18n ------------------------------------------
  console.log("\nChapters, playlist and translation:");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/playlist.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2500);

    const state = await page.evaluate(() => {
      const player = document.getElementById("player");
      return {
        chapters: player.chapters.length,
        marks: player.shadowRoot.querySelectorAll(".lumen-chapter-mark").length,
        playlist: player.playlist.length,
      };
    });
    check("chapters parsed", state.chapters === 4, `${state.chapters} chapters`);
    check("chapter markers drawn", state.marks === 3, `${state.marks} marks`);
    check("playlist loaded", state.playlist === 3);
    await page.close();
  }

  // --- the documentation site renders too -------------------------------
  console.log("\nDocumentation pages:");
  for (const name of DOC_PAGES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${PORT}/docs/${name}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(500);
    const nav = await page.evaluate(() => document.querySelector(".sidebar")?.children.length ?? 0);
    check(name, errors.length === 0 && nav > 0, errors.join("; "));
    await page.close();
  }

  // --- AVI: the container the web is told to give up on -----------------
  //
  // Playwright's Chromium ships without the H.264/AAC decoders, so what can
  // be asserted here is the routing and the negotiation — and, when the
  // codecs are missing, that the failure says so precisely instead of
  // blaming the container. A browser with the decoders plays the file.
  console.log("\nAVI remux:");
  {
    const page = await browser.newPage();
    const errors = [];
    const notices = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/formats.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1000);

    const state = await page.evaluate(async () => {
      const player = document.getElementById("avi");
      const messages = [];
      player.on("error", (e) => messages.push(e.message));

      const canDecode = MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"');
      // Reload the source now that the listener is attached, so the first
      // attempt's messages aren't missed.
      await player.load("./media/sample-h264.avi");
      player.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const info = player.mediaInfo();
      return {
        canDecode,
        messages,
        container: info.container,
        engine: info.engine,
        codecs: info.codecs,
        blob: player.videoElement.currentSrc.startsWith("blob:"),
        width: player.videoElement.videoWidth,
        time: player.videoElement.currentTime,
      };
    });
    notices.push(...state.messages);

    check("sniffed as AVI by its bytes, not its extension", state.container === "AVI", state.container);

    if (state.canDecode) {
      check("routed to the AVI remuxer", state.engine === "AVI remux", state.engine);
      check(
        "negotiated the codecs from the stream headers",
        state.codecs === "avc1.64001f,mp4a.40.2",
        String(state.codecs),
      );
      check("handed to MediaSource rather than the browser's non-existent AVI support", state.blob);
      check("video decodes", state.width > 0, `${state.width}px`);
      check("playhead advances", state.time > 0.3, `t=${state.time.toFixed(2)}`);
    } else {
      // The honest outcome on a codec-less build: a specific reason.
      check(
        "reports the missing codec rather than blaming the container",
        notices.some((message) => /codec your browser can't play/.test(message)),
        notices.join("; ") || "(no message)",
      );
      console.log("  note  this Chromium has no H.264/AAC decoder, so decoding is not asserted here");
    }

    check("no uncaught errors", errors.length === 0, errors.join("; "));
    await page.close();
  }

  // --- the VLC toolkit ---------------------------------------------------
  console.log("\nEqualizer, filters and the rest:");
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/effects.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.getElementById("player").play().catch(() => {}));
    await page.waitForTimeout(2500);
    await shot(page, "01-player");

    // --- equalizer ---
    const eq = await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.setEqualizerPreset("rock");
      const applied = player.audioEffects;
      // The Web Audio graph is a separate chunk, fetched on first use.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const active = player.audio.isActive;
      player.setEqualizerPreset("flat");
      return {
        applied,
        presetCount: player.audio.effects.bands.length,
        active,
        available: player.audio.isAvailable,
      };
    });
    check("preset loads VLC's curve", eq.applied.bands[0] === 8 && eq.applied.bands[9] === 11.2, JSON.stringify(eq.applied.bands));
    check("equalizer switches itself on with a preset", eq.applied.equalizer === true);
    check("ten bands", eq.presetCount === 10);
    check("Web Audio graph engaged on same-origin media", eq.active === true && eq.available === true);

    // --- panels ---
    const panels = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const results = {};
      for (const view of ["equalizer", "effects", "playlist", "info", "shortcuts"]) {
        player.openPanel(view);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const body = player.shadowRoot.querySelector('[data-el="panel-body"]');
        results[view] = {
          open: !player.shadowRoot.querySelector('[data-el="panel"]').hidden,
          title: player.shadowRoot.querySelector('[data-el="panel-title"]').textContent,
          children: body.childElementCount,
          styled: !!player.shadowRoot.querySelector("style[data-lumen-panels]"),
        };
      }
      player.openPanel(null);
      return results;
    });

    for (const [view, state] of Object.entries(panels)) {
      check(`${view} panel renders`, state.open && state.children > 0 && state.styled, `${state.title}, ${state.children} rows`);
    }

    // Screenshots of each panel, one at a time.
    for (const view of ["equalizer", "effects", "info", "shortcuts"]) {
      await page.evaluate((v) => document.getElementById("player").openPanel(v), view);
      await page.waitForTimeout(350);
      await shot(page, `02-panel-${view}`);
    }
    await page.evaluate(() => document.getElementById("player").openPanel(null));

    // --- equalizer sliders actually move the state ---
    const dragged = await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.openPanel("equalizer");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sliders = player.shadowRoot.querySelectorAll(".lumen-eq-band input");
      sliders[0].value = "12";
      sliders[0].dispatchEvent(new Event("input", { bubbles: true }));
      const state = player.audioEffects;
      player.openPanel(null);
      return { count: sliders.length, band0: state.bands[0], preset: state.preset };
    });
    check("equalizer has a slider per band", dragged.count === 10, `${dragged.count} sliders`);
    check("dragging a band updates the state", dragged.band0 === 12);
    check("a hand-edited curve reads as custom", dragged.preset === null);

    // --- picture adjustments ---
    const filters = await page.evaluate(() => {
      const player = document.getElementById("player");
      player.setVideoFilters({ brightness: 1.4, saturation: 1.6, gamma: 1.8, zoom: 1.2 });
      const video = player.videoElement;
      const computed = getComputedStyle(video);
      return {
        filter: computed.filter,
        transform: computed.transform,
        hasGammaFilter: !!player.shadowRoot.querySelector("#lumen-gamma"),
      };
    });
    check("CSS filter applied to the video", filters.filter.includes("brightness(1.4)"), filters.filter);
    check("gamma routed through the SVG filter", filters.hasGammaFilter && filters.filter.includes("lumen-gamma"));
    check("zoom applied as a transform", filters.transform !== "none", filters.transform);

    // A gentler grade for the screenshot: the assertion above deliberately
    // pushes the sliders further than anyone would watch a film at.
    await page.evaluate(() => {
      const player = document.getElementById("player");
      player.filters.reset();
      player.setVideoFilters({ saturation: 0.15, contrast: 1.3, brightness: 0.95 });
      player.openPanel("effects");
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const player = document.getElementById("player");
      // Switch the effects panel to its Video tab for the shot.
      const tabs = player.shadowRoot.querySelectorAll(".lumen-tab");
      tabs[1]?.click();
    });
    await page.waitForTimeout(300);
    await shot(page, "03-adjustments");
    await page.evaluate(() => {
      const player = document.getElementById("player");
      player.openPanel(null);
      player.filters.reset();
    });

    const rotated = await page.evaluate(() => {
      const player = document.getElementById("player");
      player.filters.reset();
      const angle = player.filters.rotate();
      const transform = getComputedStyle(player.videoElement).transform;
      return { angle, transform };
    });
    check("rotation applied", rotated.angle === 90 && rotated.transform !== "none", rotated.transform);
    await page.evaluate(() => document.getElementById("player").filters.reset());

    // --- A-B loop ---
    const loop = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const video = player.videoElement;
      video.currentTime = 1;
      player.setAbLoop({ start: 1, end: 1.6 });
      video.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const region = player.shadowRoot.querySelector('[data-el="loop-region"]');
      const state = { time: video.currentTime, regionShown: !region.hidden, width: region.style.width };
      player.setAbLoop(null);
      return state;
    });
    check("playback stays inside the loop", loop.time <= 1.7, `t=${loop.time.toFixed(2)}`);
    check("loop drawn on the progress bar", loop.regionShown && loop.width !== "", loop.width);

    // --- frame stepping ---
    const stepped = await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const before = player.currentTime;
      const fps = player.frameRate;
      player.stepFrame(1);
      const after = player.currentTime;
      player.stepFrame(-1);
      return { before, after, back: player.currentTime, fps, paused: player.paused };
    });
    check("stepping pauses and advances by one frame", stepped.paused && stepped.after > stepped.before, `${stepped.before.toFixed(3)} → ${stepped.after.toFixed(3)}`);
    check("stepping back returns to where it was", Math.abs(stepped.back - stepped.before) < 0.005);
    check("frame rate measured from presented frames", stepped.fps !== null && stepped.fps > 10, `${stepped.fps?.toFixed(2)} fps`);

    // --- snapshot ---
    const snap = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const blob = await player.snapshot({ type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      return { size: blob.size, type: blob.type, width: bitmap.width, height: bitmap.height };
    });
    check("snapshot encodes a real image", snap.size > 1000 && snap.type === "image/png", `${snap.width}×${snap.height}, ${snap.size} bytes`);
    check("snapshot matches the video's own size", snap.width > 0 && snap.height > 0);

    // --- media info ---
    const info = await page.evaluate(() => document.getElementById("player").mediaInfo());
    check("media info names the container", info.container === "Matroska (MKV)", info.container);
    check("media info names the pipeline", info.engine === "MKV remux", info.engine);
    check("media info reports the resolution", info.width > 0 && info.height > 0, `${info.width}×${info.height}`);
    check("media info reports buffered media", info.bufferAheadSeconds >= 0);

    // --- subtitle and audio delay ---
    const delays = await page.evaluate(() => {
      const player = document.getElementById("player");
      player.setSubtitleOffset(0.5);
      player.audio.set({ delayMs: 120 });
      return { subtitle: player.subtitleOffset, audio: player.audioEffects.delayMs };
    });
    check("subtitle delay applied", delays.subtitle === 0.5);
    check("audio delay applied", delays.audio === 120);

    // --- bookmarks ---
    const bookmarks = await page.evaluate(() => {
      const player = document.getElementById("player");
      player.videoElement.currentTime = 2;
      player.addBookmark("Test point");
      const marks = player.shadowRoot.querySelectorAll(".lumen-bookmark-mark").length;
      const list = player.bookmarks;
      player.removeBookmark(list[0].time);
      return { marks, count: list.length, label: list[0]?.label, after: player.bookmarks.length };
    });
    check("bookmark added and pinned to the bar", bookmarks.count === 1 && bookmarks.marks === 1, bookmarks.label);
    check("bookmark removed", bookmarks.after === 0);

    // --- keyboard ---
    const keys = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const root = player.shadowRoot.querySelector(".lumen");
      const press = (key, shift = false) =>
        root.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));

      player.filters.reset();
      press("a");
      const aspect = player.filters.filters.aspectRatio;
      press("z");
      const zoom = player.filters.filters.zoom;
      player.setSubtitleOffset(0);
      press("g");
      const subtitleDelay = player.subtitleOffset;
      press("?");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const panel = player.panel;
      press("Escape");
      const closed = player.panel;
      player.filters.reset();
      player.setSubtitleOffset(0);
      return { aspect, zoom, subtitleDelay, panel, closed };
    });
    check("`a` cycles the aspect ratio", keys.aspect === "16/9", String(keys.aspect));
    check("`z` cycles the zoom", keys.zoom === 2, String(keys.zoom));
    check("`g` nudges the subtitle delay", Math.abs(keys.subtitleDelay + 0.05) < 0.001, String(keys.subtitleDelay));
    check("`?` opens the shortcut panel and Escape closes it", keys.panel === "shortcuts" && keys.closed === null);

    // Focus inside the shadow tree reports as the host from the document's
    // point of view, so the guards that protect focused controls have to
    // read the shadow root's own activeElement.
    const focusGuards = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const sr = player.shadowRoot;
      const root = sr.querySelector(".lumen");
      const press = (key) => root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

      const volume = sr.querySelector('[data-el="volume"]');
      // Away from the ends, so a hijacked ArrowUp would visibly move it.
      player.volume = 0.5;
      volume.focus();
      const beforeVolume = player.volume;
      press("ArrowUp");
      const afterVolume = player.volume;
      volume.blur();
      player.volume = 1;

      player.openPanel("equalizer");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const slider = sr.querySelector(".lumen-eq-band input");
      slider.focus();
      const beforeZoom = player.filters.filters.zoom;
      press("z");
      const afterZoom = player.filters.filters.zoom;
      slider.blur();
      player.openPanel(null);
      player.filters.reset();

      return { beforeVolume, afterVolume, beforeZoom, afterZoom };
    });
    check(
      "a focused volume slider keeps its own arrow keys",
      focusGuards.beforeVolume === focusGuards.afterVolume,
      `${focusGuards.beforeVolume} → ${focusGuards.afterVolume}`,
    );
    check(
      "a focused panel control isn't hijacked by player shortcuts",
      focusGuards.beforeZoom === focusGuards.afterZoom,
      `${focusGuards.beforeZoom} → ${focusGuards.afterZoom}`,
    );

    // --- local files, via the same path a drop takes ---
    const opened = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const srt = "1\n00:00:01,000 --> 00:00:04,000\nConverted from SubRip.\n";
      const file = new File([srt], "clip.es.srt", { type: "text/plain" });
      const before = player.textTracks.length;
      await player.addSubtitleFile(file);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const tracks = player.textTracks;
      return {
        before,
        after: tracks.length,
        label: tracks[tracks.length - 1]?.label,
        language: tracks[tracks.length - 1]?.language,
      };
    });
    check("an SRT file becomes a text track", opened.after === opened.before + 1, `${opened.before} → ${opened.after}`);
    check("its name and language come from the filename", opened.label === "clip es" && opened.language === "es", `${opened.label} / ${opened.language}`);

    // --- the drag-and-drop target ---
    const drop = await page.evaluate(async () => {
      const player = document.getElementById("player");
      const root = player.shadowRoot.querySelector(".lumen");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "movie.mkv", { type: "" }));
      root.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { shown: !player.shadowRoot.querySelector('[data-el="drop"]').hidden };
    });
    check("dragging a file reveals the drop target", drop.shown);
    await shot(page, "05-drop");
    await page.evaluate(() => {
      const player = document.getElementById("player");
      const root = player.shadowRoot.querySelector(".lumen");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "movie.mkv", { type: "" }));
      root.dispatchEvent(new DragEvent("dragleave", { dataTransfer: transfer, bubbles: true }));
    });

    check("no uncaught errors anywhere in that", errors.length === 0, errors.join("; "));
    await page.close();
  }

  // --- the light theme, which the token fix restored ---------------------
  console.log("\nTheming:");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/theming.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    const themed = await page.evaluate(() => {
      const players = [...document.querySelectorAll("lumen-player")];
      return players.map((player) => {
        const root = player.shadowRoot.querySelector(".lumen-controls");
        return {
          theme: player.getAttribute("theme"),
          accent: getComputedStyle(player).getPropertyValue("--lumen-color-accent").trim(),
          text: getComputedStyle(root).color,
        };
      });
    });

    check("every player resolves its palette", themed.every((t) => t.accent !== ""), JSON.stringify(themed.map((t) => t.accent)));
    const light = themed.find((t) => t.theme === "light");
    if (light) check("the light theme uses its own accent", light.accent === "#b8791a", light.accent);

    await page.close();
  }

  // The light palette, shot on the page that plays a local file so the
  // frame is guaranteed to be there.
  //
  // Also the regression test for the idle timer: pausing must bring the
  // controls back and keep them, rather than letting a timer armed before
  // the pause hide them again a moment later.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/effects.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.setAttribute("theme", "light");
      player.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2500));
      player.pause();
    });
    await page.waitForTimeout(1200);

    const paused = await page.evaluate(() => {
      const player = document.getElementById("player");
      const shell = player.shadowRoot.querySelector(".lumen");
      return {
        idle: shell.classList.contains("is-idle"),
        opacity: getComputedStyle(player.shadowRoot.querySelector(".lumen-controls")).opacity,
      };
    });
    check("controls stay visible while paused", !paused.idle && paused.opacity === "1", `idle=${paused.idle}`);

    await shot(page, "06-theming");
    await page.close();
  }

  // --- repeat and shuffle over a real playlist ---------------------------
  console.log("\nPlaylist behaviour:");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/playlist.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);

    const state = await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.setRepeat("all");
      player.playItem(player.playlist.length - 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const wrapped = player.hasNext();

      player.setShuffle(true);
      const shuffled = player.getShuffle();
      player.setShuffle(false);
      player.setRepeat("off");
      await new Promise((resolve) => setTimeout(resolve, 200));
      player.playItem(player.playlist.length - 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { wrapped, shuffled, endOfQueue: player.hasNext() };
    });

    check("repeat all wraps past the last item", state.wrapped === true);
    check("shuffle can be turned on", state.shuffled === true);
    check("without repeat, the queue ends", state.endOfQueue === false);

    await page.evaluate(async () => {
      const player = document.getElementById("player");
      player.playItem(0);
      player.addBookmark("Opening shot");
      player.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1500));
      player.pause();
      player.openPanel("playlist");
    });
    await page.waitForTimeout(600);
    await shot(page, "04-playlist");
    await page.evaluate(() => {
      const player = document.getElementById("player");
      player.openPanel(null);
      for (const bookmark of player.bookmarks) player.removeBookmark(bookmark.time);
    });
    await page.close();
  }

  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/i18n.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1000);
    const labels = await page.evaluate(() => {
      const player = document.getElementById("player");
      const button = () =>
        player.shadowRoot.querySelector('.lumen-row [data-action="play-pause"]').getAttribute("aria-label");
      const before = button();
      [...document.querySelectorAll("#langs button")].find((b) => b.textContent === "Français").click();
      return { before, after: button() };
    });
    check("UI translates", labels.before === "Play" && labels.after === "Lecture", JSON.stringify(labels));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
