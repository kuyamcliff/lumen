/**
 * Public types for the Lumen player.
 */

export type LumenSourceType =
  | "hls"
  | "dash"
  | "mp4"
  | "mov"
  | "mkv"
  | "webm"
  | "ogg"
  | "ts"
  | "flv"
  | "auto";

export interface LumenSource {
  src: string;
  type?: LumenSourceType;
  /** Human label shown in the quality menu, e.g. "1080p". Progressive only. */
  label?: string;
}

export interface LumenQualityLevel {
  id: number;
  height: number;
  width: number;
  bitrate: number;
  label: string;
}

export interface LumenTextTrackInit {
  src: string;
  kind?: TextTrackKind;
  label: string;
  srclang: string;
  default?: boolean;
}

export interface LumenChapter {
  start: number;
  end: number;
  title: string;
}

export interface LumenAudioTrack {
  id: string;
  label: string;
  language: string;
  active: boolean;
}

/** One entry in a playlist. `src` accepts the same shapes as `player.load()`. */
export interface LumenPlaylistItem {
  src: string | LumenSource | LumenSource[];
  title?: string;
  poster?: string;
  /** External subtitle tracks for this item. */
  tracks?: LumenTextTrackInit[];
  /** WebVTT thumbnail sprite for scrub previews. */
  thumbnails?: string;
  /** WebVTT chapters file. */
  chapters?: string;
}

export type LumenErrorCode =
  | "NETWORK"
  | "DECODE"
  | "SRC_NOT_SUPPORTED"
  /** The file's container format can't be played or remuxed in a browser. */
  | "CONTAINER_UNSUPPORTED"
  | "MANIFEST_LOAD"
  | "ABORTED"
  | "UNKNOWN";

export interface LumenError {
  code: LumenErrorCode;
  message: string;
  fatal: boolean;
  raw?: unknown;
}

export type LumenTheme = "dark" | "light";

export interface SubtitleStylePrefs {
  fontSize: number; // relative scale, 1 = 100%
  fontFamily?: string;
  color: string;
  background: string;
  backgroundOpacity: number; // 0-1
  edge: "none" | "drop-shadow" | "outline" | "raised";
  position: "bottom" | "top";
  offsetSeconds: number;
}

export const DEFAULT_SUBTITLE_PREFS: SubtitleStylePrefs = {
  fontSize: 1,
  color: "#ffffff",
  background: "#000000",
  backgroundOpacity: 0.6,
  edge: "drop-shadow",
  position: "bottom",
  offsetSeconds: 0,
};

export type LumenEventMap = {
  play: undefined;
  pause: undefined;
  ended: undefined;
  timeupdate: { currentTime: number; duration: number };
  progress: { buffered: number };
  volumechange: { volume: number; muted: boolean };
  ratechange: { rate: number };
  waiting: undefined;
  playing: undefined;
  canplay: undefined;
  seeking: undefined;
  seeked: undefined;
  error: LumenError;
  qualitychange: { level: LumenQualityLevel | null; auto: boolean };
  qualitieschange: { levels: LumenQualityLevel[] };
  texttrackchange: { track: TextTrack | null };
  /** A text track discovered inside the media file itself (e.g. MKV subtitles). */
  embeddedtexttrack: { track: TextTrack };
  chapterschange: { chapters: LumenChapter[] };
  chapterchange: { chapter: LumenChapter | null };
  audiotrackschange: { tracks: LumenAudioTrack[] };
  audiotrackchange: { track: LumenAudioTrack | null };
  playlistchange: { items: LumenPlaylistItem[] };
  /** Fired when the playlist advances, manually or automatically. */
  playlistitemchange: { item: LumenPlaylistItem; index: number };
  castavailabilitychange: { available: boolean };
  enterfullscreen: undefined;
  exitfullscreen: undefined;
  enterpip: undefined;
  leavepip: undefined;
  loadedmetadata: { duration: number };
  ready: undefined;
  destroy: undefined;
};

export type LumenEventName = keyof LumenEventMap;
