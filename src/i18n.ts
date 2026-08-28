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

  // Panels and the extended controls behind them.
  equalizer: string;
  effects: string;
  mediaInformation: string;
  shortcuts: string;
  closePanel: string;
  reset: string;
  custom: string;
  preset: string;
  preamp: string;
  volumeBoost: string;
  audioDelay: string;
  subtitleDelay: string;
  stereoMode: string;
  stereo: string;
  mono: string;
  leftOnly: string;
  rightOnly: string;
  swapChannels: string;
  normalizeVolume: string;
  brightness: string;
  contrast: string;
  saturation: string;
  hue: string;
  gamma: string;
  zoom: string;
  rotate: string;
  flipHorizontal: string;
  flipVertical: string;
  aspectRatio: string;
  fitMode: string;
  fit: string;
  fill: string;
  stretch: string;
  source: string;
  snapshot: string;
  frameForward: string;
  frameBack: string;
  abLoop: string;
  repeat: string;
  repeatOne: string;
  repeatAll: string;
  shuffle: string;
  bookmarks: string;
  addBookmark: string;
  openFile: string;
  dropToPlay: string;
  resolution: string;
  frameRate: string;
  bitrate: string;
  container: string;
  engine: string;
  codecs: string;
  droppedFrames: string;
  bufferHealth: string;
  duration: string;
  statistics: string;
  nothingPlaying: string;
  audioEffects: string;
  videoEffects: string;

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
  audioEffectsUnavailable: string;
  snapshotUnavailable: string;
  noFramesToStep: string;
  abLoopStart: string;
  abLoopCleared: string;
  bookmarkAdded: string;
  subtitleFileAdded: string;
  unsupportedFile: string;

  /** Interpolated with {value}. */
  speedAnnouncement: string;
  qualityAnnouncement: string;
  captionsAnnouncement: string;
  audioAnnouncement: string;
  chapterAnnouncement: string;
  subtitlesAvailable: string;
  nowPlaying: string;
  abLoopSet: string;
  snapshotSaved: string;
  resumedAt: string;
  aspectAnnouncement: string;
  zoomAnnouncement: string;
  rotationAnnouncement: string;
  audioDelayAnnouncement: string;
  subtitleDelayAnnouncement: string;
  repeatAnnouncement: string;
  shuffleAnnouncement: string;
  presetAnnouncement: string;
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

  equalizer: "Equalizer",
  effects: "Effects",
  mediaInformation: "Media information",
  shortcuts: "Keyboard shortcuts",
  closePanel: "Close panel",
  reset: "Reset",
  custom: "Custom",
  preset: "Preset",
  preamp: "Preamp",
  volumeBoost: "Volume boost",
  audioDelay: "Audio delay",
  subtitleDelay: "Subtitle delay",
  stereoMode: "Stereo mode",
  stereo: "Stereo",
  mono: "Mono",
  leftOnly: "Left only",
  rightOnly: "Right only",
  swapChannels: "Swap channels",
  normalizeVolume: "Normalize volume",
  brightness: "Brightness",
  contrast: "Contrast",
  saturation: "Saturation",
  hue: "Hue",
  gamma: "Gamma",
  zoom: "Zoom",
  rotate: "Rotate",
  flipHorizontal: "Flip horizontally",
  flipVertical: "Flip vertically",
  aspectRatio: "Aspect ratio",
  fitMode: "Fit",
  fit: "Fit",
  fill: "Fill",
  stretch: "Stretch",
  source: "Source",
  snapshot: "Take snapshot",
  frameForward: "Next frame",
  frameBack: "Previous frame",
  abLoop: "A-B loop",
  repeat: "Repeat",
  repeatOne: "Repeat one",
  repeatAll: "Repeat all",
  shuffle: "Shuffle",
  bookmarks: "Bookmarks",
  addBookmark: "Add bookmark",
  openFile: "Open file",
  dropToPlay: "Drop a video or subtitle file to play it",
  resolution: "Resolution",
  frameRate: "Frame rate",
  bitrate: "Bitrate",
  container: "Container",
  engine: "Pipeline",
  codecs: "Codecs",
  droppedFrames: "Dropped frames",
  bufferHealth: "Buffer ahead",
  duration: "Duration",
  statistics: "Statistics",
  nothingPlaying: "Nothing is playing",
  audioEffects: "Audio",
  videoEffects: "Video",

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
  audioEffectsUnavailable:
    "Audio effects need same-origin media or the crossorigin attribute",
  snapshotUnavailable: "This frame can't be saved",
  noFramesToStep: "Frame stepping needs a loaded video",
  abLoopStart: "Loop start set - press again to set the end",
  abLoopCleared: "Loop cleared",
  bookmarkAdded: "Bookmark added",
  subtitleFileAdded: "Subtitle file added",
  unsupportedFile: "That file type can't be opened",

  speedAnnouncement: "Speed {value}",
  qualityAnnouncement: "Quality: {value}",
  captionsAnnouncement: "Captions: {value}",
  audioAnnouncement: "Audio: {value}",
  chapterAnnouncement: "Chapter: {value}",
  subtitlesAvailable: "Subtitles available: {value}",
  nowPlaying: "Now playing: {value}",
  abLoopSet: "Looping {value}",
  snapshotSaved: "Snapshot saved as {value}",
  resumedAt: "Resumed at {value}",
  aspectAnnouncement: "Aspect ratio: {value}",
  zoomAnnouncement: "Zoom: {value}",
  rotationAnnouncement: "Rotation: {value}",
  audioDelayAnnouncement: "Audio delay: {value}",
  subtitleDelayAnnouncement: "Subtitle delay: {value}",
  repeatAnnouncement: "Repeat: {value}",
  shuffleAnnouncement: "Shuffle: {value}",
  presetAnnouncement: "Equalizer: {value}",
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
