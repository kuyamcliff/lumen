import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index";
import type { LumenPlayer } from "../src/LumenPlayer";
import type { LumenAudioTrack, LumenQualityLevel } from "../src/types";

/**
 * The quality and audio menus, which are the only way a viewer can act on
 * a multi-variant stream. They're driven entirely by the engine, so the
 * tests stub the engine's getters rather than a real stream.
 */

const players: LumenPlayer[] = [];

function mount(): LumenPlayer {
  const player = document.createElement("lumen-player") as LumenPlayer;
  document.body.appendChild(player);
  players.push(player);
  return player;
}

interface EngineStub {
  qualityLevels?: LumenQualityLevel[];
  currentQuality?: LumenQualityLevel | null;
  isAutoQuality?: boolean;
  isHls?: boolean;
  isAdaptive?: boolean;
  audioTracks?: LumenAudioTrack[];
}

/** The playback engine backing a player, which is what the menus drive. */
function engineOf(player: LumenPlayer): { setQuality(id: number | "auto"): void; setAudioTrack(id: string): void } {
  return (player as unknown as { engine: { setQuality(id: number | "auto"): void; setAudioTrack(id: string): void } })
    .engine;
}

/** Replaces the engine's read-only getters on this instance only. */
function stubEngine(player: LumenPlayer, values: EngineStub): void {
  const engine = (player as unknown as { engine: object }).engine;
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(engine, key, { value, configurable: true });
  }
}

const shadow = (player: LumenPlayer) => player.shadowRoot!;
const find = (player: LumenPlayer, selector: string) => shadow(player).querySelector<HTMLElement>(selector);
const menuLabels = (player: LumenPlayer) =>
  [...shadow(player).querySelectorAll(".lumen-menu-item")].map((item) => item.textContent?.trim() ?? "");

function click(element: Element | null | undefined): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
}

function openMenu(player: LumenPlayer): void {
  click(find(player, '[data-action="settings"]'));
}

function openRow(player: LumenPlayer, action: string): void {
  openMenu(player);
  click(shadow(player).querySelector(`[data-menu-action="${action}"]`));
}

const LEVELS: LumenQualityLevel[] = [
  { id: 0, label: "360p", height: 360, width: 640, bitrate: 800_000 },
  { id: 1, label: "720p", height: 720, width: 1280, bitrate: 2_400_000 },
  { id: 2, label: "1080p", height: 1080, width: 1920, bitrate: 5_000_000 },
];

const AUDIO: LumenAudioTrack[] = [
  { id: "en", label: "English", language: "en", active: true },
  { id: "fr", label: "Français", language: "fr", active: false },
];

afterEach(() => {
  for (const player of players.splice(0)) {
    player.destroy();
    player.remove();
  }
  vi.restoreAllMocks();
});

describe("quality menu", () => {
  it("stays hidden for a stream with no variants", () => {
    const player = mount();
    openMenu(player);
    expect(menuLabels(player).join("|")).not.toMatch(/Quality/i);
  });

  it("appears for HLS and lists every level plus Auto", () => {
    const player = mount();
    stubEngine(player, { isHls: true, isAdaptive: true, qualityLevels: LEVELS, isAutoQuality: true });

    openRow(player, "open-quality");
    expect(menuLabels(player)).toEqual(["Back", "Auto", "360p", "720p", "1080p"]);
  });

  it("appears for DASH as well", () => {
    // The row used to be gated on `isHls`, so a DASH stream's levels were
    // computed and then never shown.
    const player = mount();
    stubEngine(player, { isHls: false, isAdaptive: true, qualityLevels: LEVELS, isAutoQuality: true });

    openMenu(player);
    expect(menuLabels(player).join("|")).toMatch(/Quality/i);
  });

  it("selecting a level calls through to the engine and returns to the root view", () => {
    const player = mount();
    stubEngine(player, { isHls: true, isAdaptive: true, qualityLevels: LEVELS, isAutoQuality: true });
    const setQuality = vi.spyOn(engineOf(player), "setQuality");

    openRow(player, "open-quality");
    click(shadow(player).querySelector('[data-menu-action="set-quality"][data-value="2"]'));

    expect(setQuality).toHaveBeenCalledWith(2);
    // Back to the root view, still open — a viewer comparing levels
    // shouldn't have to reopen the menu for every attempt.
    expect(find(player, '[data-el="menu"]')!.hidden).toBe(false);
    expect(menuLabels(player)).not.toContain("Back");
  });

  it("Auto is passed through as the string, not a number", () => {
    const player = mount();
    stubEngine(player, { isHls: true, isAdaptive: true, qualityLevels: LEVELS, isAutoQuality: false });
    const setQuality = vi.spyOn(engineOf(player), "setQuality");

    openRow(player, "open-quality");
    click(shadow(player).querySelector('[data-menu-action="set-quality"][data-value="auto"]'));
    expect(setQuality).toHaveBeenCalledWith("auto");
  });

  it("marks the active level with aria-checked", () => {
    const player = mount();
    stubEngine(player, {
      isHls: true,
      isAdaptive: true,
      qualityLevels: LEVELS,
      isAutoQuality: false,
      currentQuality: LEVELS[1],
    });

    openRow(player, "open-quality");
    const checked = [...shadow(player).querySelectorAll('[aria-checked="true"]')].map((el) => el.textContent);
    expect(checked).toEqual(["720p"]);
  });

  it("shows the resolution Auto settled on alongside the label", () => {
    const player = mount();
    stubEngine(player, {
      isHls: true,
      isAdaptive: true,
      qualityLevels: LEVELS,
      isAutoQuality: true,
      currentQuality: LEVELS[2],
    });

    openMenu(player);
    expect(menuLabels(player).join("|")).toContain("Auto (1080p)");
  });
});

describe("audio track menu", () => {
  it("stays hidden when there's only one track", () => {
    const player = mount();
    stubEngine(player, { audioTracks: [AUDIO[0]!] });
    openMenu(player);
    expect(menuLabels(player).join("|")).not.toMatch(/Audio/i);
  });

  it("lists the tracks and marks the active one", () => {
    const player = mount();
    stubEngine(player, { audioTracks: AUDIO });

    openRow(player, "open-audio");
    expect(menuLabels(player)).toEqual(["Back", "English", "Français"]);
    expect(shadow(player).querySelector('[aria-checked="true"]')!.textContent).toBe("English");
  });

  it("selecting a track calls through to the engine", () => {
    const player = mount();
    stubEngine(player, { audioTracks: AUDIO });
    const setAudioTrack = vi.spyOn(engineOf(player), "setAudioTrack");

    openRow(player, "open-audio");
    click(shadow(player).querySelector('[data-menu-action="set-audio"][data-value="fr"]'));
    expect(setAudioTrack).toHaveBeenCalledWith("fr");
  });
});

describe("menu label safety", () => {
  it("does not parse media-supplied labels as markup", () => {
    // Track names come from the manifest, so anyone who can serve the
    // media can choose this string. It has to land as text.
    const player = mount();
    stubEngine(player, {
      audioTracks: [
        { id: "a", label: "<img src=x onerror=alert(1)>", language: "en", active: true },
        { id: "b", label: "Commentary", language: "en", active: false },
      ],
    });

    openMenu(player);
    const menu = find(player, '[data-el="menu"]')!;
    expect(menu.querySelector("img")).toBeNull();
    expect(menu.textContent).toContain("onerror");
  });
});

describe("speed menu", () => {
  it("lists the speeds and applies the chosen one", () => {
    const player = mount();
    openRow(player, "open-speed");

    expect(menuLabels(player)).toEqual(["Back", "0.25×", "0.5×", "0.75×", "Normal", "1.25×", "1.5×", "1.75×", "2×"]);

    click(shadow(player).querySelector('[data-menu-action="set-speed"][data-value="1.5"]'));
    expect(player.playbackRate).toBe(1.5);
  });

  it("shows the current speed on the root row", () => {
    const player = mount();
    player.playbackRate = 2;
    openMenu(player);
    expect(menuLabels(player).join("|")).toContain("2×");
  });
});
