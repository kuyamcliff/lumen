import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "../src/core/EventEmitter";

describe("EventEmitter", () => {
  it("calls listeners with the emitted detail", () => {
    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.on("play", spy);
    emitter.emit("play", undefined);
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  it("supports multiple listeners for the same event", () => {
    const emitter = new EventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on("pause", a);
    emitter.on("pause", b);
    emitter.emit("pause", undefined);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("on() returns an unsubscribe function", () => {
    const emitter = new EventEmitter();
    const spy = vi.fn();
    const off = emitter.on("play", spy);
    off();
    emitter.emit("play", undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it("off() removes a specific listener", () => {
    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.on("play", spy);
    emitter.off("play", spy);
    emitter.emit("play", undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it("once() only fires a single time", () => {
    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.once("play", spy);
    emitter.emit("play", undefined);
    emitter.emit("play", undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a listener may unsubscribe itself mid-emit without breaking other listeners", () => {
    const emitter = new EventEmitter();
    const b = vi.fn();
    const a = vi.fn(() => emitter.off("play", a));
    emitter.on("play", a);
    emitter.on("play", b);
    emitter.emit("play", undefined);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    emitter.emit("play", undefined);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("clear() removes all listeners", () => {
    const emitter = new EventEmitter();
    const spy = vi.fn();
    emitter.on("play", spy);
    emitter.clear();
    emitter.emit("play", undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it("emitting an event with no listeners is a no-op", () => {
    const emitter = new EventEmitter();
    expect(() => emitter.emit("ended", undefined)).not.toThrow();
  });
});
