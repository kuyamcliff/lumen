import { beforeEach, describe, expect, it } from "vitest";
import { ASPECT_RATIOS, VideoFilters, ZOOM_STEPS } from "../src/video/VideoFilters";

function setup() {
  const host = document.createElement("div");
  const root = document.createElement("div");
  const video = document.createElement("video");
  root.appendChild(video);
  host.appendChild(root);
  document.body.appendChild(host);
  return { host, root, video };
}

describe("VideoFilters", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  it("starts as an identity transform, painting nothing", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    expect(filters.isIdentity).toBe(true);
    expect(filters.cssFilter()).toBe("none");
    expect(filters.cssTransform()).toBe("none");
  });

  it("emits only the adjustments that have actually moved", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ brightness: 1.2, saturation: 0.5 });

    expect(filters.cssFilter()).toBe("brightness(1.2) saturate(0.5)");
    expect(filters.cssFilter()).not.toContain("contrast");
  });

  it("references the SVG filter only when gamma is off its default", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    expect(filters.cssFilter()).not.toContain("url(#");
    filters.set({ gamma: 2 });
    expect(filters.cssFilter()).toContain("url(#lumen-gamma)");
  });

  it("builds the gamma filter with the reciprocal exponent", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ gamma: 2 });
    const func = root.querySelector("feFuncR");

    expect(func).not.toBeNull();
    // feFuncR computes C^exponent, so gamma 2 is exponent 0.5.
    expect(func!.getAttribute("exponent")).toBe("0.5");

    filters.set({ gamma: 0.5 });
    expect(root.querySelector("feFuncR")!.getAttribute("exponent")).toBe("2");
    // The filter is created once and updated, not duplicated.
    expect(root.querySelectorAll("filter").length).toBe(1);
  });

  it("combines zoom and flips into one scale", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ zoom: 2, flipHorizontal: true });
    expect(filters.cssTransform()).toBe("scale(-2, 2)");

    filters.set({ flipVertical: true });
    expect(filters.cssTransform()).toBe("scale(-2, -2)");
  });

  it("rotates in quarter turns and wraps at a full circle", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    expect(filters.rotate()).toBe(90);
    expect(filters.cssTransform()).toContain("rotate(90deg)");
    expect(filters.rotate()).toBe(180);
    expect(filters.rotate()).toBe(270);
    expect(filters.rotate()).toBe(0);
  });

  it("cycles aspect ratios in VLC's order, starting from the source", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    expect(filters.cycleAspectRatio()).toBe("16/9");
    expect(filters.cycleAspectRatio()).toBe("4/3");
    // …and eventually back to the file's own ratio.
    for (let i = 2; i < ASPECT_RATIOS.length; i++) filters.cycleAspectRatio();
    expect(filters.filters.aspectRatio).toBeNull();
  });

  it("writes a forced aspect ratio onto the host, not the picture", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ aspectRatio: "4/3" });
    expect(host.style.getPropertyValue("--lumen-aspect-ratio")).toBe("4 / 3");

    filters.set({ aspectRatio: null });
    expect(host.style.getPropertyValue("--lumen-aspect-ratio")).toBe("");
  });

  it("cycles through the zoom steps and wraps back to the smallest", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    // Starts at 1, so the next step up is 2.
    expect(filters.cycleZoom()).toBe(2);
    expect(filters.cycleZoom()).toBe(4);
    expect(filters.cycleZoom()).toBe(ZOOM_STEPS[0]);
  });

  it("maps fit modes onto object-fit", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    expect(filters.cycleFit()).toBe("fill");
    expect(video.style.objectFit).toBe("cover");
    expect(filters.cycleFit()).toBe("stretch");
    expect(video.style.objectFit).toBe("fill");
    expect(filters.cycleFit()).toBe("fit");
    expect(video.style.objectFit).toBe("");
  });

  it("clamps adjustments to their documented ranges", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ brightness: 9, saturation: -3, hue: 900, gamma: 0, zoom: 100 });
    const state = filters.filters;

    expect(state.brightness).toBe(2);
    expect(state.saturation).toBe(0);
    expect(state.hue).toBe(180);
    expect(state.gamma).toBe(0.1);
    expect(state.zoom).toBe(8);
  });

  it("persists geometry across players, the way VLC remembers its filters", () => {
    const first = setup();
    new VideoFilters(first.video, first.host, first.root).set({ zoom: 2, rotation: 90 });

    const second = setup();
    const restored = new VideoFilters(second.video, second.host, second.root);

    expect(restored.filters.zoom).toBe(2);
    expect(restored.filters.rotation).toBe(90);
  });

  it("resets adjustments without disturbing geometry", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ brightness: 1.4, zoom: 2 });
    filters.resetAdjustments();

    expect(filters.filters.brightness).toBe(1);
    expect(filters.filters.zoom).toBe(2);
  });

  it("clears its styles on destroy", () => {
    const { host, root, video } = setup();
    const filters = new VideoFilters(video, host, root);

    filters.set({ brightness: 1.5, gamma: 2, zoom: 2 });
    filters.destroy();

    expect(video.style.filter).toBe("");
    expect(video.style.transform).toBe("");
    expect(root.querySelector("filter")).toBeNull();
  });
});
