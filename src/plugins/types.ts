import type { LumenPlayer } from "../LumenPlayer";

/**
 * A plugin extends the player without being part of it.
 *
 * `setup` runs once the player is mounted and may return a teardown
 * function, which is called on `destroy()`. Anything a plugin needs —
 * events, the media element, the public API — it reaches through the same
 * surface an application would, so plugins can't come to depend on
 * internals that are free to change.
 */
export interface LumenPlugin {
  name: string;
  setup(player: LumenPlayer): void | (() => void);
}

/** A plugin that takes options, e.g. `ads({ tagUrl })`. */
export type LumenPluginFactory<TOptions> = (options: TOptions) => LumenPlugin;
