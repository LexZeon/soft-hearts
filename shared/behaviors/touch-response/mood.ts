/**
 * I-136 定稿 5 的写回 ("被拉、被捏会推一下心情：轻轻牵手偏亲近，拉得重、拉得久偏紧张"). A click or a pull nudges her hormones a little;
 * a pinch, a pat and a snack already have their own mood events (shared/foundation/mood.ts rua / food) and get nothing more here.
 *
 *  - a gentle click (head, face, hand, hair, shoulder, arm) or a light, short pull: O +gentleO (closeness);
 *  - a click on the body (torso, leg, foot, elsewhere): half that, and N +half (a little startled);
 *  - every pokeEvery-th click of one merged touch: N +pokeN, C +pokeC (being poked over and over);
 *  - a hard or long pull: N and C up to hardN / hardC by how hard (or how long); breaking free: C +brokeFreeC more.
 *
 * MoodHost.lift multiplies by the card's sensitivity, keeps the stronger recent reason (keepReason), and each channel falls back by its
 * own half-life (O 40 min, N 3 min, C 20 min: shared/foundation/mood.ts DEFAULT_MOOD_PARAMETERS). Every amount is far inside lift's ±20.
 */
import type { MoodValues } from '../../foundation/mood';
import type { TouchPart } from '../../mood/touch';
import type { TouchEpisode } from './interface';
import { TOUCH_RESPONSE_KNOBS, type TouchResponseKnobs } from './knobs';

const GENTLE_PARTS: ReadonlySet<TouchPart> = new Set(['head', 'face', 'hand', 'hair', 'shoulder', 'arm']);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The fixed reasons (never a word of the user's). */
export const TOUCH_MOOD_REASONS = Object.freeze({ click: '被点了一下', poke: '被连着戳', pull: '被拉了拉', hardPull: '被用力拉' });

export interface TouchLift { readonly delta: Partial<MoodValues>; readonly reason: string }

/**
 * What this report adds (null: nothing). `fresh`: it started the episode; `counted`: it added to the count. Called once per report.
 */
export function touchLift(episode: Pick<TouchEpisode, 'kind' | 'part' | 'count' | 'strength' | 'heldMs' | 'ended'>, report: { fresh: boolean; counted: boolean },
  knobs: Pick<TouchResponseKnobs, 'lift'> = TOUCH_RESPONSE_KNOBS): TouchLift | null {
  const k = knobs.lift;
  if (episode.kind === 'click') {
    const delta: Partial<MoodValues> = {};
    if (report.fresh) {
      const gentle = !!episode.part && GENTLE_PARTS.has(episode.part);
      delta.O = round1(gentle ? k.gentleO : k.gentleO / 2);
      if (!gentle) delta.N = round1(k.gentleO / 2);
    }
    const poked = report.counted && k.pokeEvery > 0 && episode.count >= k.pokeEvery && episode.count % k.pokeEvery === 0;
    if (poked) { delta.N = round1((delta.N ?? 0) + k.pokeN); delta.C = round1((delta.C ?? 0) + k.pokeC); }
    return Object.keys(delta).length ? { delta, reason: poked ? TOUCH_MOOD_REASONS.poke : TOUCH_MOOD_REASONS.click } : null;
  }
  if (episode.kind === 'pull') {
    // A pull is weighed when it ends (the "still holding" report waits); a cancelled one leaves nothing.
    if (episode.ended === 'holding' || episode.ended === 'cancelled') return null;
    const strength = Math.min(1, Math.max(0, Number.isFinite(episode.strength) ? episode.strength : 0));
    const long = Math.min(1, Math.max(0, (Number.isFinite(episode.heldMs) ? episode.heldMs : 0) / Math.max(1, 2 * k.longMs)));
    const hard = strength >= k.hardAt || episode.heldMs >= k.longMs;
    if (!hard) return { delta: { O: round1(k.gentleO) }, reason: TOUCH_MOOD_REASONS.pull };
    const how = Math.max(strength, long);
    const delta: Partial<MoodValues> = { N: round1(k.hardN * how), C: round1(k.hardC * how + (episode.ended === 'broke-free' ? k.brokeFreeC : 0)) };
    return { delta, reason: TOUCH_MOOD_REASONS.hardPull };
  }
  return null;
}
