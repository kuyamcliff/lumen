import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Lumen, type LumenHandle } from "../src/react";
import { lumen } from "../src/svelte";
import { Lumen as VueLumen } from "../src/vue";
import { createApp, h as vueH, type App } from "vue";
import type { LumenPlayer } from "../src/LumenPlayer";

/**
 * The wrappers had never been imported, let alone rendered. These mount
 * each one for real and check the parts framework integration actually
 * has to solve: object props (which attributes can't carry) and the
 * player's own event system (which frameworks can't bind to).
 */

// Tells React that act() is available, which is what turns its "not
// configured to support act" warnings off.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

function render(element: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);

  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return host;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const host of hosts.splice(0)) host.remove();
  vi.restoreAllMocks();
});

describe("React wrapper", () => {
  it("renders a working lumen-player element", () => {
    const host = render(<Lumen />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    expect(player).not.toBeNull();
    // Upgraded, not just an unknown tag.
    expect(player.shadowRoot).not.toBeNull();
    expect(player.shadowRoot!.querySelector("video")).not.toBeNull();
  });

  it("passes scalar props through as attributes", () => {
    const host = render(<Lumen theme="light" poster="p.jpg" aspectRatio="4/3" muted />);
    const player = host.querySelector("lumen-player")!;

    expect(player.getAttribute("theme")).toBe("light");
    expect(player.getAttribute("poster")).toBe("p.jpg");
    expect(player.getAttribute("aspect-ratio")).toBe("4/3");
    expect(player.hasAttribute("muted")).toBe(true);
  });

  it("applies object props that attributes cannot carry", () => {
    // This is the whole reason the wrapper exists: React would stringify
    // a playlist into a useless attribute.
    const playlist = [{ src: "a.mp4", title: "A" }, { src: "b.mp4", title: "B" }];
    const host = render(<Lumen playlist={playlist} />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    expect(player.playlist).toHaveLength(2);
    expect(player.playlist[0]!.title).toBe("A");
  });

  it("applies translations passed as a prop", () => {
    const host = render(<Lumen translations={{ play: "Lecture" }} />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    const playButton = player.shadowRoot!.querySelector('.lumen-row [data-action="play-pause"]');
    expect(playButton!.getAttribute("aria-label")).toBe("Lecture");
  });

  it("adds text tracks passed as a prop", () => {
    const host = render(<Lumen tracks={[{ src: "en.vtt", label: "English", srclang: "en" }]} />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    expect(player.videoElement.querySelector("track")?.getAttribute("src")).toBe("en.vtt");
  });

  it("registers plugins passed as a prop", () => {
    const setup = vi.fn();
    render(<Lumen plugins={[{ name: "p", setup }]} />);
    expect(setup).toHaveBeenCalled();
  });

  it("binds player events to React callbacks", () => {
    const onPlay = vi.fn();
    const onReady = vi.fn();
    const host = render(<Lumen onPlay={onPlay} onReady={onReady} />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    expect(onReady).toHaveBeenCalledWith(player);

    act(() => {
      player.videoElement.dispatchEvent(new Event("play"));
    });
    expect(onPlay).toHaveBeenCalled();
  });

  it("keeps working after a re-render with new handlers", () => {
    // Handlers live in a ref so re-renders don't churn subscriptions; the
    // latest handler must still be the one that runs.
    const first = vi.fn();
    const second = vi.fn();
    const host = render(<Lumen onPlay={first} />);
    const player = host.querySelector("lumen-player") as LumenPlayer;

    act(() => {
      roots[0]!.render(<Lumen onPlay={second} />);
    });
    act(() => {
      player.videoElement.dispatchEvent(new Event("play"));
    });

    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });

  it("exposes an imperative handle", () => {
    const ref = React.createRef<LumenHandle>();
    render(<Lumen ref={ref} />);

    expect(ref.current).not.toBeNull();
    expect(ref.current!.player).not.toBeNull();
    expect(typeof ref.current!.play).toBe("function");
    expect(ref.current!.currentTime).toBe(0);
    expect(ref.current!.qualityLevels).toEqual([]);

    expect(() => ref.current!.seek(5)).not.toThrow();
    expect(ref.current!.currentTime).toBe(5);
  });

  it("unmounts without throwing", () => {
    render(<Lumen playlist={[{ src: "a.mp4" }]} />);
    expect(() =>
      act(() => {
        for (const root of roots.splice(0)) root.unmount();
      }),
    ).not.toThrow();
  });
});

describe("Svelte action", () => {
  function mountElement(): LumenPlayer {
    const player = document.createElement("lumen-player") as LumenPlayer;
    document.body.appendChild(player);
    hosts.push(player);
    return player;
  }

  it("applies options and reports ready", async () => {
    const player = mountElement();
    const ready = vi.fn();

    const action = lumen(player, { playlist: [{ src: "a.mp4" }], on: { ready } });
    await Promise.resolve();

    expect(ready).toHaveBeenCalledWith(player);
    expect(player.playlist).toHaveLength(1);
    action.destroy();
  });

  it("binds events declared in `on`", async () => {
    const player = mountElement();
    const onPlay = vi.fn();

    const action = lumen(player, { on: { play: onPlay } });
    await Promise.resolve();

    player.videoElement.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalled();
    action.destroy();
  });

  it("stops calling handlers after destroy", async () => {
    const player = mountElement();
    const onPlay = vi.fn();

    const action = lumen(player, { on: { play: onPlay } });
    await Promise.resolve();
    action.destroy();

    player.videoElement.dispatchEvent(new Event("play"));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("registers plugins and translations", async () => {
    const player = mountElement();
    const setup = vi.fn();

    const action = lumen(player, {
      plugins: [{ name: "p", setup }],
      translations: { play: "再生" },
    });
    await Promise.resolve();

    expect(setup).toHaveBeenCalled();
    const playButton = player.shadowRoot!.querySelector('.lumen-row [data-action="play-pause"]');
    expect(playButton!.getAttribute("aria-label")).toBe("再生");
    action.destroy();
  });

  it("update() re-applies options without duplicating subscriptions", async () => {
    const player = mountElement();
    const onPlay = vi.fn();

    const action = lumen(player, { on: { play: onPlay } });
    await Promise.resolve();
    action.update({ on: { play: onPlay } });

    player.videoElement.dispatchEvent(new Event("play"));
    // Exactly once, not once per update() call.
    expect(onPlay).toHaveBeenCalledTimes(1);
    action.destroy();
  });
});

describe("Vue wrapper", () => {
  const apps: App[] = [];

  function mountVue(props: Record<string, unknown>): { host: HTMLElement; player: LumenPlayer } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);

    const app = createApp({ render: () => vueH(VueLumen, props) });
    // Vue would otherwise warn about an unrecognised element.
    app.config.compilerOptions = { isCustomElement: (tag: string) => tag === "lumen-player" };
    apps.push(app);
    app.mount(host);

    return { host, player: host.querySelector("lumen-player") as LumenPlayer };
  }

  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount();
  });

  it("renders a working lumen-player element", () => {
    const { player } = mountVue({});
    expect(player).not.toBeNull();
    expect(player.shadowRoot!.querySelector("video")).not.toBeNull();
  });

  it("passes scalar props as attributes", () => {
    const { player } = mountVue({ theme: "light", poster: "p.jpg" });
    expect(player.getAttribute("theme")).toBe("light");
    expect(player.getAttribute("poster")).toBe("p.jpg");
  });

  it("applies object props and emits player events", async () => {
    const onPlay = vi.fn();
    const { player } = mountVue({
      playlist: [{ src: "a.mp4", title: "A" }],
      onPlay,
    });

    expect(player.playlist).toHaveLength(1);

    player.videoElement.dispatchEvent(new Event("play"));
    expect(onPlay).toHaveBeenCalled();
  });

  it("registers plugins and translations", () => {
    const setup = vi.fn();
    const { player } = mountVue({ plugins: [{ name: "p", setup }], translations: { play: "Lecture" } });

    expect(setup).toHaveBeenCalled();
    const playButton = player.shadowRoot!.querySelector('.lumen-row [data-action="play-pause"]');
    expect(playButton!.getAttribute("aria-label")).toBe("Lecture");
  });

  it("unmounts without throwing", () => {
    mountVue({ playlist: [{ src: "a.mp4" }] });
    expect(() => {
      for (const app of apps.splice(0)) app.unmount();
    }).not.toThrow();
  });
});

describe("Vue wrapper property/attribute handling", () => {
  const apps: App[] = [];

  function mountVue(props: Record<string, unknown>): LumenPlayer {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const app = createApp({ render: () => vueH(VueLumen, props) });
    app.config.compilerOptions = { isCustomElement: (tag: string) => tag === "lumen-player" };
    apps.push(app);
    app.mount(host);
    return host.querySelector("lumen-player") as LumenPlayer;
  }

  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount();
  });

  it("does not warn or throw when binding attribute-shaped props", () => {
    // Vue sets DOM properties when the element has one of that name, which
    // throws for read-only getters like `chapters`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountVue({ chapters: "chapters.vtt", thumbnails: "t.vtt" });
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).not.toMatch(/Failed setting prop/);
  });

  it("actually mutes the player when muted is set", () => {
    // The attribute is what the player observes; a property set to "" is
    // falsy and would silently leave sound on.
    const player = mountVue({ muted: true });
    expect(player.muted).toBe(true);
  });
});
