import { describe, expect, it } from "vitest";
import { bufferedAhead, bufferedEnd, clamp, formatTime } from "../src/utils/time";

describe("formatTime", () => {
  it("formats sub-minute durations", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(59)).toBe("0:59");
  });

  it("formats minutes", () => {
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(600)).toBe("10:00");
  });

  it("formats hours", () => {
    expect(formatTime(3661)).toBe("1:01:01");
    expect(formatTime(7325)).toBe("2:02:05");
  });

  it("handles invalid input", () => {
    expect(formatTime(NaN)).toBe("0:00");
    expect(formatTime(-5)).toBe("0:00");
    expect(formatTime(Infinity)).toBe("0:00");
  });
});

describe("clamp", () => {
  it("clamps within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

function fakeRanges(ranges: Array<[number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i]![0],
    end: (i: number) => ranges[i]![1],
  } as TimeRanges;
}

describe("bufferedAhead", () => {
  it("returns remaining contiguous buffer from currentTime", () => {
    const ranges = fakeRanges([[0, 10]]);
    expect(bufferedAhead(ranges, 4)).toBe(6);
  });

  it("returns 0 when currentTime isn't within any range", () => {
    const ranges = fakeRanges([[20, 30]]);
    expect(bufferedAhead(ranges, 4)).toBe(0);
  });

  it("picks the range containing currentTime among several", () => {
    const ranges = fakeRanges([
      [0, 5],
      [8, 20],
    ]);
    expect(bufferedAhead(ranges, 10)).toBe(10);
  });
});

describe("bufferedEnd", () => {
  it("returns the end of the last range", () => {
    expect(bufferedEnd(fakeRanges([[0, 5], [8, 20]]))).toBe(20);
  });

  it("returns 0 for empty ranges", () => {
    expect(bufferedEnd(fakeRanges([]))).toBe(0);
  });
});
