/**
 * Unbound v1 step 3 「只认你的声音」 (docs/claude/2026-11-17-unbound-step3.md; scope 定稿 2, user chose C; research Codex T-247): a voiceprint
 * made from the user's own short recordings, kept only on this computer, used to tell "this is you" from "this is clearly someone
 * else" (a person nearby, a voice in a video). The rule is the face check's: when it cannot tell, it counts as you; only a clip
 * that is clearly not you is ignored. Too short, too noisy or two voices mixed is "can't confirm" (said, never guessed).
 *
 * No thresholds from papers (T-247: published EERs are other data, other lengths): the two cut-offs come from the user's own
 * enrollment (how alike their own clips are), minus a generous margin. Pure; tests/voiceprint.test.ts.
 */

/** What one clip was judged to be. */
export type VoiceCheck = 'you' | 'unsure' | 'cannot' | 'not-you';
/** Why a clip could not be judged (for the line the user reads). */
export type VoiceQuality = 'ok' | 'short' | 'noisy';

export type VoiceprintPhase = 'unsupported' | 'needs-runtime' | 'not-installed' | 'downloading' | 'installing' | 'idle' | 'starting' | 'ready';
export type VoiceprintNotice = '' | 'download-failed' | 'verify-failed' | 'failed' | 'removed' | 'deleted' | 'enrolled' | 'no-encryption' | 'needs-runtime'
  | 'enrol-skipped' | 'enrol-failed';

/** What the windows see: switches, counts, phases. Never a vector, a score or a sound. */
export interface VoiceprintView {
  enabled: boolean;
  phase: VoiceprintPhase;
  /** Bytes the model download takes (the runtime is only ever copied from a component already installed). */
  downloadBytes: number;
  progress: number | null;
  notice: VoiceprintNotice;
  /** The system's secure storage works (without it nothing is enrolled). */
  encryption: boolean;
  enrolled: { clips: number; seconds: number; at: number } | null;
  /** While recording the sample: how far along. */
  enrolling: { clips: number; seconds: number; needClips: number; needSeconds: number } | null;
  /** The last clip's state while it is in use (null: not used yet). */
  lastCheck: { check: VoiceCheck; why: VoiceQuality | 'mixed' | null; at: number } | null;
}

export const VOICEPRINT_KNOBS = Object.freeze({
  sampleRate: 16_000,
  enrol: Object.freeze({
    /** Short sentences said while holding T (T-247: 6–10 sentences, 30–60 s of speech is the starting point, not a proven minimum). */
    clips: 6,
    seconds: 24,
    /** A clip with less speech than this does not count (it is said again). */
    clipMinSeconds: 1.5,
  }),
  check: Object.freeze({
    /** Less speech than this: can't confirm. */
    minSeconds: 0.8,
    /** Loud parts over quiet parts below this (about 10 dB): too noisy to judge. */
    minContrast: 3,
    /** More than this share of samples at full scale: clipped, can't confirm. */
    maxClipped: 0.01,
    /** A clip at least this long is also checked in two halves; halves that disagree mean two voices mixed. */
    halvesSeconds: 3,
  }),
  calibration: Object.freeze({
    /** Below her own least-alike clip by more than this: clearly not you (generous on purpose: missing you is worse). */
    rejectMargin: 0.3,
    /** Within this of her own least-alike clip: surely you. Between the two: unsure, counted as you. */
    acceptMargin: 0.1,
  }),
  /** The model process stops after this long unused. */
  idleStopMinutes: 5,
});

/** The two cut-offs, from the user's own enrollment. */
export interface VoiceCalibration { reject: number; accept: number }

const FRAME = 320; // 20 ms

/** How much speech a clip has and whether it can be judged at all (energy only; never what was said). */
export function voiceQuality(samples: Float32Array, rate = VOICEPRINT_KNOBS.sampleRate): { quality: VoiceQuality; voicedSeconds: number } {
  const frames = Math.floor(samples.length / FRAME);
  if (!frames) return { quality: 'short', voicedSeconds: 0 };
  const levels: number[] = [];
  let clipped = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) { const x = samples[i]; sum += x * x; if (Math.abs(x) >= 0.99) clipped++; }
    levels.push(Math.sqrt(sum / FRAME));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.1)] ?? 0, loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.max(0.003, quiet * 3);
  const voicedSeconds = levels.filter(level => level > threshold).length * FRAME / rate;
  const knobs = VOICEPRINT_KNOBS.check;
  // Sound throughout with no quieter moments (a hiss, a crowd), or clipped: too noisy to judge. Too little speech: too short.
  if (loud > 0.003 && (clipped / samples.length > knobs.maxClipped || loud < Math.max(quiet, 1e-6) * knobs.minContrast)) return { quality: 'noisy', voicedSeconds };
  if (voicedSeconds < knobs.minSeconds) return { quality: 'short', voicedSeconds };
  return { quality: 'ok', voicedSeconds };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export function unitMean(vectors: readonly ArrayLike<number>[]): Float32Array {
  const size = vectors[0]?.length ?? 0, out = new Float32Array(size);
  for (const vector of vectors) {
    let norm = 0; for (let i = 0; i < size; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < size; i++) out[i] += vector[i] / norm;
  }
  let norm = 0; for (let i = 0; i < size; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < size; i++) out[i] /= norm;
  return out;
}

/**
 * The voiceprint from the enrollment clips: their mean direction, and the cut-offs from how alike the user's own clips are (each clip
 * against the mean of the others). Throws with fewer than two clips.
 */
export function enrolVoice(vectors: readonly ArrayLike<number>[]): { centroid: Float32Array; calibration: VoiceCalibration } {
  if (vectors.length < 2) throw new Error('not enough clips');
  const own = vectors.map((vector, index) => cosine(vector, unitMean(vectors.filter((_, other) => other !== index))));
  const least = Math.min(...own), knobs = VOICEPRINT_KNOBS.calibration;
  const accept = least - knobs.acceptMargin;
  return { centroid: unitMean(vectors), calibration: { accept, reject: Math.min(least - knobs.rejectMargin, accept - 0.05) } };
}

/**
 * One clip: can't confirm when it is too short or noisy, or when its two halves sound like two people; otherwise you, unsure (counted as
 * you) or clearly not you, by the user's own cut-offs.
 */
export function decideVoice(input: { quality: VoiceQuality; score: number | null; halves?: number | null; calibration: VoiceCalibration }): { check: VoiceCheck; why: VoiceQuality | 'mixed' | null } {
  if (input.quality !== 'ok') return { check: 'cannot', why: input.quality };
  if (input.score === null || !Number.isFinite(input.score)) return { check: 'cannot', why: null };
  if (typeof input.halves === 'number' && input.halves < input.calibration.reject) return { check: 'cannot', why: 'mixed' };
  if (input.score >= input.calibration.accept) return { check: 'you', why: null };
  if (input.score >= input.calibration.reject) return { check: 'unsure', why: null };
  return { check: 'not-you', why: null };
}

/** Only a clip that is clearly someone else is kept from her; everything else counts as the user (the face check's rule). */
export const counted = (check: VoiceCheck | null): boolean => check !== 'not-you';

/** The line the control window shows for the last clip. */
export function voiceCheckLine(last: VoiceprintView['lastCheck']): string {
  if (!last) return '';
  if (last.check === 'you') return '刚才那句：是你。';
  if (last.check === 'unsure') return '刚才那句：拿不准，按是你算。';
  if (last.check === 'not-you') return '刚才那句：明显不是你的声音，她没有听。';
  return last.why === 'short' ? '刚才那句：太短，确认不了是不是你（按是你算）。'
    : last.why === 'noisy' ? '刚才那句：太吵，确认不了是不是你（按是你算）。'
    : last.why === 'mixed' ? '刚才那句：像是几个人的声音混在一起，确认不了是不是你（按是你算）。'
    : '刚才那句：确认不了是不是你（按是你算）。';
}
