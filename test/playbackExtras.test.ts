import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";
import { LoopController } from "../src/media/LoopController";
import { PositionMemory } from "../src/media/PositionMemory";
import { classifyFile, extensionOf, languageFromFilename, sortFiles, titleFromFilename } from "../src/media/files";
import { snapshotFilename } from "../src/media/Snapshot";

/**
 * jsdom's `<video>` has no media pipeline, so `currentTime` is writable but
 * inert. That's exactly what these need: the loop and position logic is
 * pure bookkeeping over the element's clock.
 */
function makeVideo(): HTMLVideoElement & { fire(type: string): void } {
  const video = document.createElement("video") as HTMLVideoElement & { fire(type: string): void };
  video.fire = (type: string) => video.dispatchEvent(new Event(type));
  return video;
}

describe("A-B loop", () => {
  it("cycles A, then B, then off", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());

    video.currentTime = 10;
    expect(loop.cycle()).toBe("a-set");
    expect(loop.abLoop).toEqual({ start: 10, end: null });

    video.currentTime = 25;
    expect(loop.cycle()).toBe("b-set");
    expect(loop.abLoop).toEqual({ start: 10, end: 25 });

    expect(loop.cycle()).toBe("cleared");
    expect(loop.abLoop).toBeNull();
  });

  it("swaps the points when B is marked behind A", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());

    video.currentTime = 40;
    loop.cycle();
    video.currentTime = 15;
    loop.cycle();

    expect(loop.abLoop).toEqual({ start: 15, end: 40 });
  });

  it("jumps back to A when playback reaches B", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());
    loop.set({ start: 5, end: 8 });

    video.currentTime = 8.1;
    video.fire("timeupdate");
    expect(video.currentTime).toBe(5);
  });

  it("pulls a seek that lands before A back into the loop", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());
    loop.set({ start: 30, end: 40 });

    video.currentTime = 2;
    video.fire("timeupdate");
    expect(video.currentTime).toBe(30);
  });

  it("leaves playback alone while only A is marked", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());
    loop.set({ start: 5, end: null });

    video.currentTime = 90;
    video.fire("timeupdate");
    expect(video.currentTime).toBe(90);
  });

  it("announces every change through the emitter", () => {
    const video = makeVideo();
    const emitter = new EventEmitter();
    const seen: Array<{ loop: { start: number; end: number | null } | null }> = [];
    emitter.on("abloopchange", (detail) => seen.push(detail));

    const loop = new LoopController(video, emitter);
    loop.cycle();
    loop.cycle();
    loop.clear();

    expect(seen).toHaveLength(3);
    expect(seen[2]?.loop).toBeNull();
  });

  it("stops enforcing the loop once destroyed", () => {
    const video = makeVideo();
    const loop = new LoopController(video, new EventEmitter());
    loop.set({ start: 5, end: 8 });
    loop.destroy();

    video.currentTime = 20;
    video.fire("timeupdate");
    expect(video.currentTime).toBe(20);
  });
});

describe("PositionMemory", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keys on the URL without its query string, so signed links still match", () => {
    const a = PositionMemory.keyFor("https://cdn.example.com/a/movie.mp4?token=111&expires=1");
    const b = PositionMemory.keyFor("https://cdn.example.com/a/movie.mp4?token=222&expires=2");
    expect(a).toBe(b);
    expect(a).toBe("https://cdn.example.com/a/movie.mp4");
  });

  it("refuses to key on a blob URL, which identifies nothing across loads", () => {
    expect(PositionMemory.keyFor("blob:http://localhost/2b7c")).toBeNull();
    expect(PositionMemory.keyFor("data:video/mp4;base64,AA")).toBeNull();
  });

  it("offers a resume point once enough has been watched", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.save(600, 3600);

    expect(memory.resumePosition(3600)).toBe(600);
  });

  it("ignores a file that barely started", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.save(4, 3600);

    expect(memory.resumePosition(3600)).toBeNull();
  });

  it("ignores a file that already reached its end", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.save(3595, 3600);

    expect(memory.resumePosition(3600)).toBeNull();
  });

  it("forgets the position when a file finishes", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.save(600, 3600);
    memory.clearPosition();

    expect(memory.resumePosition(3600)).toBeNull();
  });

  it("keeps bookmarks when the position is cleared", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.addBookmark({ time: 120, label: "2:00" });
    memory.save(600, 3600);
    memory.clearPosition();

    expect(memory.bookmarks).toHaveLength(1);
    expect(memory.resumePosition(3600)).toBeNull();
  });

  it("keeps bookmarks sorted and removes them by time", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/film.mp4");
    memory.addBookmark({ time: 300, label: "later" });
    memory.addBookmark({ time: 60, label: "earlier" });

    expect(memory.bookmarks.map((b) => b.label)).toEqual(["earlier", "later"]);

    memory.removeBookmark(60);
    expect(memory.bookmarks.map((b) => b.label)).toEqual(["later"]);
  });

  it("keeps each file's memory separate", () => {
    const memory = new PositionMemory();
    memory.track("https://example.com/one.mp4");
    memory.save(300, 3600);
    memory.track("https://example.com/two.mp4");

    expect(memory.resumePosition(3600)).toBeNull();
    memory.track("https://example.com/one.mp4");
    expect(memory.resumePosition(3600)).toBe(300);
  });

  it("stores nothing for an untracked source", () => {
    const memory = new PositionMemory();
    memory.save(600, 3600);
    expect(memory.bookmarks).toEqual([]);
  });

  it("evicts the oldest entries rather than growing without bound", () => {
    const memory = new PositionMemory();
    for (let i = 0; i < 80; i++) {
      memory.track(`https://example.com/film-${i}.mp4`);
      memory.save(300, 3600);
    }

    const stored = JSON.parse(window.localStorage.getItem("lumen-player:positions") ?? "{}");
    expect(Object.keys(stored).length).toBeLessThanOrEqual(60);
    // The most recent survives.
    memory.track("https://example.com/film-79.mp4");
    expect(memory.resumePosition(3600)).toBe(300);
  });
});

describe("local file handling", () => {
  const file = (name: string, type = "") => new File([new Uint8Array([1, 2, 3])], name, { type });

  it("classifies by extension, which is more reliable than the OS MIME type", () => {
    // Most systems report no MIME at all for .mkv.
    expect(classifyFile(file("show.mkv"))).toBe("media");
    expect(classifyFile(file("show.avi"))).toBe("media");
    expect(classifyFile(file("show.srt", "text/plain"))).toBe("subtitle");
    expect(classifyFile(file("notes.pdf", "application/pdf"))).toBe("unknown");
  });

  it("falls back to the MIME type when the extension is unfamiliar", () => {
    expect(classifyFile(file("clip.weird", "video/mp4"))).toBe("media");
  });

  it("splits a drop into media, subtitles and the rest", () => {
    const sorted = sortFiles([file("b.mp4"), file("a.srt"), file("c.txt"), file("readme.pdf")]);

    expect(sorted.media.map((f) => f.name)).toEqual(["b.mp4"]);
    // .txt is treated as a subtitle: that's what an unlabelled SRT is.
    expect(sorted.subtitles.map((f) => f.name).sort()).toEqual(["a.srt", "c.txt"]);
    expect(sorted.rejected.map((f) => f.name)).toEqual(["readme.pdf"]);
  });

  it("queues episodes in natural order, not the order the OS handed them over", () => {
    const sorted = sortFiles([file("ep10.mkv"), file("ep2.mkv"), file("ep1.mkv")]);
    expect(sorted.media.map((f) => f.name)).toEqual(["ep1.mkv", "ep2.mkv", "ep10.mkv"]);
  });

  it("derives a readable title from a filename", () => {
    expect(titleFromFilename("The.Big.Movie.2019.1080p.mkv")).toBe("The Big Movie 2019 1080p");
    expect(titleFromFilename("holiday_clip.mp4")).toBe("holiday clip");
  });

  it("picks a language out of a subtitle filename", () => {
    expect(languageFromFilename("movie.en.srt")).toBe("en");
    expect(languageFromFilename("movie.fre.srt")).toBe("fre");
    // The subtitle extension itself is never a language code.
    expect(languageFromFilename("movie.srt")).toBeNull();
  });

  it("reads extensions case-insensitively", () => {
    expect(extensionOf("MOVIE.MKV")).toBe("mkv");
    expect(classifyFile(file("MOVIE.MKV"))).toBe("media");
  });
});

describe("snapshot naming", () => {
  it("stamps the filename with the capture time", () => {
    vi.setSystemTime(new Date("2026-03-04T05:06:07Z"));
    expect(snapshotFilename()).toBe("lumen-snapshot-2026-03-04-05-06-07.png");
    vi.useRealTimers();
  });

  it("uses the right extension for the requested type", () => {
    expect(snapshotFilename("image/jpeg")).toMatch(/\.jpg$/);
    expect(snapshotFilename("image/webp")).toMatch(/\.webp$/);
  });
});
