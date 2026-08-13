/**
 * Offline playback helpers built on the Cache API.
 *
 * Storing media for offline use is mostly a caching problem, not a player
 * problem — the player just needs the URL to resolve. These helpers
 * handle the parts that are easy to get wrong: byte-range requests (which
 * `cache.match` won't satisfy from a full response without help), quota
 * failures, and knowing what's already downloaded.
 */

const CACHE_NAME = "lumen-media-v1";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  /** 0–1, or null when the server doesn't report a length. */
  fraction: number | null;
}

function cachesAvailable(): boolean {
  return typeof caches !== "undefined";
}

/**
 * Downloads a media file into the cache for offline playback.
 *
 * Resolves false when caching isn't available or the quota is exceeded,
 * rather than throwing — an app should be able to offer "save offline"
 * without wrapping every call.
 */
export async function downloadForOffline(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  if (!cachesAvailable()) return false;

  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return false;

    const totalBytes = Number(response.headers.get("Content-Length")) || 0;

    // The body is consumed to report progress, so it's buffered and a new
    // Response is what actually gets cached.
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      receivedBytes += value.byteLength;
      onProgress?.({
        receivedBytes,
        totalBytes,
        fraction: totalBytes > 0 ? receivedBytes / totalBytes : null,
      });
    }

    const body = new Blob(chunks as BlobPart[], {
      type: response.headers.get("Content-Type") ?? "application/octet-stream",
    });

    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      url,
      new Response(body, {
        headers: {
          "Content-Type": body.type,
          "Content-Length": String(body.size),
          // Range support is what makes seeking work offline; advertise it
          // so the service worker below knows it can slice this response.
          "Accept-Ranges": "bytes",
        },
      }),
    );
    return true;
  } catch {
    // QuotaExceededError is the common case and isn't worth a stack trace.
    return false;
  }
}

export async function isAvailableOffline(url: string): Promise<boolean> {
  if (!cachesAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

export async function removeOffline(url: string): Promise<boolean> {
  if (!cachesAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return cache.delete(url);
  } catch {
    return false;
  }
}

export async function listOffline(): Promise<string[]> {
  if (!cachesAvailable()) return [];
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.keys()).map((request) => request.url);
  } catch {
    return [];
  }
}

/**
 * Service-worker source that serves cached media, including byte ranges.
 *
 * A plain `cache.match()` returns the whole file with a 200, which breaks
 * seeking: the media element issues a `Range` request and needs a 206
 * with `Content-Range` back. This slices the cached body to answer
 * properly. Write it to a file and register it as a service worker.
 */
export const OFFLINE_SERVICE_WORKER = `
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request.url);
    if (!cached) return fetch(request);

    const range = request.headers.get("range");
    if (!range) return cached;

    // Media elements seek with "bytes=start-end"; answer with a 206 so
    // the browser knows partial content is supported.
    const buffer = await cached.arrayBuffer();
    const match = /bytes=(\\d*)-(\\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : buffer.byteLength - 1;

    return new Response(buffer.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
        "Content-Range": \`bytes \${start}-\${end}/\${buffer.byteLength}\`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      },
    });
  })());
});
`.trim();
