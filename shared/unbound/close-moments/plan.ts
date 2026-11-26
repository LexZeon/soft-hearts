/**
 * I-184: one close moment as the page plays it (a kiss, a hug, or shying back a step), planned on the host from her mood and character,
 * and its key frames. Pure. The page's performance (src/unbound/director/close-moment.ts) walks her to the front, then plays these curves
 * as goals for her body (every one through her springs: she never jumps), and walks her back.
 *
 *   lean   I-203, the kiss storyboard (docs/claude/2026-11-23-i203-kiss-hug-plan.md): from where she stands at the normal distance, one step
 *          in while she leans toward you (about half way by 0.9 s), arrived by about `approachS` (1.7 s): a kiss tilts her head and closes
 *          her eyes; a hug turns her face outward (to the screen's right, `yawRad`), closes her eyes, smiles a little, her arms open
 *   hold   as long as she decides (at least ARRIVAL_KNOBS.closeHoldMinS, 1.5 s; at most holdCapS)
 *   back   everything eases back while she steps back to where she began (`backS`, about 1.2 s), the after-beat (after-beat.ts, by her
 *          character) comes in and stays a moment
 *   settle she walks back to where she stood; the after-beat fades on the way
 * Her own choices lie on top (extras.ts): `extras` (pucker, tuck, blush) and the after-beat.
 * A cancel (a large pull, a full-screen program) goes straight to `back` from wherever every channel is ("禁止只是不开始新的动作，不是定住").
 */
import type { MoodReading } from '../director';
import { AFTER_BEATS, type AfterBeat } from './after-beat';
import { closeReading, NEUTRAL_TEMPERAMENT, type CloseAct, type CloseTemperament, type CloseVia } from './chooser';
import { chooseCloseExtras, parseCloseExtras, type CloseExtra } from './extras';
import type { CloseMomentKnobs } from './knobs';
import type { MoodLabel } from '../../foundation/mood';
import { ARRIVAL_KNOBS, arrivalHoldS, type ArrivalKnobs } from '../arrival'; // I-192: her own hold, the face's yaw

export interface CloseMomentPlan {
  action: 'close-moment';
  kind: CloseAct;
  after: AfterBeat;
  via: CloseVia;
  /** She notices the lens before she sets off (s). */
  noticeS: number;
  walkSpeedMps: number;
  /** The lean in (s). */
  approachS: number;
  holdS: number;
  /** Easing back to rest (s). */
  backS: number;
  /** How long the after-beat stays before she walks back (s). */
  afterS: number;
  /** Upper-body lean toward you at the closest (rad; shy: a small lean back, negative). */
  leanRad: number;
  /** Head tilt (rad, + = toward her left shoulder). */
  tiltRad: number;
  /** How much the after-beat shows (0..1; the card's expression intensity). */
  show: number;
  /** I-192: her head turned to one side at the closest (rad, + = toward her left; a hug's cheek toward you, a kiss a little; shy 0). */
  yawRad: number;
  seed: number;
  /** I-203: her own choices on top of the line (closed words: extras.ts); none fixed in the timeline. */
  extras: CloseExtra[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Plans one from her mood and character; `random` in [0, 1). */
export function planCloseMoment(input: { kind: CloseAct; after: AfterBeat; via: CloseVia; mood: MoodReading; label: MoodLabel | null;
  temperament?: CloseTemperament; knobs?: CloseMomentKnobs; arrival?: ArrivalKnobs;
  /** I-203: her own choices when her words name them (closed words); absent: drawn from her mood (chooseCloseExtras). */
  extras?: readonly CloseExtra[] }, random: () => number): CloseMomentPlan {
  const t = input.temperament ?? NEUTRAL_TEMPERAMENT, a = input.arrival ?? ARRIVAL_KNOBS;
  const r = closeReading(input.mood, input.label, t), rnd = () => clamp01(random());
  const side = rnd() < 0.5 ? 1 : -1, show = clamp01(0.35 + 0.65 * t.intensity.expression / 100);
  const base = { action: 'close-moment' as const, kind: input.kind, after: input.after, via: input.via, show, seed: rnd() };
  if (input.kind === 'shy') return { ...base, noticeS: 0.35, walkSpeedMps: 0.55, approachS: 0.7, holdS: clamp(0.5 + 0.4 * r.tension, 0.4, 1), backS: 0.9,
    afterS: clamp(1 + 0.8 * (1 - r.boldness), 0.8, 2.2), leanRad: -clamp(0.05 + 0.04 * r.tension, 0.03, 0.1), tiltRad: side * 0.06, yawRad: 0, extras: [] };
  const kiss = input.kind === 'kiss';
  const plan = {
    ...base,
    noticeS: clamp(0.7 - 0.3 * r.boldness + 0.2 * r.tension, 0.3, 1.2),
    walkSpeedMps: clamp(0.55 + 0.2 * r.boldness - 0.1 * r.sleepy, 0.5, 0.8),
    // I-203: the storyboard's rhythm for both (the user: the hug approaches "in the kiss's rhythm"): about 1.7 s from the normal distance
    // to arrived, a little quicker when bold, slower when tense.
    approachS: clamp(1.7 - 0.2 * r.boldness + 0.3 * r.tension, 1.4, 2.2),
    holdS: arrivalHoldS(kiss ? 'kiss' : 'hug', r, rnd(), a), // I-192: her own length, from her mood, character
    // I-203: back to where she began by about 1.2 s after the hold (the storyboard's 05).
    backS: clamp(1.2 + 0.15 * (1 - r.boldness) - 0.1 * r.warmth, 1.0, 1.45),
    afterS: clamp(1.4 + 0.8 * r.warmth, 1, 2.5),
    leanRad: clamp((kiss ? 0.22 : 0.16) + 0.08 * r.boldness - 0.06 * r.tension, 0.1, 0.32),
    // I-203: a kiss tilts her head to her own side; a hug lays her head toward her left (onto your shoulder: her head on the screen's right).
    tiltRad: (kiss ? side : 1) * clamp((kiss ? 0.12 : 0.15) + 0.04 * r.boldness, 0.06, 0.2),
    // I-203: a hug turns her face OUTWARD (toward her left: the screen's right, the user's picture), a kiss a small turn to her own side.
    yawRad: (kiss ? side : 1) * (kiss ? a.kissYawDeg : a.hugYawDeg) * Math.PI / 180,
  };
  const extras = input.extras ? parseCloseExtras([...input.extras], input.kind) ?? [] : chooseCloseExtras(input.kind, r, rnd);
  return { ...plan, extras };
}

/** Plain bounds on a plan that crossed IPC (the page trusts nothing it did not compute). */
export function parseCloseMomentPlan(value: unknown): CloseMomentPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const n = (key: string, lo: number, hi: number) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= lo && (v[key] as number) <= hi;
  if (v.action !== 'close-moment' || !['kiss', 'hug', 'shy'].includes(v.kind as string) || !(AFTER_BEATS as readonly unknown[]).includes(v.after)
    || !['own', 'pulled', 'chat'].includes(v.via as string)) return null;
  if (!(n('noticeS', 0.1, 2) && n('walkSpeedMps', 0.3, 1) && n('approachS', 0.3, 3) && n('holdS', 0.2, 30) && n('backS', 0.3, 3) && n('afterS', 0, 4)
    && n('leanRad', -0.2, 0.4) && n('tiltRad', -0.3, 0.3) && n('yawRad', -1.5, 1.5) && n('show', 0, 1) && n('seed', 0, 1))) return null;
  // I-203: her extras are closed words only (absent from an older host: none).
  const extras = v.extras === undefined ? [] : parseCloseExtras(v.extras, v.kind as CloseAct);
  if (!extras) return null;
  const keys = ['action', 'kind', 'after', 'via', 'noticeS', 'walkSpeedMps', 'approachS', 'holdS', 'backS', 'afterS', 'leanRad', 'tiltRad', 'yawRad', 'show', 'seed'];
  return { ...Object.fromEntries(keys.map(key => [key, v[key]])), extras } as unknown as CloseMomentPlan;
}
