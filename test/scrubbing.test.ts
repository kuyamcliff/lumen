import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import type { LumenPlayer } from "../src/LumenPlayer";

/**
 * The progress bar: seeking, the hover preview, and the arithmetic behind
 * both. jsdom lays nothing out, so every test here gives the bar an
 * explicit rectangle and drives real pointer events over it.
 */

const players: LumenPlayer[] = [];

function mount(duration = 100): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  document.body.appendChild(player);
  players.push(player);
  setDuration(player, duration);
  return player;
}

function setDuration(player: LumenPlayer, duration: number): void {
  Object.defineProperty(player.videoElement, "duration", { value: duration, configurable: true });
}

const bar = (player: LumenPlayer) => player.shadowRoot!.querySelector<HTMLElement>('[data-el="progress"]')!;

/** jsdom reports a zero-size rect for everything, so the bar needs one. */
function sized(element: HTMLElement, width = 200, left = 0): HTMLElement {
  element.getBoundingClientRect = () =>
    ({ left, top: 0, right: left + width, bottom: 10, width, height: 10, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  // Pointer capture isn't implemented in jsdom.
  let captured: number | null = null;
  element.setPointerCapture = (id: number) => {
    captured = id;
  };
  element.releasePointerCapture = (id: number) => {
    if (captured !== id) throw new Error("InvalidPointerId");
    captured = null;
  };
  element.hasPointerCapture = (id: number) => captured === id;
  return element;
}

function pointer(element: HTMLElement, type: string, clientX: number, pointerId = 1): void {
  const event = new Event(type, { bubbles: true, composed: true }) as Event & {
    clientX: number;
    pointerId: number;
  };
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  element.dispatchEvent(event);
}

function press(element: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, composed: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
  vi.restoreAllMocks();
});

describe("scrubbing", () => {
  it("seeks to the position that was clicked", () => {
    const player = mount(100);
    const track = sized(bar(player));

    pointer(track, "pointerdown", 50); // a quarter along a 200px bar
    expect(player.currentTime).toBe(25);
  });

  it("clamps a drag past either end of the bar", () => {
    const player = mount(100);
    const track = sized(bar(player));

    pointer(track, "pointerdown", 100);
    pointer(track, "pointermove", -500);
    expect(player.currentTime).toBe(0);

    pointer(track, "pointermove", 9999);
    expect(player.currentTime).toBe(100);
  });

  it("pauses while scrubbing and resumes only if it had been playing", () => {
    const player = mount(100);
    const track = sized(bar(player));
    const video = player.videoElement;
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    Object.defineProperty(video, "paused", { value: false, configurable: true });

    pointer(track, "pointerdown", 100);
    expect(pause).toHaveBeenCalled();

    pointer(track, "pointerup", 100);
    expect(play).toHaveBeenCalled();
  });

  it("stays paused after scrubbing a paused video", () => {
    const player = mount(100);
    const track = sized(bar(player));
    const play = vi.spyOn(player.videoElement, "play").mockResolvedValue(undefined);

    pointer(track, "pointerdown", 100);
    pointer(track, "pointerup", 100);
    expect(play).not.toHaveBeenCalled();
  });

  it("survives a cancelled pointer, which has already released its capture", () => {
    // Releasing a pointer that isn't captured throws.
    const player = mount(100);
    const track = sized(bar(player));

    pointer(track, "pointerdown", 100);
    track.releasePointerCapture(1); // what the browser does on cancel
    expect(() => pointer(track, "pointercancel", 100)).not.toThrow();
  });

  it("ignores a bar that has no width yet", () => {
    // Before layout every coordinate is zero, and dividing by that width
    // produces NaN, which throws when assigned to currentTime.
    const player = mount(100);
    const track = bar(player);
    expect(() => pointer(track, "pointerdown", 10)).not.toThrow();
    expect(player.currentTime).toBe(0);
  });

  it("does not seek before a duration is known", () => {
    const player = mount(NaN);
    const track = sized(bar(player));
    expect(() => pointer(track, "pointerdown", 100)).not.toThrow();
    expect(player.currentTime).toBe(0);
  });
});

describe("live streams", () => {
  /** A live stream reports Infinity for duration and a seekable window. */
  function live(player: LumenPlayer, end: number): void {
    setDuration(player, Infinity);
    Object.defineProperty(player.videoElement, "seekable", {
      value: { length: 1, start: () => 0, end: () => end },
      configurable: true,
    });
  }

  it("scrubs within the seekable window instead of throwing", () => {
    // duration is Infinity here, so every ratio calculation used to come
    // out Infinity or NaN — and assigning NaN to currentTime throws.
    const player = mount();
    live(player, 60);
    const track = sized(bar(player));

    expect(() => pointer(track, "pointerdown", 100)).not.toThrow();
    expect(player.currentTime).toBe(30);
  });

  it("End jumps to the live edge", () => {
    const player = mount();
    live(player, 60);
    const track = sized(bar(player));

    press(track, "End");
    expect(player.currentTime).toBe(60);
  });

  it("reports a finite progress percentage", () => {
    const player = mount();
    live(player, 60);
    player.videoElement.dispatchEvent(new Event("timeupdate"));

    const value = bar(player).getAttribute("aria-valuenow");
    expect(Number.isFinite(Number(value))).toBe(true);
  });
});

describe("keyboard seeking on the bar", () => {
  it("steps by 5 seconds, or 10 with shift — once, not once per handler", () => {
    // The player-wide shortcut handler also acts on arrows. Its guard read
    // `document.activeElement`, which stops at the shadow host, so it
    // never recognised the focused bar and every press seeked twice.
    const player = mount(100);
    const track = sized(bar(player));
    track.focus();

    press(track, "ArrowRight");
    expect(player.currentTime).toBe(5);

    press(track, "ArrowRight", true);
    expect(player.currentTime).toBe(15);

    press(track, "ArrowLeft");
    expect(player.currentTime).toBe(10);
  });

  it("clamps at both ends and handles Home", () => {
    const player = mount(100);
    const track = sized(bar(player));
    track.focus();

    press(track, "ArrowLeft");
    expect(player.currentTime).toBe(0);

    player.seek(98);
    press(track, "ArrowRight");
    expect(player.currentTime).toBe(100);

    press(track, "Home");
    expect(player.currentTime).toBe(0);
  });

  it("leaves the volume slider's own arrow handling alone", () => {
    // Same shadow-root focus problem: the slider moves itself, and the
    // player-wide handler used to move it a second time.
    const player = mount(100);
    const slider = player.shadowRoot!.querySelector<HTMLInputElement>('[data-el="volume"]')!;
    slider.focus();
    // Not 1: clamping at the top would hide a stray adjustment.
    player.volume = 0.5;

    press(slider, "ArrowUp");
    expect(player.volume).toBe(0.5);
  });

  it("leaves keys it doesn't handle alone", () => {
    const player = mount(100);
    const track = sized(bar(player));
    track.focus();
    expect(press(track, "Tab").defaultPrevented).toBe(false);
    expect(press(track, "ArrowRight").defaultPrevented).toBe(true);
  });
});

describe("hover preview", () => {
  const SPRITE_VTT = `WEBVTT

00:00:00.000 --> 00:00:50.000
sprite.jpg#xywh=0,0,160,90

00:00:50.000 --> 00:01:40.000
sprite.jpg#xywh=160,0,160,90
`;

  const PLAIN_VTT = `WEBVTT

00:00:00.000 --> 00:00:50.000
frame-1.jpg

00:00:50.000 --> 00:01:40.000
frame-2.jpg
`;

  async function withThumbnails(vtt: string): Promise<LumenPlayer> {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(vtt, { status: 200 })));
    const player = mount(100);
    player.setAttribute("thumbnails", "https://cdn/thumbs.vtt");
    await vi.waitFor(() =>
      expect(
        player.shadowRoot!.querySelector<HTMLImageElement>('[data-el="preview-img"]'),
      ).not.toBeNull(),
    );
    // Let the fetch and parse settle before hovering.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return player;
  }

  const previewImg = (player: LumenPlayer) =>
    player.shadowRoot!.querySelector<HTMLImageElement>('[data-el="preview-img"]')!;

  it("shows the time and reveals the preview on hover", () => {
    const player = mount(100);
    const track = sized(bar(player));
    pointer(track, "pointermove", 100);

    const preview = player.shadowRoot!.querySelector<HTMLElement>('[data-el="preview"]')!;
    expect(preview.classList.contains("is-visible")).toBe(true);
    expect(player.shadowRoot!.querySelector('[data-el="preview-time"]')!.textContent).toBe("0:50");
  });

  it("crops a sprite sheet to the right tile", async () => {
    const player = await withThumbnails(SPRITE_VTT);
    const track = sized(bar(player));
    pointer(track, "pointermove", 150); // t = 75s → second tile

    const img = previewImg(player);
    expect(img.hidden).toBe(false);
    // `object-fit: none` is what makes object-position crop at all; under
    // the default `fill` the whole sheet is squashed into the box.
    expect(img.style.objectFit).toBe("none");
    expect(img.style.objectPosition).toBe("-160px -0px");
    expect(img.style.width).toBe("160px");
    expect(img.style.height).toBe("90px");
  });

  it("clears sprite cropping for a track of whole images", async () => {
    const player = await withThumbnails(PLAIN_VTT);
    const track = sized(bar(player));
    pointer(track, "pointermove", 20);

    const img = previewImg(player);
    expect(img.src).toContain("frame-1.jpg");
    expect(img.style.objectFit).toBe("");
    expect(img.style.width).toBe("");
  });

  it("hides the image when there are no thumbnails at all", () => {
    const player = mount(100);
    const track = sized(bar(player));
    pointer(track, "pointermove", 100);
    expect(previewImg(player).hidden).toBe(true);
  });

  it("labels the preview with the chapter under the cursor", () => {
    const player = mount(100);
    player.setChapters([
      { start: 0, end: 50, title: "Opening" },
      { start: 50, end: 100, title: "Finale" },
    ]);
    const track = sized(bar(player));

    pointer(track, "pointermove", 150);
    const chapter = player.shadowRoot!.querySelector<HTMLElement>('[data-el="preview-chapter"]')!;
    expect(chapter.hidden).toBe(false);
    expect(chapter.textContent).toBe("Finale");
  });

  it("hides the preview again when the pointer leaves", () => {
    const player = mount(100);
    const track = sized(bar(player));
    pointer(track, "pointermove", 100);
    pointer(track, "pointerleave", 100);

    const preview = player.shadowRoot!.querySelector<HTMLElement>('[data-el="preview"]')!;
    expect(preview.classList.contains("is-visible")).toBe(false);
  });
});
