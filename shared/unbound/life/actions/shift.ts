/**
 * Her own action: shifting her weight (Unbound v1 step 4). Her hips go over one foot, stay there a while (the stand people fall into
 * when they wait), and come back. Smaller when she is tense; not when she is very sleepy (she barely moves then).
 */
import type { LifeActionSpec } from '../action';

export const SHIFT_TIMING = Object.freeze({ inS: 1.6, holdS: [6, 14] as const, outS: 1.8, size: 0.9 });

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

export const SHIFT: LifeActionSpec = {
  id: 'shift', level: 'small', words: '换重心',
  interval: rates => rates.smallMinutes * 60,
  notNow: context => context.drives.sleepy >= 0.85 ? '她很困' : null,
  plan: context => {
    const side = context.random() < 0.5 ? 1 : -1, t = SHIFT_TIMING;
    const hold = lerp(t.holdS[0], t.holdS[1], context.random()), hip = side * t.size;
    return {
      plan: { action: 'shift', level: 'small', amplitude: context.drives.amplitude, easeS: 1.4, waitQuickS: 0, walk: null,
        keys: [{ t: 0, hip: 0 }, { t: t.inS, hip }, { t: t.inS + hold, hip }, { t: t.inS + hold + t.outS, hip: 0 }] },
      answerable: false,
    };
  },
};
