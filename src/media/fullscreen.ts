/**
 * Cross-browser fullscreen.
 *
 * Three implementations are still in the wild and the differences are not
 * cosmetic:
 *
 * - The standard `Element.requestFullscreen` / `document.fullscreenElement`.
 * - Safari's `webkit`-prefixed equivalents, which are all that's available
 *   before Safari 16.4.
 * - iPhone, where `Element.requestFullscreen` does not exist at all. The
 *   only way to go fullscreen is `video.webkitEnterFullscreen()`, which
 *   promotes the video element to the system player and never sets
 *   `document.fullscreenElement`.
 *
 * Calling the standard API blind therefore doesn't merely fail on iOS —
 * it throws a `TypeError` synchronously, before any promise exists to
 * catch, so a caller doing `.catch()` still crashes.
 */

interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface IosVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsFullscreen?: boolean;
}

const nativeRequestFullscreen: (() => Promise<void>) | undefined =
  typeof Element !== "undefined" ? Element.prototype.requestFullscreen : undefined;

/** The element currently presented fullscreen, under either spelling. */
export function fullscreenElement(): Element | null {
  const doc = document as PrefixedDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * True when `element` — or, on iPhone, `video` — is the one presented
 * fullscreen. The video fallback matters because the iOS system player
 * leaves `fullscreenElement` null the whole time it's up.
 */
export function isFullscreen(element: Element, video?: HTMLVideoElement | null): boolean {
  if (fullscreenElement() === element) return true;
  return Boolean((video as IosVideoElement | null | undefined)?.webkitDisplayingFullscreen);
}

/** True when some form of fullscreen can be entered at all. */
export function isFullscreenSupported(element: Element, video?: HTMLVideoElement | null): boolean {
  const el = element as PrefixedElement;
  // Read from the prototype rather than the instance for the same reason
  // `enterFullscreen` does: the player overrides the method, so an instance
  // check would report support everywhere.
  if (typeof nativeRequestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function") {
    // False inside an iframe without `allowfullscreen`.
    return document.fullscreenEnabled !== false;
  }
  return typeof (video as IosVideoElement | null | undefined)?.webkitEnterFullscreen === "function";
}

export async function enterFullscreen(element: Element, video?: HTMLVideoElement | null): Promise<void> {
  const el = element as PrefixedElement;

  // Taken from the prototype, not the instance: `LumenPlayer` overrides
  // `requestFullscreen` with a call back into this function, so reading it
  // off the element would recurse until the stack gave out.
  if (typeof nativeRequestFullscreen === "function") {
    await nativeRequestFullscreen.call(el);
    return;
  }
  if (typeof el.webkitRequestFullscreen === "function") {
    await el.webkitRequestFullscreen();
    return;
  }

  // iPhone: the player's own chrome can't come along, but the video going
  // fullscreen is far better than the button doing nothing.
  const ios = video as IosVideoElement | null | undefined;
  if (typeof ios?.webkitEnterFullscreen === "function") {
    ios.webkitEnterFullscreen();
    return;
  }

  throw new Error("Fullscreen is not available");
}

export async function exitFullscreen(video?: HTMLVideoElement | null): Promise<void> {
  const doc = document as PrefixedDocument;
  const ios = video as IosVideoElement | null | undefined;

  if (ios?.webkitDisplayingFullscreen && typeof ios.webkitExitFullscreen === "function") {
    ios.webkitExitFullscreen();
    return;
  }
  if (typeof doc.exitFullscreen === "function") {
    await doc.exitFullscreen();
    return;
  }
  if (typeof doc.webkitExitFullscreen === "function") {
    await doc.webkitExitFullscreen();
  }
}

/**
 * Subscribes to every event that can signal a fullscreen transition and
 * returns an unsubscribe function. iOS reports its own pair on the video
 * element rather than on the document.
 */
export function onFullscreenChange(video: HTMLVideoElement | null, handler: () => void): () => void {
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  video?.addEventListener("webkitbeginfullscreen", handler);
  video?.addEventListener("webkitendfullscreen", handler);

  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
    video?.removeEventListener("webkitbeginfullscreen", handler);
    video?.removeEventListener("webkitendfullscreen", handler);
  };
}
