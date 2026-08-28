import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioController, MAX_AUDIO_DELAY_MS, MAX_BOOST, canRouteThroughWebAudio } from "../src/audio/AudioController";
import { EQ_FREQUENCIES, EQ_GAIN_LIMIT, EQ_PRESETS, bandQ, findPreset, presetIdForGains } from "../src/audio/presets";

/**
 * jsdom has no Web Audio implementation, so these exercise the half that
 * matters to the API: the state machine, its clamping and its persistence.
 * The node graph is verified in a real browser by the smoke suite.
 */

function makeVideo(src = "https://example.com/movie.mp4"): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentSrc", { value: src, configurable: true });
  return video;
}

describe("equalizer presets", () => {
  it("ships all eighteen of VLC's presets", () => {
    expect(EQ_PRESETS).toHaveLength(18);
    expect(EQ_PRESETS.map((preset) => preset.id)).toContain("fullbasstreble");
    for (const preset of EQ_PRESETS) {
      expect(preset.gains).toHaveLength(EQ_FREQUENCIES.length);
    }
  });

  it("uses VLC's ten centre frequencies", () => {
    expect([...EQ_FREQUENCIES]).toEqual([60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]);
  });

  it("re-bases preamps so flat is unity and boosted presets make headroom", () => {
    expect(findPreset("flat")!.preamp).toBe(0);
    expect(findPreset("flat")!.gains.every((gain) => gain === 0)).toBe(true);
    // Full treble pushes four bands to +16 dB, so it pulls the preamp down.
    expect(findPreset("fulltreble")!.preamp).toBeLessThan(0);
    expect(findPreset("rock")!.gains[0]).toBe(8);
  });

  it("matches a curve back to the preset it came from", () => {
    const rock = findPreset("rock")!;
    expect(presetIdForGains(rock.gains, rock.preamp)).toBe("rock");

    const nudged = [...rock.gains];
    nudged[3] = (nudged[3] ?? 0) + 2;
    expect(presetIdForGains(nudged, rock.preamp)).toBeNull();
  });

  it("gives the crowded top bands a narrower Q than the wide low ones", () => {
    // 12k, 14k and 16k sit close together; 60 Hz has the whole bottom end.
    expect(bandQ(8)).toBeGreaterThan(bandQ(0));
    for (let i = 0; i < EQ_FREQUENCIES.length; i++) {
      expect(bandQ(i)).toBeGreaterThanOrEqual(0.3);
      expect(bandQ(i)).toBeLessThanOrEqual(6);
    }
  });

  it("returns null for a preset that doesn't exist", () => {
    expect(findPreset("dubstep")).toBeNull();
  });
});

describe("AudioController state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts at passthrough, with nothing engaged", () => {
    const audio = new AudioController(makeVideo());

    expect(audio.isPassthrough()).toBe(true);
    expect(audio.isActive).toBe(false);
    expect(audio.effects.boost).toBe(1);
    expect(audio.effects.bands).toHaveLength(10);
  });

  it("clamps every value to the range the UI offers", () => {
    const audio = new AudioController(makeVideo());
    audio.set({ preamp: 99, boost: 12, delayMs: 99999, bands: new Array(10).fill(-99) });

    expect(audio.effects.preamp).toBe(EQ_GAIN_LIMIT);
    expect(audio.effects.boost).toBe(MAX_BOOST);
    expect(audio.effects.delayMs).toBe(MAX_AUDIO_DELAY_MS);
    expect(audio.effects.bands.every((gain) => gain === -EQ_GAIN_LIMIT)).toBe(true);
  });

  it("clamps a negative audio delay to zero, which is the only direction possible", () => {
    const audio = new AudioController(makeVideo());
    audio.set({ delayMs: -500 });
    expect(audio.effects.delayMs).toBe(0);
  });

  it("loads a preset's whole curve and turns the equalizer on", () => {
    const audio = new AudioController(makeVideo());
    expect(audio.setPreset("techno")).toBe(true);

    expect(audio.effects.preset).toBe("techno");
    expect(audio.effects.equalizer).toBe(true);
    expect(audio.effects.bands[0]).toBe(8);
    expect(audio.isPassthrough()).toBe(false);
  });

  it("reports a hand-edited curve as custom", () => {
    const audio = new AudioController(makeVideo());
    audio.setPreset("rock");

    const bands = [...audio.effects.bands];
    bands[5] = 1.5;
    audio.set({ bands });

    expect(audio.effects.preset).toBeNull();
  });

  it("hands back a copy, so the caller can't mutate its state", () => {
    const audio = new AudioController(makeVideo());
    const snapshot = audio.effects;
    snapshot.bands[0] = 15;
    snapshot.boost = 3;

    expect(audio.effects.bands[0]).toBe(0);
    expect(audio.effects.boost).toBe(1);
  });

  it("persists settings and restores them for the next player", () => {
    const first = new AudioController(makeVideo());
    first.set({ boost: 1.5, stereo: "mono", normalize: true });

    const second = new AudioController(makeVideo());
    expect(second.effects.boost).toBe(1.5);
    expect(second.effects.stereo).toBe("mono");
    expect(second.effects.normalize).toBe(true);
  });

  it("repairs a stored band array of the wrong length", () => {
    window.localStorage.setItem(
      "lumen-player:audio-effects",
      JSON.stringify({ bands: [3, 3, 3], boost: 1 }),
    );
    const audio = new AudioController(makeVideo());

    expect(audio.effects.bands).toHaveLength(10);
    expect(audio.effects.bands.slice(0, 3)).toEqual([3, 3, 3]);
    expect(audio.effects.bands[9]).toBe(0);
  });

  it("resets back to passthrough", () => {
    const audio = new AudioController(makeVideo());
    audio.set({ boost: 2, delayMs: 300, normalize: true, stereo: "swap" });
    audio.reset();

    expect(audio.isPassthrough()).toBe(true);
  });

  it("treats an equalizer switched on with a flat curve as passthrough", () => {
    const audio = new AudioController(makeVideo());
    audio.set({ equalizer: true });
    expect(audio.isPassthrough()).toBe(true);
  });

  it("has no frequency data before a graph exists", () => {
    const audio = new AudioController(makeVideo());
    expect(audio.getFrequencyData(new Uint8Array(64))).toBe(false);
    expect(audio.frequencyBinCount).toBe(0);
  });
});

describe("Web Audio availability", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", class {});
  });

  it("allows same-origin media", () => {
    expect(canRouteThroughWebAudio(makeVideo(`${window.location.origin}/movie.mp4`))).toBe(true);
  });

  it("allows blob and data URLs, which every remuxed format uses", () => {
    expect(canRouteThroughWebAudio(makeVideo("blob:http://localhost/abc"))).toBe(true);
    expect(canRouteThroughWebAudio(makeVideo("data:video/mp4;base64,AAA"))).toBe(true);
  });

  it("refuses cross-origin media without CORS, which Web Audio would silence", () => {
    expect(canRouteThroughWebAudio(makeVideo("https://cdn.example.com/movie.mp4"))).toBe(false);
  });

  it("allows cross-origin media once crossorigin is set", () => {
    const video = makeVideo("https://cdn.example.com/movie.mp4");
    video.crossOrigin = "anonymous";
    expect(canRouteThroughWebAudio(video)).toBe(true);
  });

  it("says no when the browser has no AudioContext at all", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    expect(canRouteThroughWebAudio(makeVideo())).toBe(false);
  });
});
