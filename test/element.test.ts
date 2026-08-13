import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import type { LumenPlayer } from "../src/LumenPlayer";

/**
 * The custom element itself: attributes, playlist behaviour, and teardown.
 * These are the parts an application touches directly, and the ones that
 * have to keep working when values change after mount rather than only
 * being right at first render.
 */

const players: LumenPlayer[] = [];

function mount(attributes: Record<string, string> = {}): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  for (const [name, value] of Object.entries(attributes)) player.setAttribute(name, value);
  document.body.appendChild(player);
  players.push(player);
  return player;
}

afterEach(() => {
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
  vi.restoreAllMocks();
});

describe("attributes", () => {
  it("applies presentation attributes set before mount", () => {
    const player = mount({ theme: "light", "aspect-ratio": "4/3", "object-fit": "contain" });

    expect(player.getAttribute("data-theme")).toBe("light");
    expect(player.style.getPropertyValue("--lumen-aspect-ratio")).toBe("4 / 3");
    expect(player.style.getPropertyValue("--lumen-object-fit")).toBe("contain");
  });

  it("defaults to the dark theme", () => {
    expect(mount().getAttribute("data-theme")).toBe("dark");
  });

  it("reacts to attributes changed after mount", () => {
    const player = mount();
    player.setAttribute("theme", "light");
    player.setAttribute("aspect-ratio", "21/9");

    expect(player.getAttribute("data-theme")).toBe("light");
    expect(player.style.getPropertyValue("--lumen-aspect-ratio")).toBe("21 / 9");
  });

  it("removing a presentation attribute undoes it", () => {
    // Setting the property and never clearing it made the shape permanent.
    const player = mount({ "aspect-ratio": "4/3", "object-fit": "cover" });
    player.removeAttribute("aspect-ratio");
    player.removeAttribute("object-fit");

    expect(player.style.getPropertyValue("--lumen-aspect-ratio")).toBe("");
    expect(player.style.getPropertyValue("--lumen-object-fit")).toBe("");
  });

  it("mirrors media attributes onto the video element", () => {
    const player = mount({ loop: "", muted: "", autoplay: "", preload: "none", crossorigin: "use-credentials" });
    const video = player.videoElement;

    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.preload).toBe("none");
    expect(video.crossOrigin).toBe("use-credentials");
    // Always inline: the custom UI can't survive the system player taking over.
    expect(video.playsInline).toBe(true);
  });

  it("toggles media attributes after mount", () => {
    const player = mount();
    player.setAttribute("muted", "");
    expect(player.videoElement.muted).toBe(true);
    player.removeAttribute("muted");
    expect(player.videoElement.muted).toBe(false);
  });

  it("defaults preload to metadata so the duration is known without a download", () => {
    expect(mount().videoElement.preload).toBe("metadata");
  });

  it("loads a new chapter track when the attribute changes", async () => {
    // Observed but unhandled: the old chapters used to stay.
    const player = mount();
    player.setChapters([{ start: 0, end: 10, title: "Old" }]);
    expect(player.chapters).toHaveLength(1);

    player.setAttribute("chapters", "https://cdn/new.vtt");
    expect(player.chapters).toHaveLength(0);
    expect(player.videoElement.querySelector('track[kind="chapters"]')?.getAttribute("src")).toBe(
      "https://cdn/new.vtt",
    );
  });

  it("picks up a src set as an attribute", async () => {
    const player = mount();
    const load = vi.spyOn(player, "load");
    player.setAttribute("src", "https://cdn/a.mp4");
    expect(load).toHaveBeenCalledWith([{ src: "https://cdn/a.mp4" }]);
  });
});

describe("light DOM", () => {
  it("collects <source> children as a fallback list", () => {
    const player = document.createElement("lumen-player") as LumenPlayer;
    player.innerHTML = `<source src="a.webm"><source src="b.mp4">`;
    document.body.appendChild(player);
    players.push(player);

    const load = vi.spyOn(player, "load");
    player.setAttribute("src", "c.mp4");
    // The attribute leads, then the declared fallbacks.
    expect(load.mock.calls[0]![0]).toEqual([{ src: "c.mp4" }, { src: "a.webm", type: "auto" }, { src: "b.mp4", type: "auto" }]);
  });

  it("adopts <track> children as subtitle tracks", () => {
    const player = document.createElement("lumen-player") as LumenPlayer;
    player.innerHTML = `<track src="en.vtt" srclang="en" label="English" default>`;
    document.body.appendChild(player);
    players.push(player);

    expect(player.videoElement.querySelector("track")?.getAttribute("srclang")).toBe("en");
  });
});

describe("playlist", () => {
  const ITEMS = [
    { src: "a.mp4", title: "First", thumbnails: "a.vtt" },
    { src: "b.mp4", title: "Second" },
    { src: "c.mp4", title: "Third" },
  ];

  it("loads the first item and exposes the queue", () => {
    const player = mount();
    player.playlist = ITEMS;

    expect(player.playlist).toHaveLength(3);
    expect(player.playlistIndex).toBe(0);
  });

  it("shows the next/previous buttons only when they can do something", () => {
    const player = mount();
    const next = player.shadowRoot!.querySelector<HTMLElement>('[data-action="next"]')!;
    const previous = player.shadowRoot!.querySelector<HTMLElement>('[data-action="previous"]')!;
    expect(next.hidden).toBe(true);

    player.playlist = ITEMS;
    expect(next.hidden).toBe(false);
    expect(previous.hasAttribute("disabled")).toBe(true);

    player.next();
    expect(previous.hasAttribute("disabled")).toBe(false);
  });

  it("advances when an item ends, and stops at the last one", () => {
    const player = mount();
    player.playlist = ITEMS;
    const changes: number[] = [];
    player.on("playlistitemchange", ({ index }) => changes.push(index));

    player.videoElement.dispatchEvent(new Event("ended"));
    expect(player.playlistIndex).toBe(1);

    player.videoElement.dispatchEvent(new Event("ended"));
    expect(player.playlistIndex).toBe(2);

    // Nothing left to advance to.
    player.videoElement.dispatchEvent(new Event("ended"));
    expect(player.playlistIndex).toBe(2);
    expect(changes).toEqual([1, 2]);
  });

  it("does not advance a looping video", () => {
    const player = mount({ loop: "" });
    player.playlist = ITEMS;
    player.videoElement.dispatchEvent(new Event("ended"));
    expect(player.playlistIndex).toBe(0);
  });

  it("ignores an out-of-range index rather than clearing the player", async () => {
    const player = mount();
    player.playlist = ITEMS;
    await player.playItem(99);
    expect(player.playlistIndex).toBe(0);
  });

  it("drops the previous item's thumbnails when the next has none", async () => {
    // Otherwise item two shows item one's frames on hover.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nt.jpg\n")));
    const player = mount();
    player.playlist = ITEMS;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await player.playItem(1);
    const controls = player as unknown as { controls: { thumbnails: unknown } };
    expect(controls.controls.thumbnails).toBeNull();
  });

  it("clears the previous item's chapters and subtitles", async () => {
    const player = mount();
    player.playlist = [
      { src: "a.mp4", chapters: "a.vtt", tracks: [{ src: "a-en.vtt", label: "English", srclang: "en" }] },
      { src: "b.mp4" },
    ];
    player.setChapters([{ start: 0, end: 5, title: "Intro" }]);

    await player.playItem(1);
    expect(player.chapters).toHaveLength(0);
    expect(player.videoElement.querySelectorAll("track")).toHaveLength(0);
  });

  it("replacing the playlist restarts from its first item", () => {
    const player = mount();
    player.playlist = ITEMS;
    player.next();
    expect(player.playlistIndex).toBe(1);

    player.playlist = [{ src: "x.mp4" }];
    expect(player.playlistIndex).toBe(0);
    expect(player.playlist).toHaveLength(1);
  });

  it("previous() at the start is a no-op", () => {
    const player = mount();
    player.playlist = ITEMS;
    player.previous();
    expect(player.playlistIndex).toBe(0);
  });
});

describe("teardown", () => {
  it("destroy() is idempotent and leaves the element inert", () => {
    const player = mount();
    player.playlist = [{ src: "a.mp4" }];

    expect(() => {
      player.destroy();
      player.destroy();
    }).not.toThrow();

    // Nothing should still be reacting.
    expect(() => player.videoElement.dispatchEvent(new Event("ended"))).not.toThrow();
  });

  it("re-appending an element does not build a second set of controls", () => {
    const player = mount();
    const before = player.shadowRoot!.querySelectorAll(".lumen-controls").length;

    player.remove();
    document.body.appendChild(player);

    expect(player.shadowRoot!.querySelectorAll(".lumen-controls")).toHaveLength(before);
  });
});
