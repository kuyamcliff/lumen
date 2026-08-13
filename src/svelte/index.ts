import "../index";
import type { LumenPlayer } from "../LumenPlayer";
import type { LumenPlaylistItem, LumenSource, LumenTextTrackInit } from "../types";
import type { LumenPlugin } from "../plugins/types";
import type { LumenStrings } from "../i18n";

export interface LumenActionOptions {
  src?: string | LumenSource | LumenSource[];
  playlist?: LumenPlaylistItem[];
  tracks?: LumenTextTrackInit[];
  plugins?: LumenPlugin[];
  translations?: Partial<LumenStrings>;
  on?: Partial<{
    ready: (player: LumenPlayer) => void;
    play: () => void;
    pause: () => void;
    ended: () => void;
    error: (error: unknown) => void;
  }>;
}

/**
 * Svelte action for `<lumen-player>`.
 *
 * Svelte renders custom elements natively and needs no component
 * wrapper, so the idiomatic integration is an action — it handles the
 * parts markup can't express: object props, imperative loading, and the
 * player's event system.
 *
 * ```svelte
 * <lumen-player use:lumen={{ src: "video.mkv", on: { ready: init } }} />
 * ```
 */
export function lumen(node: HTMLElement, options: LumenActionOptions = {}) {
  const player = node as LumenPlayer;
  let cleanups: Array<() => void> = [];

  const apply = (next: LumenActionOptions) => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];

    for (const [event, handler] of Object.entries(next.on ?? {})) {
      // Cast is needed because the key type widens across the union.
      cleanups.push(player.on(event as "play", handler as () => void));
    }

    for (const plugin of next.plugins ?? []) player.use(plugin);
    for (const track of next.tracks ?? []) player.addTextTrack(track);
    if (next.translations) player.setTranslations(next.translations);

    if (next.playlist) player.playlist = next.playlist;
    else if (next.src) void player.load(next.src);
  };

  // Custom-element upgrade is synchronous once defined, but the element
  // may not be connected yet when the action runs.
  queueMicrotask(() => {
    apply(options);
    options.on?.ready?.(player);
  });

  return {
    update(next: LumenActionOptions) {
      apply(next);
    },
    destroy() {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      player.destroy?.();
    },
  };
}

export type { LumenPlayer };
export * from "../types";
