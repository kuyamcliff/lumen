import { beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { SubtitleManager } from "../src/subtitles/SubtitleManager";
import { DEFAULT_SUBTITLE_PREFS } from "../src/types";

// jsdom doesn't implement HTMLMediaElement's text-track pipeline (neither
// addTextTrack() nor <track> → video.textTracks reflection), so track-list
// behavior is exercised against hand-built TextTrack/TextTrackList doubles
// that behave like the real spec objects SubtitleManager depends on.
function fakeTrack(kind: TextTrackKind, label: string, language: string): TextTrack {
  let mode: TextTrackMode = "disabled";
  return {
    kind,
    label,
    language,
    activeCues: null,
    cues: null,
    get mode() {
      return mode;
    },
    set mode(value: TextTrackMode) {
      mode = value;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as TextTrack;
}

function fakeTextTrackList(tracks: TextTrack[]): TextTrackList {
  const list = tracks.slice() as unknown as TextTrackList;
  (list as unknown as { addEventListener: () => void }).addEventListener = () => {};
  (list as unknown as { removeEventListener: () => void }).removeEventListener = () => {};
  return list;
}

function setup(tracks: TextTrack[] = []) {
  const video = document.createElement("video");
  Object.defineProperty(video, "textTracks", { value: fakeTextTrackList(tracks), configurable: true });
  const overlay = document.createElement("div");
  const emitter = new EventEmitter();
  const manager = new SubtitleManager(video, overlay, emitter);
  return { video, overlay, manager, emitter };
}

describe("SubtitleManager", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts with default styling preferences", () => {
    const { manager } = setup();
    expect(manager.prefs).toEqual(DEFAULT_SUBTITLE_PREFS);
  });

  it("addTrack() appends a <track> element with the right attributes", () => {
    const { video, manager } = setup();
    manager.addTrack({ src: "en.vtt", label: "English", srclang: "en", kind: "subtitles" });

    const track = video.querySelector("track");
    expect(track).not.toBeNull();
    expect(track?.getAttribute("src")).toBe("en.vtt");
    expect(track?.getAttribute("label")).toBe("English");
    expect(track?.getAttribute("srclang")).toBe("en");
  });

  it("tracks only lists subtitle/caption kinds", () => {
    const english = fakeTrack("subtitles", "English", "en");
    const notes = fakeTrack("metadata", "Notes", "en");
    const { manager } = setup([english, notes]);

    expect(manager.tracks).toHaveLength(1);
    expect(manager.tracks[0]?.label).toBe("English");
  });

  it("setActiveTrack() sets the track mode to hidden and emits texttrackchange", () => {
    const english = fakeTrack("subtitles", "English", "en");
    const { manager, emitter } = setup([english]);

    let changed: unknown;
    emitter.on("texttrackchange", (d) => (changed = d));

    manager.setActiveTrack(english);
    expect(english.mode).toBe("hidden");
    expect(manager.current).toBe(english);
    expect(changed).toEqual({ track: english });

    manager.setActiveTrack(null);
    expect(english.mode).toBe("disabled");
    expect(manager.current).toBeNull();
  });

  it("setPrefs() merges and persists preferences", () => {
    const { manager } = setup();
    manager.setPrefs({ fontSize: 1.3, edge: "outline" });

    expect(manager.prefs.fontSize).toBe(1.3);
    expect(manager.prefs.edge).toBe("outline");
    expect(manager.prefs.color).toBe(DEFAULT_SUBTITLE_PREFS.color);

    const raw = window.localStorage.getItem("lumen-player:subtitle-prefs");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ fontSize: 1.3, edge: "outline" });
  });

  it("a fresh manager restores persisted preferences", () => {
    const first = setup();
    first.manager.setPrefs({ fontSize: 1.3 });

    const second = setup();
    expect(second.manager.prefs.fontSize).toBe(1.3);
  });
});
