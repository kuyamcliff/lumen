import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SERVICE_WORKER,
  downloadForOffline,
  isAvailableOffline,
  listOffline,
  removeOffline,
} from "../src/offline";

/** A minimal in-memory stand-in for the Cache API. */
class FakeCache {
  store = new Map<string, Response>();
  async put(request: RequestInfo, response: Response): Promise<void> {
    this.store.set(String(request), response);
  }
  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.store.get(String(request));
  }
  async delete(request: RequestInfo): Promise<boolean> {
    return this.store.delete(String(request));
  }
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => ({ url }) as Request);
  }
}

let cache: FakeCache;

function stubCaches(): void {
  cache = new FakeCache();
  vi.stubGlobal("caches", { open: async () => cache });
}

/** A response whose body streams in several chunks, so progress is observable. */
function streamingResponse(chunks: Uint8Array[], contentLength?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers: Record<string, string> = { "Content-Type": "video/mp4" };
  if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
  return new Response(stream, { status: 200, headers });
}

beforeEach(stubCaches);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadForOffline", () => {
  it("caches the file and reports progress as it downloads", async () => {
    const chunks = [new Uint8Array(40), new Uint8Array(60)];
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse(chunks, 100)));

    const progress: Array<number | null> = [];
    const ok = await downloadForOffline("https://cdn/movie.mp4", (p) => progress.push(p.fraction));

    expect(ok).toBe(true);
    expect(progress).toEqual([0.4, 1]);
    expect(await isAvailableOffline("https://cdn/movie.mp4")).toBe(true);
  });

  it("reports a null fraction when the server sends no Content-Length", async () => {
    // A chunked response has no total, so progress can't be a percentage —
    // callers need to be able to tell that apart from 0%.
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse([new Uint8Array(10)])));

    const progress: Array<number | null> = [];
    await downloadForOffline("https://cdn/a.mp4", (p) => progress.push(p.fraction));

    expect(progress).toEqual([null]);
  });

  it("stores the body with the headers that make seeking work", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse([new Uint8Array(8)], 8)));
    await downloadForOffline("https://cdn/b.mp4");

    const cached = await cache.match("https://cdn/b.mp4");
    expect(cached).toBeDefined();
    // Without Accept-Ranges the service worker can't know it may slice this.
    expect(cached!.headers.get("Accept-Ranges")).toBe("bytes");
    expect(cached!.headers.get("Content-Length")).toBe("8");
    expect(cached!.headers.get("Content-Type")).toBe("video/mp4");
  });

  it("returns false rather than throwing when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await downloadForOffline("https://cdn/missing.mp4")).toBe(false);
  });

  it("returns false rather than throwing when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await downloadForOffline("https://cdn/x.mp4")).toBe(false);
  });

  it("returns false when the quota is exceeded", async () => {
    // Apps should be able to offer "save offline" without wrapping the call.
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse([new Uint8Array(8)], 8)));
    vi.stubGlobal("caches", {
      open: async () => ({
        put: async () => {
          throw new DOMException("quota", "QuotaExceededError");
        },
      }),
    });

    expect(await downloadForOffline("https://cdn/big.mp4")).toBe(false);
  });

  it("returns false where the Cache API doesn't exist", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await downloadForOffline("https://cdn/a.mp4")).toBe(false);
    expect(await isAvailableOffline("https://cdn/a.mp4")).toBe(false);
    expect(await listOffline()).toEqual([]);
    expect(await removeOffline("https://cdn/a.mp4")).toBe(false);
  });
});

describe("offline inventory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => streamingResponse([new Uint8Array(4)], 4)));
  });

  it("lists and removes cached media", async () => {
    await downloadForOffline("https://cdn/one.mp4");
    await downloadForOffline("https://cdn/two.mp4");

    expect(await listOffline()).toEqual(["https://cdn/one.mp4", "https://cdn/two.mp4"]);

    expect(await removeOffline("https://cdn/one.mp4")).toBe(true);
    expect(await isAvailableOffline("https://cdn/one.mp4")).toBe(false);
    expect(await isAvailableOffline("https://cdn/two.mp4")).toBe(true);
  });

  it("reports a file that was never downloaded as unavailable", async () => {
    expect(await isAvailableOffline("https://cdn/nope.mp4")).toBe(false);
  });
});

describe("service worker source", () => {
  /**
   * The worker is shipped as source text, so it can't be imported. It's
   * evaluated here in a fake worker scope to check the part that actually
   * matters: answering a Range request with a 206, without which seeking
   * silently breaks on cached media.
   */
  function evaluateWorker(cached: Response | undefined) {
    let fetchHandler: ((event: any) => void) | null = null;
    const scope = {
      addEventListener: (type: string, handler: (event: any) => void) => {
        if (type === "fetch") fetchHandler = handler;
      },
    };
    const caches = { open: async () => ({ match: async () => cached }) };

    // eslint-disable-next-line no-new-func
    new Function("self", "caches", "fetch", OFFLINE_SERVICE_WORKER)(
      scope,
      caches,
      async () => new Response("network", { status: 200 }),
    );
    return fetchHandler!;
  }

  async function respond(handler: (event: any) => void, request: { url: string; method: string; headers: Headers }) {
    let responded: Promise<Response> | null = null;
    handler({ request, respondWith: (promise: Promise<Response>) => { responded = promise; } });
    return responded ? await responded : null;
  }

  it("serves a byte range as 206 with Content-Range", async () => {
    const body = new Uint8Array(100).map((_, i) => i);
    const cached = new Response(body, { headers: { "Content-Type": "video/mp4" } });
    const handler = evaluateWorker(cached);

    const response = await respond(handler, {
      url: "https://cdn/movie.mp4",
      method: "GET",
      headers: new Headers({ range: "bytes=10-19" }),
    });

    expect(response!.status).toBe(206);
    expect(response!.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(response!.headers.get("Content-Length")).toBe("10");
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(body.slice(10, 20));
  });

  it("treats an open-ended range as running to the end of the file", async () => {
    const cached = new Response(new Uint8Array(50));
    const handler = evaluateWorker(cached);

    const response = await respond(handler, {
      url: "https://cdn/movie.mp4",
      method: "GET",
      headers: new Headers({ range: "bytes=20-" }),
    });

    expect(response!.status).toBe(206);
    expect(response!.headers.get("Content-Range")).toBe("bytes 20-49/50");
  });

  it("returns the whole cached response when no range is requested", async () => {
    const cached = new Response(new Uint8Array(30));
    const handler = evaluateWorker(cached);

    const response = await respond(handler, {
      url: "https://cdn/movie.mp4",
      method: "GET",
      headers: new Headers(),
    });

    expect(response!.status).toBe(200);
  });

  it("falls through to the network for something that isn't cached", async () => {
    const handler = evaluateWorker(undefined);

    const response = await respond(handler, {
      url: "https://cdn/other.mp4",
      method: "GET",
      headers: new Headers(),
    });

    expect(await response!.text()).toBe("network");
  });

  it("ignores non-GET requests entirely", async () => {
    const handler = evaluateWorker(new Response(new Uint8Array(10)));
    const response = await respond(handler, {
      url: "https://cdn/movie.mp4",
      method: "POST",
      headers: new Headers(),
    });

    expect(response).toBeNull();
  });
});
