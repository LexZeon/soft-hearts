/**
 * Her own action: a pause in her idle (Unbound v1 step 4; Codex T-248 B1, no retraining). The idle's own clock slows to zero on a
 * quintic curve, holds, and speeds up again: the idle's phase is paused, not its size, so she does not drift back to her stand pose
 * and does not snap on when it resumes. If a quick move of her idle is under way she waits up to a second for it to end; still
 * going: this pause is skipped (never stopped mid-move, never made up later). People pause 2.6–10.7 times a minute (T-248's two
 * references), StayStill's idle only 0.5: the pace comes from her mood (mood-read.ts pausesPerMinute).
 */
import type { LifeActionSpec } from '../action';
import { LIFE_BODY } from '../types';

/**
 * Hold of the idle's clock (s): short when lively, longer when still. People's head stops had a median near 0.48 s (T-248), but her
 * springs and breath keep the head moving a little after the idle stands still (measured: about 0.3 s to fall under 1°/s), so the
 * source is held a little longer to give a visible stop of that size. A first pick for the developer to judge; not a human constant.
 */
export const PAUSE_TIMING = Object.freeze({ holdS: [0.6, 1.8] as const, waitQuickS: 1 });

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

export const PAUSE: LifeActionSpec = {
  id: 'pause', level: 'idle', words: '待机里停一下',
  interval: rates => 60 / Math.max(0.1, rates.pausesPerMinute),
  notNow: () => null,
  plan: context => {
    const ramp = LIFE_BODY.rateRampS, still = Math.min(1, Math.max(0, 1 - context.drives.energy + 0.5 * context.drives.sleepy));
    const hold = lerp(PAUSE_TIMING.holdS[0], PAUSE_TIMING.holdS[1], 0.6 * context.random() + 0.4 * still);
    return {
      plan: { action: 'pause', level: 'idle', amplitude: 1, easeS: ramp, waitQuickS: PAUSE_TIMING.waitQuickS, walk: null,
        keys: [{ t: 0, rate: 1 }, { t: ramp, rate: 0 }, { t: ramp + hold, rate: 0 }, { t: 2 * ramp + hold, rate: 1 }] },
      answerable: false,
    };
  },
};
