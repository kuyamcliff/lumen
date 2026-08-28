import type { LumenStrings } from "../../i18n";

export interface ShortcutEntry {
  keys: string[];
  /** Translation key for what the shortcut does. */
  label: keyof LumenStrings;
}

/**
 * The keyboard reference shown in the shortcuts panel.
 *
 * Where a VLC binding and a web-player binding disagree, the web one wins —
 * `j`/`l` have meant "seek ten seconds" to anyone who watches video in a
 * browser for over a decade, and breaking that to match a desktop app
 * would cost more than it gained. Everything VLC binds that the web has no
 * opinion about (`e`, `g`/`h`, `a`, `z`, `v`, `b`) is kept exactly as VLC
 * has it.
 */
export const SHORTCUTS: ShortcutEntry[] = [
  { keys: ["Space", "K"], label: "play" },
  { keys: ["←", "→"], label: "seek" },
  { keys: ["J", "L"], label: "seek" },
  { keys: ["↑", "↓"], label: "volume" },
  { keys: ["M"], label: "mute" },
  { keys: ["F"], label: "fullscreen" },
  { keys: ["C"], label: "captions" },
  { keys: ["<", ">"], label: "speed" },
  { keys: ["E"], label: "frameForward" },
  { keys: ["Shift", "E"], label: "frameBack" },
  { keys: ["G", "H"], label: "subtitleDelay" },
  { keys: ["Shift", "G/H"], label: "audioDelay" },
  { keys: ["A"], label: "aspectRatio" },
  { keys: ["Z"], label: "zoom" },
  { keys: ["R"], label: "rotate" },
  { keys: ["V"], label: "captions" },
  { keys: ["B"], label: "audio" },
  { keys: ["Shift", "A"], label: "abLoop" },
  { keys: ["Shift", "B"], label: "addBookmark" },
  { keys: ["S"], label: "snapshot" },
  { keys: ["N"], label: "next" },
  { keys: ["Shift", "N"], label: "previous" },
  { keys: ["Shift", "R"], label: "shuffle" },
  { keys: ["Shift", "L"], label: "repeat" },
  { keys: ["P"], label: "playlist" },
  { keys: ["X"], label: "effects" },
  { keys: ["Q"], label: "equalizer" },
  { keys: ["I"], label: "mediaInformation" },
  { keys: ["O"], label: "openFile" },
  { keys: ["?"], label: "shortcuts" },
  { keys: ["0", "9"], label: "seek" },
  { keys: ["Esc"], label: "closePanel" },
];
