import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import "../index";
import type { LumenPlayer } from "../LumenPlayer";
import type { LumenPlaylistItem, LumenSource, LumenTextTrackInit } from "../types";
import type { LumenPlugin } from "../plugins/types";
import type { LumenStrings } from "../i18n";

/**
 * Vue wrapper around `<lumen-player>`.
 *
 * Vue handles custom elements better than most frameworks — it can set
 * DOM properties directly — but object props and the player's own event
 * system still need explicit wiring, which is what this provides.
 */
export const Lumen = defineComponent({
  name: "LumenPlayer",
  props: {
    src: { type: [String, Object, Array] as PropType<string | LumenSource | LumenSource[]>, default: undefined },
    poster: { type: String, default: undefined },
    theme: { type: String as PropType<"dark" | "light" | "system">, default: undefined },
    autoplay: { type: Boolean, default: false },
    loop: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    aspectRatio: { type: String, default: undefined },
    objectFit: { type: String, default: undefined },
    thumbnails: { type: String, default: undefined },
    chapters: { type: String, default: undefined },
    tracks: { type: Array as PropType<LumenTextTrackInit[]>, default: undefined },
    playlist: { type: Array as PropType<LumenPlaylistItem[]>, default: undefined },
    plugins: { type: Array as PropType<LumenPlugin[]>, default: undefined },
    translations: { type: Object as PropType<Partial<LumenStrings>>, default: undefined },
  },
  emits: ["ready", "play", "pause", "ended", "timeupdate", "error", "qualitychange", "chapterchange", "playlistitemchange"],

  setup(props, { emit, expose }) {
    const element = ref<LumenPlayer | null>(null);
    const cleanups: Array<() => void> = [];

    onMounted(() => {
      const player = element.value;
      if (!player) return;

      cleanups.push(
        player.on("play", () => emit("play")),
        player.on("pause", () => emit("pause")),
        player.on("ended", () => emit("ended")),
        player.on("timeupdate", (detail) => emit("timeupdate", detail)),
        player.on("error", (error) => emit("error", error)),
        player.on("qualitychange", (detail) => emit("qualitychange", detail)),
        player.on("chapterchange", ({ chapter }) => emit("chapterchange", chapter)),
        player.on("playlistitemchange", (detail) => emit("playlistitemchange", detail)),
      );

      for (const plugin of props.plugins ?? []) player.use(plugin);
      for (const track of props.tracks ?? []) player.addTextTrack(track);
      if (props.translations) player.setTranslations(props.translations);
      if (props.playlist) player.playlist = props.playlist;
      else if (props.src) void player.load(props.src);

      emit("ready", player);
    });

    watch(
      () => props.src,
      (src) => {
        if (src && element.value) void element.value.load(src);
      },
    );

    watch(
      () => props.playlist,
      (playlist) => {
        if (playlist && element.value) element.value.playlist = playlist;
      },
    );

    onBeforeUnmount(() => {
      for (const cleanup of cleanups) cleanup();
      element.value?.destroy();
    });

    expose({ player: element });

    // The `^` prefix forces attribute binding. Vue otherwise prefers a DOM
    // property whenever the element has one of that name, which breaks two
    // ways here: `chapters` is a read-only getter and throws, and setting
    // the `muted` property to "" is falsy, so the player would never mute.
    // These inputs are attribute-shaped — the element observes them as
    // attributes — so binding them as attributes is also simply correct.
    return () =>
      h("lumen-player", {
        ref: element,
        "^poster": props.poster,
        "^theme": props.theme,
        "^thumbnails": props.thumbnails,
        "^chapters": props.chapters,
        "^aspect-ratio": props.aspectRatio,
        "^object-fit": props.objectFit,
        "^autoplay": props.autoplay ? "" : undefined,
        "^loop": props.loop ? "" : undefined,
        "^muted": props.muted ? "" : undefined,
      });
  },
});

export default Lumen;
export type { LumenPlayer };
export * from "../types";
