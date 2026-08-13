import { describe, expect, it } from "vitest";
import { DEFAULT_STRINGS, Translator } from "../src/i18n";

describe("Translator", () => {
  it("returns the English default for an untranslated key", () => {
    expect(new Translator().t("play")).toBe("Play");
  });

  it("applies overrides", () => {
    const translator = new Translator();
    translator.set({ play: "Lecture", pause: "Pause" });
    expect(translator.t("play")).toBe("Lecture");
  });

  it("falls back to English for keys a partial translation omits", () => {
    // A translation covering half the UI should leave the rest readable,
    // not blank.
    const translator = new Translator();
    translator.set({ play: "再生" });
    expect(translator.t("play")).toBe("再生");
    expect(translator.t("fullscreen")).toBe(DEFAULT_STRINGS.fullscreen);
  });

  it("interpolates {value}", () => {
    const translator = new Translator();
    expect(translator.t("qualityAnnouncement", "1080p")).toBe("Quality: 1080p");
    expect(translator.t("speedAnnouncement", "1.5×")).toBe("Speed 1.5×");
  });

  it("interpolates into translated templates too", () => {
    const translator = new Translator();
    translator.set({ qualityAnnouncement: "Qualité : {value}" });
    expect(translator.t("qualityAnnouncement", "720p")).toBe("Qualité : 720p");
  });

  it("leaves the template untouched when no value is supplied", () => {
    expect(new Translator().t("qualityAnnouncement")).toBe("Quality: {value}");
  });

  it("merges successive set() calls rather than replacing", () => {
    const translator = new Translator();
    translator.set({ play: "Lecture" });
    translator.set({ pause: "Pause fr" });
    expect(translator.t("play")).toBe("Lecture");
    expect(translator.t("pause")).toBe("Pause fr");
  });

  it("exposes a complete string table so translators can see every key", () => {
    const keys = Object.keys(new Translator().all);
    expect(keys).toEqual(Object.keys(DEFAULT_STRINGS));
    expect(keys.length).toBeGreaterThan(40);
  });
});
