/**
 * I-174 item 1 (docs/claude/2026-11-21-i174-parity-fixes.md): her own small things in the companion window go through full-screen's own
 * scheduler and arbiter (shared/unbound/life/host.ts LifeHost, shared/unbound/life/arbiter.ts), played by full-screen's own player
 * (../life/player.ts). Standing design: "窗口是unbound的删减版".
 *
 * So in both: idle pauses and small moves (a weight shift, a glance at you) come on the same schedule from her mood, one at a time, with the
 * same gap between two you notice; you interacting with her (typing, waiting for her reply, her reply or reading, a click or a pat, a game, a
 * pull) makes whatever runs ease out first (the player's S5 from where every channel is) and nothing new starts until a while after you.
 * What the window never satisfies: walking somewhere (`here` is null: the place action says "还不知道她站在哪") and the peek (never claimed).
 * What the window does not read: the host's sense readings (idle seconds, pose, the program in front): signals stay 'unknown' (the page has
 * none of them; nothing new is sensed or asked for). Her mood comes from the mood view she already has.
 *
 * The player's goals are laid over the window's own (window-body.ts): the hips over one foot and the torso's lean back added, the head tilt
 * added, the smile at least this, the idle's clock rate (the pause), and how much a glance looks at you (the window's look-at-you weight).
 * Every channel moves on S5 between keys and eases back on S5 when cut: never a jump ("禁止只是不开始新的动作，不是定住").
 */
import { LifeHost, type LifePorts, type LifeLink } from '../../../shared/unbound/life/host';
import { LIFE_ACTION_IDS } from '../../../shared/unbound/life/registry';
import type { MoodReading } from '../../../shared/unbound/director';
import type { MoodView } from '../../../shared/mood';
import { LifePlayer } from '../life/player';
import { REST_TARGETS, type BodySense, type PoseTargets } from '../motion/generator';

/** What the window knows each second about you and her (the arbiter's interaction inputs; the rest are never true here). */
export interface WindowArbiterSituation {
  shown: boolean;
  typing: boolean;
  /** Your message is out and her reply has not started yet (her thinking look). */
  waiting: boolean;
  /** Her voice is sounding (a reply, a line of hers). */
  speaking: boolean;
  /** A game, an offer or her reach for your hand. */
  playing: boolean;
  view: MoodView | null;
}

/** The goals laid over the window's own this frame. */
export interface WindowLifeOverlay {
  lateral: number; torsoRoll: number; neckRoll: number; headRoll: number; smile: number;
  /** How much she looks at you (a glance): the window's look-at-you weight, 0..1. */
  look: number;
  /** Her idle's clock rate (1 = as it plays; the pause brings it to 0 and back). */
  rate: number;
}
export const NO_LIFE_OVERLAY: Readonly<WindowLifeOverlay> = Object.freeze({ lateral: 0, torsoRoll: 0, neckRoll: 0, headRoll: 0, smile: 0, look: 0, rate: 1 });

/** Her mood numbers from the mood view (the same reading the host gives full-screen; null without a view). */
export function moodReadingOf(view: MoodView | null): MoodReading | null {
  const v = view?.snapshot?.values as Partial<Record<'D' | 'O' | 'E' | 'N' | 'C' | 'A' | 'B' | 'M', number>> | undefined;
  if (!v) return null;
  const n = (x: unknown, d: number) => typeof x === 'number' && Number.isFinite(x) ? x : d;
  return { D: n(v.D, 50), O: n(v.O, 50), E: n(v.E, 50), N: n(v.N, 50), C: n(v.C, 50), A: n(v.A, 0.2), B: n(v.B, 0), M: n(v.M, 0) };
}

export interface WindowArbiterOptions {
  clock?: () => number;
  random?: () => number;
  /** A repeating timer (the stage's one-second beat); tests pass their own. */
  every?: (ms: number, run: () => void) => () => void;
  /** A quick move of her idle is under way (the pause waits for it). */
  quickBusy?: () => boolean;
}

export class WindowArbiter {
  readonly host: LifeHost;
  readonly player: LifePlayer;
  private situationNow: WindowArbiterSituation = { shown: false, typing: false, waiting: false, speaking: false, playing: false, view: null };
  private captured: PoseTargets | null = null;
  private stop: (() => void) | null = null;
  private wasReplying = false;

  constructor(options: WindowArbiterOptions = {}) {
    const clock = options.clock ?? Date.now, random = options.random ?? Math.random;
    const every = options.every ?? ((ms: number, run: () => void) => { const timer = setInterval(run, ms); return () => clearInterval(timer); });
    const s = () => this.situationNow;
    const ports: LifePorts = {
      clock, random, readings: () => ({}), asleep: () => s().view?.fatigue?.sleeping === true, inCall: () => false,
      waiting: () => s().waiting, typing: () => s().typing, readingAloud: () => s().speaking, playing: () => s().playing,
      mood: () => moodReadingOf(s().view), lastInteractionAt: () => s().view?.snapshot?.lastInteractionAt ?? null, answered: () => false, every,
    };
    const link: LifeLink = {
      shown: () => s().shown, fullscreen: () => false, out: () => false, send: command => this.player.command(command),
      here: () => null, toWorld: () => null, arrived: () => {}, peekActive: () => false, interruptPeek: () => {}, changed: () => {},
    };
    this.host = new LifeHost(ports, link);
    this.player = new LifePlayer(LIFE_ACTION_IDS, report => this.host.report(report), options.quickBusy ?? (() => false));
    this.everyPort = every;
  }
  private readonly everyPort: (ms: number, run: () => void) => () => void;

  /** Start the one-second beat (the stage made a model and is drawing); idempotent. */
  start(): void { this.stop ??= this.everyPort(1_000, () => this.host.tick()); }
  /** Stop the beat and forget what ran (the stage went away or its model did); what plays eases out by the player's own rule. */
  halt(): void { this.stop?.(); this.stop = null; this.host.stop(); }

  /** What the window knows now (every frame is fine: the host reads it once a second). */
  situation(next: WindowArbiterSituation): void {
    this.situationNow = next;
    // Her reply's tail counts as you two still talking (the host's replyTailMs), from when her voice stops.
    if (next.speaking !== this.wasReplying) { this.host.chat(next.speaking ? 'delta' : 'done'); this.wasReplying = next.speaking; }
  }
  /** You clicked or patted her. */
  touched(): void { this.host.touched(); }
  /** A pull began or ended (she never walks along here). */
  pulled(phase: 'start' | 'end'): void { this.host.pulled(phase); }
  /** A game, an offer or her reach started: what she does eases out now. */
  yieldNow(): void { this.player.yieldNow(); }

  /**
   * One frame: the player's goals, read as the window's overlay. `suppressed`: something with priority has her whole body (her sleep, a pull,
   * the camera being adjusted): nothing is written, her own action eases out unseen.
   */
  frame(dt: number, body: { sense: BodySense | null; heightM: number }, suppressed: boolean): WindowLifeOverlay {
    this.captured = null;
    const capture = { sense: null as BodySense | null, setPoseTargets: (targets: PoseTargets) => { this.captured = targets; } };
    this.player.frame(dt, { lens: { camera: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: -1 } } }, capture,
      { walking: false, moving: false, heightM: body.heightM, placement: { xM: 0, depthM: 0 } }, suppressed);
    const t = this.captured as PoseTargets | null;
    const look = this.player.lookNow;
    if (!t || t === REST_TARGETS) return { ...NO_LIFE_OVERLAY, rate: this.player.idleRate, look };
    return { lateral: t.pelvis.lateral, torsoRoll: t.torso.roll, neckRoll: t.neck.roll, headRoll: t.head.roll, smile: t.face.smile, look, rate: this.player.idleRate };
  }

  get active(): boolean { return this.player.active; }
}

/** The overlay laid over the window's own goals (window-body.ts): added offsets, the smile at least this. Pure. */
export function withLifeOverlay(targets: PoseTargets, life: WindowLifeOverlay | null | undefined): PoseTargets {
  if (!life || (life.lateral === 0 && life.torsoRoll === 0 && life.neckRoll === 0 && life.headRoll === 0 && life.smile === 0)) return targets;
  return { ...targets, pelvis: { ...targets.pelvis, lateral: targets.pelvis.lateral + life.lateral },
    torso: { ...targets.torso, roll: targets.torso.roll + life.torsoRoll }, neck: { ...targets.neck, roll: targets.neck.roll + life.neckRoll },
    head: { ...targets.head, roll: targets.head.roll + life.headRoll }, face: { ...targets.face, smile: Math.max(targets.face.smile, life.smile) } };
}
