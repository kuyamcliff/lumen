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
import { chromium } from "playwright";

const PORT = 5199;
const BASE = `http://localhost:${PORT}/examples`;
const PAGES = [
  "index.html",
  "basic.html",
  "hls.html",
  "formats.html",
  "subtitles.html",
  "playlist.html",
  "theming.html",
  "resilience.html",
  "i18n.html",
];

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

// LUMEN_CHROMIUM lets a machine with a browser Playwright didn't install
// itself (a CI image with a pre-seeded Chromium, say) run this suite
// without a second multi-hundred-megabyte download.
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  ...(process.env.LUMEN_CHROMIUM ? { executablePath: process.env.LUMEN_CHROMIUM } : {}),
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
    await page.goto(`${BASE}/formats.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById("mkv").play().catch(() => {}));
    await page.waitForTimeout(3500);

    const state = await page.evaluate(() => {
      const video = document.getElementById("mkv").videoElement;
      return {
        blob: video.currentSrc.startsWith("blob:"),
        width: video.videoWidth,
        frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
        time: video.currentTime,
      };
    });

    check("routed through MediaSource, not native", state.blob);
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

  // --- shell details jsdom can't see -------------------------------------
  console.log("\nShadow DOM shell:");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/basic.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(800);

    const state = await page.evaluate(() => {
      const player = document.querySelector("lumen-player");

      // A slot is the only way light-DOM children (plugin overlays, ad
      // containers) reach the screen at all.
      const badge = document.createElement("div");
      badge.id = "slotted-probe";
      badge.textContent = "overlay";
      player.appendChild(badge);

      const fullscreen = player.shadowRoot.querySelector('[data-action="fullscreen"]');
      const pip = player.shadowRoot.querySelector('[data-action="pip"]');
      return {
        slotted: badge.assignedSlot !== null,
        painted: badge.getBoundingClientRect().width > 0,
        fullscreenVisible: !fullscreen.hidden && fullscreen.offsetParent !== null,
        pipVisible: !pip.hidden,
        controlsVisible: player.shadowRoot.querySelector(".lumen-controls").getBoundingClientRect().height > 0,
      };
    });

    check("light-DOM children are slotted", state.slotted);
    check("slotted content is laid out", state.painted);
    // Guards the support probe: Chromium has fullscreen, so hiding the
    // button here would mean the detection is broken for everyone.
    check("fullscreen button is offered", state.fullscreenVisible);
    check("PiP button is offered", state.pipVisible);
    check("controls have height", state.controlsVisible);
    await page.close();
  }

  // --- subtitles render through the custom overlay -----------------------
  console.log("\nSubtitles:");
  {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${BASE}/subtitles.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    const state = await page.evaluate(async () => {
      const player = document.querySelector("lumen-player");
      const track = player.textTracks[0];
      player.setSubtitleTrack?.(track) ?? player.subtitles?.setActiveTrack?.(track);
      return {
        trackCount: player.textTracks.length,
        // The browser must not be drawing captions itself — "hidden" is
        // what lets the custom overlay own the styling.
        mode: player.videoElement.textTracks[0]?.mode,
        prefsPersist: (() => {
          player.setSubtitlePrefs({ fontSize: 1.3 });
          return player.subtitlePrefs.fontSize;
        })(),
      };
    });

    check("external track discovered", state.trackCount > 0, `${state.trackCount} track(s)`);
    check("cue parsing enabled without native rendering", state.mode === "hidden", String(state.mode));
    check("style preferences apply", state.prefsPersist === 1.3);
    check("no uncaught errors", errors.length === 0, errors.join("; "));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
