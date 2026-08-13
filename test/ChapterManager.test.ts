import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { ChapterManager } from "../src/media/ChapterManager";
import type { LumenChapter } from "../src/types";

function setup() {
  const video = document.createElement("video");
  const emitter = new EventEmitter();
  const manager = new ChapterManager(video, emitter);
  return { video, emitter, manager };
}

const chapters: LumenChapter[] = [
  { start: 0, end: 30, title: "Intro" },
  { start: 30, end: 90, title: "Main topic" },
  { start: 90, end: 120, title: "Outro" },
];

describe("ChapterManager", () => {
  it("starts with no chapters", () => {
    expect(setup().manager.chapters).toEqual([]);
  });

  it("setChapters emits chapterschange", () => {
    const { manager, emitter } = setup();
    const spy = vi.fn();
    emitter.on("chapterschange", spy);

    manager.setChapters(chapters);

    expect(manager.chapters).toHaveLength(3);
    expect(spy).toHaveBeenCalledWith({ chapters: manager.chapters });
  });

  it("sorts chapters by start time regardless of input order", () => {
    const { manager } = setup();
    manager.setChapters([chapters[2]!, chapters[0]!, chapters[1]!]);
    expect(manager.chapters.map((c) => c.title)).toEqual(["Intro", "Main topic", "Outro"]);
  });

  it("resolves the chapter containing a given time", () => {
    const { manager } = setup();
    manager.setChapters(chapters);

    expect(manager.chapterAt(0)?.title).toBe("Intro");
    expect(manager.chapterAt(29.9)?.title).toBe("Intro");
    // A time exactly on a boundary belongs to the chapter it starts.
    expect(manager.chapterAt(30)?.title).toBe("Main topic");
    expect(manager.chapterAt(95)?.title).toBe("Outro");
  });

  it("returns the last chapter for times past the end, not null", () => {
    const { manager } = setup();
    manager.setChapters(chapters);
    expect(manager.chapterAt(9999)?.title).toBe("Outro");
  });

  it("returns null when the time precedes the first chapter", () => {
    const { manager } = setup();
    manager.setChapters([{ start: 10, end: 20, title: "Late start" }]);
    expect(manager.chapterAt(5)).toBeNull();
  });

  it("adds a chapters track element with kind=chapters", () => {
    const { video, manager } = setup();
    manager.addTrackElement("chapters.vtt", "Chapters", "en");

    const track = video.querySelector("track");
    expect(track?.getAttribute("kind")).toBe("chapters");
    expect(track?.getAttribute("src")).toBe("chapters.vtt");
  });

  it("destroy() leaves the manager safe to query", () => {
    const { manager } = setup();
    manager.setChapters(chapters);
    expect(() => manager.destroy()).not.toThrow();
    expect(manager.chapters).toHaveLength(3);
  });
});
