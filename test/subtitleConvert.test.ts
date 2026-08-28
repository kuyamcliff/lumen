import { describe, expect, it } from "vitest";
import {
  assToVtt,
  detectSubtitleFormat,
  formatVttTime,
  microDvdToVtt,
  parseAssTime,
  srtToVtt,
  stripAssTags,
  stripMicroDvdTags,
  subViewerToVtt,
  toWebVtt,
} from "../src/subtitles/convert";

const SRT = `1
00:00:01,000 --> 00:00:04,500
Hello there.

2
00:00:05,250 --> 00:00:08,000
<i>General Kenobi.</i>
Second line.
`;

const ASS = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,{\\pos(400,570)}Hello there.
Dialogue: 0,0:00:05.25,0:00:08.00,Default,,0,0,0,,{\\i1}General{\\i0} Kenobi.\\NSecond line, with a comma.
`;

describe("format detection", () => {
  it("identifies each supported format from its content", () => {
    expect(detectSubtitleFormat("WEBVTT\n\n00:00.000 --> 00:01.000\nhi")).toBe("vtt");
    expect(detectSubtitleFormat(SRT)).toBe("srt");
    expect(detectSubtitleFormat(ASS)).toBe("ass");
    expect(detectSubtitleFormat("{1}{25}Hello|World")).toBe("microdvd");
    expect(detectSubtitleFormat("00:00:01.00,00:00:04.00\nHello")).toBe("subviewer");
  });

  it("falls back to the filename when the content is ambiguous", () => {
    expect(detectSubtitleFormat("", "movie.ass")).toBe("ass");
    expect(detectSubtitleFormat("", "movie.ssa")).toBe("ass");
    expect(detectSubtitleFormat("", "movie.sub")).toBe("microdvd");
    expect(detectSubtitleFormat("", "movie.bin")).toBe("unknown");
  });

  it("sees past a byte-order mark", () => {
    expect(detectSubtitleFormat("﻿WEBVTT\n")).toBe("vtt");
  });
});

describe("SubRip", () => {
  it("converts commas to points and drops the cue counters", () => {
    const vtt = srtToVtt(SRT);

    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.500");
    expect(vtt).toContain("00:00:05.250 --> 00:00:08.000");
    expect(vtt).not.toMatch(/^\s*1\s*$/m);
  });

  it("keeps the tags WebVTT understands and the line breaks", () => {
    const vtt = srtToVtt(SRT);
    expect(vtt).toContain("<i>General Kenobi.</i>\nSecond line.");
  });

  it("pads a short fractional part instead of misreading it", () => {
    const vtt = srtToVtt("00:00:01,5 --> 00:00:02,25\nhi");
    // ",5" is 500 ms and ",25" is 250 ms — not 5 ms and 25 ms.
    expect(vtt).toContain("00:00:01.500 --> 00:00:02.250");
  });

  it("accepts cues written without an hours field", () => {
    const vtt = srtToVtt("00:30,000 --> 00:35,000\nhi");
    expect(vtt).toContain("00:00:30.000 --> 00:00:35.000");
  });

  it("skips malformed blocks rather than aborting the file", () => {
    const vtt = srtToVtt("1\nnot a timestamp\ntext\n\n2\n00:00:02,000 --> 00:00:03,000\nreal cue");
    expect(vtt).toContain("real cue");
    expect(vtt).not.toContain("not a timestamp");
  });

  it("strips positioning overrides and font colours SubRip files pick up", () => {
    const vtt = srtToVtt('00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#fff">Top</font>');
    expect(vtt).toContain("Top");
    expect(vtt).not.toContain("an8");
    expect(vtt).not.toContain("font");
  });
});

describe("ASS/SSA", () => {
  it("reads field positions from the Format line", () => {
    const vtt = assToVtt(ASS);

    expect(vtt).toContain("00:00:01.000 --> 00:00:04.500");
    expect(vtt).toContain("Hello there.");
  });

  it("keeps text containing commas intact", () => {
    expect(assToVtt(ASS)).toContain("Second line, with a comma.");
  });

  it("translates italic overrides and drops positioning ones", () => {
    const vtt = assToVtt(ASS);
    expect(vtt).toContain("<i>General</i> Kenobi.");
    expect(vtt).not.toContain("pos(400,570)");
  });

  it("turns ASS line breaks into real ones", () => {
    expect(assToVtt(ASS)).toContain("Kenobi.\nSecond line");
  });

  it("parses centisecond timestamps", () => {
    expect(parseAssTime("0:00:01.50")).toBeCloseTo(1.5);
    expect(parseAssTime("1:02:03.25")).toBeCloseTo(3723.25);
    expect(parseAssTime("nonsense")).toBeNull();
  });

  it("closes a tag the line left open", () => {
    expect(stripAssTags("{\\i1}unterminated")).toBe("<i>unterminated</i>");
  });

  it("drops vector drawing blocks, which are shapes rather than words", () => {
    expect(stripAssTags("{\\p1}m 0 0 l 100 0 100 100{\\p0}")).toBe("");
  });

  it("ignores Dialogue lines outside the Events section", () => {
    const stray = "[Script Info]\nDialogue: 0,0:00:01.00,0:00:02.00,X,,0,0,0,,nope\n";
    expect(assToVtt(stray)).not.toContain("nope");
  });

  it("skips cues whose end is not after their start", () => {
    const bad = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:05.00,D,,0,0,0,,zero length\n`;
    expect(assToVtt(bad)).not.toContain("zero length");
  });
});

describe("MicroDVD", () => {
  it("uses the frame rate the file declares in its first line", () => {
    const vtt = microDvdToVtt("{1}{1}25.000\n{25}{50}One second in.");
    // Frame 25 at 25 fps is exactly one second.
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("falls back to the caller's frame rate", () => {
    const vtt = microDvdToVtt("{30}{60}Hello", 30);
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("expands pipe-separated lines and strips control codes", () => {
    expect(stripMicroDvdTags("{y:i}First|Second")).toBe("First\nSecond");
  });

  it("does not mistake a real subtitle for the frame-rate line", () => {
    const vtt = microDvdToVtt("{0}{25}Chapter 12", 25);
    expect(vtt).toContain("Chapter 12");
  });
});

describe("SubViewer", () => {
  it("parses its comma-separated timing line and [br] breaks", () => {
    const vtt = subViewerToVtt("00:00:01.00,00:00:04.00\nFirst[br]Second\n\n00:00:05.00,00:00:06.50\nNext");

    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(vtt).toContain("First\nSecond");
    expect(vtt).toContain("00:00:05.000 --> 00:00:06.500");
  });
});

describe("toWebVtt", () => {
  it("passes WebVTT through, normalising only its line endings", () => {
    const vtt = toWebVtt("WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nhi");
    expect(vtt).toBe("WEBVTT\n\n00:00.000 --> 00:01.000\nhi");
  });

  it("treats an unlabelled file as SubRip, which is what it usually is", () => {
    const vtt = toWebVtt("00:00:01,000 --> 00:00:02,000\nguess");
    expect(vtt).toContain("guess");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
  });

  it("routes each format to its own converter", () => {
    expect(toWebVtt(ASS)).toContain("General");
    expect(toWebVtt("{1}{1}25\n{25}{50}x")).toContain("00:00:01.000");
  });
});

describe("time formatting", () => {
  it("writes WebVTT's fixed-width form", () => {
    expect(formatVttTime(0)).toBe("00:00:00.000");
    expect(formatVttTime(3661.5)).toBe("01:01:01.500");
  });

  it("clamps a negative time to zero rather than writing an invalid cue", () => {
    expect(formatVttTime(-5)).toBe("00:00:00.000");
  });
});
