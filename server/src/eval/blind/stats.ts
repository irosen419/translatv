// Seeded randomness and the few statistics the blind test reports. Seeded, so a run's candidate
// order, its rating sheet and its intervals are the same every time they are recomputed.

/** A 32 bit seed from a string (FNV-1a). */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast, seeded generator of numbers in [0, 1). Not for anything secret. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy (Fisher Yates). */
export function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Null for no samples, never zero: "nothing measured" and "measured zero" are different facts. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest rank, the convention script/latency_stats.mjs uses: every value printed was observed. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export interface Interval {
  n: number;
  mean: number;
  low: number;
  high: number;
}

/**
 * The mean of paired differences (one per item, arm minus baseline) with a percentile bootstrap
 * 95 percent interval: resample the items with replacement `resamples` times and take the 2.5th
 * and 97.5th percentiles of the resampled means. Pairing by item is what removes the variation
 * between easy and hard lines from the comparison. Null when there are no pairs.
 */
export function pairedBootstrap(differences: readonly number[], resamples: number, random: () => number): Interval | null {
  const n = differences.length;
  const observed = mean(differences);
  if (observed === null) return null;
  const means: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let total = 0;
    for (let k = 0; k < n; k += 1) total += differences[Math.floor(random() * n)]!;
    means.push(total / n);
  }
  return { n, mean: observed, low: percentile(means, 2.5)!, high: percentile(means, 97.5)! };
}
