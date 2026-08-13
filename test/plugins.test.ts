import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import { LumenPlayer } from "../src/LumenPlayer";
import { ambient } from "../src/plugins/ambient";
import { ads } from "../src/plugins/ads";
import type { LumenPlugin } from "../src/plugins/types";

const players: LumenPlayer[] = [];

function mount(): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  document.body.appendChild(player);
  players.push(player);
  return player;
}

afterEach(() => {
  vi.useRealTimers();
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plugin lifecycle", () => {
  it("runs setup for a plugin registered before mount", () => {
    const setup = vi.fn();
    const player = document.createElement("lumen-player") as LumenPlayer;
    player.use({ name: "early", setup });

    document.body.appendChild(player);
    players.push(player);

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![0]).toBe(player);
  });

  it("runs setup immediately for a plugin registered after mount", () => {
    const player = mount();
    const setup = vi.fn();
    player.use({ name: "late", setup });
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("calls the returned teardown on destroy", () => {
    const teardown = vi.fn();
    const player = mount();
    player.use({ name: "t", setup: () => teardown });

    expect(teardown).not.toHaveBeenCalled();
    player.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("survives a plugin that throws in setup", () => {
    // A broken plugin must not take the player with it.
    const player = mount();
    expect(() => player.use({ name: "bad", setup: () => { throw new Error("boom"); } })).not.toThrow();

    const after = vi.fn();
    player.use({ name: "good", setup: after });
    expect(after).toHaveBeenCalled();
  });

  it("survives a plugin that throws during teardown", () => {
    const player = mount();
    const secondTeardown = vi.fn();
    player.use({ name: "bad", setup: () => () => { throw new Error("boom"); } });
    player.use({ name: "good", setup: () => secondTeardown });

    expect(() => player.destroy()).not.toThrow();
    expect(secondTeardown).toHaveBeenCalled();
  });

  it("use() is chainable", () => {
    const player = mount();
    const noop: LumenPlugin = { name: "noop", setup: () => {} };
    expect(player.use(noop)).toBe(player);
  });

  it("applies globally registered plugins to players created afterwards", () => {
    const setup = vi.fn();
    LumenPlayer.use({ name: "global", setup });

    mount();
    expect(setup).toHaveBeenCalledTimes(1);

    // And to each subsequent player, not just the first.
    mount();
    expect(setup).toHaveBeenCalledTimes(2);

    // Reset so later tests aren't affected by the global registry.
    (LumenPlayer as unknown as { globalPlugins: LumenPlugin[] }).globalPlugins = [];
  });
});

describe("ambient plugin", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }) as MediaQueryList);
  });

  it("bails out cleanly where no 2D canvas context exists", () => {
    // jsdom has no canvas backend, which is the same situation as a
    // browser refusing the context: the plugin must simply do nothing.
    const player = mount();
    expect(() => player.use(ambient())).not.toThrow();
    expect(() => player.destroy()).not.toThrow();
  });

  it("does nothing under prefers-reduced-motion", () => {
    // A shifting glow is exactly what that setting exists to suppress.
    vi.stubGlobal("matchMedia", (query: string) =>
      ({ matches: query.includes("reduced-motion"), media: query }) as MediaQueryList);

    const player = mount();
    player.use(ambient());
    expect(player.querySelector("canvas")).toBeNull();
  });

  it("samples only while playing", () => {
    // Stub the canvas backend jsdom lacks so the sampling loop is reachable.
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.useFakeTimers();

    const player = mount();
    const video = player.videoElement;
    player.use(ambient({ intervalMs: 10 }));

    // Paused: no sampling.
    vi.advanceTimersByTime(50);
    expect(drawImage).not.toHaveBeenCalled();

    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    video.dispatchEvent(new Event("play"));
    vi.advanceTimersByTime(50);
    expect(drawImage).toHaveBeenCalled();

    const whilePlaying = drawImage.mock.calls.length;
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    video.dispatchEvent(new Event("pause"));
    vi.advanceTimersByTime(50);
    expect(drawImage.mock.calls.length).toBe(whilePlaying);
  });

  it("puts its glow in the light DOM, which the slot renders", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    const player = mount();
    player.use(ambient());

    const glow = player.querySelector("canvas");
    expect(glow).not.toBeNull();
    expect(glow!.getAttribute("aria-hidden")).toBe("true");
    expect(player.shadowRoot!.querySelector("slot")).not.toBeNull();

    player.destroy();
    expect(player.querySelector("canvas")).toBeNull();
  });
});

const VAST = `<VAST version="4.0"><Ad id="a"><InLine>
  <Impression><![CDATA[https://t/imp]]></Impression>
  <Creatives><Creative><Linear skipoffset="00:00:02">
    <Duration>00:00:10</Duration>
    <TrackingEvents>
      <Tracking event="start"><![CDATA[https://t/start]]></Tracking>
      <Tracking event="firstQuartile"><![CDATA[https://t/q1]]></Tracking>
      <Tracking event="midpoint"><![CDATA[https://t/mid]]></Tracking>
      <Tracking event="thirdQuartile"><![CDATA[https://t/q3]]></Tracking>
      <Tracking event="skip"><![CDATA[https://t/skip]]></Tracking>
      <Tracking event="complete"><![CDATA[https://t/complete]]></Tracking>
    </TrackingEvents>
    <VideoClicks><ClickThrough><![CDATA[https://advertiser]]></ClickThrough></VideoClicks>
    <MediaFiles><MediaFile type="video/mp4" width="640" height="360" bitrate="500"><![CDATA[https://cdn/ad.mp4]]></MediaFile></MediaFiles>
  </Linear></Creative></Creatives>
</InLine></Ad></VAST>`;

describe("ads plugin", () => {
  let beacons: string[];

  beforeEach(() => {
    beacons = [];
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type: string) =>
      type.startsWith("video/mp4") ? "probably" : "",
    );
    // Ad playback must work without a real media stack.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === undefined && url.startsWith("https://t/")) {
        beacons.push(url);
        return new Response("", { status: 204 });
      }
      if (url.includes("vast")) return new Response(VAST, { status: 200 });
      beacons.push(url);
      return new Response("", { status: 204 });
    }));
  });

  const adUi = (player: LumenPlayer) => player.querySelector<HTMLElement>("div[hidden], div:not([hidden])");
  const adVideo = (player: LumenPlayer) =>
    [...player.querySelectorAll("video")].find((v) => v !== player.videoElement)!;
  const skipButton = (player: LumenPlayer) => player.querySelector<HTMLButtonElement>("button")!;

  it("plays a pre-roll and fires impression and start beacons", async () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));

    await vi.waitFor(() => expect(adVideo(player).src).toBe("https://cdn/ad.mp4"));
    await vi.waitFor(() => expect(beacons).toContain("https://t/imp"));
    expect(beacons).toContain("https://t/start");
  });

  it("shows a skip countdown that becomes an active skip button", async () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    await vi.waitFor(() => expect(adVideo(player).src).toBeTruthy());

    const video = adVideo(player);
    Object.defineProperty(video, "duration", { value: 10, configurable: true });

    Object.defineProperty(video, "currentTime", { value: 0.5, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(skipButton(player).disabled).toBe(true);
    expect(skipButton(player).textContent).toContain("Skip in");

    Object.defineProperty(video, "currentTime", { value: 3, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(skipButton(player).disabled).toBe(false);
    expect(skipButton(player).textContent).toBe("Skip ad");
  });

  it("fires quartile beacons as the ad progresses", async () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    await vi.waitFor(() => expect(adVideo(player).src).toBeTruthy());

    const video = adVideo(player);
    Object.defineProperty(video, "duration", { value: 10, configurable: true });
    for (const time of [2.6, 5.1, 7.6]) {
      Object.defineProperty(video, "currentTime", { value: time, configurable: true });
      video.dispatchEvent(new Event("timeupdate"));
    }

    expect(beacons).toContain("https://t/q1");
    expect(beacons).toContain("https://t/mid");
    expect(beacons).toContain("https://t/q3");

    // Each quartile fires exactly once, however many timeupdates arrive.
    Object.defineProperty(video, "currentTime", { value: 8, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));
    expect(beacons.filter((b) => b === "https://t/q1")).toHaveLength(1);
  });

  it("skipping fires the skip beacon and hides the ad", async () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    await vi.waitFor(() => expect(adVideo(player).src).toBeTruthy());

    const video = adVideo(player);
    Object.defineProperty(video, "duration", { value: 10, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 3, configurable: true });
    video.dispatchEvent(new Event("timeupdate"));

    skipButton(player).dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(beacons).toContain("https://t/skip");
    expect(skipButton(player).closest("div")!.hidden).toBe(true);
  });

  it("returns to content when the ad ends", async () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    await vi.waitFor(() => expect(adVideo(player).src).toBeTruthy());

    adVideo(player).dispatchEvent(new Event("ended"));

    expect(beacons).toContain("https://t/complete");
    expect(skipButton(player).closest("div")!.hidden).toBe(true);
  });

  it("returns to content when the ad fails to load", async () => {
    // A broken ad must never block the video the viewer came for.
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    await vi.waitFor(() => expect(adVideo(player).src).toBeTruthy());

    adVideo(player).dispatchEvent(new Event("error"));
    expect(skipButton(player).closest("div")!.hidden).toBe(true);
  });

  it("does not block content when the VAST tag itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nonsense", { status: 500 })));
    const player = mount();
    expect(() => player.use(ads({ tagUrl: "https://ads/vast.xml" }))).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const overlay = [...player.querySelectorAll("div")].find((d) => d.querySelector("video"));
    expect(overlay?.hidden).not.toBe(false);
  });

  it("removes its overlay on teardown", () => {
    const player = mount();
    player.use(ads({ tagUrl: "https://ads/vast.xml" }));
    // The player's own video is in the shadow root; the light DOM holds
    // only the ad overlay, which must be slotted to render at all.
    expect(player.querySelectorAll("video")).toHaveLength(1);
    expect(player.shadowRoot!.querySelector("slot")).not.toBeNull();

    player.destroy();
    expect(player.querySelectorAll("video")).toHaveLength(0);
  });
});
