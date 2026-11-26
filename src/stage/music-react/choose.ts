/**
 * I-077 step 1, "她来挑": whether she reacts to a moment in the song, which intent, which variant and how big.
 *
 * Read from her mood as hormone-inspired channels relative to the card's own baseline (handbook/how-we-work.md "心情相关的事，按激素和
 * 心情数值来想"; the same reading as the speaking accents, speech-face/choose.ts `hormoneTemper`):
 *  - N with D up (lively, keyed up) → more often, bigger, the lively variants;
 *  - A through fatigue (drowsy) → fewer and smaller; asleep → none;
 *  - C up (stress) → fewer and smaller;
 *  - E up (at ease) → the soft, slow variants, a little slower; more "enjoy" at a lift.
 * The card's tendencies (I-037) shift the same way: lively more, restrained less, volatile bigger. Step 2: her music taste (taste.ts) scales
 * the chance and the size by how much she likes this song (neutral taste: exactly 1, step 1's numbers).
 * Never the same variant twice in a row (across intents too). Pure: the random source is passed in.
 */
import { MUSIC_REACT_KNOBS } from './knobs';
import { MUSIC_RECIPES, type MusicIntent, type MusicVariant } from './recipes';
import type { DispositionTemper, HormoneTemper } from '../../voice';

const clamp = (x: number, lo: number, hi: number) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
const pos = (x: number) => Math.max(0, x);
const disp = (value: number) => clamp((value - 50) / 50, -1, 1);

/** How much more (or less) often and how much bigger she reacts right now. */
export function musicGains(t: HormoneTemper, d: DispositionTemper): { often: number; size: number } {
  const h = MUSIC_REACT_KNOBS.hormones, k = MUSIC_REACT_KNOBS.dispositions;
  // N counts as "keyed up" only together with D (N with C is tension: it reads as C here).
  const nd = Math.min(pos(t.N), pos(t.D)) + 0.5 * pos(t.D) * (t.N > -0.2 ? 1 : 0);
  const often = (1 + h.ND.often * nd) * (1 + h.sleepy.often * t.sleepy) * (1 + h.C.often * pos(t.C))
    * (1 + k.lively.often * disp(d.lively)) * (1 + k.restrained.often * disp(d.restrained)) * (1 + k.volatile.often * disp(d.volatile));
  const size = (1 + h.ND.size * nd) * (1 + h.sleepy.size * t.sleepy) * (1 + h.C.size * pos(t.C))
    * (1 + k.lively.size * disp(d.lively)) * (1 + k.restrained.size * disp(d.restrained)) * (1 + k.volatile.size * disp(d.volatile));
  return { often: clamp(often, 0, 2.5), size: clamp(size, 0.4, 1.5) };
}

export interface MusicPick { intent: MusicIntent; variant: MusicVariant; size: number; side: number; slow: number }
export type MusicSkip = 'asleep' | 'chance' | 'budget' | 'gap' | 'no-variant';

/** The intent for a section change: a lift may be taken as enjoying it, a fall in a slow dark song as being moved. */
export function intentFor(kind: 'lift' | 'fall' | 'spontaneous' | 'recognized', color: number, t: HormoneTemper, random: () => number, bpm: number | null = null): MusicIntent | null {
  const c = MUSIC_REACT_KNOBS.choice;
  if (kind === 'recognized') return 'recognize';
  // Moved needs a slow song too (no beat, or a slow one), not only a dark color.
  const dark = color <= c.dark && (bpm === null || bpm <= MUSIC_REACT_KNOBS.color.slowBpm + 10);
  if (kind === 'lift') return random() < clamp(0.2 + 0.3 * pos(color) + 0.3 * pos(t.E) - 0.2 * pos(t.N), 0.05, 0.7) ? 'enjoy' : 'lift';
  if (kind === 'fall') return dark && random() < 0.7 ? 'moved' : 'settle';
  return dark ? 'moved' : color >= 0 ? 'enjoy' : null;
}

/**
 * One pick. `already`: reactions she already had in this song (each lowers the next chance); `last`: the last variant id shown (never
 * the same twice in a row); `still`: she is only listening (no dance or nod), so only the face can react and less often.
 */
export function chooseMusic(intent: MusicIntent, base: number, temper: HormoneTemper, dispositions: DispositionTemper, random: () => number,
  options: { already: number; last: string | null; still: boolean; gentle: boolean; taste?: { often: number; size: number } }): MusicPick | MusicSkip {
  if (temper.sleepy >= 1) return 'asleep';
  const knobs = MUSIC_REACT_KNOBS;
  let pool = MUSIC_RECIPES[intent].filter(v => !options.still || v.face);
  if (pool.length > 1 && options.last) { const rest = pool.filter(v => v.id !== options.last); if (rest.length) pool = rest; }
  if (!pool.length) return 'no-variant';
  const gains = musicGains(temper, dispositions);
  const chance = base * Math.pow(knobs.choice.again, options.already) * gains.often * (options.taste?.often ?? 1) * (options.still ? knobs.choice.still : 1);
  if (!(random() < clamp(chance, 0, 0.95))) return 'chance';
  const nd = Math.min(pos(temper.N), pos(temper.D)) + 0.3 * pos(temper.D), soft = pos(temper.E) * knobs.hormones.E.soft;
  const weights = pool.map(v => (v.weight ?? 1) * (v.lean === 'lively' ? 1 + nd - 0.5 * pos(temper.C) : v.lean === 'soft' ? 1 + soft : v.lean === 'quiet' ? 1 + temper.sleepy + 0.5 * pos(temper.C) : 1));
  let roll = random() * weights.reduce((a, b) => a + b, 0), index = 0;
  while (index < pool.length - 1 && roll >= weights[index]!) { roll -= weights[index]!; index++; }
  const size = gains.size * (options.taste?.size ?? 1) * (0.85 + 0.25 * random()) * (options.gentle ? knobs.choice.gentle : 1);
  return { intent, variant: pool[index]!, size, side: random() < 0.5 ? -1 : 1, slow: 1 + 0.2 * soft };
}
