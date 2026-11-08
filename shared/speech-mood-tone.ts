import type { MoodContext, MoodLabel } from './mood';
import type { FatiguePhase } from './fatigue';

/**
 * R02. Bailian already gets the mood as instruction text; the free
 * system voice only has rate and pitch, so the reply's frozen mood becomes a
 * small, bounded nudge on both.
 *
 * A tone is a direction in [-1, 1] per axis, computed once per reply by the
 * host from the same frozen snapshot as the Bailian instruction (labels plus
 * the fatigue phase; never live values, so nothing wobbles mid-reply). The
 * renderer scales it by the user's 0–100 % setting into multipliers.
 */
export interface SpeechTone { readonly rate: number; readonly pitch: number }

/** At 100 %: rate ×0.90–1.10 on the user's own rate, pitch ×0.92–1.08 on the engine default. */
export const SPEECH_TONE_RANGE = Object.freeze({ rate: 0.10, pitch: 0.08 });
export const DEFAULT_MOOD_VOICE_INFLUENCE = 50;
export const NEUTRAL_SPEECH_TONE: SpeechTone = Object.freeze({ rate: 0, pitch: 0 });

const tone = (rate: number, pitch: number): SpeechTone => Object.freeze({ rate, pitch });
/** By the mood's primary label (shared/mood.ts getMoodSnapshot). */
const LABEL_TONES: Readonly<Record<MoodLabel, SpeechTone>> = Object.freeze({
  excited: tone(1, 1),
  happy: tone(0.6, 0.7),
  relieved: tone(0.2, 0.4),
  close: tone(-0.2, 0.3),
  content: tone(-0.1, 0.2),
  calm: NEUTRAL_SPEECH_TONE,
  /** Stress + arousal without a "support" context reads as nervous: a little faster. */
  concerned: tone(0.4, 0.2),
  'tense-expectation': tone(0.6, 0.3),
  longing: tone(-0.5, -0.4),
  disappointed: tone(-0.6, -0.6),
  sad: tone(-1, -1),
  upset: tone(0.1, -0.5),
});
/** Comforting the user: gentler, a little slower and lower. */
const COMFORT = tone(-0.4, -0.2);
/** Tired voices are slower and lower; added on top of the mood. */
const FATIGUE_TONES: Readonly<Record<FatiguePhase, SpeechTone>> = Object.freeze({
  awake: NEUTRAL_SPEECH_TONE,
  'light-drowsy': tone(-0.3, -0.2),
  drowsy: tone(-0.6, -0.4),
  'falling-asleep': tone(-0.9, -0.6),
  asleep: tone(-1, -0.7),
  'micro-awake': tone(-0.4, -0.3),
});

const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * The reply's tone from its frozen mood. The conversational context takes
 * precedence over a lingering label, like the Bailian emotion choice
 * (electron/speech-emotion.ts selectSpeechEmotion).
 */
export function speechToneFor(mood: { primary: MoodLabel; context: MoodContext; gesture?: string }, fatigue?: FatiguePhase): SpeechTone {
  let base: SpeechTone;
  if (mood.context === 'concern' || mood.context === 'support') base = COMFORT;
  else if (mood.context === 'offense') base = LABEL_TONES.upset;
  else if (mood.context === 'disappointment') base = LABEL_TONES.disappointed;
  else if (mood.context === 'positive' || mood.gesture === 'upbeat') base = mood.primary === 'excited' ? LABEL_TONES.excited : LABEL_TONES.happy;
  else base = LABEL_TONES[mood.primary] ?? NEUTRAL_SPEECH_TONE;
  const tired = fatigue && Object.hasOwn(FATIGUE_TONES, fatigue) ? FATIGUE_TONES[fatigue] : NEUTRAL_SPEECH_TONE;
  return tone(clampUnit(base.rate + tired.rate), clampUnit(base.pitch + tired.pitch));
}

/** A tone from IPC: finite numbers clamped to [-1, 1]; anything else is no tone. */
export function validSpeechTone(value: unknown): SpeechTone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { rate, pitch } = value as Record<string, unknown>;
  if (typeof rate !== 'number' || typeof pitch !== 'number' || !Number.isFinite(rate) || !Number.isFinite(pitch)) return null;
  return tone(clampUnit(rate), clampUnit(pitch));
}

export interface SystemVoiceScale { readonly rate: number; readonly pitch: number }
export const IDENTITY_VOICE_SCALE: SystemVoiceScale = Object.freeze({ rate: 1, pitch: 1 });

/** Multipliers for the system voice; `influence` is the user's 0–100 % setting (0 = off). */
export function systemVoiceScale(value: SpeechTone | null | undefined, influence: number | undefined): SystemVoiceScale {
  const toneValue = validSpeechTone(value);
  const amount = typeof influence === 'number' && Number.isFinite(influence) ? Math.max(0, Math.min(100, influence)) / 100 : DEFAULT_MOOD_VOICE_INFLUENCE / 100;
  if (!toneValue || amount === 0) return IDENTITY_VOICE_SCALE;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return Object.freeze({
    rate: round(1 + toneValue.rate * SPEECH_TONE_RANGE.rate * amount),
    pitch: round(1 + toneValue.pitch * SPEECH_TONE_RANGE.pitch * amount),
  });
}
