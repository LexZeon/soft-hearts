/**
 * I-136 定稿 6 ("也可以根据心情数值决定是否发起对话。按角色不按设置"): whether she says something about a touch, decided here from her
 * mood numbers and her character, with no switch and no Claude call. One roll per merged touch (and one more when it keeps going,
 * see the brain); a touch she just spoke about makes the next one less likely. Only when she decides to speak does the brain start a
 * proactive turn (one Claude call through the inner loop).
 *
 * chance = base[kind] + mood (hormones against the baseline, B boredom, M longing) + character lean + repeats + pull strength
 *          − sleepy − recently spoke about a touch, clamped to [0, max]. Asleep: never.
 */
import { MOOD_CHANNELS, moodLevel, type MoodChannel } from '../../foundation/mood';
import type { DispositionId } from '../reactions/dispositions';
import type { TouchSpeechDecision, TouchSpeechInput } from './interface';
import { TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from './knobs';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The chance and each term (pure). */
export function touchSpeechChance(input: TouchSpeechInput, knobs: Pick<TouchResponseKnobs, 'speak'> = TOUCH_RESPONSE_KNOBS): TouchSpeechDecision['parts'] & { chance: number } {
  const k = knobs.speak;
  const base = finite(k.base[input.kind as keyof typeof k.base]) ? k.base[input.kind as keyof typeof k.base] : 0;
  let mood = 0;
  for (const channel of MOOD_CHANNELS) {
    const perPoint = k.mood[channel as MoodChannel], value = input.values?.[channel], baseline = input.baseline?.[channel] ?? 50;
    if (!finite(perPoint) || !finite(value)) continue;
    const level = finite(baseline) && baseline > 0 && baseline < 100 ? moodLevel(value, baseline, finite(input.evidence) ? input.evidence : 1) : value;
    mood += perPoint * (level - 50);
  }
  if (finite(k.mood.B) && finite(input.boredom)) mood += k.mood.B * Math.min(100, Math.max(0, input.boredom));
  if (finite(k.mood.M) && finite(input.longing)) mood += k.mood.M * Math.min(100, Math.max(0, input.longing));
  let lean = 0;
  for (const [id, perPoint] of Object.entries(k.lean) as [DispositionId, number][]) {
    const value = input.dispositions?.[id];
    if (finite(perPoint) && finite(value)) lean += perPoint * (value - 50);
  }
  const repeat = Math.min(Math.max(0, k.extraMax), Math.max(0, (finite(input.count) ? input.count : 1) - 1) * Math.max(0, k.perExtra));
  const strength = input.kind === 'pull' && finite(input.strength) ? k.strength * Math.min(1, Math.max(0, input.strength)) : 0;
  const sleepy = input.sleepy ? -Math.abs(k.sleepy) : 0;
  const recent = finite(input.sinceSpokeMs) && input.sinceSpokeMs >= 0 && k.recent.halfLifeMs > 0
    ? -k.recent.penalty * Math.pow(0.5, input.sinceSpokeMs / k.recent.halfLifeMs) : 0;
  const raw = base > 0 ? base + mood + lean + repeat + strength + sleepy + recent : 0;
  const chance = input.asleep ? 0 : Math.min(Math.max(0, k.max), Math.max(0, raw));
  return { base, mood: round3(mood), lean: round3(lean), repeat: round3(repeat), strength: round3(strength), sleepy, recent: round3(recent), chance: round3(chance) };
}

/** Rolls once against the chance: `random` is 0–1 (tests pass a fixed one). */
export function decideTouchSpeech(input: TouchSpeechInput, random: () => number = Math.random, knobs: Pick<TouchResponseKnobs, 'speak'> = TOUCH_RESPONSE_KNOBS): TouchSpeechDecision {
  const { chance, ...parts } = touchSpeechChance(input, knobs);
  let r = 1;
  try { r = random(); } catch { r = 1; }
  return { speak: chance > 0 && finite(r) && r < chance, chance, parts };
}
