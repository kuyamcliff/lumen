import { LumenPlayer } from "./LumenPlayer";

export { LumenPlayer };
export { DEFAULT_STRINGS, Translator } from "./i18n";
export type { LumenStrings } from "./i18n";
export type { LumenPlugin, LumenPluginFactory } from "./plugins/types";
export type { LumenDrmConfig, KeySystemConfig, FairPlayConfig } from "./core/DrmController";
export { sniffContainer, probeContainer, containerLabel, isPlayableContainer } from "./core/containers";
export type { ContainerKind } from "./core/containers";
export type {
  LumenSource,
  LumenSourceType,
  LumenQualityLevel,
  LumenAudioTrack,
  LumenChapter,
  LumenPlaylistItem,
  LumenTextTrackInit,
  LumenError,
  LumenErrorCode,
  LumenTheme,
  SubtitleStylePrefs,
  LumenEventMap,
  LumenEventName,
} from "./types";

if (typeof window !== "undefined" && !customElements.get("lumen-player")) {
  customElements.define("lumen-player", LumenPlayer);
}

declare global {
  interface HTMLElementTagNameMap {
    "lumen-player": LumenPlayer;
  }
}
