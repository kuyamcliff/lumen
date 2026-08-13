/** Shorthand for creating an element and applying attributes/props. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, value);
    }
  }
  return el;
}

/** True if the current pointer environment is primarily touch/coarse. */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Resolves once fonts/layout settle enough for a transition to be visible; falls back instantly. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let idCounter = 0;
export function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Starts playback and always hands back a promise.
 *
 * `HTMLMediaElement.play()` was specified to return one only in 2016;
 * older WebKit and several embedded browsers still return `undefined`, so
 * the near-universal `video.play().catch(…)` throws a TypeError there —
 * and it throws in the failure path, exactly where the code was trying to
 * be careful. Autoplay rejections are the norm, so every call site needs
 * something it can attach to.
 */
export function safePlay(video: HTMLMediaElement): Promise<void> {
  try {
    return Promise.resolve(video.play() as Promise<void> | undefined).then(() => {});
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
