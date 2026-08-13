import * as React from "react";
import "../index";
import type { LumenPlayer } from "../LumenPlayer";
import type {
  LumenChapter,
  LumenError,
  LumenEventMap,
  LumenPlaylistItem,
  LumenQualityLevel,
  LumenSource,
  LumenTextTrackInit,
} from "../types";
import type { LumenPlugin } from "../plugins/types";
import type { LumenStrings } from "../i18n";

export interface LumenProps {
  src?: string | LumenSource | LumenSource[];
  poster?: string;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  crossOrigin?: string;
  preload?: "none" | "metadata" | "auto";
  theme?: "dark" | "light" | "system";
  aspectRatio?: string;
  objectFit?: "contain" | "cover" | "fill";
  thumbnails?: string;
  chapters?: string;
  tracks?: LumenTextTrackInit[];
  playlist?: LumenPlaylistItem[];
  plugins?: LumenPlugin[];
  translations?: Partial<LumenStrings>;
  className?: string;
  style?: React.CSSProperties;

  onReady?: (player: LumenPlayer) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onTimeUpdate?: (detail: LumenEventMap["timeupdate"]) => void;
  onError?: (error: LumenError) => void;
  onQualityChange?: (detail: LumenEventMap["qualitychange"]) => void;
  onChapterChange?: (chapter: LumenChapter | null) => void;
  onPlaylistItemChange?: (detail: LumenEventMap["playlistitemchange"]) => void;
}

export interface LumenHandle {
  readonly player: LumenPlayer | null;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): void;
  readonly currentTime: number;
  readonly duration: number;
  readonly qualityLevels: LumenQualityLevel[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "lumen-player": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        poster?: string;
        theme?: string;
      };
    }
  }
}

/**
 * React wrapper around `<lumen-player>`.
 *
 * Custom elements and React disagree on two things: React sets everything
 * as an attribute (so object props like `playlist` never arrive), and it
 * has no way to bind non-DOM events. Both are handled here by assigning
 * properties and subscribing imperatively, which is what makes the
 * component feel like ordinary React from the outside.
 */
export const Lumen = React.forwardRef<LumenHandle, LumenProps>(function Lumen(props, ref) {
  const elementRef = React.useRef<LumenPlayer | null>(null);
  const [ready, setReady] = React.useState(false);

  // Handlers live in a ref so re-renders don't churn event subscriptions.
  const handlers = React.useRef(props);
  handlers.current = props;

  React.useImperativeHandle(
    ref,
    () => ({
      get player() {
        return elementRef.current;
      },
      play: () => elementRef.current?.play() ?? Promise.resolve(),
      pause: () => elementRef.current?.pause(),
      seek: (time: number) => elementRef.current?.seek(time),
      get currentTime() {
        return elementRef.current?.currentTime ?? 0;
      },
      get duration() {
        return elementRef.current?.duration ?? NaN;
      },
      get qualityLevels() {
        return elementRef.current?.qualityLevels ?? [];
      },
    }),
    [],
  );

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const offs = [
      element.on("play", () => handlers.current.onPlay?.()),
      element.on("pause", () => handlers.current.onPause?.()),
      element.on("ended", () => handlers.current.onEnded?.()),
      element.on("timeupdate", (detail) => handlers.current.onTimeUpdate?.(detail)),
      element.on("error", (error) => handlers.current.onError?.(error)),
      element.on("qualitychange", (detail) => handlers.current.onQualityChange?.(detail)),
      element.on("chapterchange", ({ chapter }) => handlers.current.onChapterChange?.(chapter)),
      element.on("playlistitemchange", (detail) => handlers.current.onPlaylistItemChange?.(detail)),
    ];

    setReady(true);
    handlers.current.onReady?.(element);

    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Object-valued props must be assigned as properties; attributes would
  // stringify them.
  React.useEffect(() => {
    const element = elementRef.current;
    if (!element || !ready || !props.src) return;
    void element.load(props.src);
  }, [ready, props.src]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element || !ready || !props.playlist) return;
    element.playlist = props.playlist;
  }, [ready, props.playlist]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element || !ready || !props.translations) return;
    element.setTranslations(props.translations);
  }, [ready, props.translations]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element || !ready || !props.tracks) return;
    for (const track of props.tracks) element.addTextTrack(track);
  }, [ready, props.tracks]);

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element || !ready || !props.plugins) return;
    for (const plugin of props.plugins) element.use(plugin);
  }, [ready, props.plugins]);

  return React.createElement("lumen-player", {
    ref: elementRef as React.Ref<HTMLElement>,
    class: props.className,
    style: props.style,
    poster: props.poster,
    theme: props.theme,
    thumbnails: props.thumbnails,
    chapters: props.chapters,
    "aspect-ratio": props.aspectRatio,
    "object-fit": props.objectFit,
    crossorigin: props.crossOrigin,
    preload: props.preload,
    autoplay: props.autoPlay ? "" : undefined,
    loop: props.loop ? "" : undefined,
    muted: props.muted ? "" : undefined,
  });
});

export type { LumenPlayer };
export * from "../types";
