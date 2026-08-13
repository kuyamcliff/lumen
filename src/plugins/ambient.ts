import type { LumenPlugin } from "./types";

export interface AmbientOptions {
  /** How far the glow extends beyond the player, in pixels. */
  spread?: number;
  /** Glow opacity, 0–1. */
  intensity?: number;
  /** Sampling interval in milliseconds. */
  intervalMs?: number;
}

const DEFAULTS = { spread: 80, intensity: 0.7, intervalMs: 200 };

/**
 * Ambient mode: a soft glow behind the player, sampled from the video.
 *
 * The frame is drawn to a tiny offscreen canvas and blurred back up,
 * which is cheap enough to run continuously — a handful of pixels per
 * sample rather than a full-resolution readback. Sampling pauses when the
 * video does, and stops entirely under `prefers-reduced-motion`, since a
 * shifting glow is exactly the kind of ambient movement that setting is
 * meant to suppress.
 */
export function ambient(options: AmbientOptions = {}): LumenPlugin {
  const config = { ...DEFAULTS, ...options };

  return {
    name: "ambient",
    setup(player) {
      const reduceMotion =
        typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) return;

      const video = player.videoElement;
      const canvas = document.createElement("canvas");
      // 16x9 is enough: the result is blurred beyond recognition anyway.
      canvas.width = 16;
      canvas.height = 9;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      const glow = document.createElement("canvas");
      glow.width = 16;
      glow.height = 9;
      glow.setAttribute("aria-hidden", "true");
      glow.style.cssText = [
        "position:absolute",
        `left:-${config.spread}px`,
        `top:-${config.spread}px`,
        // A canvas is a replaced element: with `width:auto` it takes its
        // intrinsic 16x9 size and `inset` alone will not stretch it, so the
        // box has to be sized explicitly.
        `width:calc(100% + ${config.spread * 2}px)`,
        `height:calc(100% + ${config.spread * 2}px)`,
        "z-index:-1",
        `filter:blur(${config.spread / 2}px) saturate(1.6)`,
        `opacity:${config.intensity}`,
        "pointer-events:none",
        "transition:opacity 400ms ease",
      ].join(";");

      // The glow sits behind the player, so the host needs a stacking
      // context that doesn't clip it.
      const previousOverflow = player.style.overflow;
      player.style.overflow = "visible";
      player.prepend(glow);

      const glowContext = glow.getContext("2d");
      let timer: number | null = null;

      const sample = () => {
        if (video.readyState < 2 || video.paused || video.ended) return;
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          glowContext?.drawImage(canvas, 0, 0);
        } catch {
          // A cross-origin video without CORS taints the canvas. Nothing
          // to do but stop trying; playback is unaffected.
          stop();
        }
      };

      const start = () => {
        if (timer !== null) return;
        timer = window.setInterval(sample, config.intervalMs);
      };

      const stop = () => {
        if (timer === null) return;
        window.clearInterval(timer);
        timer = null;
      };

      video.addEventListener("play", start);
      video.addEventListener("pause", stop);
      video.addEventListener("ended", stop);
      if (!video.paused) start();

      return () => {
        stop();
        video.removeEventListener("play", start);
        video.removeEventListener("pause", stop);
        video.removeEventListener("ended", stop);
        glow.remove();
        player.style.overflow = previousOverflow;
      };
    },
  };
}
