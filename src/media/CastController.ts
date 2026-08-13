/**
 * Casting hooks for AirPlay and the Remote Playback API.
 *
 * Both are advertised only when a receiver is actually reachable, so the
 * cast button appears when it can do something and stays out of the way
 * otherwise — a permanently visible button that always fails is worse
 * than no button.
 */

interface AirPlayVideoElement extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

export class CastController {
  private video: AirPlayVideoElement;
  private onAvailabilityChange: (available: boolean) => void;
  private airplayAvailable = false;
  private remoteAvailable = false;
  private watchId: number | null = null;
  private boundAirplayChange = (event: Event) => {
    this.airplayAvailable = (event as Event & { availability?: string }).availability === "available";
    this.notify();
  };

  constructor(video: HTMLVideoElement, onAvailabilityChange: (available: boolean) => void) {
    this.video = video as AirPlayVideoElement;
    this.onAvailabilityChange = onAvailabilityChange;
    this.watch();
  }

  get isAvailable(): boolean {
    return this.airplayAvailable || this.remoteAvailable;
  }

  /** True while playback is being routed to an external device. */
  get isCasting(): boolean {
    if (this.video.webkitCurrentPlaybackTargetIsWireless) return true;
    return this.video.remote?.state === "connected";
  }

  private watch(): void {
    // Safari/AirPlay.
    if (typeof this.video.webkitShowPlaybackTargetPicker === "function") {
      this.video.addEventListener("webkitplaybacktargetavailabilitychanged", this.boundAirplayChange);
    }

    // Remote Playback API (Chrome, Edge). watchAvailability rejects when
    // the page disables remote playback, which is not an error worth
    // surfacing — it just means no cast button.
    const remote = this.video.remote;
    if (remote?.watchAvailability) {
      remote
        .watchAvailability((available) => {
          this.remoteAvailable = available;
          this.notify();
        })
        .then((id) => {
          this.watchId = id;
        })
        .catch(() => {
          /* remote playback disabled for this element */
        });
    }
  }

  /** Opens the platform's device picker. Resolves false if none could be shown. */
  async prompt(): Promise<boolean> {
    if (typeof this.video.webkitShowPlaybackTargetPicker === "function") {
      this.video.webkitShowPlaybackTargetPicker();
      return true;
    }
    // `await undefined` resolves happily, so without this check a browser
    // with no Remote Playback API would report having shown a picker that
    // never existed.
    const remote = this.video.remote;
    if (typeof remote?.prompt !== "function") return false;

    try {
      await remote.prompt();
      return true;
    } catch {
      // Also thrown when the user simply dismisses the picker.
      return false;
    }
  }

  private notify(): void {
    this.onAvailabilityChange(this.isAvailable);
  }

  destroy(): void {
    this.video.removeEventListener("webkitplaybacktargetavailabilitychanged", this.boundAirplayChange);
    if (this.watchId !== null) {
      this.video.remote?.cancelWatchAvailability(this.watchId).catch(() => {});
      this.watchId = null;
    }
  }
}
