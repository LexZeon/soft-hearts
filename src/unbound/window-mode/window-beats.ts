/**
 * I-154 batch 2 + 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md, docs/claude/2026-11-20-unbound-window-batch2.md): her reply's
 * beats on the window engine. The wiring calls the stage's speechBeat(word) at the moment the word is reached in the reading or the
 * text; every word plays through the showcase's own performer (src/unbound/showcase/performer.ts: the same timing, variation and hand
 * poses as in Unbound mode, speechBeatShowcase for the word), and its frame is turned into window goals here:
 *  - the face (expressions, a shy blush) → expression slots and named shapes, max with what else shows; while she speaks the mouth
 *    shapes step aside (the face does that for all of them);
 *  - where she looks: "at you" here is wherever she looks in the window (the cursor, her thinking glance), so a glance is an offset on
 *    top of it; a look away takes over her look by the performer's own envelope;
 *  - a tilt, a nod, a lean → head and upper body goals; a lean never walks (window mode does not walk: lean-in / lean-back only lean);
 *  - a hand at her cheek, a V → the figure's own arm reach (the hands' targets), given up while you pull her or hold her hand.
 * What it is not: no blinks of its own (the window keeps its own rhythm; 慢慢眨眼 is one slow blink the window shows, batch 4) and no idle of its own.
 * Held (边说边演, "跨句子"): an expression, a look or an eyes beat stays up while she speaks (until the next on its channel, `releaseSpan` when her
 * speaking of the reply is over, or the cap; ../speech-beat-hold.ts). The body's words (tilt, hand, V, lean) keep their own short time.
 * A beat is refused while she is asleep or hidden ("禁止" is only "not starting": one playing finishes, then everything eases back).
 * A new reply, a stop, an error: the wiring drops what did not play (it never calls speechBeat for it); a lost scope releases.
 * I-185 亲亲、抱抱 (kiss, hug): done where she stands (window mode does not walk): a kiss closes her eyes, leans a little and puckers only in
 * a pause (never while she speaks: PuckerGate); a hug brings her arms forward and wraps them in, with a small lean. Her arms held (a pull,
 * the game, an offer, her reach) or no arm rig: the lighter hug (a small lean, no arms). The same plan and curves as full-screen
 * (shared/unbound/close-moments/in-place.ts), every channel eased; a lost scope or sleep sends it back from where it is.
 * Pure: no DOM, no three.js objects.
 */
import type { MorphSlot } from '../../../shared/actions';
import { CLOSE_BEAT_LIGHTER, SPEECH_BEAT_GO_WORDS, isCloseBeatWord, isCloseOrFrameWord, isFrameBeatWord, isGoBeatWord, windowCloseMomentsOn, type SpeechBeatCloseWord } from '../../../shared/brain';
import { InPlaceClose, inPlacePlan, type InPlaceFrame } from '../../../shared/unbound/close-moments';
import type { HandTargets } from '../arm-reach';
import { faceNamed, faceSlots } from '../motion/showcase-motion';
import type { Rot, ShowcaseFace } from '../motion/generator';
import { ShowcasePerformer, type PlayedBeat } from '../showcase/performer';
import { closeBeatStage, speechBeatMayStart, speechBeatShowcase, UNBOUND_SPEECH_BEATS, type SpeechBeatGates } from '../speech-beat-player';
import { HeldBeats } from '../speech-beat-hold';
import { CLOSE_AWAY, closeFace, closeHands } from '../director/close-pose';

/** The words this engine does not show in the window (the beat is refused: false). I-193: her "go where" words are full-screen only (the window does not walk her). */
export const WINDOW_BEATS_SKIPPED: readonly string[] = Object.freeze([...SPEECH_BEAT_GO_WORDS]);
/**
 * Batch 4, 慢慢眨眼 (blink-slow): one slow, soft blink when the word is reached (close, hold, open in s; S5 ramps, so the lids never
 * jump), and lids a little soft while the beat lasts (the old stage's lidSoft 0.15, rising and falling like its eyes channel). Natural
 * blinks wait while it shows (window-life.ts), as the old stage stretches its interval.
 */
export const SLOW_BLINK = Object.freeze({ close: 0.18, hold: 0.12, open: 0.34, soft: 0.15, rise: 0.4, fall: 0.9 });
/** The performer's lens: the window has no world lens; only the place of an approach would read it, and nothing here walks. */
const LENS = Object.freeze({ camera: Object.freeze({ x: 0, y: 1.4, z: 2 }), axis: Object.freeze({ x: 0, y: 0, z: -1 }) });

export interface WindowBeatsFrame {
  slots: Partial<Record<MorphSlot, number>>;
  named: Record<string, number>;
  /** The face's blush part (0..1), for the face's blush follower. */
  blush: number;
  head: Rot; torso: Rot;
  /** A glance on top of her look (rad, + = her left / down), and how much a look away replaces her look (0..1) with `away`. */
  gaze: { yaw: number; pitch: number; away: number; awayYaw: number; awayPitch: number };
  hands: HandTargets | null;
  /** 慢慢眨眼: a performed blink (0..1, shown over the natural one) and the soft lids while the beat lasts. */
  blink: number; softLids: number;
}
const ZERO: Rot = Object.freeze({ pitch: 0, yaw: 0, roll: 0 }) as Rot;
const IDLE_FRAME: WindowBeatsFrame = Object.freeze({ slots: {}, named: {}, blush: 0, head: ZERO, torso: ZERO,
  gaze: Object.freeze({ yaw: 0, pitch: 0, away: 0, awayYaw: 0, awayPitch: 0 }), hands: null, blink: 0, softLids: 0 }) as WindowBeatsFrame;
/** The slow blink's closure `d` seconds after the word (0 outside it). */
export function slowBlinkAt(d: number): number {
  const { close, hold, open } = SLOW_BLINK;
  if (!(d >= 0) || d > close + hold + open) return 0;
  return d < close ? S5(d / close) : d < close + hold ? 1 : 1 - S5((d - close - hold) / open);
}
const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };

export class WindowBeats {
  private performer: ShowcasePerformer | null = null;
  private endsAt = 0;
  private held = new HeldBeats();
  private seed = 1;
  private away = 0;
  /** Where the last look away was (it eases out from there, not from straight ahead). */
  private awayLook = { yaw: 0, pitch: 0 };
  /** Words performed (diagnostics, tests). */
  readonly played: string[] = [];
  /** Batch 4, 慢慢眨眼: each one's start on this clock and its beat (whose `dur` a hold stretches and a release shortens). */
  private slow: { at: number; beat: PlayedBeat }[] = [];
  private t = 0;
  /** I-185: the in-place kiss or hug, and its seed for the plan. */
  private close: InPlaceClose | null = null;
  private closeSeed = 1;
  /** I-185: the last in-place frame (tests, the record). */
  lastClose: InPlaceFrame | null = null;

  /** 2026-11-24: the small window has kiss and hug (the knob, shared/behaviors/speech-beats/window-close.ts; a test may turn it on). */
  closeMoments = windowCloseMomentsOn();

  get active(): boolean { return this.performer !== null || this.slow.length > 0 || this.close !== null; }
  /** The showcase face the beats showed on the last frame (null: none); the mouth-reading log reads which expression held her face (mouth-reading-log.ts). */
  lastFace: ShowcaseFace | null = null;

  /**
   * One word, now. false: not a word, not shown here, or she cannot start one now (asleep, hidden, her arms held). I-185: `model` (the
   * capability card's arms) decides whether a hug can bring her arms; a kiss or a hug while one is on plays its lighter word.
   */
  play(word: string, gates: SpeechBeatGates, span: boolean | 'line' = false, model: { arms: boolean } | null = null): boolean {
    // 2026-11-24 (user: 小窗先没有亲亲抱抱): while the knob is off a kiss, a hug and their frames play nothing here, not even the lighter shy smile / lean-in.
    if (!this.closeMoments && isCloseOrFrameWord(word)) return false;
    // I-203 frames: the in-place kiss / hug here has no walk and no words that wait; her let-go still lets go at its place (the others: nothing to do here).
    if (isFrameBeatWord(word)) { if (word !== 'let-go' || !this.close?.active) return false; this.close.letGo(); this.played.push(word); return true; }
    if (WINDOW_BEATS_SKIPPED.includes(word) || !speechBeatMayStart(word, gates) || isGoBeatWord(word) || isFrameBeatWord(word)) return false; // one rule with full-screen (I-174 item 5); I-193: no walking here
    if (isCloseBeatWord(word)) return this.playClose(word, gates, model);
    this.performer ??= new ShowcasePerformer({ x: 0, z: 0 }, UNBOUND_SPEECH_BEATS.liveliness, (this.seed++ % 97) / 97, 'standing');
    const beat = speechBeatShowcase(word);
    const [played] = this.performer.append([beat]);
    this.held.hold(word, played, this.performer.clock, span);
    this.endsAt = Math.max(this.endsAt, this.performer.clock + 0.2 + played.dur);
    // 慢慢眨眼: the window shows it itself (the performer's blinks are not the window's); the eyes channel's hold applies to its soft lids.
    if (word === 'blink-slow') this.slow.push({ at: this.t, beat: played });
    this.played.push(word);
    return true;
  }

  /** I-185: a kiss or a hug where she stands (closeBeatStage: wrapped arms, or the lighter one without arms); one at a time. */
  private playClose(word: SpeechBeatCloseWord, gates: SpeechBeatGates, model: { arms: boolean } | null): boolean {
    if (this.close?.active) { const lighter = this.play(CLOSE_BEAT_LIGHTER[word], gates); if (lighter) this.played.push(`${word}>${CLOSE_BEAT_LIGHTER[word]}`); return lighter; }
    const stage = closeBeatStage(word, { lighter: false, armsHeld: gates.armsHeld, arms: model ? model.arms : undefined });
    if (stage.kind === 'word') return this.play(stage.word, gates);
    const seed = () => ((this.closeSeed++ * 0.618034) % 1);
    this.close = new InPlaceClose(inPlacePlan(word, seed), { arms: stage.arms, lean: stage.lean });
    this.played.push(stage.arms === 'none' && word === 'hug' ? 'hug:lighter' : word);
    return true;
  }

  /**
   * Everything eases back (a lost scope): the performer is let go; the springs carry what showed back to rest. A slow blink under way
   * finishes its own short curve; its soft lids fall from now. I-185: an in-place kiss or hug goes back from where it is.
   */
  release(): void {
    this.close?.cancel();
    this.performer = null; this.endsAt = 0; this.held = new HeldBeats();
    for (const entry of this.slow) entry.beat.dur = Math.max(0, Math.min(entry.beat.dur, this.t - entry.at));
  }

  /** 慢慢眨眼 now: the slow blink's closure and the soft lids (each eases in and out; a release shortens the hold, never cuts it). */
  private slowEyes(): { blink: number; softLids: number } {
    let blink = 0, soft = 0;
    this.slow = this.slow.filter(({ at, beat }) => {
      const d = this.t - at, fallAt = Math.max(0, beat.dur);
      const envelope = S5(d / SLOW_BLINK.rise) * (1 - S5((d - fallAt) / SLOW_BLINK.fall));
      blink = Math.max(blink, slowBlinkAt(d)); soft = Math.max(soft, SLOW_BLINK.soft * envelope);
      return d < fallAt + SLOW_BLINK.fall || slowBlinkAt(d) > 0;
    });
    return { blink, softLids: soft };
  }

  /** I-175: a 'line' beat's sentence reached its pause: only the beats held to the line fall (their usual ease). */
  releaseLine(): void { if (this.performer) this.held.releaseLine(this.performer.clock); }
  /** Her speaking of this reply is over, or it was cancelled, a new reply began, she fell asleep: the held beats fall now (their usual ease), nothing replayed. */
  releaseSpan(): void {
    const performer = this.performer;
    if (!performer) return;
    this.held.releaseAll(performer.clock);
    this.endsAt = Math.min(this.endsAt, Math.max(performer.endsAt ?? 0, performer.clock + 0.2));
  }

  /**
   * One frame. `speaking` (I-185): the held "she is speaking" (or about to): an in-place kiss's pucker waits for the pause and steps back
   * when she speaks again; the rest of the kiss (eyes, lean) goes on.
   */
  frame(dt: number, gates: { armsHeld: boolean; asleep?: boolean; speaking?: boolean }): WindowBeatsFrame {
    const base = this.beatsFrame(dt, gates);
    const close = this.close;
    if (!close) { this.lastClose = null; return base; }
    if (gates.asleep) close.cancel();
    const speaking = gates.speaking === true;
    const out = close.frame(dt, { mayStart: !speaking, speaking }, !gates.armsHeld);
    this.lastClose = out;
    if (!close.active) this.close = null;
    return layerCloseFrame(base, out, close.plan.tiltRad >= 0 ? 1 : -1, gates.armsHeld);
  }

  private beatsFrame(dt: number, gates: { armsHeld: boolean; asleep?: boolean }): WindowBeatsFrame {
    if (gates.asleep) this.releaseSpan(); // asleep: what stayed up falls at once
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.t += step;
    const eyes = this.slow.length ? this.slowEyes() : null;
    const performer = this.performer;
    this.lastFace = null;
    // The look away eases out after the performer is gone (its share was the performer's own envelope while it played).
    if (!performer) {
      this.away = Math.max(0, this.away - step / 0.4);
      const idle = this.away > 0 ? { ...IDLE_FRAME, gaze: { yaw: 0, pitch: 0, away: S5(this.away), awayYaw: this.awayLook.yaw, awayPitch: this.awayLook.pitch } } : IDLE_FRAME;
      return eyes ? { ...idle, ...eyes } : idle;
    }
    const { intent } = performer.frame(step, LENS);
    if (performer.clock >= this.endsAt + UNBOUND_SPEECH_BEATS.releaseS) this.performer = null;
    const face: ShowcaseFace = intent.face;
    this.lastFace = face;
    const slots = faceSlots(face), named = faceNamed(face);
    delete slots.shy; delete slots.blink; // the blush goes through the face's follower; blinks stay the window's own
    const { lean, tilt, nod, gaze } = intent;
    this.away = gaze.mode === 'away' ? Math.min(1, this.away + step / 0.4) : Math.max(0, this.away - step / 0.4);
    if (gaze.mode === 'away') this.awayLook = { yaw: gaze.yaw, pitch: gaze.pitch };
    return {
      slots, named, blush: face.blush,
      head: { pitch: -0.7 * lean + nod, yaw: 0, roll: tilt },
      torso: { pitch: lean, yaw: 0, roll: 0 },
      gaze: gaze.mode === 'lens' ? { yaw: gaze.yaw, pitch: gaze.pitch - nod, away: S5(this.away), awayYaw: this.awayLook.yaw, awayPitch: this.awayLook.pitch }
        : { yaw: 0, pitch: 0, away: S5(this.away), awayYaw: this.awayLook.yaw, awayPitch: this.awayLook.pitch },
      hands: gates.armsHeld ? null : intent.hands,
      blink: eyes?.blink ?? 0, softLids: eyes?.softLids ?? 0,
    };
  }
}

/**
 * I-185: an in-place kiss or hug laid over the beats' frame. Face parts take the larger (its closed eyes go to the performed blink and its
 * soft eyes to the soft lids, so the window's own blink rhythm stays its own); lean and tilt add to the head and upper body as the
 * performer's do; its arms take the hands while they are out (never while something holds her arms); a look away (an after-beat) the larger.
 */
export function layerCloseFrame(base: WindowBeatsFrame, out: InPlaceFrame, side: 1 | -1, armsHeld: boolean): WindowBeatsFrame {
  const c = out.channels, face = closeFace(c, out.pucker);
  const slots = { ...base.slots }, named = { ...base.named };
  const own = faceSlots(face);
  delete own.shy; delete own.blink; // the blush goes through the face's follower; closed eyes through the performed blink below
  for (const [slot, value] of Object.entries(own) as [MorphSlot, number][]) slots[slot] = Math.max(slots[slot] ?? 0, value);
  for (const [name, value] of Object.entries(faceNamed(face))) named[name] = Math.max(named[name] ?? 0, value);
  // Two looks away at once blend by their shares (no switch from one direction to the other).
  const b = base.gaze.away, sum = b + c.away, away = Math.max(b, c.away);
  const mix = (mine: number, theirs: number) => sum > 1e-6 ? (b * theirs + c.away * mine) / sum : theirs;
  return {
    slots, named, blush: Math.max(base.blush, c.blush),
    head: { pitch: base.head.pitch - 0.7 * c.lean + 0.06 * c.away, yaw: base.head.yaw, roll: base.head.roll + c.tilt },
    torso: { pitch: base.torso.pitch + c.lean, yaw: base.torso.yaw, roll: base.torso.roll },
    gaze: { ...base.gaze, away, awayYaw: mix(side * CLOSE_AWAY.yaw, base.gaze.awayYaw), awayPitch: mix(CLOSE_AWAY.pitch, base.gaze.awayPitch) },
    hands: armsHeld ? null : c.arms > 1e-4 ? closeHands(c.arms, c.wrap) : base.hands,
    blink: Math.max(base.blink, 0.95 * c.closed), softLids: Math.max(base.softLids, 0.42 * c.soft),
  };
}
