/**
 * DRM configuration, expressed once and translated for whichever
 * pipeline ends up playing the stream.
 *
 * The three key systems differ in more than their name: FairPlay needs a
 * server certificate and returns its license in a different shape, which
 * is why each gets its own entry rather than one generic URL.
 */
export interface LumenDrmConfig {
  widevine?: KeySystemConfig;
  playready?: KeySystemConfig;
  fairplay?: FairPlayConfig;
}

export interface KeySystemConfig {
  licenseUrl: string;
  /** Extra headers for the license request (auth tokens, typically). */
  headers?: Record<string, string>;
  /** Rewrites the license response body before it reaches the CDM. */
  transformLicense?: (response: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>;
}

export interface FairPlayConfig extends KeySystemConfig {
  /** DER/base64 server certificate. FairPlay cannot start without it. */
  certificateUrl?: string;
  certificate?: BufferSource;
}

export const KEY_SYSTEMS = {
  widevine: "com.widevine.alpha",
  playready: "com.microsoft.playready",
  fairplay: "com.apple.fps",
} as const;

/**
 * Drives Encrypted Media Extensions for natively-played sources.
 *
 * hls.js and dash.js handle their own licensing when given the same
 * config, so this covers the remaining case: an encrypted stream the
 * browser plays directly (Safari/FairPlay, or a plain encrypted MP4).
 */
export class DrmController {
  private video: HTMLVideoElement;
  private config: LumenDrmConfig;
  private onError: (message: string) => void;
  private attached = false;
  private boundEncrypted = (event: Event) => void this.onEncrypted(event as MediaEncryptedEvent);

  constructor(video: HTMLVideoElement, config: LumenDrmConfig, onError: (message: string) => void) {
    this.video = video;
    this.config = config;
    this.onError = onError;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.widevine || this.config.playready || this.config.fairplay);
  }

  attach(): void {
    if (this.attached || !this.isConfigured) return;
    this.attached = true;
    this.video.addEventListener("encrypted", this.boundEncrypted);
  }

  /** Builds the `drmSystems` option hls.js expects from the same config. */
  toHlsConfig(): Record<string, { licenseUrl: string; serverCertificateUrl?: string }> {
    const systems: Record<string, { licenseUrl: string; serverCertificateUrl?: string }> = {};
    if (this.config.widevine) systems["com.widevine.alpha"] = { licenseUrl: this.config.widevine.licenseUrl };
    if (this.config.playready) {
      systems["com.microsoft.playready"] = { licenseUrl: this.config.playready.licenseUrl };
    }
    if (this.config.fairplay) {
      systems["com.apple.fps"] = {
        licenseUrl: this.config.fairplay.licenseUrl,
        serverCertificateUrl: this.config.fairplay.certificateUrl,
      };
    }
    return systems;
  }

  /** Builds the protection data dash.js expects from the same config. */
  toDashProtectionData(): Record<string, { serverURL: string; httpRequestHeaders?: Record<string, string> }> {
    const data: Record<string, { serverURL: string; httpRequestHeaders?: Record<string, string> }> = {};
    for (const [name, system] of Object.entries(KEY_SYSTEMS)) {
      const entry = this.config[name as keyof LumenDrmConfig];
      if (entry) data[system] = { serverURL: entry.licenseUrl, httpRequestHeaders: entry.headers };
    }
    return data;
  }

  private async onEncrypted(event: MediaEncryptedEvent): Promise<void> {
    // Once a MediaKeys object is attached it handles every subsequent
    // `encrypted` event, including key rotation, so this only runs once.
    if (this.video.mediaKeys) return;

    try {
      const { keySystem, config } = await this.selectKeySystem();
      const access = await navigator.requestMediaKeySystemAccess(keySystem, [
        {
          initDataTypes: [event.initDataType],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        },
      ]);

      const mediaKeys = await access.createMediaKeys();

      if (keySystem === KEY_SYSTEMS.fairplay) {
        const certificate = await this.resolveCertificate(config as FairPlayConfig);
        if (certificate) await mediaKeys.setServerCertificate(certificate);
      }

      await this.video.setMediaKeys(mediaKeys);

      const session = mediaKeys.createSession();
      session.addEventListener("message", (message) => {
        void this.onLicenseRequest(session, message as MediaKeyMessageEvent, config);
      });
      if (event.initData) await session.generateRequest(event.initDataType, event.initData);
    } catch {
      this.onError("This video is protected and couldn't be unlocked on this device.");
    }
  }

  /**
   * Picks the key system the browser actually supports. Configuration can
   * name several; only one will be available on any given platform
   * (FairPlay on Apple, Widevine on Chrome/Firefox, PlayReady on Edge).
   */
  private async selectKeySystem(): Promise<{ keySystem: string; config: KeySystemConfig }> {
    const candidates: Array<[string, KeySystemConfig | undefined]> = [
      [KEY_SYSTEMS.fairplay, this.config.fairplay],
      [KEY_SYSTEMS.widevine, this.config.widevine],
      [KEY_SYSTEMS.playready, this.config.playready],
    ];

    for (const [keySystem, config] of candidates) {
      if (!config) continue;
      try {
        await navigator.requestMediaKeySystemAccess(keySystem, [
          {
            initDataTypes: ["cenc", "sinf", "skd"],
            videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
          },
        ]);
        return { keySystem, config };
      } catch {
        // Not available here — try the next.
      }
    }
    throw new Error("no supported key system");
  }

  private async resolveCertificate(config: FairPlayConfig): Promise<BufferSource | null> {
    if (config.certificate) return config.certificate;
    if (!config.certificateUrl) return null;
    const response = await fetch(config.certificateUrl);
    return response.arrayBuffer();
  }

  private async onLicenseRequest(
    session: MediaKeySession,
    message: MediaKeyMessageEvent,
    config: KeySystemConfig,
  ): Promise<void> {
    try {
      const response = await fetch(config.licenseUrl, {
        method: "POST",
        headers: config.headers,
        body: message.message,
      });
      if (!response.ok) throw new Error(`license request failed: ${response.status}`);

      let license = await response.arrayBuffer();
      if (config.transformLicense) license = await config.transformLicense(license);
      await session.update(license);
    } catch {
      this.onError("Couldn't get permission to play this protected video.");
    }
  }

  destroy(): void {
    this.video.removeEventListener("encrypted", this.boundEncrypted);
    this.attached = false;
  }
}
