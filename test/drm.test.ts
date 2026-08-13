import { afterEach, describe, expect, it, vi } from "vitest";
import { DrmController } from "../src/core/DrmController";

/**
 * The EME flow, driven against a fake CDM. None of this had ever been
 * executed: everything past `attach()` only runs when a browser reports an
 * encrypted stream, which no test environment does on its own.
 */

interface FakeSession {
  messages: Array<(event: unknown) => void>;
  updated: ArrayBuffer[];
  closed: boolean;
  generatedWith: { type: string; data: BufferSource } | null;
}

interface FakeCdm {
  sessions: FakeSession[];
  certificates: BufferSource[];
  /** Key systems the fake browser claims to support. */
  supported: string[];
  requested: string[];
  mediaKeysSet: number;
}

function installFakeEme(supported: string[]): FakeCdm {
  const cdm: FakeCdm = { sessions: [], certificates: [], supported, requested: [], mediaKeysSet: 0 };

  const createSession = (): FakeSession & {
    addEventListener(type: string, handler: (event: unknown) => void): void;
    generateRequest(type: string, data: BufferSource): Promise<void>;
    update(license: ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  } => {
    const session = {
      messages: [] as Array<(event: unknown) => void>,
      updated: [] as ArrayBuffer[],
      closed: false,
      generatedWith: null as { type: string; data: BufferSource } | null,
      addEventListener(type: string, handler: (event: unknown) => void) {
        if (type === "message") session.messages.push(handler);
      },
      async generateRequest(type: string, data: BufferSource) {
        session.generatedWith = { type, data };
        // A real CDM answers generateRequest with a license request.
        for (const handler of session.messages) {
          handler({ message: new Uint8Array([1, 2, 3]).buffer });
        }
      },
      async update(license: ArrayBuffer) {
        session.updated.push(license);
      },
      async close() {
        session.closed = true;
      },
    };
    cdm.sessions.push(session);
    return session;
  };

  const requestAccess = vi.fn(async (keySystem: string) => {
    cdm.requested.push(keySystem);
    if (!cdm.supported.includes(keySystem)) throw new Error("unsupported");
    return {
      keySystem,
      async createMediaKeys() {
        return {
          createSession,
          async setServerCertificate(cert: BufferSource) {
            cdm.certificates.push(cert);
            return true;
          },
        };
      },
    };
  });

  Object.defineProperty(navigator, "requestMediaKeySystemAccess", {
    value: requestAccess,
    configurable: true,
    writable: true,
  });

  return cdm;
}

function encryptedVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  let keys: unknown = null;
  Object.defineProperty(video, "mediaKeys", { get: () => keys, configurable: true });
  Object.defineProperty(video, "setMediaKeys", {
    value: async (value: unknown) => {
      // A real element rejects a second call once keys are attached.
      if (keys) throw new Error("MediaKeys already set");
      keys = value;
    },
    configurable: true,
  });
  return video;
}

function fireEncrypted(video: HTMLVideoElement): void {
  const event = new Event("encrypted") as Event & { initDataType: string; initData: ArrayBuffer };
  Object.defineProperty(event, "initDataType", { value: "cenc" });
  Object.defineProperty(event, "initData", { value: new Uint8Array([9, 9]).buffer });
  video.dispatchEvent(event);
}

/** Lets every queued microtask settle, since the EME flow is all awaits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EME license acquisition", () => {
  it("selects a supported key system, fetches a license, and feeds it to the session", async () => {
    const cdm = installFakeEme(["com.widevine.alpha"]);
    const license = new Uint8Array([7, 7, 7]).buffer;
    const fetchMock = vi.fn(async () => new Response(license, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const video = encryptedVideo();
    const errors: string[] = [];
    const drm = new DrmController(
      video,
      { widevine: { licenseUrl: "https://lic/wv", headers: { Authorization: "Bearer t" } } },
      (message) => errors.push(message),
    );
    drm.attach();

    fireEncrypted(video);
    await settle();

    expect(errors).toEqual([]);
    expect(cdm.sessions).toHaveLength(1);
    expect(cdm.sessions[0]!.generatedWith?.type).toBe("cenc");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://lic/wv");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer t" });

    expect(new Uint8Array(cdm.sessions[0]!.updated[0]!)).toEqual(new Uint8Array([7, 7, 7]));
  });

  it("falls through to the key system this platform actually has", async () => {
    const cdm = installFakeEme(["com.microsoft.playready"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(4), { status: 200 })));

    const video = encryptedVideo();
    const drm = new DrmController(
      video,
      { fairplay: { licenseUrl: "https://lic/fps" }, playready: { licenseUrl: "https://lic/pr" } },
      () => {},
    );
    drm.attach();
    fireEncrypted(video);
    await settle();

    // FairPlay was tried first and refused, so PlayReady must have won.
    expect(cdm.requested).toContain("com.apple.fps");
    expect(cdm.requested.at(-1)).toBe("com.microsoft.playready");
    expect(cdm.sessions).toHaveLength(1);
  });

  it("sets the FairPlay server certificate before creating a session", async () => {
    const cdm = installFakeEme(["com.apple.fps"]);
    const cert = new Uint8Array([0xca, 0xfe]).buffer;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("cert") ? new Response(cert) : new Response(new ArrayBuffer(2)),
      ),
    );

    const video = encryptedVideo();
    const drm = new DrmController(
      video,
      { fairplay: { licenseUrl: "https://lic/fps", certificateUrl: "https://lic/cert" } },
      () => {},
    );
    drm.attach();
    fireEncrypted(video);
    await settle();

    // FairPlay cannot start without it.
    expect(cdm.certificates).toHaveLength(1);
    expect(new Uint8Array(cdm.certificates[0] as ArrayBuffer)).toEqual(new Uint8Array([0xca, 0xfe]));
  });

  it("applies a license transform before handing the bytes to the CDM", async () => {
    // FairPlay servers commonly wrap the license in JSON or base64.
    const cdm = installFakeEme(["com.widevine.alpha"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]).buffer)));

    const video = encryptedVideo();
    const drm = new DrmController(
      video,
      {
        widevine: {
          licenseUrl: "https://lic/wv",
          transformLicense: () => new Uint8Array([42]).buffer,
        },
      },
      () => {},
    );
    drm.attach();
    fireEncrypted(video);
    await settle();

    expect(new Uint8Array(cdm.sessions[0]!.updated[0]!)).toEqual(new Uint8Array([42]));
  });

  it("sets up once for a stream that reports encryption per track", async () => {
    // An encrypted MP4 fires `encrypted` for video and audio in the same
    // tick; a second setMediaKeys() would reject and be reported to the
    // viewer as an unplayable video.
    const cdm = installFakeEme(["com.widevine.alpha"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(2))));

    const video = encryptedVideo();
    const errors: string[] = [];
    const drm = new DrmController(video, { widevine: { licenseUrl: "https://lic/wv" } }, (m) => errors.push(m));
    drm.attach();

    fireEncrypted(video);
    fireEncrypted(video);
    await settle();

    expect(cdm.sessions).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("reports a readable error when no configured key system is available", async () => {
    installFakeEme([]);
    const video = encryptedVideo();
    const errors: string[] = [];
    const drm = new DrmController(video, { widevine: { licenseUrl: "https://lic/wv" } }, (m) => errors.push(m));
    drm.attach();

    fireEncrypted(video);
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/protected/i);
  });

  it("reports a distinct error when the license server refuses", async () => {
    installFakeEme(["com.widevine.alpha"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));

    const video = encryptedVideo();
    const errors: string[] = [];
    const drm = new DrmController(video, { widevine: { licenseUrl: "https://lic/wv" } }, (m) => errors.push(m));
    drm.attach();
    fireEncrypted(video);
    await settle();

    // Distinguishable from "no key system": this one is an entitlement
    // problem, not a device problem.
    expect(errors[0]).toMatch(/permission/i);
  });

  it("closes its sessions on teardown", async () => {
    const cdm = installFakeEme(["com.widevine.alpha"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(2))));

    const video = encryptedVideo();
    const drm = new DrmController(video, { widevine: { licenseUrl: "https://lic/wv" } }, () => {});
    drm.attach();
    fireEncrypted(video);
    await settle();

    drm.destroy();
    await settle();

    // Sessions hold keys and a server-side allocation; leaving them open
    // leaks both for the life of the page.
    expect(cdm.sessions[0]!.closed).toBe(true);
  });

  it("stops responding to encrypted events after destroy", async () => {
    const cdm = installFakeEme(["com.widevine.alpha"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ArrayBuffer(2))));

    const video = encryptedVideo();
    const drm = new DrmController(video, { widevine: { licenseUrl: "https://lic/wv" } }, () => {});
    drm.attach();
    drm.destroy();

    fireEncrypted(video);
    await settle();
    expect(cdm.sessions).toHaveLength(0);
  });
});
