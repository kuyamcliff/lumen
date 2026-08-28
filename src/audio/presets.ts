/**
 * Equalizer band frequencies and presets.
 *
 * The ten centre frequencies and the eighteen preset curves below are the
 * ones VLC ships (`modules/audio_filter/equalizer_presets.h`), so a listener
 * who knows what "Full bass" or "Techno" sounds like in VLC gets the same
 * shape here.
 *
 * One deliberate difference: VLC stores each preset's preamp on the 0–20
 * scale it inherited from Winamp, where 12 means "unity". Applying that
 * literally in a browser would add +12 dB to a flat curve and clip
 * everything. Lumen re-bases those values against flat's 12, so "Flat"
 * means 0 dB of preamp and the presets that need headroom (Rock, Full
 * treble, …) pull the preamp *down* to make room for their boosted bands —
 * the same relative relationship, at a level a browser can actually play.
 */

/** VLC's ten-band centre frequencies, in Hz. */
export const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

export const EQ_BAND_COUNT = EQ_FREQUENCIES.length;

/** Range of every band gain and of the preamp, in dB. Matches VLC's sliders. */
export const EQ_GAIN_LIMIT = 20;

export interface EqualizerPreset {
  /** Stable identifier, e.g. `"fullbasstreble"`. */
  id: string;
  /** English display name; translated through `LumenStrings.eqPresets`. */
  label: string;
  /** Preamp in dB, re-based so flat is 0. */
  preamp: number;
  /** Ten band gains in dB, ordered to match `EQ_FREQUENCIES`. */
  gains: number[];
}

/** VLC's unity point on its 0–20 preamp scale; see the note above. */
const VLC_PREAMP_UNITY = 12;

/** VLC's raw table: [id, label, preamp (0-20 scale), ...ten gains in dB]. */
const RAW: Array<[string, string, number, ...number[]]> = [
  ["flat", "Flat", 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ["classical", "Classical", 12, 0, 0, 0, 0, 0, 0, -7.2, -7.2, -7.2, -9.6],
  ["club", "Club", 6, 0, 0, 8, 5.6, 5.6, 5.6, 3.2, 0, 0, 0],
  ["dance", "Dance", 5, 9.6, 7.2, 2.4, 0, 0, -5.6, -7.2, -7.2, 0, 0],
  ["fullbass", "Full bass", 5, -8, 9.6, 9.6, 5.6, 1.6, -4, -8, -10.4, -11.2, -11.2],
  ["fullbasstreble", "Full bass and treble", 4, 7.2, 5.6, 0, -7.2, -4.8, 1.6, 8, 11.2, 12, 12],
  ["fulltreble", "Full treble", 3, -9.6, -9.6, -9.6, -4, 2.4, 11.2, 16, 16, 16, 16.8],
  ["headphones", "Headphones", 4, 4.8, 11.2, 5.6, -3.2, -2.4, 1.6, 4.8, 9.6, 12.8, 14.4],
  ["largehall", "Large Hall", 5, 10.4, 10.4, 5.6, 5.6, 0, -4.8, -4.8, -4.8, 0, 0],
  ["live", "Live", 7, -4.8, 0, 4, 5.6, 5.6, 5.6, 4, 2.4, 2.4, 2.4],
  ["party", "Party", 6, 7.2, 7.2, 0, 0, 0, 0, 0, 0, 7.2, 7.2],
  ["pop", "Pop", 6, -1.6, 4.8, 7.2, 8, 5.6, 0, -2.4, -2.4, -1.6, -1.6],
  ["reggae", "Reggae", 8, 0, 0, 0, -5.6, 0, 6.4, 6.4, 0, 0, 0],
  ["rock", "Rock", 5, 8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2],
  ["ska", "Ska", 6, -2.4, -4.8, -4, 0, 4, 5.6, 8.8, 9.6, 11.2, 9.6],
  ["soft", "Soft", 5, 4.8, 1.6, 0, -2.4, 0, 4, 8, 9.6, 11.2, 12],
  ["softrock", "Soft rock", 7, 4, 4, 2.4, 0, -4, -5.6, -3.2, 0, 2.4, 8.8],
  ["techno", "Techno", 5, 8, 5.6, 0, -5.6, -4.8, 0, 8, 9.6, 9.6, 8.8],
];

export const EQ_PRESETS: EqualizerPreset[] = RAW.map(([id, label, preamp, ...gains]) => ({
  id,
  label,
  preamp: preamp - VLC_PREAMP_UNITY,
  gains,
}));

export function findPreset(id: string): EqualizerPreset | null {
  return EQ_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Matches a set of gains against the presets, so a curve restored from
 * storage or nudged back to a known shape still shows its preset name
 * instead of "Custom".
 */
export function presetIdForGains(gains: number[], preamp: number): string | null {
  const close = (a: number, b: number) => Math.abs(a - b) < 0.05;
  const match = EQ_PRESETS.find(
    (preset) => close(preset.preamp, preamp) && preset.gains.every((gain, i) => close(gain, gains[i] ?? 0)),
  );
  return match?.id ?? null;
}

/**
 * Per-band filter Q, derived from how far each band sits from its
 * neighbours on a log scale.
 *
 * VLC's frequencies aren't evenly spaced — there are three bands crammed
 * between 12 and 16 kHz — so one fixed Q would leave the low bands too
 * narrow and pile the top three on top of each other. Deriving the width
 * from the geometric midpoints to either side keeps each band responsible
 * for roughly the range it's named after.
 */
export function bandQ(index: number): number {
  const frequencies = EQ_FREQUENCIES;
  const centre = frequencies[index]!;
  const previous = frequencies[index - 1];
  const next = frequencies[index + 1];

  const lower = previous !== undefined ? Math.sqrt(previous * centre) : centre / Math.sqrt(2);
  const upper = next !== undefined ? Math.sqrt(centre * next) : centre * Math.sqrt(2);

  const q = centre / (upper - lower);
  return Math.min(Math.max(q, 0.3), 6);
}
