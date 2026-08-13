/** A single scrub-preview thumbnail cue, parsed from a WebVTT sprite sheet. */
interface ThumbCue {
  start: number;
  end: number;
  url: string;
  xywh?: [number, number, number, number];
}

const TIME_RE = /(\d+):(\d{2})(?::(\d{2}))?\.(\d{3})/;

function parseTime(raw: string): number {
  const m = TIME_RE.exec(raw);
  if (!m) return 0;
  const [, a, b, c, ms] = m;
  if (c !== undefined) {
    return Number(a) * 3600 + Number(b) * 60 + Number(c) + Number(ms) / 1000;
  }
  return Number(a) * 60 + Number(b) + Number(ms) / 1000;
}

/**
 * Parses a WebVTT thumbnail-sprite file (the format used by Bunny, Mux,
 * Vimeo, etc.: cues pointing at `image.jpg#xywh=x,y,w,h`) so the scrub bar
 * can show a preview frame. Best-effort — a malformed or missing file
 * simply means no preview, never a broken player.
 */
export class ThumbnailTrack {
  private cues: ThumbCue[] = [];
  private ready = false;

  static async load(url: string): Promise<ThumbnailTrack | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();
      const track = new ThumbnailTrack();
      track.parse(text, url);
      return track;
    } catch {
      return null;
    }
  }

  private parse(vtt: string, baseUrl: string): void {
    const lines = vtt.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.includes("-->")) {
        const [startRaw, endRaw] = line.split("-->").map((s) => s.trim());
        const start = parseTime(startRaw ?? "");
        const end = parseTime((endRaw ?? "").split(/\s+/)[0] ?? "");
        i += 1;
        const target = (lines[i] ?? "").trim();
        if (target) {
          const [urlPart, hash] = target.split("#");
          const url = new URL(urlPart || "", baseUrl).toString();
          let xywh: ThumbCue["xywh"];
          const m = /xywh=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(hash ?? "");
          if (m) xywh = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
          this.cues.push({ start, end, url, xywh });
        }
      }
      i += 1;
    }
    this.ready = this.cues.length > 0;
  }

  get isReady(): boolean {
    return this.ready;
  }

  cueAt(time: number): ThumbCue | null {
    if (!this.ready) return null;
    // Cues are typically in ascending order; linear scan is fine for the
    // sizes these sprite tracks come in (a few hundred cues at most).
    for (const cue of this.cues) {
      if (time >= cue.start && time < cue.end) return cue;
    }
    return this.cues[this.cues.length - 1] ?? null;
  }
}
