import panelStyles from "./panels.css?inline";
import type { Translator, LumenStrings } from "../../i18n";
import type { PlayerBridge } from "../PlayerBridge";
import type { SubtitleManager } from "../../subtitles/SubtitleManager";
import type { LumenPanel } from "../../types";
import { EQ_FREQUENCIES, EQ_GAIN_LIMIT, EQ_PRESETS } from "../../audio/presets";
import { MAX_AUDIO_DELAY_MS, MAX_BOOST } from "../../audio/AudioController";
import { ASPECT_RATIOS } from "../../video/VideoFilters";
import { formatTime } from "../../utils/time";
import { prefersReducedMotion } from "../../utils/dom";
import { icon } from "../icons";
import { SHORTCUTS } from "./shortcuts";

export interface PanelHost {
  bridge: PlayerBridge;
  video: HTMLVideoElement;
  subtitles: SubtitleManager;
  strings: Translator;
  announce(message: string): void;
}

type StringKey = keyof LumenStrings;

/**
 * The side panels: playlist, equalizer, effects, media information and the
 * shortcut reference — VLC's "Playlist", "Adjustments and Effects" and
 * "Media Information" windows, folded into one drawer.
 *
 * This module is only ever reached through a dynamic `import()` from
 * ControlsController, so it builds as its own chunk: a page that never
 * opens a panel never downloads any of it, and the core bundle keeps its
 * budget even though the player gained a dialog's worth of controls.
 */
export class PanelController {
  private host: PanelHost;
  private body: HTMLElement;
  private titleEl: HTMLElement;
  private view: LumenPanel = "playlist";
  private effectsTab: "audio" | "video" | "subtitles" = "audio";
  /** Nodes the info view updates in place, so it doesn't rebuild every second. */
  private liveFields = new Map<string, HTMLElement>();
  /** Handle for the spectrum's animation frame, so it can be stopped. */
  private spectrumFrame: number | null = null;

  constructor(host: PanelHost, body: HTMLElement, titleEl: HTMLElement) {
    this.host = host;
    this.body = body;
    this.titleEl = titleEl;
    injectPanelStyles(body.getRootNode());
  }

  private t(key: StringKey, value?: string | number): string {
    return this.host.strings.t(key, value);
  }

  render(view: LumenPanel): void {
    this.view = view;
    this.liveFields.clear();
    this.stopSpectrum();
    this.body.replaceChildren();

    switch (view) {
      case "playlist":
        this.titleEl.textContent = this.t("playlist");
        this.renderPlaylist();
        break;
      case "equalizer":
        this.titleEl.textContent = this.t("equalizer");
        this.renderEqualizer();
        break;
      case "effects":
        this.titleEl.textContent = this.t("effects");
        this.renderEffects();
        break;
      case "info":
        this.titleEl.textContent = this.t("mediaInformation");
        this.renderInfo();
        break;
      case "shortcuts":
        this.titleEl.textContent = this.t("shortcuts");
        this.renderShortcuts();
        break;
    }
  }

  /** Updates the values a live view shows, without rebuilding the DOM. */
  refresh(): void {
    if (this.view === "info") this.updateInfo();
  }

  /** Called when the panel closes, so nothing keeps animating off-screen. */
  stop(): void {
    this.stopSpectrum();
  }

  // -------------------------------------------------------- playlist

  private renderPlaylist(): void {
    const bridge = this.host.bridge;

    const modes = this.section(this.t("repeat"));
    modes.appendChild(
      this.chipRow(
        [
          { id: "off", label: this.t("off") },
          { id: "one", label: this.t("repeatOne") },
          { id: "all", label: this.t("repeatAll") },
        ],
        bridge.getRepeat(),
        (id) => {
          bridge.setRepeat(id as "off" | "one" | "all");
          this.render("playlist");
        },
      ),
    );

    const shuffle = this.chip(this.t("shuffle"), bridge.getShuffle(), () => {
      bridge.setShuffle(!bridge.getShuffle());
      this.render("playlist");
    });
    const shuffleRow = document.createElement("div");
    shuffleRow.className = "lumen-chip-row";
    shuffleRow.appendChild(shuffle);
    modes.appendChild(shuffleRow);
    this.body.appendChild(modes);

    const items = bridge.playlistItems();
    if (items.length > 0) {
      const list = document.createElement("div");
      list.className = "lumen-playlist";
      const current = bridge.currentPlaylistIndex();

      items.forEach((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lumen-playlist-item";
        button.setAttribute("aria-current", String(index === current));

        const ordinal = document.createElement("span");
        ordinal.className = "lumen-playlist-index";
        ordinal.textContent = String(index + 1);

        const label = document.createElement("span");
        label.className = "lumen-playlist-label";
        label.textContent = item.title || sourceLabel(item.src);

        button.append(ordinal, label);
        button.addEventListener("click", () => {
          bridge.playItem(index);
          this.render("playlist");
        });
        list.appendChild(button);
      });

      this.body.appendChild(list);
    }

    this.renderBookmarks();

    const open = document.createElement("button");
    open.type = "button";
    open.className = "lumen-chip";
    open.innerHTML = `${icon("folder")} ${this.t("openFile")}`;
    open.style.cssText = "display:flex;align-items:center;gap:6px;align-self:flex-start";
    open.addEventListener("click", () => {
      this.body.dispatchEvent(new CustomEvent("lumen-open-file", { bubbles: true, composed: true }));
    });
    this.body.appendChild(open);
  }

  private renderBookmarks(): void {
    const bridge = this.host.bridge;
    const bookmarks = bridge.getBookmarks();

    const section = this.section(this.t("bookmarks"));

    if (bookmarks.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "margin:0;font-size:0.78rem;color:var(--lumen-color-text-muted)";
      empty.textContent = "—";
      section.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "lumen-playlist";
      for (const bookmark of bookmarks) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "lumen-playlist-item";

        const time = document.createElement("span");
        time.className = "lumen-playlist-index";
        time.textContent = formatTime(bookmark.time);

        const label = document.createElement("span");
        label.className = "lumen-playlist-label";
        label.textContent = bookmark.label;

        const remove = document.createElement("span");
        remove.innerHTML = icon("close");
        remove.setAttribute("role", "button");
        remove.setAttribute("aria-label", `${this.t("bookmarks")}: ${bookmark.label}`);
        remove.style.cssText = "display:flex;opacity:0.6";
        remove.addEventListener("click", (event) => {
          // The row itself seeks; the cross must not do both.
          event.stopPropagation();
          bridge.removeBookmark(bookmark.time);
          this.render("playlist");
        });

        row.append(time, label, remove);
        row.addEventListener("click", () => {
          this.host.video.currentTime = bookmark.time;
        });
        list.appendChild(row);
      }
      section.appendChild(list);
    }

    const add = this.chip(this.t("addBookmark"), false, () => {
      bridge.addBookmark();
      this.render("playlist");
    });
    const row = document.createElement("div");
    row.className = "lumen-chip-row";
    row.appendChild(add);
    section.appendChild(row);

    this.body.appendChild(section);
  }

  // ------------------------------------------------------- equalizer

  private renderEqualizer(): void {
    const audio = this.host.bridge.audio;
    const state = audio.effects;

    const enable = this.chip(this.t("equalizer"), state.equalizer, () => {
      audio.set({ equalizer: !audio.effects.equalizer });
      this.render("equalizer");
    });
    const reset = this.chip(this.t("reset"), false, () => {
      audio.setPreset("flat");
      this.render("equalizer");
    });
    const controls = document.createElement("div");
    controls.className = "lumen-chip-row";
    controls.append(enable, reset);
    this.body.appendChild(controls);

    const presetRow = this.section(this.t("preset"));
    const select = document.createElement("select");
    select.setAttribute("aria-label", this.t("preset"));

    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = this.t("custom");
    select.appendChild(custom);

    for (const preset of EQ_PRESETS) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      select.appendChild(option);
    }
    select.value = state.preset ?? "";
    select.addEventListener("change", () => {
      if (!select.value) return;
      audio.setPreset(select.value);
      this.host.announce(this.t("presetAnnouncement", select.selectedOptions[0]?.textContent ?? ""));
      this.render("equalizer");
    });
    presetRow.appendChild(select);
    this.body.appendChild(presetRow);

    this.body.appendChild(
      this.slider({
        label: this.t("preamp"),
        min: -EQ_GAIN_LIMIT,
        max: EQ_GAIN_LIMIT,
        step: 0.5,
        value: state.preamp,
        format: (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`,
        onInput: (value) => audio.set({ preamp: value, equalizer: true }),
      }),
    );

    this.body.appendChild(this.buildSpectrum());

    const bank = document.createElement("div");
    bank.className = "lumen-eq";

    EQ_FREQUENCIES.forEach((frequency, index) => {
      const band = document.createElement("div");
      band.className = "lumen-eq-band";

      const readout = document.createElement("span");
      readout.className = "lumen-eq-gain";
      const gain = state.bands[index] ?? 0;
      readout.textContent = formatDb(gain);

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(-EQ_GAIN_LIMIT);
      input.max = String(EQ_GAIN_LIMIT);
      input.step = "0.5";
      input.value = String(gain);
      input.setAttribute("aria-label", `${formatHz(frequency)} ${this.t("equalizer")}`);
      input.addEventListener("input", () => {
        const bands = [...audio.effects.bands];
        bands[index] = Number(input.value);
        readout.textContent = formatDb(Number(input.value));
        audio.set({ bands, equalizer: true });
        // Editing a band makes the curve custom; the select follows.
        select.value = audio.effects.preset ?? "";
      });

      const slot = document.createElement("div");
      slot.className = "lumen-eq-slot";
      slot.appendChild(input);

      const label = document.createElement("label");
      label.textContent = formatHz(frequency);

      band.append(readout, slot, label);
      bank.appendChild(band);
    });

    this.body.appendChild(bank);

    if (!audio.isAvailable) this.body.appendChild(this.notice(this.t("audioEffectsUnavailable")));
  }

  /**
   * A live spectrum, drawn from the analyser already sitting at the end of
   * the audio graph.
   *
   * It only draws once the graph exists — that is, once an effect has
   * actually been engaged. Building the graph just to animate a strip
   * would route the element through Web Audio permanently and end AirPlay
   * handoff, which is far too much to spend on decoration.
   */
  private buildSpectrum(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "lumen-spectrum";

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    wrap.appendChild(canvas);

    const hint = document.createElement("span");
    hint.className = "lumen-spectrum-hint";
    hint.textContent = this.t("spectrumHint");
    wrap.appendChild(hint);

    const audio = this.host.bridge.audio;
    const context = canvas.getContext("2d");
    if (!context || prefersReducedMotion()) return wrap;

    const bins = new Uint8Array(512);

    const draw = () => {
      this.spectrumFrame = requestAnimationFrame(draw);

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (!audio.getFrequencyData(bins)) return;
      hint.hidden = true;

      const count = Math.min(audio.frequencyBinCount, bins.length);
      const bars = 48;
      const gap = 2;
      const barWidth = (width - gap * (bars - 1)) / bars;
      const accent = getComputedStyle(canvas).getPropertyValue("--lumen-color-accent").trim() || "#eab54c";

      context.fillStyle = accent;
      for (let i = 0; i < bars; i++) {
        // Bins are linear in frequency but hearing isn't, so the bars are
        // spread logarithmically — otherwise nine tenths of the display
        // would be the top two octaves, where there is rarely anything.
        const from = Math.floor(Math.pow(i / bars, 2) * count);
        const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / bars, 2) * count));
        let peak = 0;
        for (let bin = from; bin < to && bin < count; bin++) peak = Math.max(peak, bins[bin] ?? 0);

        const barHeight = Math.max(1, (peak / 255) * height);
        context.globalAlpha = 0.35 + (peak / 255) * 0.65;
        context.fillRect(i * (barWidth + gap), height - barHeight, barWidth, barHeight);
      }
      context.globalAlpha = 1;
    };

    this.spectrumFrame = requestAnimationFrame(draw);
    return wrap;
  }

  private stopSpectrum(): void {
    if (this.spectrumFrame !== null) {
      cancelAnimationFrame(this.spectrumFrame);
      this.spectrumFrame = null;
    }
  }

  // --------------------------------------------------------- effects

  private renderEffects(): void {
    const tabs = document.createElement("div");
    tabs.className = "lumen-tabs";
    tabs.setAttribute("role", "tablist");

    const definitions: Array<[typeof this.effectsTab, string]> = [
      ["audio", this.t("audioEffects")],
      ["video", this.t("videoEffects")],
      ["subtitles", this.t("captions")],
    ];

    for (const [id, label] of definitions) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "lumen-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(this.effectsTab === id));
      tab.textContent = label;
      tab.addEventListener("click", () => {
        this.effectsTab = id;
        this.render("effects");
      });
      tabs.appendChild(tab);
    }
    this.body.appendChild(tabs);

    if (this.effectsTab === "audio") this.renderAudioEffects();
    else if (this.effectsTab === "video") this.renderVideoEffects();
    else this.renderSubtitleEffects();
  }

  private renderAudioEffects(): void {
    const audio = this.host.bridge.audio;
    const state = audio.effects;

    this.body.appendChild(
      this.slider({
        label: this.t("volumeBoost"),
        min: 1,
        max: MAX_BOOST,
        step: 0.05,
        value: state.boost,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => audio.set({ boost: value }),
      }),
    );

    this.body.appendChild(
      this.slider({
        label: this.t("audioDelay"),
        min: 0,
        max: MAX_AUDIO_DELAY_MS,
        step: 10,
        value: state.delayMs,
        format: (value) => `${Math.round(value)} ms`,
        onInput: (value) => audio.set({ delayMs: value }),
      }),
    );

    const stereo = this.section(this.t("stereoMode"));
    stereo.appendChild(
      this.chipRow(
        [
          { id: "stereo", label: this.t("stereo") },
          { id: "mono", label: this.t("mono") },
          { id: "left", label: this.t("leftOnly") },
          { id: "right", label: this.t("rightOnly") },
          { id: "swap", label: this.t("swapChannels") },
        ],
        state.stereo,
        (id) => {
          audio.set({ stereo: id as typeof state.stereo });
          this.render("effects");
        },
      ),
    );
    this.body.appendChild(stereo);

    const extras = document.createElement("div");
    extras.className = "lumen-chip-row";
    extras.appendChild(
      this.chip(this.t("normalizeVolume"), state.normalize, () => {
        audio.set({ normalize: !audio.effects.normalize });
        this.render("effects");
      }),
    );
    extras.appendChild(
      this.chip(this.t("equalizer"), state.equalizer, () => {
        this.render("equalizer");
      }),
    );
    extras.appendChild(
      this.chip(this.t("reset"), false, () => {
        audio.reset();
        this.render("effects");
      }),
    );
    this.body.appendChild(extras);

    if (!audio.isAvailable) this.body.appendChild(this.notice(this.t("audioEffectsUnavailable")));
  }

  private renderVideoEffects(): void {
    const filters = this.host.bridge.filters;
    const state = filters.filters;
    const percent = (value: number) => `${Math.round(value * 100)}%`;

    const adjustments: Array<{
      key: "brightness" | "contrast" | "saturation" | "hue" | "gamma";
      label: string;
      min: number;
      max: number;
      step: number;
      format: (value: number) => string;
    }> = [
      { key: "brightness", label: this.t("brightness"), min: 0, max: 2, step: 0.01, format: percent },
      { key: "contrast", label: this.t("contrast"), min: 0, max: 2, step: 0.01, format: percent },
      { key: "saturation", label: this.t("saturation"), min: 0, max: 3, step: 0.01, format: percent },
      { key: "hue", label: this.t("hue"), min: -180, max: 180, step: 1, format: (value) => `${Math.round(value)}°` },
      { key: "gamma", label: this.t("gamma"), min: 0.1, max: 4, step: 0.05, format: (value) => value.toFixed(2) },
    ];

    for (const adjustment of adjustments) {
      this.body.appendChild(
        this.slider({
          label: adjustment.label,
          min: adjustment.min,
          max: adjustment.max,
          step: adjustment.step,
          value: state[adjustment.key],
          format: adjustment.format,
          onInput: (value) => filters.set({ [adjustment.key]: value }),
        }),
      );
    }

    this.body.appendChild(
      this.slider({
        label: this.t("zoom"),
        min: 0.5,
        max: 4,
        step: 0.05,
        value: state.zoom,
        format: percent,
        onInput: (value) => filters.set({ zoom: value }),
      }),
    );

    const geometry = this.section(this.t("aspectRatio"));
    geometry.appendChild(
      this.chipRow(
        ASPECT_RATIOS.map((ratio) => ({ id: ratio ?? "", label: ratio ?? this.t("source") })),
        state.aspectRatio ?? "",
        (id) => {
          filters.set({ aspectRatio: id || null });
          this.render("effects");
        },
      ),
    );
    geometry.appendChild(
      this.chipRow(
        [
          { id: "fit", label: this.t("fit") },
          { id: "fill", label: this.t("fill") },
          { id: "stretch", label: this.t("stretch") },
        ],
        state.fit,
        (id) => {
          filters.set({ fit: id as typeof state.fit });
          this.render("effects");
        },
      ),
    );
    this.body.appendChild(geometry);

    const transforms = document.createElement("div");
    transforms.className = "lumen-chip-row";
    transforms.appendChild(
      this.chip(`${this.t("rotate")} ${state.rotation}°`, state.rotation !== 0, () => {
        filters.rotate();
        this.render("effects");
      }),
    );
    transforms.appendChild(
      this.chip(this.t("flipHorizontal"), state.flipHorizontal, () => {
        filters.set({ flipHorizontal: !filters.filters.flipHorizontal });
        this.render("effects");
      }),
    );
    transforms.appendChild(
      this.chip(this.t("flipVertical"), state.flipVertical, () => {
        filters.set({ flipVertical: !filters.filters.flipVertical });
        this.render("effects");
      }),
    );
    transforms.appendChild(
      this.chip(this.t("reset"), false, () => {
        filters.reset();
        this.render("effects");
      }),
    );
    this.body.appendChild(transforms);

    const snapshot = document.createElement("button");
    snapshot.type = "button";
    snapshot.className = "lumen-chip";
    snapshot.innerHTML = `${icon("camera")} ${this.t("snapshot")}`;
    snapshot.style.cssText = "display:flex;align-items:center;gap:6px;align-self:flex-start";
    snapshot.addEventListener("click", () => void this.host.bridge.saveSnapshot());
    this.body.appendChild(snapshot);
  }

  private renderSubtitleEffects(): void {
    const bridge = this.host.bridge;
    const subtitles = this.host.subtitles;
    const prefs = subtitles.prefs;

    this.body.appendChild(
      this.slider({
        label: this.t("subtitleDelay"),
        min: -10,
        max: 10,
        step: 0.1,
        value: bridge.getSubtitleOffset(),
        format: (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} s`,
        onInput: (value) => bridge.setSubtitleOffset(value),
      }),
    );

    this.body.appendChild(
      this.slider({
        label: this.t("subtitleSize"),
        min: 0.6,
        max: 2.5,
        step: 0.05,
        value: prefs.fontSize,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => subtitles.setPrefs({ fontSize: value }),
      }),
    );

    this.body.appendChild(
      this.slider({
        label: this.t("subtitleBackground"),
        min: 0,
        max: 1,
        step: 0.05,
        value: prefs.backgroundOpacity,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => subtitles.setPrefs({ backgroundOpacity: value }),
      }),
    );

    const edge = this.section(this.t("subtitleEdge"));
    edge.appendChild(
      this.chipRow(
        [
          { id: "drop-shadow", label: this.t("dropShadow") },
          { id: "outline", label: this.t("outline") },
          { id: "raised", label: this.t("medium") },
          { id: "none", label: this.t("none") },
        ],
        prefs.edge,
        (id) => {
          subtitles.setPrefs({ edge: id as typeof prefs.edge });
          this.render("effects");
        },
      ),
    );
    this.body.appendChild(edge);

    const position = this.section(this.t("subtitlePosition"));
    position.appendChild(
      this.chipRow(
        [
          { id: "bottom", label: this.t("bottom") },
          { id: "top", label: this.t("top") },
        ],
        prefs.position,
        (id) => {
          subtitles.setPrefs({ position: id as typeof prefs.position });
          this.render("effects");
        },
      ),
    );
    this.body.appendChild(position);
  }

  // ------------------------------------------------------------ info

  private renderInfo(): void {
    const grid = document.createElement("dl");
    grid.className = "lumen-info-grid";

    const rows: Array<[string, string]> = [
      ["container", this.t("container")],
      ["engine", this.t("engine")],
      ["codecs", this.t("codecs")],
      ["resolution", this.t("resolution")],
      ["frameRate", this.t("frameRate")],
      ["duration", this.t("duration")],
      ["bitrate", this.t("bitrate")],
      ["dropped", this.t("droppedFrames")],
      ["buffer", this.t("bufferHealth")],
      ["source", this.t("source")],
    ];

    for (const [key, label] of rows) {
      const term = document.createElement("dt");
      term.textContent = label;
      const value = document.createElement("dd");
      value.textContent = "—";
      this.liveFields.set(key, value);
      grid.append(term, value);
    }

    this.body.appendChild(grid);
    this.updateInfo();
  }

  private updateInfo(): void {
    if (this.liveFields.size === 0) return;
    const info = this.host.bridge.mediaInfo();

    const set = (key: string, value: string) => {
      const node = this.liveFields.get(key);
      if (node) node.textContent = value;
    };

    set("container", info.container);
    set("engine", info.engine);
    set("codecs", info.codecs ?? "—");
    set("resolution", info.width ? `${info.width} × ${info.height}` : "—");
    set("frameRate", info.frameRate ? `${info.frameRate.toFixed(2)} fps` : "—");
    set("duration", Number.isFinite(info.duration) ? formatTime(info.duration) : "—");
    set("bitrate", info.bitrateKbps ? `${Math.round(info.bitrateKbps)} kbit/s` : "—");
    set(
      "dropped",
      info.decodedFrames > 0 ? `${info.droppedFrames} / ${info.decodedFrames}` : String(info.droppedFrames),
    );
    set("buffer", `${info.bufferAheadSeconds.toFixed(1)} s`);
    set("source", info.source ? shorten(info.source) : this.t("nothingPlaying"));
  }

  // ------------------------------------------------------- shortcuts

  private renderShortcuts(): void {
    const list = document.createElement("div");
    list.className = "lumen-shortcuts";

    for (const shortcut of SHORTCUTS) {
      const keys = document.createElement("div");
      for (const key of shortcut.keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        keys.appendChild(kbd);
        keys.append(" ");
      }
      const label = document.createElement("span");
      label.textContent = this.t(shortcut.label);
      list.append(keys, label);
    }

    this.body.appendChild(list);
  }

  // -------------------------------------------------------- builders

  private section(title: string): HTMLElement {
    const section = document.createElement("div");
    section.className = "lumen-panel-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  private notice(message: string): HTMLElement {
    const notice = document.createElement("p");
    notice.style.cssText =
      "margin:0;font-size:0.75rem;line-height:1.4;color:var(--lumen-color-text-muted);border-left:2px solid var(--lumen-color-border);padding-left:8px";
    notice.textContent = message;
    return notice;
  }

  private chip(label: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lumen-chip";
    chip.setAttribute("aria-pressed", String(pressed));
    chip.textContent = label;
    chip.addEventListener("click", onClick);
    return chip;
  }

  private chipRow(
    options: Array<{ id: string; label: string }>,
    selected: string,
    onPick: (id: string) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "lumen-chip-row";
    for (const option of options) {
      row.appendChild(this.chip(option.label, option.id === selected, () => onPick(option.id)));
    }
    return row;
  }

  private slider(options: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    onInput: (value: number) => void;
  }): HTMLElement {
    const field = document.createElement("div");
    field.className = "lumen-field";

    const head = document.createElement("div");
    head.className = "lumen-field-head";
    const label = document.createElement("span");
    label.textContent = options.label;
    const readout = document.createElement("span");
    readout.className = "lumen-field-value";
    readout.textContent = options.format(options.value);
    head.append(label, readout);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
    input.setAttribute("aria-label", options.label);
    input.addEventListener("input", () => {
      const value = Number(input.value);
      readout.textContent = options.format(value);
      options.onInput(value);
    });

    field.append(head, input);
    return field;
  }
}

function formatHz(frequency: number): string {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
}

function formatDb(gain: number): string {
  if (gain === 0) return "0";
  return `${gain > 0 ? "+" : ""}${gain.toFixed(1)}`;
}

/** A readable label for a playlist entry that has no title of its own. */
function sourceLabel(src: unknown): string {
  const first = Array.isArray(src) ? src[0] : src;
  const url = typeof first === "string" ? first : (first as { src?: string } | undefined)?.src;
  if (!url) return "—";
  return decodeURIComponent(url.split("?")[0]?.split("/").pop() ?? url);
}

/** Trims a long URL to its filename, keeping the origin for context. */
function shorten(url: string): string {
  if (url.length <= 60) return url;
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").pop() || parsed.pathname;
    return `${parsed.origin}/…/${name}`;
  } catch {
    return `${url.slice(0, 40)}…${url.slice(-16)}`;
  }
}

/**
 * Adds the panel stylesheet to the shadow root, once per root.
 *
 * The panel markup lives in the player's shell but its styles ship with
 * this module, so they have to be attached before the first render — and
 * exactly once, however many panels are opened afterwards.
 */
function injectPanelStyles(root: Node): void {
  const target = root as ShadowRoot | Document;
  if (!("querySelector" in target)) return;
  if (target.querySelector("style[data-lumen-panels]")) return;

  const style = document.createElement("style");
  style.setAttribute("data-lumen-panels", "");
  style.textContent = panelStyles;
  target.appendChild(style);
}
