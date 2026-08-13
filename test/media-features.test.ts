import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import type { LumenPlayer } from "../src/LumenPlayer";
import { ThumbnailTrack } from "../src/ui/Thumbnails";
import { DrmController } from "../src/core/DrmController";
import { EventEmitter } from "../src/core/EventEmitter";

const players: LumenPlayer[] = [];

function mount(): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  document.body.appendChild(player);
  players.push(player);
  return player;
}

afterEach(() => {
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------- thumbnails

const SPRITE_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
sprite.jpg#xywh=320,0,160,90
`;

describe("thumbnail sprite track", () => {
  it("parses cues and resolves the sprite region for a time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SPRITE_VTT, { status: 200 })));

    const track = await ThumbnailTrack.load("https://cdn/thumbs.vtt");
    expect(track).not.toBeNull();
    expect(track!.isReady).toBe(true);

    const cue = track!.cueAt(7);
    expect(cue).not.toBeNull();
    expect(cue!.url).toBe("https://cdn/sprite.jpg");
    expect(cue!.xywh).toEqual([160, 0, 160, 90]);
  });

  it("resolves sprite URLs relative to the VTT, not the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SPRITE_VTT, { status: 200 })));
    const track = await ThumbnailTrack.load("https://cdn/media/thumbs.vtt");
    expect(track!.cueAt(1)!.url).toBe("https://cdn/media/sprite.jpg");
  });

  it("clamps to the last cue past the end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SPRITE_VTT, { status: 200 })));
    const track = await ThumbnailTrack.load("https://cdn/thumbs.vtt");
    expect(track!.cueAt(9999)!.xywh).toEqual([320, 0, 160, 90]);
  });

  it("returns null for a missing or unparseable file instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await ThumbnailTrack.load("https://cdn/missing.vtt")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await ThumbnailTrack.load("https://cdn/x.vtt")).toBeNull();
  });

  it("reports not-ready for a VTT with no usable cues", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("WEBVTT\n\n", { status: 200 })));
    const track = await ThumbnailTrack.load("https://cdn/empty.vtt");
    expect(track!.isReady).toBe(false);
    expect(track!.cueAt(1)).toBeNull();
  });

  it("is wired to the player through the thumbnails attribute", async () => {
    const fetchMock = vi.fn(async () => new Response(SPRITE_VTT, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const player = mount();
    player.setAttribute("thumbnails", "https://cdn/thumbs.vtt");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://cdn/thumbs.vtt"));
  });
});

// ------------------------------------------------------------ subtitles

describe("subtitle rendering and preferences", () => {
  function fakeCueTrack(cues: Array<{ start: number; end: number; text: string }>) {
    const listeners = new Map<string, Array<() => void>>();
    const track = {
      kind: "subtitles" as TextTrackKind,
      label: "English",
      language: "en",
      mode: "disabled" as TextTrackMode,
      // Deliberately plain objects, not VTTCue instances: that's what
      // in-band captions look like in Safari, and jsdom has no VTTCue.
      cues: cues.map((c) => ({ startTime: c.start, endTime: c.end, text: c.text })),
      activeCues: null as unknown,
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
      removeEventListener: () => {},
      fire: (type: string) => (listeners.get(type) ?? []).forEach((h) => h()),
    };
    return track;
  }

  function attach(player: LumenPlayer, track: ReturnType<typeof fakeCueTrack>) {
    const list = Object.assign([track], { addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(player.videoElement, "textTracks", { value: list, configurable: true });
    return track;
  }

  it("renders active cues into the overlay, not the browser caption box", () => {
    const player = mount();
    const track = attach(player, fakeCueTrack([{ start: 0, end: 5, text: "Hello" }]));

    player.videoElement.dispatchEvent(new Event("loadedmetadata"));
    const overlay = player.shadowRoot!.querySelector(".lumen-captions")!;

    // "hidden" parses cues without the browser drawing them.
    const target = player.textTracks[0]!;
    (player as unknown as { subtitles: { setActiveTrack(t: unknown): void } }).subtitles.setActiveTrack(target);
    expect(track.mode).toBe("hidden");

    track.activeCues = track.cues;
    track.fire("cuechange");
    expect(overlay.textContent).toContain("Hello");
  });

  it("escapes markup in cue text but keeps the permitted tags", () => {
    // Cue text is untrusted: a subtitle file must not be able to inject
    // script, but <b>/<i>/<u> are part of WebVTT.
    const player = mount();
    const track = attach(
      player,
      fakeCueTrack([{ start: 0, end: 5, text: "<b>bold</b> <img src=x onerror=alert(1)>" }]),
    );

    (player as unknown as { subtitles: { setActiveTrack(t: unknown): void } }).subtitles.setActiveTrack(
      player.textTracks[0]!,
    );
    track.activeCues = track.cues;
    track.fire("cuechange");

    const overlay = player.shadowRoot!.querySelector(".lumen-captions")!;
    expect(overlay.querySelector("b")).not.toBeNull();
    expect(overlay.querySelector("img")).toBeNull();
    expect(overlay.textContent).toContain("onerror");
  });

  it("applies styling preferences to the overlay and persists them", () => {
    const player = mount();
    player.setSubtitlePrefs({ fontSize: 1.3, edge: "outline", position: "top", backgroundOpacity: 0.2 });

    const overlay = player.shadowRoot!.querySelector<HTMLElement>(".lumen-captions")!;
    expect(overlay.style.getPropertyValue("--lumen-cue-scale")).toBe("1.3");
    expect(overlay.dataset.edge).toBe("outline");
    expect(overlay.dataset.position).toBe("top");

    expect(player.subtitlePrefs.fontSize).toBe(1.3);
    expect(JSON.parse(localStorage.getItem("lumen-player:subtitle-prefs")!)).toMatchObject({
      fontSize: 1.3,
      edge: "outline",
    });
  });

  it("shifts cue timings by the offset preference", () => {
    const player = mount();
    const track = attach(player, fakeCueTrack([{ start: 10, end: 12, text: "Late" }]));

    (player as unknown as { subtitles: { setActiveTrack(t: unknown): void } }).subtitles.setActiveTrack(
      player.textTracks[0]!,
    );
    player.setSubtitlePrefs({ offsetSeconds: 2 });

    expect(track.cues[0]!.startTime).toBe(12);
    expect(track.cues[0]!.endTime).toBe(14);

    // Changing the offset again shifts relative to the previous value,
    // not cumulatively from the original.
    player.setSubtitlePrefs({ offsetSeconds: 3 });
    expect(track.cues[0]!.startTime).toBe(13);
  });
});

// ----------------------------------------------------- presentation APIs

describe("presentation", () => {
  it("hides the PiP button where the API is unavailable", () => {
    const player = mount();
    const pip = player.shadowRoot!.querySelector<HTMLElement>('[data-action="pip"]')!;
    // jsdom implements no Picture-in-Picture, which is the same situation
    // as a browser that has it disabled.
    expect(pip.hidden).toBe(true);
  });

  it("reports cast as unavailable until a receiver appears", () => {
    const player = mount();
    expect(player.isCastAvailable).toBe(false);
    const cast = player.shadowRoot!.querySelector<HTMLElement>('[data-action="cast"]')!;
    expect(cast.hidden).toBe(true);
  });

  it("shows the cast button when availability is announced", () => {
    const player = mount();
    const cast = player.shadowRoot!.querySelector<HTMLElement>('[data-action="cast"]')!;

    (player as unknown as { emitter: EventEmitter }).emitter.emit("castavailabilitychange", {
      available: true,
    });
    expect(cast.hidden).toBe(false);
  });

  it("requestCast resolves false rather than throwing with no receiver", async () => {
    const player = mount();
    await expect(player.requestCast()).resolves.toBe(false);
  });

  it("requestFullscreen rejects rather than throwing synchronously", async () => {
    const player = mount();
    // jsdom has no fullscreen, which is exactly the iPhone situation: the
    // inherited method doesn't exist. It has to come back as a rejected
    // promise the caller can handle, not an exception at the call site and
    // not a stack overflow from the override calling itself.
    await expect(player.requestFullscreen()).rejects.toThrow(/not available/);
  });

  it("falls back to the iOS video fullscreen path", async () => {
    const player = mount();
    const video = player.videoElement as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    };

    // iPhone: no Element.requestFullscreen at all, only this on the video.
    const enter = vi.fn(() => {
      video.webkitDisplayingFullscreen = true;
    });
    const exit = vi.fn(() => {
      video.webkitDisplayingFullscreen = false;
    });
    video.webkitEnterFullscreen = enter;
    video.webkitExitFullscreen = exit;
    video.webkitDisplayingFullscreen = false;

    await player.requestFullscreen();
    expect(enter).toHaveBeenCalled();
    expect(player.isFullscreen).toBe(true);

    await player.exitFullscreen();
    expect(exit).toHaveBeenCalled();
    expect(player.isFullscreen).toBe(false);
  });

  it("hides the fullscreen button only where nothing at all is supported", () => {
    const player = mount();
    const button = player.shadowRoot!.querySelector<HTMLElement>('[data-action="fullscreen"]')!;
    expect(button.hidden).toBe(true);
  });

  it("requestPictureInPicture rejects where the API is missing", async () => {
    const player = mount();
    await expect(player.requestPictureInPicture()).rejects.toThrow(/not available/);
  });
});

// ------------------------------------------------------------------ DRM

describe("DRM configuration", () => {
  const config = {
    widevine: { licenseUrl: "https://lic/wv", headers: { Authorization: "Bearer x" } },
    playready: { licenseUrl: "https://lic/pr" },
    fairplay: { licenseUrl: "https://lic/fps", certificateUrl: "https://lic/cert" },
  };

  it("reports whether anything is configured", () => {
    const video = document.createElement("video");
    expect(new DrmController(video, {}, () => {}).isConfigured).toBe(false);
    expect(new DrmController(video, config, () => {}).isConfigured).toBe(true);
  });

  it("translates to the shape hls.js expects", () => {
    const controller = new DrmController(document.createElement("video"), config, () => {});
    expect(controller.toHlsConfig()).toEqual({
      "com.widevine.alpha": { licenseUrl: "https://lic/wv" },
      "com.microsoft.playready": { licenseUrl: "https://lic/pr" },
      "com.apple.fps": { licenseUrl: "https://lic/fps", serverCertificateUrl: "https://lic/cert" },
    });
  });

  it("translates to the shape dash.js expects, carrying auth headers", () => {
    const controller = new DrmController(document.createElement("video"), config, () => {});
    const data = controller.toDashProtectionData();

    expect(data["com.widevine.alpha"]).toEqual({
      serverURL: "https://lic/wv",
      httpRequestHeaders: { Authorization: "Bearer x" },
    });
    expect(data["com.apple.fps"]!.serverURL).toBe("https://lic/fps");
  });

  it("emits nothing for key systems that weren't configured", () => {
    const controller = new DrmController(
      document.createElement("video"),
      { widevine: { licenseUrl: "https://lic/wv" } },
      () => {},
    );
    expect(Object.keys(controller.toHlsConfig())).toEqual(["com.widevine.alpha"]);
    expect(Object.keys(controller.toDashProtectionData())).toEqual(["com.widevine.alpha"]);
  });

  it("attaches only when configured, and detaches cleanly", () => {
    const video = document.createElement("video");
    const spy = vi.spyOn(video, "addEventListener");

    const unconfigured = new DrmController(video, {}, () => {});
    unconfigured.attach();
    expect(spy).not.toHaveBeenCalledWith("encrypted", expect.anything());

    const configured = new DrmController(video, config, () => {});
    configured.attach();
    expect(spy).toHaveBeenCalledWith("encrypted", expect.anything());
    expect(() => configured.destroy()).not.toThrow();
  });

  it("is exposed through the player and reaches the engine", () => {
    const player = mount();
    player.drm = { widevine: { licenseUrl: "https://lic/wv" } };
    expect(player.drm.widevine!.licenseUrl).toBe("https://lic/wv");
  });
});
