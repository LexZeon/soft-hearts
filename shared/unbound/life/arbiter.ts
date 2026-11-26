/**
 * Unbound v1 step 4: the one owner of her free time and her gaze (docs/claude/2026-11-17-unbound-step4.md; Codex T-246b: one
 * arbiter owns the gaze; T-246a: one segment at a time, shared gaps, quiet when there is no chance).
 *
 * Pure. The host (electron/unbound/life.ts) asks once a second, and the peek asks before it starts (`claim`).
 *
 *   you (click, pulling her (step 5), playing with her (batch B: a game, an offer, her reach for your hand), the input box, waiting for her reply, a call, her reply coming out, her reading aloud)
 *     > peek (up to the lens) > place (walking somewhere) > small (a weight shift, a glance) > idle (a pause in her idle)
 *
 * A higher one arriving makes the running lower one ease out ('yield': the page brings every channel back to rest smoothly, a
 * walk brakes to a stop); the higher one starts only once the lower has reported it is done. "Not now" only stops new things from
 * starting: whatever runs finishes by itself ("禁止只是不开始新的动作，不是定住").
 */
import type { MoodReading } from '../director';
import type { LifeKnobs } from './mood-read';
import type { LifeSignals } from './signals';
import { levelRank, noticeable, type LifeLevel } from './types';

/** What the host sees once a second. */
export interface LifeSituation {
  /** She is out in Unbound and her window is on screen. */
  shown: boolean;
  asleep: boolean;
  inCall: boolean;
  /** Her small input box is open (you are typing to her). */
  typing: boolean;
  /** You sent her something and wait for the reply. */
  waiting: boolean;
  /** Step 5 (拉她): you are pulling her now (from the page's start until its end report). */
  pulled?: boolean;
  /** Batch B (docs/claude/2026-11-21-unbound-full-BG.md): a game, an offer or her reach for your hand is on (one rank under a pull). */
  playing?: boolean;
  /** You clicked her a moment ago. */
  clicked: boolean;
  /** Her reply is coming out (or its tail). */
  replying: boolean;
  /** Her voice is reading something (the reply speech or a playback lease). */
  readingAloud: boolean;
  signals: LifeSignals;
  mood: MoodReading | null;
}

export type LifeInteraction = 'call' | 'pull' | 'play' | 'typing' | 'waiting' | 'click' | 'reply' | 'reading';
/** You are interacting with her: the first reason, or null. */
export function interactionOf(s: Pick<LifeSituation, 'inCall' | 'pulled' | 'playing' | 'typing' | 'waiting' | 'clicked' | 'replying' | 'readingAloud'>): LifeInteraction | null {
  if (s.inCall) return 'call';
  if (s.pulled) return 'pull';
  if (s.playing) return 'play';
  if (s.typing) return 'typing';
  if (s.waiting) return 'waiting';
  if (s.clicked) return 'click';
  if (s.replying) return 'reply';
  if (s.readingAloud) return 'reading';
  return null;
}

export type LifeQuiet = 'not-shown' | 'fullscreen' | 'asleep' | 'away' | 'no-mood';
/**
 * No chance (nobody would see her, or she sleeps), or you are watching something full screen (I-199: she stays drawn above it; only
 * her own new walks and actions wait, what runs goes on): nothing new starts. Null: she may. Away counts only when the camera cannot tell:
 * when it sees you have left, she wanders freely (afternoon addition A: "你走开 → 她自由走动"); the actions that need you there
 * (a glance, the peek) say no by themselves.
 */
export function quietOf(s: Pick<LifeSituation, 'shown' | 'asleep' | 'signals' | 'mood'>): LifeQuiet | null {
  if (!s.shown) return 'not-shown';
  if (s.signals.fullscreen) return 'fullscreen';
  if (s.asleep) return 'asleep';
  if (s.signals.doing === 'away' && s.signals.someoneInFront === null) return 'away';
  if (!s.mood) return 'no-mood';
  return null;
}

export interface LifeRunning { id: string; level: LifeLevel; easing: boolean }
/** `prompt`: a reaction to something you just did (a wave, coming back): it skips the gap and the after-you wait, nothing else. */
export interface LifeWant { id: string; level: LifeLevel; prompt?: boolean }
export interface ArbiterInput {
  now: number;
  interaction: LifeInteraction | null;
  quiet: LifeQuiet | null;
  /** What plays now (the peek included), or null. */
  running: LifeRunning | null;
  /** What would like to start now (already due and ready by its own rules). */
  wants: readonly LifeWant[];
  /** When the last thing you notice (small and up) ended. */
  lastNoticeableEndAt: number | null;
  /** When you last stopped interacting with her. */
  interactionEndedAt: number | null;
  knobs: Pick<LifeKnobs, 'gapSeconds' | 'afterUserSeconds'>;
  /** Fast-forward (developer panel): gaps divided by this (default 1). */
  speed?: number;
}
export type ArbiterWait = 'user' | 'busy' | 'quiet' | 'after-user' | 'gap' | 'nothing';
export type ArbiterDecision = { kind: 'wait'; why: ArbiterWait } | { kind: 'yield'; id: string; reason: 'user' | 'higher' } | { kind: 'start'; id: string };

/** The highest want (a prompt one first among equals, then the first listed). */
export function topWant(wants: readonly LifeWant[]): LifeWant | null {
  let top: LifeWant | null = null;
  for (const want of wants) if (!top || levelRank(want.level) > levelRank(top.level) || (levelRank(want.level) === levelRank(top.level) && want.prompt && !top.prompt)) top = want;
  return top;
}

export function arbitrate(input: ArbiterInput): ArbiterDecision {
  const running = input.running, speed = input.speed && input.speed > 0 ? input.speed : 1;
  if (input.interaction) {
    if (running && !running.easing && levelRank(running.level) < levelRank('user')) return { kind: 'yield', id: running.id, reason: 'user' };
    return { kind: 'wait', why: 'user' };
  }
  const top = topWant(input.wants);
  if (running) {
    if (!running.easing && top && levelRank(top.level) > levelRank(running.level)) return { kind: 'yield', id: running.id, reason: 'higher' };
    return { kind: 'wait', why: 'busy' };
  }
  if (input.quiet) return { kind: 'wait', why: 'quiet' };
  if (!top) return { kind: 'wait', why: 'nothing' };
  if (top.prompt) return { kind: 'start', id: top.id };
  if (input.interactionEndedAt !== null && input.now - input.interactionEndedAt < input.knobs.afterUserSeconds * 1000 / speed) return { kind: 'wait', why: 'after-user' };
  if (noticeable(top.level) && input.lastNoticeableEndAt !== null && input.now - input.lastNoticeableEndAt < input.knobs.gapSeconds * 1000 / speed) return { kind: 'wait', why: 'gap' };
  return { kind: 'start', id: top.id };
}

/** Who her gaze belongs to now: a peek (its director), you (you are interacting), the running action, or nobody (where she walks / faces). */
export type GazeOwner = 'peek' | 'user' | 'facing' | 'action' | 'free';
/** `facing`: you face her and she looks back (I-081's gaze attention, shared/behaviors/gaze-attention): gaze only, nothing is cancelled. */
export function gazeOwner(s: { peekActive: boolean; interaction: LifeInteraction | null; facing: boolean; running: LifeRunning | null }): GazeOwner {
  if (s.peekActive) return 'peek';
  if (s.interaction) return 'user';
  if (s.facing) return 'facing';
  if (s.running) return 'action';
  return 'free';
}

export const ARBITER_WAIT_WORDS: Readonly<Record<ArbiterWait, string>> = Object.freeze({
  user: '你在和她互动', busy: '她在做一件事', quiet: '现在没机会', 'after-user': '你刚理完她，先等一会儿', gap: '两件事之间隔一会儿', nothing: '没有想做的',
});
export const LIFE_QUIET_WORDS: Readonly<Record<LifeQuiet, string>> = Object.freeze({
  'not-shown': '她不在外面', fullscreen: '有全屏程序', asleep: '她在睡', away: '你离开了', 'no-mood': '读不到她的心情',
});
export const INTERACTION_WORDS: Readonly<Record<LifeInteraction, string>> = Object.freeze({
  call: '在通话', pull: '你在拉她', play: '你在和她玩', typing: '你在给她打字', waiting: '你在等她回复', click: '你刚点了她', reply: '她在回你', reading: '她在朗读',
});
