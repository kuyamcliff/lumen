import { describe, expect, it } from "vitest";
import { containerLabel, isPlayableContainer, sniffContainer } from "../src/core/containers";

function bytes(...values: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") out.push(value);
    else for (const char of value) out.push(char.charCodeAt(0));
  }
  return new Uint8Array(out);
}

function pad(head: Uint8Array, length = 512): Uint8Array {
  const out = new Uint8Array(length);
  out.set(head.subarray(0, Math.min(head.length, length)));
  return out;
}

describe("sniffContainer", () => {
  it("detects the ISO-BMFF family regardless of brand", () => {
    for (const brand of ["isom", "mp42", "qt  ", "3gp5", "M4V "]) {
      const head = pad(bytes(0x00, 0x00, 0x00, 0x18, "ftyp", brand));
      expect(sniffContainer(head), brand).toBe("iso-bmff");
    }
  });

  it("separates Matroska from WebM by DocType", () => {
    const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00];
    expect(sniffContainer(pad(bytes(...ebml, 0x42, 0x82, 0x88, "matroska")))).toBe("matroska");
    expect(sniffContainer(pad(bytes(...ebml, 0x42, 0x82, 0x84, "webm")))).toBe("webm");
  });

  it("treats EBML without a recognizable DocType as Matroska, the safer route", () => {
    // WebM is a strict subset, so guessing "matroska" costs a remux at
    // worst; guessing "webm" would hand the browser a file it can't play.
    expect(sniffContainer(pad(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04)))).toBe("matroska");
  });

  it("detects Ogg", () => {
    expect(sniffContainer(pad(bytes("OggS", 0x00, 0x02, 0x00, 0x00)))).toBe("ogg");
  });

  it("detects MPEG-TS from its repeating sync byte", () => {
    const head = new Uint8Array(512);
    head[0] = 0x47;
    head[188] = 0x47;
    head[376] = 0x47;
    expect(sniffContainer(head)).toBe("mpeg-ts");
  });

  it("does not mistake an unrelated file starting with 0x47 for MPEG-TS", () => {
    const head = new Uint8Array(512);
    head[0] = 0x47; // no sync bytes at the 188-byte packet boundaries
    expect(sniffContainer(head)).toBe("unknown");
  });

  it("detects AVI, ASF and FLV", () => {
    expect(sniffContainer(pad(bytes("RIFF", 0, 0, 0, 0, "AVI ")))).toBe("avi");
    expect(sniffContainer(pad(bytes(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0, 0, 0, 0)))).toBe("asf");
    expect(sniffContainer(pad(bytes("FLV", 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0)))).toBe("flv");
  });

  it("detects an MPEG program stream", () => {
    expect(sniffContainer(pad(bytes(0x00, 0x00, 0x01, 0xba, 0x44, 0, 0, 0, 0, 0, 0, 0)))).toBe("mpeg-ps");
  });

  it("ignores the file extension entirely — only bytes decide", () => {
    // An MKV renamed to .mp4 is a routine real-world case; the sniffer must
    // still report Matroska so it gets remuxed rather than handed to the
    // browser's MP4 demuxer, which would reject it.
    const mkvBytes = pad(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x42, 0x82, 0x88, "matroska"));
    expect(sniffContainer(mkvBytes)).toBe("matroska");
  });

  it("reports unknown for short or unrecognized input rather than throwing", () => {
    expect(sniffContainer(new Uint8Array(0))).toBe("unknown");
    expect(sniffContainer(new Uint8Array([1, 2, 3]))).toBe("unknown");
    expect(sniffContainer(pad(bytes("hello world!")))).toBe("unknown");
  });
});

describe("isPlayableContainer", () => {
  it("accepts everything Lumen can play natively or by remuxing", () => {
    for (const kind of ["iso-bmff", "matroska", "webm", "ogg", "mpeg-ts"] as const) {
      expect(isPlayableContainer(kind), kind).toBe(true);
    }
  });

  it("rejects containers that need transcoding", () => {
    for (const kind of ["avi", "asf", "flv", "mpeg-ps"] as const) {
      expect(isPlayableContainer(kind), kind).toBe(false);
    }
  });
});

describe("containerLabel", () => {
  it("gives every container a name fit to show a viewer", () => {
    expect(containerLabel("matroska")).toBe("Matroska (MKV)");
    expect(containerLabel("avi")).toBe("AVI");
    expect(containerLabel("unknown")).toBe("this file");
  });
});
