/**
 * I-081 第 1 步：开着姿势识别时，她自己挑看你、看鼠标，还是移开一下（旋钮见 knobs.ts，记录 docs/claude/2026-11-11-i081-gaze.md）。
 *
 * 纯计算：每帧喂一次（dt 秒），不读时钟、不碰舞台；随机数从外面给（测试注入固定序列）。
 *  - 只有"你在、脸朝着她、她醒着可以看"持续 arriveS 秒，才进入"会看你"的状态；不在或转开持续 leaveS 秒就退出。
 *    没进入时每帧都返回 { mouse: 1 }，和以前完全一样。
 *  - 进入时第一眼看你；之后每看完一段，按分量随机挑下一段（shared/foundation/she-chooses.ts），看你之后下一段一定先移开，所以从不一直盯着。
 *  - 三个分量（user / mouse / away）在 switchS 秒里按平滑曲线换过去，所以视线目标从不跳；之后舞台原有的阻尼让眼睛先到、头跟着。
 *  - 对视：她在看你、你朝着她，累计 eyeContactS 秒算一次（每段最多一次）；害羞时对上眼 after 秒后可能先躲开一下再看回来。
 *
 * 心情的读法和写回见 knobs.ts 头注释；这里只把"此刻"的数换成分量和时长。
 */
import { sheChooses, type SheChoosesCandidate, type SheChoosesReason } from '../../brain';
import { moodLevel, type MoodValues } from '../../foundation/mood';
import type { PoseFacing } from '../../senses/pose-signals';
import type { ScreenInterest } from './interface';
import { GAZE_ATTENTION_KNOBS, type GazeAttentionKnobs } from './knobs';

export const GAZE_TARGETS = ['user', 'mouse', 'away'] as const;
export type GazeTarget = typeof GAZE_TARGETS[number];
const LABEL: Readonly<Record<GazeTarget, string>> = { user: '看你', mouse: '看鼠标', away: '移开一下' };

/** Her mood now, as this feature reads it. O, D, N, C: −1..1 relative to the card's baseline; M, B, A, shy: 0..1. */
export interface GazeMood { readonly O: number; readonly D: number; readonly N: number; readonly C: number; readonly M: number; readonly B: number; readonly A: number; readonly shy: number }
export const NEUTRAL_GAZE_MOOD: GazeMood = Object.freeze({ O: 0, D: 0, N: 0, C: 0, M: 0, B: 0, A: 0, shy: 0 });

/** The parts of the stage's mood view this reads (shared/mood/mood-runtime.ts MoodView); anything missing counts as neutral. */
export interface GazeMoodSource {
  parameters?: { baseline?: Partial<MoodValues>; evidence?: { level?: number }; weights?: { cautious?: number } };
  snapshot?: { values?: Partial<MoodValues>; boredom?: number; longing?: number; blush?: { amount?: number } | null };
  fatigue?: { A?: number } | null;
}

const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, finite(value, low)));

/** Her mood view → GazeMood (null or broken parts read as neutral). */
export function gazeMoodFrom(view: GazeMoodSource | null | undefined): GazeMood {
  if (!view) return NEUTRAL_GAZE_MOOD;
  const values = view.snapshot?.values ?? {}, baseline = view.parameters?.baseline ?? {}, evidence = clamp(finite(view.parameters?.evidence?.level, 1), 0, 2);
  const rel = (key: keyof MoodValues) => {
    const value = values[key], base = baseline[key];
    if (typeof value !== 'number' || typeof base !== 'number' || !Number.isFinite(value) || !(base > 0 && base < 100)) return 0;
    return clamp((moodLevel(value, base, evidence) - 50) / 50, -1, 1);
  };
  const O = rel('O');
  const blush = clamp(finite(view.snapshot?.blush?.amount), 0, 1), cautious = finite(view.parameters?.weights?.cautious, 1);
  return { O, D: rel('D'), N: rel('N'), C: rel('C'), M: clamp(finite(view.snapshot?.longing) / 100, 0, 1), B: clamp(finite(view.snapshot?.boredom) / 100, 0, 1),
    A: clamp(finite(view.fatigue?.A), 0, 1), shy: clamp(blush + 0.3 * Math.max(0, cautious - 1) + 0.15 * Math.max(0, O), 0, 1) };
}

export interface GazeAttentionInput {
  /** Seconds since the last frame (bounded inside). */
  readonly dt: number;
  /**
   * What pose sensing says now; null: sensing off or no fresh reading. I-167 `looking`: the head points at her (looking.ts); false: facing
   * the screen but elsewhere, so no eye contact and no shy look-away; absent or null: not known, facing alone decides as before.
   */
  readonly user: { readonly present: boolean; readonly facing: PoseFacing; readonly energy: number; readonly looking?: boolean | null } | null;
  /** "跟着鼠标看" is on (the mouse is a target). */
  readonly mouse: boolean;
  /** She may look around now (awake: the fatigue frame's gazeAllowed). */
  readonly allowed: boolean;
  /** Her thinking gaze holds her eyes (waiting for a reply): eye contact does not accrue. */
  readonly thinking?: boolean;
  /** She is speaking to the user. */
  readonly speaking?: boolean;
  /** 0..1, how much the cursor moves. */
  readonly pointerMoving?: number;
  readonly mood?: GazeMood;
  readonly screen?: ScreenInterest | null;
  /** A fresh warm moment (praise, a kind word): she looks at the user now if she can. */
  readonly praised?: boolean;
}

export interface GazeAttentionFrame {
  /** She is in the "looks at you" state (pose sees you, facing her). */
  readonly engaged: boolean;
  readonly target: GazeTarget | null;
  /** Blend weights, each 0..1, summing to 1. */
  readonly user: number;
  readonly mouse: number;
  readonly away: number;
  /** The look-away offset (gazeTargets' units), already blended. */
  readonly awayX: number;
  readonly awayY: number;
}

/** What the developer readout shows of the chooser (I-169). */
export interface GazeReadout { readonly target: GazeTarget; readonly user: number; readonly mouse: number; readonly away: number; readonly why: string }

export type GazeStopWhy = 'left' | 'turned' | 'off' | 'asleep';
export type GazeAttentionEvent =
  | { readonly kind: 'start'; readonly why: 'arrived' | 'facing' }
  | { readonly kind: 'stop'; readonly why: GazeStopWhy }
  | { readonly kind: 'eye-contact' }
  | { readonly kind: 'shy' };

const smoothstep = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const between = (random: () => number, [low, high]: readonly [number, number]) => low + (high - low) * clamp(random(), 0, 1);

interface Now {
  readonly mood: GazeMood;
  readonly mouse: boolean;
  readonly afterUser: boolean;
  readonly speaking: boolean;
  readonly moving: number;
  readonly pointer: number;
  readonly screen: ScreenInterest | null;
}
/** How much each mood reading counts in one place (shared by the weights and the dwell). */
function moodParts(mood: GazeMood) {
  return { close: clamp(mood.O + mood.M, -1, 1.5), curious: clamp(Math.max(0, mood.D) + mood.B, 0, 1.5), tense: clamp(Math.max(0, mood.N) + Math.max(0, mood.C), 0, 1.5), sleepy: clamp(mood.A, 0, 1) };
}

export class GazeAttention {
  private engagedFlag = false;
  private availableFor = 0;
  private unavailableFor = 0;
  private sawAbsent = true;
  private target: GazeTarget | null = null;
  private remaining = 0;
  private readonly weights = { user: 0, mouse: 1, away: 0 };
  private readonly from = { user: 0, mouse: 1, away: 0, awayX: 0, awayY: 0 };
  private awayTo = { x: 0, y: 0 };
  private readonly away = { x: 0, y: 0 };
  private progress = 1;
  private recent: GazeTarget[] = [];
  private mutual = 0;
  private shyAt = Infinity;
  private shyChecked = false;
  private eyeContactDone = false;
  private forceUser = false;
  private time = 0;
  private readonly lastNoted: Partial<Record<'eye-contact' | 'shy', number>> = {};
  private events: GazeAttentionEvent[] = [];
  /** Why the last target was picked (developer diagnostics; labels only). */
  why: readonly string[] = [];

  constructor(private readonly random: () => number = Math.random, private readonly knobs: GazeAttentionKnobs = GAZE_ATTENTION_KNOBS) {}

  get engaged(): boolean { return this.engagedFlag; }

  /** I-169 (developer mode's gaze readout; read only, labels and numbers): who she looks at, the blend, and the first reason for the last switch. */
  readout(): GazeReadout { return { target: this.target ?? 'mouse', user: this.weights.user, mouse: this.weights.mouse, away: this.weights.away, why: this.why[0] ?? '' }; }

  /** What happened since the last call (start / stop / eye contact / shy), oldest first. */
  takeEvents(): GazeAttentionEvent[] { const out = this.events; this.events = []; return out; }

  frame(input: GazeAttentionInput): GazeAttentionFrame {
    const dt = clamp(finite(input.dt), 0, 0.25), k = this.knobs;
    this.time += dt;
    const user = input.user;
    const can = input.allowed && !!user && user.present && user.facing === 'toward';
    if (can) { this.availableFor += dt; this.unavailableFor = 0; }
    else { this.unavailableFor += dt; this.availableFor = 0; if (!user || !user.present) this.sawAbsent = true; }
    const now: Now = { mood: input.mood ?? NEUTRAL_GAZE_MOOD, mouse: input.mouse, afterUser: false, speaking: input.speaking === true,
      moving: clamp(finite(user?.energy), 0, 1), pointer: clamp(finite(input.pointerMoving), 0, 1), screen: input.screen ?? null };
    if (!this.engagedFlag && can && this.availableFor >= k.arriveS) {
      this.engagedFlag = true;
      this.events.push({ kind: 'start', why: this.sawAbsent ? 'arrived' : 'facing' });
      this.sawAbsent = false;
      // She looks at you first when you come back or turn to her.
      this.switchTo('user', this.dwellFor('user', now), ['你来了，先看你一眼']);
    } else if (this.engagedFlag && !can && this.unavailableFor >= k.leaveS) {
      this.engagedFlag = false;
      this.events.push({ kind: 'stop', why: !user ? 'off' : !input.allowed ? 'asleep' : !user.present ? 'left' : 'turned' });
      this.target = null; this.forceUser = false;
      this.switchTo('mouse', 0, ['你不在或转开了，回到以前的样子']);
    }
    if (this.engagedFlag) {
      this.remaining -= dt;
      if (input.praised && can && this.target !== 'user') this.switchTo('user', this.dwellFor('user', now), ['你刚说了暖心的话，看着你']);
      if (this.target === 'user' && can && user!.looking !== false && !input.thinking && this.weights.user > 0.9) this.contact(dt, now);
      if (this.remaining <= 0) this.pick(now);
    }
    this.blend(dt);
    if (!this.engagedFlag && this.progress >= 1) {
      // Settled back: exactly as before I-081.
      this.weights.user = 0; this.weights.mouse = 1; this.weights.away = 0;
    }
    return { engaged: this.engagedFlag, target: this.target, user: this.weights.user, mouse: this.weights.mouse, away: this.weights.away,
      awayX: this.away.x, awayY: this.away.y };
  }

  /** Mutual gaze while she looks at you: the shy look-away, then the eye-contact moment. */
  private contact(dt: number, now: Now): void {
    const k = this.knobs;
    this.mutual += dt;
    if (!this.shyChecked && this.mutual >= this.shyAt) {
      this.shyChecked = true;
      if (clamp(this.random(), 0, 1) < Math.min(k.shy.cap, k.shy.chance * now.mood.shy)) {
        this.note({ kind: 'shy' });
        this.forceUser = true;
        this.switchTo('away', between(this.random, k.dwell.shyAway) * this.slower(now), ['和你对上眼，害羞地躲开一下']);
        return;
      }
    }
    if (!this.eyeContactDone && this.mutual >= k.eyeContactS) { this.eyeContactDone = true; this.note({ kind: 'eye-contact' }); }
  }

  private note(event: { kind: 'eye-contact' | 'shy' }): void {
    const last = this.lastNoted[event.kind];
    if (last !== undefined && this.time - last < this.knobs.journalGapS) {
      // Eye contact still reaches her mood (the host gates it); only the journal line is spaced. Shy has no mood write.
      if (event.kind === 'eye-contact') this.events.push(event);
      return;
    }
    this.lastNoted[event.kind] = this.time;
    this.events.push(event);
  }

  private pick(now: Now): void {
    const afterUser = this.target === 'user';
    if (this.forceUser) {
      this.forceUser = false;
      this.switchTo('user', this.dwellFor('user', now), ['躲开一下又看回来']);
      return;
    }
    const at: Now = { ...now, afterUser };
    const chose = sheChooses({ candidates: this.candidates(), now: at, random: this.random, recent: this.recent, recentFactors: this.knobs.recent });
    const target: GazeTarget = chose?.id ?? (now.mouse ? 'mouse' : 'away');
    this.switchTo(target, this.dwellFor(target, now), chose?.why ?? []);
  }

  private candidates(): SheChoosesCandidate<GazeTarget, Now>[] {
    const k = this.knobs;
    const user: SheChoosesCandidate<GazeTarget, Now> = { id: 'user', label: LABEL.user, weigh: now => {
      if (now.afterUser) return { base: 0, reasons: [{ text: '刚看过你，先移开一下', factor: 0 }] };
      const parts = moodParts(now.mood), reasons: SheChoosesReason[] = [];
      if (parts.close !== 0) reasons.push({ text: parts.close > 0 ? '亲近、想你' : '这会儿没那么黏你', factor: Math.max(0.3, 1 + k.mood.close * parts.close) });
      if (parts.tense > 0) reasons.push({ text: '有点紧张，看看你在不在', factor: 1 + k.mood.tense * parts.tense });
      if (now.moving > 0) reasons.push({ text: '你在动', factor: 1 + k.user.moving * now.moving });
      if (now.speaking) reasons.push({ text: '她在跟你说话', factor: k.user.speaking });
      if (now.screen) reasons.push({ text: SCREEN_WORDS[now.screen], factor: k.screen[now.screen].user });
      return { base: k.weights.user, reasons };
    } };
    const mouse: SheChoosesCandidate<GazeTarget, Now> = { id: 'mouse', label: LABEL.mouse, weigh: now => {
      if (!now.mouse) return { base: 0, reasons: [] };
      const parts = moodParts(now.mood), reasons: SheChoosesReason[] = [];
      if (parts.curious > 0) reasons.push({ text: '好奇、有点无聊', factor: 1 + k.mood.curious * parts.curious });
      if (now.pointer > 0) reasons.push({ text: '鼠标在动', factor: 1 + k.pointer.moving * now.pointer });
      if (now.screen) reasons.push({ text: SCREEN_WORDS[now.screen], factor: k.screen[now.screen].mouse });
      if (parts.sleepy > 0) reasons.push({ text: '困了', factor: Math.max(0.05, 1 - k.mood.sleepy * parts.sleepy) });
      return { base: k.weights.mouse, reasons };
    } };
    const away: SheChoosesCandidate<GazeTarget, Now> = { id: 'away', label: LABEL.away, weigh: now => {
      const parts = moodParts(now.mood), reasons: SheChoosesReason[] = [];
      if (parts.sleepy > 0) reasons.push({ text: '困了', factor: Math.max(0.05, 1 - k.mood.sleepy * parts.sleepy) });
      return { base: now.mouse ? k.weights.away : k.weights.awayNoMouse, reasons };
    } };
    return [user, mouse, away];
  }

  private slower(now: Now): number { return 1 + this.knobs.mood.sleepyDwell * moodParts(now.mood).sleepy; }

  private dwellFor(target: GazeTarget, now: Now): number {
    const k = this.knobs, parts = moodParts(now.mood);
    let seconds = between(this.random, k.dwell[target]) * this.slower(now);
    if (target === 'user') {
      seconds *= Math.max(0.5, 1 + k.mood.closeDwell * parts.close) * Math.max(0.4, 1 - k.mood.tenseDwell * parts.tense);
      if (now.speaking) seconds *= k.user.speakingDwell;
    } else if (target === 'mouse') {
      seconds *= (1 + k.mood.curiousDwell * parts.curious) * (now.screen ? k.screen[now.screen].mouseDwell : 1);
    }
    return Math.max(0.3, seconds);
  }

  private switchTo(target: GazeTarget, seconds: number, why: readonly string[]): void {
    this.from.user = this.weights.user; this.from.mouse = this.weights.mouse; this.from.away = this.weights.away;
    this.from.awayX = this.away.x; this.from.awayY = this.away.y;
    if (target === 'away') this.awayTo = { x: (clamp(this.random(), 0, 1) < 0.5 ? -1 : 1) * between(this.random, this.knobs.away.x), y: between(this.random, this.knobs.away.y) };
    this.progress = 0;
    if (this.engagedFlag) { this.target = target; this.recent = [target, ...this.recent].slice(0, 4); }
    this.remaining = seconds;
    this.mutual = 0; this.shyChecked = false; this.eyeContactDone = false;
    this.shyAt = target === 'user' ? between(this.random, this.knobs.shy.after) : Infinity;
    this.why = why;
  }

  private blend(dt: number): void {
    if (this.progress >= 1) return;
    this.progress = Math.min(1, this.progress + dt / Math.max(0.02, this.knobs.switchS));
    const e = smoothstep(this.progress), to = this.target ?? 'mouse';
    for (const key of GAZE_TARGETS) this.weights[key] = this.from[key] + ((key === to ? 1 : 0) - this.from[key]) * e;
    if (this.progress >= 1) for (const key of GAZE_TARGETS) this.weights[key] = key === to ? 1 : 0;
    this.away.x = this.from.awayX + (this.awayTo.x - this.from.awayX) * e;
    this.away.y = this.from.awayY + (this.awayTo.y - this.from.awayY) * e;
  }
}

const SCREEN_WORDS: Readonly<Record<ScreenInterest, string>> = {
  lively: '屏幕上正精彩', calm: '屏幕上在放东西', typing: '你在打字', idle: '屏幕上没什么',
};
