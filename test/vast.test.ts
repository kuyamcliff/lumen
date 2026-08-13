import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkipOffset, parseVast, parseVastTime, selectMediaFile } from "../src/plugins/ads/vast";

const linearVast = `<?xml version="1.0"?>
<VAST version="4.0">
  <Ad id="ad-1">
    <InLine>
      <Impression><![CDATA[https://track/impression]]></Impression>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:05">
            <Duration>00:00:30</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://track/start]]></Tracking>
              <Tracking event="midpoint"><![CDATA[https://track/mid]]></Tracking>
              <Tracking event="complete"><![CDATA[https://track/complete]]></Tracking>
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough><![CDATA[https://advertiser.example]]></ClickThrough>
              <ClickTracking><![CDATA[https://track/click]]></ClickTracking>
            </VideoClicks>
            <MediaFiles>
              <MediaFile type="video/mp4" width="640" height="360" bitrate="500"><![CDATA[https://cdn/low.mp4]]></MediaFile>
              <MediaFile type="video/mp4" width="1920" height="1080" bitrate="4000"><![CDATA[https://cdn/high.mp4]]></MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

const wrapperVast = `<?xml version="1.0"?>
<VAST version="4.0">
  <Ad id="wrap-1">
    <Wrapper>
      <VASTAdTagURI><![CDATA[https://other/vast.xml]]></VASTAdTagURI>
      <Impression><![CDATA[https://track/wrapper-impression]]></Impression>
      <TrackingEvents>
        <Tracking event="start"><![CDATA[https://track/wrapper-start]]></Tracking>
      </TrackingEvents>
    </Wrapper>
  </Ad>
</VAST>`;

describe("parseVastTime", () => {
  it("parses HH:MM:SS with optional milliseconds", () => {
    expect(parseVastTime("00:00:30")).toBe(30);
    expect(parseVastTime("01:02:03")).toBe(3723);
    expect(parseVastTime("00:00:05.500")).toBe(5.5);
  });

  it("returns undefined for malformed or missing input", () => {
    expect(parseVastTime(undefined)).toBeUndefined();
    expect(parseVastTime("")).toBeUndefined();
    expect(parseVastTime("30")).toBeUndefined();
  });
});

describe("parseSkipOffset", () => {
  it("accepts a timestamp", () => {
    expect(parseSkipOffset("00:00:05", 30)).toBe(5);
  });

  it("accepts a percentage of the ad duration", () => {
    expect(parseSkipOffset("25%", 40)).toBe(10);
  });

  it("returns undefined when the ad is unskippable", () => {
    expect(parseSkipOffset(null, 30)).toBeUndefined();
  });
});

describe("parseVast", () => {
  it("extracts duration, media files, tracking and click-through", () => {
    const ad = parseVast(linearVast)!;

    expect(ad.id).toBe("ad-1");
    expect(ad.duration).toBe(30);
    expect(ad.skipOffset).toBe(5);
    expect(ad.mediaFiles).toHaveLength(2);
    expect(ad.impressions).toEqual(["https://track/impression"]);
    expect(ad.clickThrough).toBe("https://advertiser.example");
    expect(ad.clickTracking).toEqual(["https://track/click"]);
    expect(ad.tracking.start).toEqual(["https://track/start"]);
    expect(ad.tracking.complete).toEqual(["https://track/complete"]);
  });

  it("reports a wrapper's redirect target rather than treating it as playable", () => {
    const ad = parseVast(wrapperVast)!;

    expect(ad.wrapperUrl).toBe("https://other/vast.xml");
    expect(ad.mediaFiles).toEqual([]);
    // Wrapper beacons still have to fire alongside the wrapped ad's.
    expect(ad.impressions).toEqual(["https://track/wrapper-impression"]);
    expect(ad.tracking.start).toEqual(["https://track/wrapper-start"]);
  });

  it("returns null for malformed XML rather than throwing", () => {
    // An ad server returning garbage must never break content playback.
    expect(parseVast("<VAST><Ad>")).toBeNull();
    expect(parseVast("not xml at all")).toBeNull();
    expect(parseVast("<VAST version='4.0'></VAST>")).toBeNull();
  });
});

describe("selectMediaFile", () => {
  // jsdom has no media stack, so `canPlayType` returns "" for everything
  // and every candidate would be filtered out. Stubbing it to a realistic
  // browser answer is what puts the selection logic under test rather
  // than jsdom's lack of codecs.
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type: string) =>
      type.startsWith("video/mp4") ? "probably" : "",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const files = [
    { url: "low.mp4", type: "video/mp4", width: 640, height: 360, bitrate: 500 },
    { url: "high.mp4", type: "video/mp4", width: 1920, height: 1080, bitrate: 4000 },
  ];

  it("prefers the highest bitrate that suits the player size", () => {
    // A 640px player shouldn't pull a 1080p creative.
    expect(selectMediaFile(files, 640)?.url).toBe("low.mp4");
    expect(selectMediaFile(files, 1920)?.url).toBe("high.mp4");
  });

  it("returns null when nothing is playable", () => {
    const exotic = [{ url: "a.wmv", type: "video/x-ms-wmv", width: 0, height: 0, bitrate: 0 }];
    expect(selectMediaFile(exotic, 640)).toBeNull();
  });

  it("keeps files that declare no type, letting the browser decide", () => {
    const untyped = [{ url: "a.mp4", type: "", width: 0, height: 0, bitrate: 100 }];
    expect(selectMediaFile(untyped, 640)?.url).toBe("a.mp4");
  });
});
