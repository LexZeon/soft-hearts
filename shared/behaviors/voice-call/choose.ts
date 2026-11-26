/**
 * I-091 step 2: whether she makes a short sound before her reply, and which one, from her personality (the card's mood
 * baseline) and her mood now. Pure; reads only, writes nothing.
 *
 * Mood read/write table (memory: mood is hormones + mood values):
 *   reads  D (pleasure) and O (closeness): more often, brighter / warmer sounds;
 *          E (ease): softer, unhurried sounds;
 *          C (stress): less often (tense → quieter), only the plainest sounds;
 *          A (adenosine, sleepiness 0–1): softer sounds and a little later ("慢半拍");
 *          the card's baseline D and O (personality): a lively or clingy character fills more often.
 *   writes nothing.
 */
import { CALL_FILLER_IDS, type CallFillerId, type CallFillerPick } from '../../voice/voice-call';
import { VOICE_CALL_KNOBS, type VoiceCallKnobs } from './knobs';

export interface CallFillerMood {
  /** Mood values now, 0–100 (shared/foundation/mood.ts D/O/E/N/C). Missing channels count as the baseline. */
  values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null;
  /** The card's baseline (her personality), 0–100. Missing: 50. */
  baseline?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null;
  /** Adenosine 0–1 (shared/mood/fatigue.ts), null when unknown. */
  A?: number | null;
}
export interface CallFillerChoiceInput extends CallFillerMood {
  /** The sound she made last time in this call (never repeated twice in a row). */
  last: CallFillerId | null;
  /** Two uniform draws in [0, 1): whether, and which. */
  random: () => number;
}

type Flavour = 'soft' | 'bright' | 'warm' | 'plain';
const FLAVOUR: Readonly<Record<CallFillerId, Flavour>> = Object.freeze({
  mm: 'soft', wu: 'soft', mmmm: 'warm', eh: 'bright', oh: 'bright', en: 'plain', ahmm: 'plain',
});

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** How far a channel is above (+) or below (−) her baseline, about −1…1. */
function lift(input: CallFillerMood, channel: 'D' | 'O' | 'E' | 'C'): number {
  const base = clamp(finite(input.baseline?.[channel], 50), 1, 99), now = clamp(finite(input.values?.[channel], base), 0, 100);
  return clamp((now - base) / (now >= base ? 100 - base : base), -1, 1);
}

/** The chance of a sound this time (knobs: chanceBase, chanceMin, chanceMax). */
export function callFillerChance(input: CallFillerMood, knobs: VoiceCallKnobs = VOICE_CALL_KNOBS): number {
  const personality = (clamp(finite(input.baseline?.D, 50), 0, 100) + clamp(finite(input.baseline?.O, 50), 0, 100) - 100) / 100; // −1…1
  const chance = knobs.filler.chanceBase + 0.15 * personality + 0.15 * lift(input, 'D') + 0.1 * lift(input, 'O') - 0.35 * Math.max(0, lift(input, 'C'));
  return clamp(chance, knobs.filler.chanceMin, knobs.filler.chanceMax);
}

/** Her pick for this pause, or null (no sound this time). Never the same sound as `last`. */
export function chooseCallFiller(input: CallFillerChoiceInput, knobs: VoiceCallKnobs = VOICE_CALL_KNOBS): CallFillerPick | null {
  const draw = () => { const value = finite(input.random(), 0.5); return clamp(value, 0, 0.999999); };
  if (draw() >= callFillerChance(input, knobs)) return null;
  const sleepy = clamp(finite(input.A, 0), 0, 1) >= 0.6, tense = lift(input, 'C') > 0.3;
  const weight: Record<Flavour, number> = {
    soft: 1 + (sleepy ? 2 : 0) + Math.max(0, lift(input, 'E')),
    bright: tense || sleepy ? 0 : 1 + 1.5 * Math.max(0, lift(input, 'D')),
    warm: tense ? 0.3 : 1 + 1.5 * Math.max(0, lift(input, 'O')),
    plain: 1 + (tense ? 1 : 0),
  };
  const options = CALL_FILLER_IDS.filter(id => id !== input.last).map(id => ({ id, weight: weight[FLAVOUR[id]] })).filter(item => item.weight > 0);
  const total = options.reduce((sum, item) => sum + item.weight, 0);
  if (!options.length || !(total > 0)) return null;
  let at = draw() * total, id = options[options.length - 1].id;
  for (const option of options) { if (at < option.weight) { id = option.id; break; } at -= option.weight; }
  return { id, delayMs: knobs.filler.delayMs + (sleepy ? knobs.filler.sleepyExtraMs : 0) };
}
