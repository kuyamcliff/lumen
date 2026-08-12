import { beforeEach, describe, expect, it } from "vitest";
import { getItem, setItem } from "../src/utils/storage";

describe("storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips JSON-serializable values", () => {
    setItem("foo", { a: 1, b: [1, 2, 3] });
    expect(getItem("foo", null)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("returns the fallback when the key is missing", () => {
    expect(getItem("missing", "fallback")).toBe("fallback");
  });

  it("namespaces keys so it never collides with unrelated app storage", () => {
    setItem("foo", "bar");
    expect(window.localStorage.getItem("foo")).toBeNull();
    expect(window.localStorage.getItem("lumen-player:foo")).toBe('"bar"');
  });
});
