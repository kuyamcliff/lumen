/**
 * Every user-visible string in the player.
 *
 * Nothing in the UI hard-codes English: control labels, menu entries,
 * screen-reader announcements and error messages all resolve through here,
 * so a page can translate the player without forking it or reaching into
 * the shadow DOM.
 */
export interface LumenStrings {
  play: string;
  pause: string;
  mute: string;
  unmute: string;
  volume: string;
  seek: string;
  loading: string;
  fullscreen: string;
  exitFullscreen: string;
  pictureInPicture: string;
  captions: string;
  settings: string;
  cast: string;
  next: string;
  previous: string;
  tryAgain: string;
  back: string;
  off: string;
  auto: string;
  on: string;

  speed: string;
  normalSpeed: string;
  quality: string;
  audio: string;
  chapters: string;
  appearance: string;
  playlist: string;

  subtitleSize: string;
  subtitleBackground: string;
  subtitleEdge: string;
  subtitlePosition: string;
  small: string;
  medium: string;
  large: string;
  solid: string;
  dropShadow: string;
  outline: string;
  none: string;
  bottom: string;
  top: string;

  // Screen-reader announcements and status messages.
  playing: string;
  paused: string;
  captionsOff: string;
  playbackBlocked: string;
  pipUnavailable: string;
  fullscreenUnavailable: string;
  castUnavailable: string;

  /** Interpolated with {value}. */
  speedAnnouncement: string;
  qualityAnnouncement: string;
  captionsAnnouncement: string;
  audioAnnouncement: string;
  chapterAnnouncement: string;
  subtitlesAvailable: string;
  nowPlaying: string;
}

export const DEFAULT_STRINGS: LumenStrings = {
  play: "Play",
  pause: "Pause",
  mute: "Mute",
  unmute: "Unmute",
  volume: "Volume",
  seek: "Seek",
  loading: "Loading",
  fullscreen: "Fullscreen",
  exitFullscreen: "Exit fullscreen",
  pictureInPicture: "Picture in picture",
  captions: "Captions",
  settings: "Settings",
  cast: "Cast",
  next: "Next",
  previous: "Previous",
  tryAgain: "Try again",
  back: "Back",
  off: "Off",
  auto: "Auto",
  on: "On",

  speed: "Speed",
  normalSpeed: "Normal",
  quality: "Quality",
  audio: "Audio",
  chapters: "Chapters",
  appearance: "Appearance",
  playlist: "Playlist",

  subtitleSize: "Size",
  subtitleBackground: "Background",
  subtitleEdge: "Edge",
  subtitlePosition: "Position",
  small: "Small",
  medium: "Medium",
  large: "Large",
  solid: "Solid",
  dropShadow: "Drop shadow",
  outline: "Outline",
  none: "None",
  bottom: "Bottom",
  top: "Top",

  playing: "Playing",
  paused: "Paused",
  captionsOff: "Captions off",
  playbackBlocked: "Playback was blocked by the browser",
  pipUnavailable: "Picture-in-picture isn't available right now",
  fullscreenUnavailable: "Fullscreen isn't available right now",
  castUnavailable: "No cast devices are available right now",

  speedAnnouncement: "Speed {value}",
  qualityAnnouncement: "Quality: {value}",
  captionsAnnouncement: "Captions: {value}",
  audioAnnouncement: "Audio: {value}",
  chapterAnnouncement: "Chapter: {value}",
  subtitlesAvailable: "Subtitles available: {value}",
  nowPlaying: "Now playing: {value}",
};

/**
 * Resolves strings, falling back to English for any key a translation
 * omits — a partial translation degrades to mixed language rather than
 * blank buttons.
 */
export class Translator {
  private strings: LumenStrings = { ...DEFAULT_STRINGS };

  set(overrides: Partial<LumenStrings>): void {
    this.strings = { ...this.strings, ...overrides };
  }

  get all(): LumenStrings {
    return this.strings;
  }

  t(key: keyof LumenStrings, value?: string | number): string {
    const template = this.strings[key] ?? DEFAULT_STRINGS[key];
    return value === undefined ? template : template.replace("{value}", String(value));
  }
}
