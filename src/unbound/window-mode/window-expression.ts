/**
 * I-154 batch 2: "show expression X now, eased" on the window engine (docs/claude/2026-11-20-unbound-window-batch2.md). The one small
 * entry the coming 「边说边演」 (shared/behaviors/speech-beats/, docs/claude/2026-11-19-per-reply-choreo-plan.md) drives on this
 * engine: its expression words map to the showcase's names (SPEECH_BEAT_SHOWCASE: smile-warm → warm-smile, ...), and each plays the
 * showcase's own envelope (performer.ts EXPRESSION_TIMING: a quick confirm smile up in ~0.3 s, a warm smile in ~1.2 s that settles to
 * its afterglow) and the showcase's face (showcase-motion.ts faceSlots / faceNamed), so an expression looks the same in the window as
 * in the showcase. Nothing here is wired to speech beats yet.
 *
 * Rules: an expression only adds to her face (max with what else shows) and every value it hands over is a goal the figure's slot
 * springs walk to, so it eases in and out at any frame rate. A start is refused while she is asleep, hidden, or a picked expression
 * motion owns her face ("禁止" is only "not starting": one already playing finishes its own envelope). While she speaks or is about to,
 * an expression's open mouth and closed-mouth shapes step aside (eased) and lip-sync opens on top; its mouth shape (a pout, a smile) stays
 * as the base the flap opens on (I-175, shared/behaviors/part-mix/mouth.ts; before, every mouth shape stepped aside, so a pout while she
 * read aloud never showed: reported on the dev build). The rest of the expression stays.
 * Pure: no DOM, no three.js.
 */
import { SHOWCASE_EXPRESSIONS, type ShowcaseExpression } from '../../../shared/unbound/showcase';
import type { MorphSlot } from '../../../shared/actions';
import { faceNamed, faceSlots } from '../motion/showcase-motion';
import type { ShowcaseFace } from '../motion/generator';
import { EXPRESSION_TIMING, WARM } from '../showcase/performer';
import { mouthRoleOfName, mouthRoleOfSlot } from '../../../shared/behaviors/part-mix/mouth';
import type { MouthRole } from '../../../shared/behaviors/part-mix/interface';

export interface ShowExpressionOptions {
  /** 0..1 (default 0.8): how strong, as in the showcase (0.55 + 0.45 × intensity of the full face). */
  intensity?: number;
  /** quick or slow rise (default: the showcase's for that expression). */
  onset?: 'quick' | 'slow';
  /** Seconds it holds before it eases away (default 1.6; at most 8). */
  holdS?: number;
}
export type ShowExpressionResult = { ok: true; id: number } | { ok: false; reason: 'unknown' | 'asleep' | 'hidden' | 'face-owned' };

/** What the face says about starting one now. */
export interface ShowGates { shown: boolean; asleep: boolean; faceOwned: boolean }

/** How many can play at once (a new one past this drops the oldest's remaining hold; it still eases out). */
export const MAX_SHOWS = 4;
/** How fast an expression's open mouth and closed-mouth shapes step aside for speech and come back (critically damped, 1/s). */
export const SHOW_MOUTH_OMEGA = 14;
/** I-175: what steps aside while she speaks: the opening (vowels, jaw) and closed-mouth shapes (cheek puff); a mouth shape stays. */
const yields = (role: MouthRole | null) => role === 'opening' || role === 'closed';
const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };
const KEY: Readonly<Record<ShowcaseExpression, keyof ShowcaseFace>> = { 'confirm-smile': 'confirm', 'warm-smile': 'warm', laugh: 'laugh', pout: 'pout', shy: 'shy',
  surprise: 'surprise', sly: 'sly', content: 'content', yawn: 'yawn' };

interface Show { id: number; name: ShowcaseExpression; at: number; rise: number; hold: number; release: number; gain: number }

export const emptyShowcaseFace = (): ShowcaseFace => ({ confirm: 0, warm: 0, laugh: 0, pout: 0, shy: 0, surprise: 0, sly: 0, content: 0, yawn: 0,
  stress: 0, closed: 0, half: 0, blush: 0, mouth: { a: 0, i: 0, u: 0, e: 0, o: 0 } });

export class WindowExpressions {
  private t = 0;
  private nextId = 1;
  private shows: Show[] = [];
  private mouthFree = 1;
  private mouthVelocity = 0;

  /** Expressions still showing (rising, holding or easing out). */
  get active(): boolean { return this.shows.length > 0; }
  /** The names showing now (diagnostics, tests). */
  get names(): ShowcaseExpression[] { return this.shows.map(show => show.name); }

  show(name: string, options: ShowExpressionOptions, gates: ShowGates): ShowExpressionResult {
    if (!(SHOWCASE_EXPRESSIONS as readonly string[]).includes(name)) return { ok: false, reason: 'unknown' };
    if (!gates.shown) return { ok: false, reason: 'hidden' };
    if (gates.asleep) return { ok: false, reason: 'asleep' };
    if (gates.faceOwned) return { ok: false, reason: 'face-owned' };
    const expression = name as ShowcaseExpression, timing = EXPRESSION_TIMING[expression];
    const onset = options.onset === 'quick' || options.onset === 'slow' ? options.onset : expression === 'warm-smile' ? 'slow' : 'quick';
    const intensity = finite01(options.intensity, 0.8), hold = Math.min(8, Math.max(0, Number.isFinite(options.holdS) ? options.holdS! : 1.6));
    // The same expression again: the one showing gives way to the new one (it eases out from where it is, through the slot springs).
    for (const show of this.shows) if (show.name === expression) show.hold = Math.min(show.hold, Math.max(0, this.t - show.at));
    // Too many at once: the oldest still holding starts easing out; past twice that, the oldest (already easing) is let go.
    const holding = this.shows.filter(show => this.t - show.at < show.hold);
    if (holding.length >= MAX_SHOWS) holding[0].hold = Math.max(0, this.t - holding[0].at);
    if (this.shows.length >= MAX_SHOWS * 2) this.shows.shift();
    const id = this.nextId++;
    this.shows.push({ id, name: expression, at: this.t, rise: onset === 'slow' ? timing.slow : timing.quick, hold, release: timing.release, gain: 0.55 + 0.45 * intensity });
    return { ok: true, id };
  }

  /** Everything showing eases away now (an interruption: a new reply, a scope change). Nothing is cut. */
  release(): void { for (const show of this.shows) show.hold = Math.min(show.hold, Math.max(0, this.t - show.at)); }

  /** Hard clear (the model went away): nothing carries over. */
  reset(): void { this.shows = []; this.mouthFree = 1; this.mouthVelocity = 0; }

  /**
   * One frame: the showcase face of what shows, as slot goals and named shapes. `speech`: she is speaking or about to (the mouth
   * shapes step aside).
   */
  frame(dt: number, speech: boolean): { slots: Partial<Record<MorphSlot, number>>; named: Record<string, number>; face: ShowcaseFace } {
    const step = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
    this.t += step;
    this.easeMouth(speech ? 0 : 1, step);
    const face = emptyShowcaseFace();
    this.shows = this.shows.filter(show => this.t - show.at - show.hold <= show.release);
    for (const show of this.shows) {
      const since = this.t - show.at, after = since - show.hold;
      let v = S5(since / show.rise) * (after > 0 ? 1 - S5(after / show.release) : 1);
      if (show.name === 'warm-smile' && since > WARM.peakS) v *= 1 - (1 - WARM.afterglow) * S5((since - WARM.peakS) / WARM.decayS);
      if (show.name === 'surprise') v *= 1 - 0.4 * S5((since - 0.45) / 0.6);
      const key = KEY[show.name];
      (face as unknown as Record<string, number>)[key] = Math.min(1, (face[key] as number) + v * show.gain);
    }
    // The blush of a shy expression: a flush follows it slowly (the face's own blush follower carries it).
    face.blush = Math.min(1, 2 * face.shy);
    const slots = faceSlots(face), named = faceNamed(face);
    this.yieldMouth(slots, named);
    return { slots, named, face };
  }

  /** The open mouth and closed-mouth shapes as free as speech leaves them this frame (eased; frame() moves the ease): for the beats' faces too. A mouth shape stays (I-175). */
  yieldMouth(slots: Partial<Record<MorphSlot, number>>, named: Record<string, number>): void {
    for (const slot of Object.keys(slots) as MorphSlot[]) if (yields(mouthRoleOfSlot(slot))) slots[slot] = (slots[slot] ?? 0) * this.mouthFree;
    for (const name of Object.keys(named)) if (yields(mouthRoleOfName(name))) named[name] *= this.mouthFree;
  }

  private easeMouth(goal: number, dt: number): void {
    if (dt <= 0) return;
    const omega = SHOW_MOUTH_OMEGA, x0 = this.mouthFree - goal, j = this.mouthVelocity + omega * x0, e = Math.exp(-omega * dt);
    this.mouthFree = Math.min(1, Math.max(0, goal + (x0 + j * dt) * e));
    this.mouthVelocity = (this.mouthVelocity - omega * j * dt) * e;
  }
}

const finite01 = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
