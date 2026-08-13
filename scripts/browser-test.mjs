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

const browser = await chromium.launch({
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
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
