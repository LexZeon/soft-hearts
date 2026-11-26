/**
 * Her own action: a glance at you (Unbound v1 step 4). Her eyes come to you first and her head follows (the eye-head coordinator),
 * a small tilt and a little smile, held a moment, then back to where she was looking. On her own only when you are not busy (paused,
 * or the camera sees you there), never over a video, a game, you talking to someone or sound playing. As a reaction (afternoon
 * addition A): to a wave (a sure one: held longer, warmer), a stretch, your coming back, or a "maybe" that you look at her.
 */
import type { LifeActionSpec } from '../action';

export const GLANCE_TIMING = Object.freeze({ inS: 0.35, holdS: [1.2, 2.2] as const, outS: 0.7, tilt: 0.06 });

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

export const GLANCE: LifeActionSpec = {
  id: 'glance', level: 'small', words: '回头看你一眼',
  interval: rates => rates.smallMinutes * 60 * 1.3,
  notNow: context => {
    const s = context.situation.signals;
    if (s.someoneInFront === false) return '前面没人';
    if (context.cue) return null; // a reaction to you
    if (s.foreground === 'video' || s.foreground === 'game') return s.foreground === 'video' ? '你在看视频' : '你在玩游戏';
    if (s.talkingToOthers) return '你在和别人说话';
    if (s.soundPlaying) return '电脑在放声音';
    if (s.doing === 'busy' && s.someoneInFront !== true) return '你在忙';
    if (context.drives.sleepy >= 0.8) return '她很困';
    return null;
  },
  plan: context => {
    const waved = context.cue?.kind === 'wave' && context.cue.band === 'sure';
    const t = GLANCE_TIMING, hold = lerp(t.holdS[0], t.holdS[1], context.random()) * (1 - 0.3 * context.drives.tense) * (waved ? 1.5 : 1);
    const tilt = (context.random() < 0.5 ? 1 : -1) * t.tilt * context.drives.amplitude;
    const smile = Math.min(0.6, 0.25 + 0.25 * context.drives.warm + (waved ? 0.15 : 0));
    const on = t.inS, off = on + hold;
    return {
      plan: { action: 'glance', level: 'small', amplitude: context.drives.amplitude, easeS: 0.6, waitQuickS: 0, walk: null,
        keys: [{ t: 0, look: 0, tilt: 0, smile: 0 }, { t: on, look: 1, tilt, smile: smile * 0.6 }, { t: off, look: 1, tilt, smile }, { t: off + t.outS, look: 0, tilt: 0, smile: 0 }] },
      answerable: false,
    };
  },
};
