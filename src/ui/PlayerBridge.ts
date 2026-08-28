import type { AudioController } from "../audio/AudioController";
import type { LoopController, RepeatMode } from "../media/LoopController";
import type { LumenMediaInfo } from "../media/MediaInfo";
import type { VideoFilters } from "../video/VideoFilters";
import type { LumenBookmarkEntry, LumenPlaylistItem } from "../types";

/**
 * Everything the UI needs from the player, expressed as an interface
 * rather than the class itself.
 *
 * `LumenPlayer` builds `ControlsController`, so the controls importing the
 * player back would be a cycle. Structural typing means the player simply
 * satisfies this — no adapter, no runtime cost — while the UI stays
 * testable against a plain object.
 */
export interface PlayerBridge {
  // ---- playlist ----
  hasPlaylist(): boolean;
  hasNext(): boolean;
  hasPrevious(): boolean;
  next(): void;
  previous(): void;
  playlistItems(): LumenPlaylistItem[];
  /** Named to leave the player's own `playlistIndex` getter alone. */
  currentPlaylistIndex(): number;
  playItem(index: number): void;

  getRepeat(): RepeatMode;
  setRepeat(mode: RepeatMode): void;
  getShuffle(): boolean;
  setShuffle(shuffle: boolean): void;

  // ---- effects ----
  readonly audio: AudioController;
  readonly filters: VideoFilters;
  readonly loop: LoopController;

  // ---- extras ----
  mediaInfo(): LumenMediaInfo;
  getBookmarks(): LumenBookmarkEntry[];
  addBookmark(label?: string): void;
  removeBookmark(time: number): void;
  saveSnapshot(): Promise<void>;
  stepFrame(direction: number): void;
  openFiles(files: File[]): Promise<void>;
  /** Current subtitle delay in seconds; positive shows cues later. */
  getSubtitleOffset(): number;
  setSubtitleOffset(seconds: number): void;
  /** Re-loads the current source after an error. */
  retry(): void;
}
