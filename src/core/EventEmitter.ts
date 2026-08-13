import type { LumenEventMap, LumenEventName } from "../types";

type Listener<K extends LumenEventName> = (detail: LumenEventMap[K]) => void;

/**
 * A tiny, strongly-typed event emitter. Kept dependency-free to protect the
 * core size budget — this is the only pub/sub mechanism the player uses
 * internally, and it also backs the public `on`/`off`/`once` API.
 */
export class EventEmitter {
  private listeners = new Map<LumenEventName, Set<Listener<any>>>();

  on<K extends LumenEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  once<K extends LumenEventName>(event: K, listener: Listener<K>): () => void {
    const off = this.on(event, (detail) => {
      off();
      listener(detail);
    });
    return off;
  }

  off<K extends LumenEventName>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends LumenEventName>(event: K, detail: LumenEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy before iterating: a listener may unsubscribe itself or others.
    for (const listener of [...set]) {
      listener(detail);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
