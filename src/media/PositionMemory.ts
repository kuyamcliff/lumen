import { getItem, setItem } from "../utils/storage";

export interface LumenBookmark {
  time: number;
  label: string;
}

interface StoredEntry {
  /** Last playback position, in seconds. */
  position: number;
  /** Total duration when it was stored, used to ignore stale entries. */
  duration: number;
  /** Epoch ms of the last update, so old entries can be evicted. */
  at: number;
  bookmarks?: LumenBookmark[];
}

type Store = Record<string, StoredEntry>;

const STORAGE_KEY = "positions";
/** Keeping every file ever opened would grow without bound. */
const MAX_ENTRIES = 60;
/** Don't offer to resume something that barely started. */
const MIN_RESUME_SECONDS = 30;
/** Nor something that's effectively finished. */
const TAIL_MARGIN_SECONDS = 20;

/**
 * Remembers where each file was left off, and any bookmarks set in it —
 * the "continue where you left off" behaviour VLC has had forever, and the
 * single feature people notice missing from a web player the fastest.
 *
 * Entries are keyed by URL with the query string stripped, because signed
 * CDN links carry an expiring token that would otherwise make every visit
 * look like a different file.
 */
export class PositionMemory {
  private key: string | null = null;

  /** Normalises a source URL into a stable storage key. */
  static keyFor(src: string): string | null {
    if (!src) return null;
    // A blob: URL is regenerated on every load, so it identifies nothing.
    if (src.startsWith("blob:") || src.startsWith("data:")) return null;
    try {
      const url = new URL(src, typeof window === "undefined" ? "http://localhost" : window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return src.split("?")[0] ?? src;
    }
  }

  /** Points the memory at a source. Pass null when nothing is loaded. */
  track(src: string | null): void {
    this.key = src ? PositionMemory.keyFor(src) : null;
  }

  /**
   * The position worth resuming from, or null when there isn't one:
   * nothing stored, barely started, or already at the end.
   */
  resumePosition(duration: number): number | null {
    const entry = this.entry();
    if (!entry) return null;
    if (entry.position < MIN_RESUME_SECONDS) return null;
    if (Number.isFinite(duration) && duration > 0) {
      if (entry.position > duration - TAIL_MARGIN_SECONDS) return null;
    }
    return entry.position;
  }

  save(position: number, duration: number): void {
    if (!this.key || !Number.isFinite(position) || position <= 0) return;
    const store = this.load();
    const existing = store[this.key];
    store[this.key] = {
      position,
      duration: Number.isFinite(duration) ? duration : 0,
      at: Date.now(),
      bookmarks: existing?.bookmarks,
    };
    this.persist(store);
  }

  /** Forgets the position but keeps bookmarks; used when a file finishes. */
  clearPosition(): void {
    if (!this.key) return;
    const store = this.load();
    const existing = store[this.key];
    if (!existing) return;
    if (existing.bookmarks?.length) {
      store[this.key] = { ...existing, position: 0, at: Date.now() };
    } else {
      delete store[this.key];
    }
    this.persist(store);
  }

  get bookmarks(): LumenBookmark[] {
    return this.entry()?.bookmarks ?? [];
  }

  addBookmark(bookmark: LumenBookmark): LumenBookmark[] {
    if (!this.key) return [];
    const store = this.load();
    const existing = store[this.key] ?? { position: 0, duration: 0, at: Date.now() };
    const bookmarks = [...(existing.bookmarks ?? []), bookmark].sort((a, b) => a.time - b.time);
    store[this.key] = { ...existing, at: Date.now(), bookmarks };
    this.persist(store);
    return bookmarks;
  }

  removeBookmark(time: number): LumenBookmark[] {
    if (!this.key) return [];
    const store = this.load();
    const existing = store[this.key];
    if (!existing?.bookmarks) return [];
    const bookmarks = existing.bookmarks.filter((bookmark) => Math.abs(bookmark.time - time) > 0.001);
    store[this.key] = { ...existing, bookmarks };
    this.persist(store);
    return bookmarks;
  }

  private entry(): StoredEntry | null {
    if (!this.key) return null;
    return this.load()[this.key] ?? null;
  }

  private load(): Store {
    return getItem<Store>(STORAGE_KEY, {});
  }

  /** Writes the store back, evicting the least recently touched entries. */
  private persist(store: Store): void {
    const entries = Object.entries(store);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].at - a[1].at);
      store = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    setItem(STORAGE_KEY, store);
  }
}
