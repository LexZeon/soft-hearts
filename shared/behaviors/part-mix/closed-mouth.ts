/**
 * I-175 闭嘴类形态（鼓腮、吐舌、亲）：她念的时候不开始，排到下一个句间停顿，或者这条念完以后；停下来以后 knobs.closedMouthDropS（3 秒）
 * 内还没轮到就不做（和"晚到的拍子不演"一样，不补演）。取消的回复（停止、新的回复、出错）排着的全部丢掉。方案第 3 条按推荐。
 *
 * 撅嘴不在这里：它能边说边做（嘴形是底形，口型在上面开合，mouth.ts），方案第 1 条按推荐。
 *
 * 什么算"停顿"：带保持的"她在说话"（SpeechOwner，断口 < 0.4 秒算同一句）关着；朗读关着时，气泡里这句话已经显示完（sentenceOpen 为假）。
 * 停顿里开始以后又开口：形态按脸的独占的规矩缓缓交还（src/stage/face-exclusive.ts cancel 'speech'），声音照常，从不被打断。
 * 纯的：时间由调用的人传进来（秒），测试用假时钟。
 */
import { PART_MIX_KNOBS, type PartMixKnobs } from './knobs';
import type { ClosedMouthWorld } from './interface';

/** The shown text ends a sentence: its full stop (。！？!?… a newline, a trailing ～), then only closing quotes or brackets (speech-beats/how-long.ts's rule). */
const SENTENCE_DONE = /[。！？!?…~～\n][」』”’）)】〗"']*$/u;

/**
 * Read-aloud off: is the bubble in the middle of a sentence? `note(shown, now)` with the text the bubble shows each time it grows (the stage's
 * "#shown" speech cue); `open(now)`: the shown text ends inside a sentence and it grew within knobs.sentenceOpenS (a reply whose last sentence
 * has no full stop, or a stream that stopped, closes by itself). Seconds, from the caller's clock.
 */
export class ShownSentence {
  private midway = false;
  private at = -Infinity;
  constructor(private readonly knobs: PartMixKnobs = PART_MIX_KNOBS) {}
  note(shown: string, now: number): void {
    const text = typeof shown === 'string' ? shown.trimEnd() : '';
    this.midway = text.length > 0 && !SENTENCE_DONE.test(text);
    this.at = now;
  }
  open(now: number): boolean { return this.midway && now - this.at <= this.knobs.sentenceOpenS; }
  reset(): void { this.midway = false; this.at = -Infinity; }
}

/** Her face actions that need a closed mouth (shared/actions/her-actions.ts ids; 'kiss' is listed for when one exists). */
export const CLOSED_MOUTH_ACTIONS: readonly string[] = Object.freeze(['cheek-puff', 'tongue-out', 'kiss']);
/** Her face actions on the mouth that she can do while speaking: the shape is the base, lip-sync opens on top. */
export const TALK_THROUGH_ACTIONS: readonly string[] = Object.freeze(['pout']);

/** How a mouth action behaves while she speaks: 'talk-through' (pout), 'closed' (waits for a pause), null (not a mouth action we know). */
export function mouthActionKind(action: string): 'talk-through' | 'closed' | null {
  if (TALK_THROUGH_ACTIONS.includes(action)) return 'talk-through';
  if (CLOSED_MOUTH_ACTIONS.includes(action)) return 'closed';
  return null;
}

/**
 * May a closed-mouth shape start now? Never while the held "she is speaking" is on, never mid-sentence with read-aloud off, and only when
 * every other owner of her mouth lets it (the caller's gates). The one rule the queue and the stage both ask.
 */
export function closedMouthMayStart(world: ClosedMouthWorld): boolean {
  if (world.held) return false;
  if (world.sentenceOpen) return false;
  return world.free === true;
}

/**
 * Must a closed-mouth shape asked for NOW wait in the queue instead of starting at once? When she speaks (the held flag, or about to) or,
 * read-aloud off, the bubble is mid-sentence (Codex T-258 C01: the direct path used to look only at speaking, so a puff asked mid-sentence
 * started at once). The queue then lets it go through closedMouthMayStart.
 */
export function closedMouthMustWait(world: { held: boolean; sentenceOpen: boolean }): boolean {
  return world.held || world.sentenceOpen;
}

interface Waiting<T> { readonly item: T; readonly since: number; quietSince: number | null }

/**
 * The waiting closed-mouth shapes (at most `max`, oldest first; a newer one past that drops the oldest). Each frame: one may start
 * (returned once, then forgotten), the ones that waited too long are dropped. `cancel()`: a cancelled reply's shapes never play.
 */
export class ClosedMouthQueue<T> {
  private waiting: Waiting<T>[] = [];
  /** How many were dropped (waited past the pause, past the cap, or cancelled): for the tests and diagnostics. */
  dropped = 0;

  constructor(private readonly max = 2, private readonly knobs: PartMixKnobs = PART_MIX_KNOBS) {}

  get size(): number { return this.waiting.length; }

  /** A shape asked for while she speaks: it waits (`now` in seconds). */
  push(item: T, now: number): void {
    this.waiting.push({ item, since: now, quietSince: null });
    while (this.waiting.length > Math.max(1, this.max)) { this.waiting.shift(); this.dropped++; }
  }

  /**
   * One frame at `now` (seconds). Returns the shape to start now (closedMouthMayStart said yes), or null. A shape whose pause began more than
   * closedMouthDropS ago without it starting (she stopped, but a touch or another owner kept her mouth), or that waited past
   * closedMouthMaxWaitS, is dropped. A pause is "quiet": not speaking and not mid-sentence; speaking again restarts the count.
   */
  frame(now: number, world: ClosedMouthWorld): T | null {
    if (!this.waiting.length) return null;
    const quiet = !world.held && !world.sentenceOpen;
    const kept: Waiting<T>[] = [];
    for (const entry of this.waiting) {
      if (quiet) entry.quietSince ??= now; else entry.quietSince = null;
      const late = entry.quietSince !== null && now - entry.quietSince > this.knobs.closedMouthDropS;
      if (late || now - entry.since > this.knobs.closedMouthMaxWaitS) { this.dropped++; continue; }
      kept.push(entry);
    }
    this.waiting = kept;
    if (!kept.length || !closedMouthMayStart(world)) return null;
    return this.waiting.shift()!.item;
  }

  /** A cancelled reply (stop, a new reply, an error, a new conversation): nothing waiting plays, ever. */
  cancel(): void { this.dropped += this.waiting.length; this.waiting = []; }
}
