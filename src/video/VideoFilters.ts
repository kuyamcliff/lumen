import { getItem, setItem } from "../utils/storage";
import { clamp } from "../utils/time";

/**
 * How the picture is fitted into the player box, mirroring VLC's
 * aspect-ratio and crop menus.
 *
 * - `fit` letterboxes (VLC's default)
 * - `fill` crops to fill the frame — VLC's "crop to fit"
 * - `stretch` ignores the source aspect entirely
 */
export type FitMode = "fit" | "fill" | "stretch";

export type Rotation = 0 | 90 | 180 | 270;

export interface VideoAdjustments {
  /** 0–2, 1 = untouched. Matches VLC's range. */
  brightness: number;
  /** 0–2, 1 = untouched. */
  contrast: number;
  /** 0–3, 1 = untouched. */
  saturation: number;
  /** −180…180 degrees. */
  hue: number;
  /** 0.1–4, 1 = untouched. */
  gamma: number;
}

export interface VideoFilterState extends VideoAdjustments {
  /** Magnification, 1 = 100%. VLC's zoom menu in continuous form. */
  zoom: number;
  rotation: Rotation;
  flipHorizontal: boolean;
  flipVertical: boolean;
  fit: FitMode;
  /** Forced display aspect, e.g. `"16/9"`, or null to use the source's. */
  aspectRatio: string | null;
}

export const DEFAULT_VIDEO_FILTERS: VideoFilterState = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  gamma: 1,
  zoom: 1,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  fit: "fit",
  aspectRatio: null,
};

/** The aspect ratios VLC cycles through with `a`, plus "source". */
export const ASPECT_RATIOS: Array<string | null> = [null, "16/9", "4/3", "1/1", "16/10", "2.35/1", "2.39/1", "5/4"];

/** The zoom steps VLC cycles through with `z`. */
export const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4];

const GAMMA_FILTER_ID = "lumen-gamma";

function approximately(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

/**
 * The picture-adjustment layer: VLC's "Video Effects → Essential" tab
 * (brightness, contrast, saturation, hue, gamma) plus its zoom, rotate,
 * flip, aspect-ratio and crop menus.
 *
 * Everything here is compositor work — a CSS `filter` and `transform` on
 * the video element — so it costs nothing until a control moves, runs on
 * the GPU, and never touches the decoded frames. Gamma is the one
 * adjustment CSS has no primitive for, so it goes through a small inline
 * SVG `feComponentTransfer` filter that is only referenced while gamma is
 * off its default.
 */
export class VideoFilters {
  private video: HTMLVideoElement;
  private host: HTMLElement;
  private root: HTMLElement;
  private gammaFilter: SVGFEComponentTransferElement | null = null;
  private state: VideoFilterState;
  private onChange: () => void;

  /**
   * @param video the media element the filters are painted onto
   * @param host  the `<lumen-player>` element itself, which carries
   *              `--lumen-aspect-ratio` — a forced aspect ratio reshapes
   *              the player box rather than stretching the picture in it
   * @param root  the shadow-DOM shell, where the gamma filter is parked so
   *              `url(#id)` resolves inside the shadow tree
   */
  constructor(
    video: HTMLVideoElement,
    host: HTMLElement,
    root: HTMLElement,
    onChange: () => void = () => {},
  ) {
    this.video = video;
    this.host = host;
    this.root = root;
    this.onChange = onChange;
    this.state = { ...DEFAULT_VIDEO_FILTERS, ...getItem<Partial<VideoFilterState>>("video-filters", {}) };
    // Adjustments are per-video decisions a viewer makes for one file, but
    // geometry (zoom/rotation/aspect) is restored, matching VLC, which
    // remembers its video-filter settings across sessions too.
    this.apply();
  }

  get filters(): VideoFilterState {
    return { ...this.state };
  }

  /** True when the picture is being shown exactly as decoded. */
  get isIdentity(): boolean {
    const s = this.state;
    return (
      approximately(s.brightness, 1) &&
      approximately(s.contrast, 1) &&
      approximately(s.saturation, 1) &&
      approximately(s.hue, 0) &&
      approximately(s.gamma, 1) &&
      approximately(s.zoom, 1) &&
      s.rotation === 0 &&
      !s.flipHorizontal &&
      !s.flipVertical &&
      s.fit === "fit" &&
      s.aspectRatio === null
    );
  }

  set(patch: Partial<VideoFilterState>): void {
    this.state = {
      ...this.state,
      ...patch,
      brightness: clamp(patch.brightness ?? this.state.brightness, 0, 2),
      contrast: clamp(patch.contrast ?? this.state.contrast, 0, 2),
      saturation: clamp(patch.saturation ?? this.state.saturation, 0, 3),
      hue: clamp(patch.hue ?? this.state.hue, -180, 180),
      gamma: clamp(patch.gamma ?? this.state.gamma, 0.1, 4),
      zoom: clamp(patch.zoom ?? this.state.zoom, 0.1, 8),
    };
    setItem("video-filters", this.state);
    this.apply();
    this.onChange();
  }

  reset(): void {
    this.set({ ...DEFAULT_VIDEO_FILTERS });
  }

  /** Resets only the colour adjustments, leaving geometry alone. */
  resetAdjustments(): void {
    const { brightness, contrast, saturation, hue, gamma } = DEFAULT_VIDEO_FILTERS;
    this.set({ brightness, contrast, saturation, hue, gamma });
  }

  /** Advances to the next aspect ratio, as VLC's `a` key does. */
  cycleAspectRatio(): string | null {
    const index = ASPECT_RATIOS.indexOf(this.state.aspectRatio);
    const next = ASPECT_RATIOS[(index + 1) % ASPECT_RATIOS.length] ?? null;
    this.set({ aspectRatio: next });
    return next;
  }

  /** Advances to the next zoom step, as VLC's `z` key does. */
  cycleZoom(): number {
    const index = ZOOM_STEPS.findIndex((step) => step > this.state.zoom + 0.001);
    const next = ZOOM_STEPS[index === -1 ? 0 : index] ?? 1;
    this.set({ zoom: next });
    return next;
  }

  /** Rotates a quarter turn clockwise. */
  rotate(): Rotation {
    const next = ((this.state.rotation + 90) % 360) as Rotation;
    this.set({ rotation: next });
    return next;
  }

  cycleFit(): FitMode {
    const order: FitMode[] = ["fit", "fill", "stretch"];
    const next = order[(order.indexOf(this.state.fit) + 1) % order.length] ?? "fit";
    this.set({ fit: next });
    return next;
  }

  // ------------------------------------------------------------- apply

  /** The CSS `filter` value for the current colour adjustments. */
  cssFilter(): string {
    const s = this.state;
    const parts: string[] = [];
    if (!approximately(s.brightness, 1)) parts.push(`brightness(${s.brightness})`);
    if (!approximately(s.contrast, 1)) parts.push(`contrast(${s.contrast})`);
    if (!approximately(s.saturation, 1)) parts.push(`saturate(${s.saturation})`);
    if (!approximately(s.hue, 0)) parts.push(`hue-rotate(${s.hue}deg)`);
    if (!approximately(s.gamma, 1)) parts.push(`url(#${GAMMA_FILTER_ID})`);
    return parts.length > 0 ? parts.join(" ") : "none";
  }

  /** The CSS `transform` value for the current geometry. */
  cssTransform(): string {
    const s = this.state;
    const parts: string[] = [];

    if (s.rotation !== 0) parts.push(`rotate(${s.rotation}deg)`);
    // A quarter turn swaps the axes, so the picture has to be scaled by the
    // box's aspect ratio to keep filling it instead of poking out the sides.
    const quarterTurn = s.rotation === 90 || s.rotation === 270;
    const rotationScale = quarterTurn ? this.quarterTurnScale() : 1;
    const scaleX = s.zoom * rotationScale * (s.flipHorizontal ? -1 : 1);
    const scaleY = s.zoom * rotationScale * (s.flipVertical ? -1 : 1);
    if (!approximately(scaleX, 1) || !approximately(scaleY, 1)) {
      parts.push(`scale(${round(scaleX)}, ${round(scaleY)})`);
    }

    return parts.length > 0 ? parts.join(" ") : "none";
  }

  /**
   * How much a quarter-turned picture must shrink to still fit the box.
   *
   * Rotating a 16:9 frame inside a 16:9 box leaves it 16/9 times too tall,
   * so the scale factor is the smaller of the two axis ratios.
   */
  private quarterTurnScale(): number {
    const width = this.video.clientWidth;
    const height = this.video.clientHeight;
    if (!width || !height) return 1;
    return Math.min(height / width, width / height);
  }

  /** Recomputes the layout-dependent part of the transform after a resize. */
  refresh(): void {
    this.apply();
  }

  private apply(): void {
    const s = this.state;
    this.video.style.filter = this.cssFilter();
    this.video.style.transform = this.cssTransform();

    this.video.style.objectFit = s.fit === "fill" ? "cover" : s.fit === "stretch" ? "fill" : "";
    if (s.aspectRatio) {
      this.host.style.setProperty("--lumen-aspect-ratio", s.aspectRatio.replace("/", " / "));
    } else {
      this.host.style.removeProperty("--lumen-aspect-ratio");
    }

    if (!approximately(s.gamma, 1)) this.applyGamma(s.gamma);
  }

  /**
   * Updates the inline SVG gamma filter, creating it on first use.
   *
   * `feFuncR type="gamma"` computes `amplitude · C^exponent + offset`, so
   * the exponent is the reciprocal of the gamma value — a gamma of 2 means
   * an exponent of 0.5, which is the direction that brightens midtones.
   */
  private applyGamma(gamma: number): void {
    const exponent = String(round(1 / gamma));
    if (!this.gammaFilter) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";

      const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.setAttribute("id", GAMMA_FILTER_ID);
      // Without this the transfer runs in linearRGB and the correction
      // lands nowhere near where a viewer expects it.
      filter.setAttribute("color-interpolation-filters", "sRGB");

      const transfer = document.createElementNS("http://www.w3.org/2000/svg", "feComponentTransfer");
      for (const channel of ["feFuncR", "feFuncG", "feFuncB"]) {
        const func = document.createElementNS("http://www.w3.org/2000/svg", channel);
        func.setAttribute("type", "gamma");
        func.setAttribute("exponent", exponent);
        transfer.appendChild(func);
      }
      filter.appendChild(transfer);
      svg.appendChild(filter);
      // Lives in the same tree as the video so `url(#id)` resolves inside
      // the shadow root rather than escaping to the page.
      this.root.appendChild(svg);
      this.gammaFilter = transfer;
      return;
    }

    for (const func of Array.from(this.gammaFilter.children)) {
      func.setAttribute("exponent", exponent);
    }
  }

  destroy(): void {
    this.video.style.filter = "";
    this.video.style.transform = "";
    this.video.style.objectFit = "";
    this.gammaFilter?.ownerSVGElement?.remove();
    this.gammaFilter = null;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
