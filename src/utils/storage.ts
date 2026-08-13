/**
 * localStorage wrapper that never throws — private browsing, disabled
 * storage, or quota errors degrade to a no-op rather than breaking playback.
 */
const NAMESPACE = "lumen-player";

function safeStorage(): Storage | null {
  try {
    const testKey = `${NAMESPACE}:__test__`;
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: Storage | null | undefined;
function storage(): Storage | null {
  if (cached === undefined) cached = safeStorage();
  return cached;
}

export function getItem<T>(key: string, fallback: T): T {
  const s = storage();
  if (!s) return fallback;
  try {
    const raw = s.getItem(`${NAMESPACE}:${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setItem<T>(key: string, value: T): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(`${NAMESPACE}:${key}`, JSON.stringify(value));
  } catch {
    // quota exceeded or blocked — ignore, preferences just won't persist
  }
}
