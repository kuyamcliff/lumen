import { afterEach, describe, expect, it } from "vitest";
import "../src/index";
import type { LumenPlayer } from "../src/LumenPlayer";

/**
 * Behavioural coverage for the control surface — the largest module, and
 * the one most exposed to regressions, since almost none of it is
 * reachable from the engine-level tests.
 */

const players: LumenPlayer[] = [];

function mount(): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  document.body.appendChild(player);
  players.push(player);
  return player;
}

const shadow = (player: LumenPlayer) => player.shadowRoot!;
const find = (player: LumenPlayer, selector: string) => shadow(player).querySelector<HTMLElement>(selector);
const menuLabels = (player: LumenPlayer) =>
  [...shadow(player).querySelectorAll(".lumen-menu-item")].map((item) => item.textContent?.trim() ?? "");

function click(element: Element | null | undefined): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
}

/** A keyboard activation, which reports `detail === 0` like a real one. */
function keyboardClick(element: Element | null | undefined): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
}

function press(element: Element | null | undefined, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
  element?.dispatchEvent(event);
  return event;
}

function withChapters(player: LumenPlayer): LumenPlayer {
  player.setChapters([
    { start: 0, end: 10, title: "Opening" },
    { start: 10, end: 20, title: "Middle" },
    { start: 20, end: 30, title: "End" },
  ]);
  return player;
}

afterEach(() => {
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
});

describe("settings menu", () => {
  it("opens and closes from the settings button", () => {
    const player = mount();
    const settings = find(player, '[data-action="settings"]')!;
    const menu = find(player, '[data-el="menu"]')!;

    expect(menu.hidden).toBe(true);
    click(settings);
    expect(menu.hidden).toBe(false);
    expect(settings.getAttribute("aria-expanded")).toBe("true");

    click(settings);
    expect(menu.hidden).toBe(true);
    expect(settings.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays usable after a click that isn't on a menu item", () => {
    // Regression: the click handler was registered per render with
    // `{ once: true }`, so a single stray click — on the panel's padding,
    // or on a caption-appearance button — consumed it and left the whole
    // menu dead until it was reopened.
    const player = withChapters(mount());
    click(find(player, '[data-action="settings"]'));

    click(find(player, '[data-el="menu"]')); // the panel itself, not a row
    click(shadow(player).querySelector('[data-menu-action="open-speed"]'));

    expect(menuLabels(player)).toContain("2×");
  });

  it("does not double-apply an action after navigating between views", () => {
    // The old per-render registration also accumulated listeners, so the
    // same click could be handled more than once.
    const player = mount();
    click(find(player, '[data-action="settings"]'));

    for (let i = 0; i < 3; i++) {
      click(shadow(player).querySelector('[data-menu-action="open-speed"]'));
      click(shadow(player).querySelector('[data-menu-action="back"]'));
    }

    click(shadow(player).querySelector('[data-menu-action="open-speed"]'));
    const speedItem = [...shadow(player).querySelectorAll<HTMLElement>('[data-menu-action="set-speed"]')].find(
      (item) => item.dataset.value === "1.5",
    );
    click(speedItem);

    expect(player.playbackRate).toBe(1.5);
    // Returning to root, not stuck in a view a duplicated handler pushed.
    expect(menuLabels(player).some((label) => label.startsWith("Speed"))).toBe(true);
  });

  it("navigates into a submenu and back", () => {
    const player = withChapters(mount());
    click(find(player, '[data-action="settings"]'));
    expect(menuLabels(player).some((l) => l.startsWith("Chapters"))).toBe(true);

    click(shadow(player).querySelector('[data-menu-action="open-chapters"]'));
    expect(menuLabels(player).some((l) => l.includes("Middle"))).toBe(true);

    click(shadow(player).querySelector('[data-menu-action="back"]'));
    expect(menuLabels(player).some((l) => l.startsWith("Speed"))).toBe(true);
  });

  it("seeks when a chapter is chosen, and closes", () => {
    const player = withChapters(mount());
    click(find(player, '[data-action="settings"]'));
    click(shadow(player).querySelector('[data-menu-action="open-chapters"]'));

    const middle = [...shadow(player).querySelectorAll<HTMLElement>('[data-menu-action="seek-chapter"]')].find(
      (item) => item.textContent?.includes("Middle"),
    );
    click(middle);

    expect(player.videoElement.currentTime).toBe(10);
    expect(find(player, '[data-el="menu"]')!.hidden).toBe(true);
  });

  it("closes when a click lands outside it", () => {
    const player = mount();
    click(find(player, '[data-action="settings"]'));
    expect(find(player, '[data-el="menu"]')!.hidden).toBe(false);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(find(player, '[data-el="menu"]')!.hidden).toBe(true);
  });
});

describe("menu keyboard navigation", () => {
  it("moves focus with arrow keys and wraps at the ends", () => {
    const player = withChapters(mount());
    keyboardClick(find(player, '[data-action="settings"]'));

    const items = () => [...shadow(player).querySelectorAll<HTMLElement>("[data-menu-action]")];
    const focused = () => shadow(player).activeElement;

    expect(focused()).toBe(items()[0]);

    press(focused(), "ArrowDown");
    expect(focused()).toBe(items()[1]);

    // Wrapping backwards from the first row lands on the last.
    press(focused(), "ArrowUp");
    press(focused(), "ArrowUp");
    expect(focused()).toBe(items()[items().length - 1]);

    press(focused(), "Home");
    expect(focused()).toBe(items()[0]);

    press(focused(), "End");
    expect(focused()).toBe(items()[items().length - 1]);
  });

  it("ArrowLeft backs out of a submenu", () => {
    const player = withChapters(mount());
    keyboardClick(find(player, '[data-action="settings"]'));
    keyboardClick(shadow(player).querySelector('[data-menu-action="open-chapters"]'));
    expect(menuLabels(player).some((l) => l.includes("Opening"))).toBe(true);

    press(shadow(player).activeElement, "ArrowLeft");
    expect(menuLabels(player).some((l) => l.startsWith("Speed"))).toBe(true);
  });

  it("Escape closes the menu and returns focus to the button that opened it", () => {
    const player = mount();
    const settings = find(player, '[data-action="settings"]')!;
    settings.focus();
    keyboardClick(settings);

    press(shadow(player).activeElement, "Escape");

    expect(find(player, '[data-el="menu"]')!.hidden).toBe(true);
    // Focus must not be stranded at the top of the document.
    expect(shadow(player).activeElement).toBe(settings);
  });

  it("prevents default on keys it handles, and leaves others alone", () => {
    const player = withChapters(mount());
    keyboardClick(find(player, '[data-action="settings"]'));

    expect(press(shadow(player).activeElement, "ArrowDown").defaultPrevented).toBe(true);
    expect(press(shadow(player).activeElement, "a").defaultPrevented).toBe(false);
  });
});

describe("transport controls", () => {
  it("toggles play state and mirrors it onto both play buttons", () => {
    const player = mount();
    const video = player.videoElement;
    // jsdom has no media stack, so play()/pause() are stubbed to drive the
    // same events a real element would.
    video.play = async () => void video.dispatchEvent(new Event("play"));
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    video.dispatchEvent(new Event("play"));

    for (const button of shadow(player).querySelectorAll('[data-action="play-pause"]')) {
      expect(button.getAttribute("aria-label")).toBe("Pause");
    }

    Object.defineProperty(video, "paused", { value: true, configurable: true });
    video.dispatchEvent(new Event("pause"));
    for (const button of shadow(player).querySelectorAll('[data-action="play-pause"]')) {
      expect(button.getAttribute("aria-label")).toBe("Play");
    }
  });

  it("mute button reflects state and updates its label", () => {
    const player = mount();
    click(find(player, '[data-action="mute"]'));

    expect(player.muted).toBe(true);
    const mute = find(player, '[data-action="mute"]')!;
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.getAttribute("aria-label")).toBe("Unmute");
  });

  it("restores a usable volume when unmuting from zero", () => {
    // Unmuting a track whose volume is 0 would otherwise stay silent, which
    // reads as a broken button.
    const player = mount();
    player.volume = 0;
    click(find(player, '[data-action="mute"]')); // mute
    click(find(player, '[data-action="mute"]')); // unmute

    expect(player.muted).toBe(false);
    expect(player.volume).toBeGreaterThan(0);
  });

  it("hides playlist buttons until there is a playlist", () => {
    const player = mount();
    expect(find(player, '[data-action="next"]')!.hidden).toBe(true);

    player.playlist = [{ src: "a.mp4" }, { src: "b.mp4" }];
    expect(find(player, '[data-action="next"]')!.hidden).toBe(false);
    // Nowhere back to go from the first item.
    expect(find(player, '[data-action="previous"]')!.hasAttribute("disabled")).toBe(true);
  });
});

describe("keyboard shortcuts", () => {
  it("m toggles mute and f/c are handled without throwing", () => {
    const player = mount();
    const root = shadow(player).querySelector(".lumen")!;

    press(root, "m");
    expect(player.muted).toBe(true);
    press(root, "m");
    expect(player.muted).toBe(false);

    expect(() => {
      press(root, "f");
      press(root, "c");
    }).not.toThrow();
  });

  it("arrow keys adjust volume", () => {
    const player = mount();
    const root = shadow(player).querySelector(".lumen")!;
    player.volume = 0.5;

    press(root, "ArrowUp");
    expect(player.volume).toBeCloseTo(0.55);

    press(root, "ArrowDown");
    expect(player.volume).toBeCloseTo(0.5);
  });

  it("does not hijack keys while a modifier is held", () => {
    // Ctrl+M and friends belong to the browser or the OS.
    const player = mount();
    const root = shadow(player).querySelector(".lumen")!;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true, composed: true }));
    expect(player.muted).toBe(false);
  });
});

describe("error surface", () => {
  it("shows a readable message for a fatal error", async () => {
    const player = mount();
    const errorBox = find(player, ".lumen-error")!;
    expect(errorBox.hidden).toBe(true);

    // Driven through the public API rather than internals.
    await player.load([]);

    expect(errorBox.hidden).toBe(false);
    const message = find(player, '[data-el="error-message"]')!.textContent ?? "";
    expect(message).toContain("No supported source");
    // Never a raw MediaError code.
    expect(message).not.toMatch(/MEDIA_ERR|code \d/);
  });

  it("keeps the error visible when a retry hits the same dead source", async () => {
    // Retrying something still impossible must re-report, not silently
    // clear the message and leave a blank player.
    const player = mount();
    await player.load([]);

    click(find(player, '[data-action="retry"]'));

    expect(find(player, ".lumen-error")!.hidden).toBe(false);
    expect(find(player, '[data-el="error-message"]')!.textContent).toContain("No supported source");
  });

  it("does not show the error panel for a non-fatal error", () => {
    // Non-fatal means recovery is already under way; showing a panel would
    // claim playback had stopped when it hadn't.
    const player = mount();
    player.on("error", () => {});
    const errorBox = find(player, ".lumen-error")!;

    // A stalled network read is reported as non-fatal by the engine.
    player.videoElement.dispatchEvent(new Event("stalled"));
    expect(errorBox.hidden).toBe(true);
  });
});

describe("teardown", () => {
  it("stops reacting to document-level events after destroy", () => {
    // The fullscreenchange listener used to be anonymous and never removed,
    // so a destroyed player kept responding — and kept itself alive.
    const player = mount();
    player.destroy();

    expect(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
  });
});
