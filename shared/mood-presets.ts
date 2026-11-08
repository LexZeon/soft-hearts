/**
 * Developer test command "测试：开心" and friends (D2, docs/claude/2026-11-03-test-commands.md): put her mood at a named state at
 * once, so what depends on the mood (M1 dancing, expressions, the tone of a reply) can be tried without waiting for the
 * right events. Pure: the table of states, and two state transforms. electron/mood.ts owns the timing.
 *
 * How it works with the real mood model (shared/mood.ts, nothing there changes):
 *  - the five channel values are SET (once) to what the label needs, then decay to the baseline at their own half-lives, as always;
 *  - the label also needs a context (an event's afterglow lasts 30 s), a longing level or a reunion, which the real model
 *    derives from events and from time away. For a while the host shows those through `heldMoodState` (a view-time copy;
 *    the stored state is not touched), until the hold ends or any real event (chat, pat, feeding) happens.
 */
import type { MoodContext, MoodLabel, MoodParameters, MoodState, MoodValues } from './mood';
import { MOOD_CHANNELS } from './mood';

export interface MoodPreset {
  label: MoodLabel;
  /** Level of each channel as the label rule reads it (50 = at baseline); unlisted channels stay at baseline. */
  levels: Partial<MoodValues>;
  /** The event context the label needs ("neutral": none). */
  context: MoodContext;
  /** Longing (0..100): sad needs 60+, longing 30+. */
  longing: number;
  /** A reunion is on (the "relieved" label). */
  reunion: boolean;
  /** What the chat context says she is reacting to (a few words; it reaches the model as "最近原因"). */
  reason: string;
}

/** How long the held context stays (the channel values keep decaying on their own the whole time). */
export const MOOD_TEST_HOLD_MS = 10 * 60_000;
/** The temporary fatigue look ("测试：困了") lasts this long unless cancelled. */
export const FATIGUE_TEST_HOLD_MS = 15 * 60_000;
export type TestFatiguePhase = 'light-drowsy' | 'drowsy' | 'asleep';
/** The F she shows in those phases (inside the fatigue model's own bands: light 0.38–0.58, drowsy 0.58–0.72). */
export const FATIGUE_TEST_F: Readonly<Record<TestFatiguePhase, number>> = { 'light-drowsy': 0.45, drowsy: 0.64, asleep: 0.9 };

const preset = (label: MoodLabel, levels: Partial<MoodValues>, context: MoodContext, reason: string, extra: { longing?: number; reunion?: boolean } = {}): MoodPreset =>
  ({ label, levels, context, reason, longing: extra.longing ?? 0, reunion: extra.reunion ?? false });

/** Chosen against the label rule in getMoodSnapshot (shared/mood.ts): a test checks every row. */
export const MOOD_PRESETS: Readonly<Record<MoodLabel, MoodPreset>> = Object.freeze({
  calm: preset('calm', {}, 'neutral', ''),
  content: preset('content', { E: 70, N: 40, C: 35 }, 'neutral', ''),
  close: preset('close', { O: 70, E: 55, C: 40, N: 45 }, 'neutral', ''),
  happy: preset('happy', { D: 70, E: 60, O: 55, C: 40 }, 'positive', '遇到了开心的事'),
  excited: preset('excited', { D: 85, N: 70, E: 60, O: 55, C: 40 }, 'positive', '遇到了让她兴奋的事'),
  concerned: preset('concerned', { C: 70, N: 60, D: 40, E: 40, O: 55 }, 'concern', '有点放心不下'),
  disappointed: preset('disappointed', { D: 30, O: 45, E: 40, N: 45, C: 45 }, 'disappointment', '有些失落'),
  upset: preset('upset', { C: 70, N: 70, D: 30, O: 40, E: 35 }, 'offense', '有点不满'),
  longing: preset('longing', { O: 60, E: 45, D: 45 }, 'neutral', '', { longing: 45 }),
  sad: preset('sad', { D: 35, O: 45, E: 40 }, 'neutral', '', { longing: 70 }),
  relieved: preset('relieved', { O: 60, E: 55, D: 55 }, 'neutral', '', { reunion: true }),
  // N has the shortest half-life (3 minutes); it starts high so the label lasts a couple of minutes.
  'tense-expectation': preset('tense-expectation', { D: 80, C: 65, N: 80, O: 55, E: 50 }, 'positive', '又紧张又期待'),
});

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** The channel value that reads as `level` for a card with this baseline and evidence (the inverse of getMoodSnapshot's level). */
export function moodValueForLevel(level: number, baseline: number, evidenceLevel: number): number {
  const n = Math.max(-1, Math.min(1, (level - 50) / (50 * (evidenceLevel > 0 ? evidenceLevel : 1))));
  return clamp(n >= 0 ? baseline + n * (100 - baseline) : baseline + n * baseline);
}

export function moodPresetValues(p: MoodPreset, parameters: Pick<MoodParameters, 'baseline' | 'evidence'>): MoodValues {
  const out = {} as MoodValues;
  for (const channel of MOOD_CHANNELS) out[channel] = moodValueForLevel(p.levels[channel] ?? 50, parameters.baseline[channel], parameters.evidence.level);
  return out;
}

/** The stored state with the channel values set (nothing else is rewritten: clocks, history and cooldowns stay). */
export function withMoodPresetValues(state: MoodState, values: MoodValues): MoodState {
  const next = structuredClone(state);
  next.values = { ...values };
  next.trend = [];
  return next;
}

/** Back to the card's baseline (what "测试：恢复心情" does to the channels). */
export function withBaselineMood(state: MoodState, parameters: Pick<MoodParameters, 'baseline'>): MoodState {
  return withMoodPresetValues(state, { ...parameters.baseline });
}

/**
 * The view-time copy that keeps the label's non-channel needs true while the hold lasts: a fresh event context, the longing
 * level, a running reunion. The stored state is never replaced by it.
 */
export function heldMoodState(state: MoodState, p: MoodPreset, now: number, id: string): MoodState {
  return {
    ...state,
    longing: p.longing,
    reason: p.context === 'neutral' ? null : { text: p.reason, at: now, context: p.context, eventId: id },
    reunion: p.reunion ? { id, at: now, longing: 35, crying: false } : null,
  };
}
