// Small statistics helpers for the fidelity suite (medians, p90, a two-sided Mann–Whitney test).

export const numbers = (values: ReadonlyArray<number | null | undefined>): number[] =>
  values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Abramowitz–Stegun 7.1.26 approximation of the error function. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1, t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
  return sign * (1 - poly * t * Math.exp(-x * x));
}

/**
 * Two-sided Mann–Whitney U test, normal approximation with tie correction. Good enough for
 * "are these two timing samples clearly apart" with n ≥ 8 per side; not for tiny samples.
 */
export function mannWhitneyP(a: readonly number[], b: readonly number[]): number | null {
  const n1 = a.length, n2 = b.length;
  if (n1 < 3 || n2 < 3) return null;
  const all = [...a.map(value => ({ value, from: 0 })), ...b.map(value => ({ value, from: 1 }))].sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].value === all[i].value) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const ties = j - i + 1;
    tieTerm += ties ** 3 - ties;
    i = j + 1;
  }
  const rankSum1 = all.reduce((sum, item, index) => sum + (item.from === 0 ? ranks[index] : 0), 0);
  const u1 = rankSum1 - n1 * (n1 + 1) / 2;
  const mu = n1 * n2 / 2;
  const n = n1 + n2;
  const variance = n1 * n2 / 12 * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return 1;
  const z = (Math.abs(u1 - mu) - 0.5) / Math.sqrt(variance);
  return Math.max(0, Math.min(1, 1 - erf(Math.max(0, z) / Math.SQRT2)));
}
