import { LumenPlayer } from "./LumenPlayer";

export { LumenPlayer };
export type {
  LumenSource,
  LumenSourceType,
  LumenQualityLevel,
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
