// I-048 step 2: 「和她一起看」 as one running thing. While the user watches together (一起听 and screen sharing both on) it takes a small
// picture from the existing screen sampler every few seconds, compares it with the last one described (shared/behaviors/watch-timeline/
// frame-change.ts) and, when the picture changed enough, reserves its place on the timeline at capture time, keeps the screenshot for
// 30 minutes, and asks the small model for a one or two sentence description and keywords. It also feeds the heard words into the
// timeline and, now and then, asks for a summary of the older part. Descriptions, summaries and keywords go to disk per character
// (WatchNotesStore); the heard words and the timeline itself stay in memory.
//
// Nothing here waits for a model on her reply path: `render` is a local read. Everything stops and every pending job is cancelled
// when watching together, the screen or 一起听 turns off, the character changes, or the user refuses ("别看", `refuse`). Late or stale
// results are dropped (the ticket generation and the planner's epoch). No timers here: the host calls `tick` every second (tests
// call it with a fake clock). Counts and timings only go to the developer panel and the experience journal, never text or pictures.

import { HaikuPlanner } from '../../shared/behaviors/watch-timeline/scheduler';
import { FrameGate } from '../../shared/behaviors/watch-timeline/frame-change';
import { WatchTimeline, type CompactPlan, type RenderedTimeline } from '../../shared/behaviors/watch-timeline/timeline';
import type { HaikuJob, SeenTicket } from '../../shared/behaviors/watch-timeline/interface';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../../shared/behaviors/watch-timeline/knobs';
import { WATCH_FRAME_SYSTEM_PROMPT, WATCH_SUMMARY_SYSTEM_PROMPT, parseFrameReply, parseSummaryReply, watchFramePrompt, watchSummaryPrompt, type WatchReply }
  from '../../shared/behaviors/watch-timeline/prompts';
import type { WatchNote, WatchNotesStore } from './store';
import type { ScreenshotCache } from './screenshots';

export interface WatchConditions {
  /** 和她一起看: 一起听 (the words) and screen sharing both on, and no refusal in force. */
  watch: boolean;
  /** Screen sharing on and not refused. */
  screen: boolean;
}

export interface WatchSessionPorts {
  now(): number;
  /** The active character; null while none. */
  characterId(): string | null;
  conditions(): WatchConditions;
  /** One frame from the existing screen sampler (a data URL), or null. Only called while watching together. */
  capture(signal: AbortSignal): Promise<string | null>;
  /** Makes the small grayscale thumbnail for the change gate and the small picture the model looks at (and the cache keeps). */
  prepare(dataUrl: string): { thumb: Uint8Array; picture: string } | null;
  /** The brain: one tool-less small-model call with the picture inline (electron/inner-loop/model.ts quickLineWithClaude). */
  describe(picture: string, prompt: string, system: string, signal: AbortSignal): Promise<string>;
  /** The brain: one tool-less small-model call, text only. */
  summarize(prompt: string, system: string, signal: AbortSignal): Promise<string>;
  notes: Pick<WatchNotesStore, 'add' | 'forget'>;
  screenshots: Pick<ScreenshotCache, 'put' | 'remove' | 'sweep' | 'stats'>;
  /** A note reached the disk (the keyword recall's text lookup learns it). */
  kept?(characterId: string, note: WatchNote): void;
  createId?(): string;
  knobs?: WatchTimelineKnobs;
}

export interface WatchSessionStats {
  /** Pictures taken from the sampler / dropped because watching had ended meanwhile. */
  sampled: number; droppedCapture: number;
  /** Frames the gate let through / turned away (not changed enough, too soon, same as before). */
  gatePassed: number; gateRefused: number;
  /** Turned away by the hourly budget or the queue. */
  budgetRefused: number;
  framesDescribed: number; framesEmpty: number; framesInvalid: number; framesFailed: number;
  summaries: number; summariesFailed: number;
  /** Results that arrived after the slot, the watch or the character was gone. */
  droppedLate: number;
  haikuCalls: number; haikuMs: number;
  heard: number;
  cancelled: number;
  swept: number;
}
export const emptyWatchStats = (): WatchSessionStats => ({ sampled: 0, droppedCapture: 0, gatePassed: 0, gateRefused: 0, budgetRefused: 0, framesDescribed: 0, framesEmpty: 0,
  framesInvalid: 0, framesFailed: 0, summaries: 0, summariesFailed: 0, droppedLate: 0, haikuCalls: 0, haikuMs: 0, heard: 0, cancelled: 0, swept: 0 });

interface FrameWork { ticket: SeenTicket; id: string; picture: string; at: number; character: string; previous: string | null }

export class WatchSession {
  readonly stats: WatchSessionStats = emptyWatchStats();
  private readonly knobs: WatchTimelineKnobs;
  private readonly timeline: WatchTimeline;
  private readonly planner: HaikuPlanner;
  private readonly gate: FrameGate;
  private readonly frames = new Map<number, FrameWork>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly flying = new Set<Promise<unknown>>();
  private readonly puts = new Map<string, Promise<unknown>>();
  private character: string | null = null;
  private watching = false;
  private sampling: AbortController | null = null;
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private lastCompactCheckAt = Number.NEGATIVE_INFINITY;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private lastDescription: string | null = null;
  private disposed = false;

  constructor(private readonly ports: WatchSessionPorts) {
    this.knobs = ports.knobs ?? WATCH_TIMELINE_KNOBS;
    this.timeline = new WatchTimeline(this.knobs.timeline);
    this.planner = new HaikuPlanner(() => ports.now(), this.knobs.haiku);
    this.gate = new FrameGate(this.knobs.frame);
  }

  /** The whole thing runs (the master knob and the watch-together conditions held at the last look). */
  get active(): boolean { return this.watching; }
  get timelineSize(): number { return this.timeline.size; }
  get planning() { return this.planner.stats; }

  // ---- what the host and the listen core call ----

  /**
   * Every second. Looks at the conditions first (any that ended cancels everything), then, at most every `sampleSeconds`, takes a
   * picture while watching together. Resolves when this tick's own work (the picture and the gate) is done; the model calls it
   * starts run on and are awaited by `settled`.
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const now = this.ports.now();
    const on = this.look();
    this.sweepIfDue(now);
    if (!on) return;
    this.compactIfDue(now);
    if (now - this.lastSampleAt < this.knobs.session.sampleSeconds * 1000 || this.sampling) return;
    this.lastSampleAt = now;
    await this.sample();
  }

  /** A piece of the heard transcript (memory only). Ignored unless watching together. */
  heard(text: string, at: number): void {
    if (this.disposed || !this.look()) return;
    if (this.timeline.addHeard(text, at)) this.stats.heard++;
  }

  /** The user refused looking ("别看"): the pending descriptions are forgotten, and nothing new starts until the refusal ends. */
  refuse(): void {
    this.cancelEverything('refused');
  }

  /** The timeline as the block for her turn, or null when she should not carry one. A local read; never waits for the model. */
  render(characterId: string | null, options: { heard?: boolean } = {}): RenderedTimeline | null {
    if (this.disposed || !characterId || !this.knobs.session.enabled || !this.look() || characterId !== this.character) return null;
    const rendered = this.timeline.render(this.ports.now(), options);
    return rendered.text ? rendered : null;
  }

  /** The character's watch notes, keywords and screenshots go (forget). Also drops what is running for her. */
  async forget(characterId: string): Promise<void> {
    if (this.character === characterId) this.cancelEverything('refused', true);
    await this.ports.notes.forget(characterId).catch(() => undefined);
  }

  /** Quit: everything stops. */
  dispose(): void {
    if (this.disposed) return;
    this.cancelEverything('watch-off', true);
    this.disposed = true;
  }

  /** Waits for the model calls started so far (tests and quit). */
  async settled(): Promise<void> {
    while (this.flying.size) await Promise.allSettled([...this.flying]);
  }

  // ---- conditions ----

  /** Reads the conditions; any that ended cancels what was running. True while watching together. */
  private look(): boolean {
    if (this.disposed) return false;
    const character = this.safe(() => this.ports.characterId(), null);
    const read = this.safe(() => this.ports.conditions(), { watch: false, screen: false });
    const on = this.knobs.session.enabled === true && !!character && read.watch === true && read.screen === true;
    if (this.character !== null && character !== this.character) this.cancelEverything('character', true);
    if (this.watching && !on) this.cancelEverything(!read.watch ? 'watch-off' : 'screen-off', !read.watch || read.screen !== true);
    this.character = character;
    this.watching = on;
    if (on) this.planner.setConditions({ watch: true, screen: true });
    return on;
  }

  private cancelEverything(reason: 'watch-off' | 'screen-off' | 'refused' | 'character', wipe = false): void {
    const cancelled = this.planner.cancelAll();
    if (reason !== 'refused') this.planner.setConditions({ watch: false, screen: false });
    for (const job of cancelled) {
      this.controllers.get(job.id)?.abort();
      this.dropFrame(job.id);
    }
    this.sampling?.abort();
    this.sampling = null;
    this.stats.cancelled += cancelled.length;
    if (wipe) this.timeline.reset(); else this.timeline.cancelPending();
    if (wipe || reason === 'refused') { this.gate.reset(); this.lastDescription = null; }
    this.watching = false;
  }

  /** A cancelled frame's cached screenshot goes too (a refusal or a watch that ended must not leave it behind). */
  private dropFrame(jobId: number): void {
    const work = this.frames.get(jobId);
    this.frames.delete(jobId);
    // After the put finished (the removal is queued behind the pending writes), so a frame cancelled right away does not outlive its refusal.
    if (work) this.track((this.puts.get(work.id) ?? Promise.resolve()).then(() => this.ports.screenshots.remove(work.character, work.id)).catch(() => undefined));
  }

  // ---- frames ----

  private async sample(): Promise<void> {
    const controller = new AbortController();
    this.sampling = controller;
    let dataUrl: string | null = null;
    try { dataUrl = await this.ports.capture(controller.signal); } catch { dataUrl = null; }
    finally { if (this.sampling === controller) this.sampling = null; }
    const at = this.ports.now();
    // The picture is used only if watching together still holds now (it may have ended while the capture ran).
    if (!dataUrl || controller.signal.aborted || !this.look()) { if (dataUrl) this.stats.droppedCapture++; return; }
    this.stats.sampled++;
    const prepared = this.safe(() => this.ports.prepare(dataUrl!), null);
    const character = this.character;
    if (!prepared || !character) return;
    const verdict = this.gate.check(prepared.thumb, at);
    if (!verdict.describe) { this.stats.gateRefused++; return; }
    this.stats.gatePassed++;
    const queued = this.planner.enqueue('frame');
    if (!queued.accepted) { this.stats.budgetRefused++; return; }
    this.gate.commit(prepared.thumb, at);
    const id = (this.ports.createId ?? (() => `f${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`))();
    // The slot is taken at capture time; the screenshot is kept for its short life at the same moment.
    const ticket = this.timeline.reserveSeen(at);
    this.frames.set(queued.job.id, { ticket, id, picture: prepared.picture, at, character, previous: this.lastDescription });
    const put = this.ports.screenshots.put(character, id, prepared.picture, at).catch(() => undefined);
    this.puts.set(id, put);
    this.track(put.finally(() => { if (this.puts.get(id) === put) this.puts.delete(id); }));
    this.pump();
  }

  private compactIfDue(now: number): void {
    if (now - this.lastCompactCheckAt < this.knobs.session.compactCheckSeconds * 1000) return;
    this.lastCompactCheckAt = now;
    if (!this.timeline.compactPlan(now)) return;
    if (this.planner.enqueue('summary').accepted) this.pump();
  }

  private sweepIfDue(now: number): void {
    if (now - this.lastSweepAt < this.knobs.session.sweepMinutes * 60_000) return;
    this.lastSweepAt = now;
    this.track(this.ports.screenshots.sweep().then(count => { this.stats.swept += count; }).catch(() => undefined));
  }

  // ---- the model calls ----

  private pump(): void {
    for (let job = this.planner.next(); job; job = this.planner.next()) this.track(this.run(job));
  }
  private track<T>(promise: Promise<T>): void {
    const tracked = promise.finally(() => { this.flying.delete(tracked); });
    this.flying.add(tracked);
  }

  private async run(job: HaikuJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.knobs.session.describeSeconds * 1000)]);
    try {
      if (job.kind === 'frame') await this.describeFrame(job, signal);
      else if (job.kind === 'summary') await this.summarize(job, signal);
    } catch { /* A failed call is just no description. */ }
    finally {
      this.controllers.delete(job.id);
      this.frames.delete(job.id);
      this.planner.finish(job);
      this.pump();
    }
  }

  private async call<T>(make: () => Promise<T>): Promise<{ value: T } | null> {
    const started = this.ports.now();
    this.stats.haikuCalls++;
    try { return { value: await make() }; }
    catch { return null; }
    finally { this.stats.haikuMs += Math.max(0, this.ports.now() - started); }
  }

  private async describeFrame(job: HaikuJob, signal: AbortSignal): Promise<void> {
    const work = this.frames.get(job.id);
    if (!work) return;
    const answer = await this.call(() => this.ports.describe(work.picture, watchFramePrompt(work.previous), WATCH_FRAME_SYSTEM_PROMPT, signal));
    // Late or cancelled: the slot may be gone, the watch may have ended, the character may have changed.
    if (!this.planner.isCurrent(job)) { this.stats.droppedLate++; return; }
    if (!answer || signal.aborted) { this.timeline.failSeen(work.ticket); this.stats.framesFailed++; return; }
    const reply = parseFrameReply(answer.value);
    if (!reply) { this.timeline.failSeen(work.ticket); this.stats.framesInvalid++; return; }
    if (!reply.text) { this.timeline.fillSeen(work.ticket, '', this.ports.now()); this.stats.framesEmpty++; return; }
    if (!this.timeline.fillSeen(work.ticket, reply.text, this.ports.now())) { this.stats.droppedLate++; return; }
    this.stats.framesDescribed++;
    this.lastDescription = reply.text;
    await this.keep(work.character, 'frame', work.id, work.at, reply);
  }

  private async summarize(job: HaikuJob, signal: AbortSignal): Promise<void> {
    const plan: CompactPlan | null = this.timeline.compactPlan(this.ports.now());
    if (!plan) return;
    const character = this.character;
    if (!character) return;
    const lines = plan.entries.filter(entry => !entry.pending).map(entry => entry.text);
    const answer = await this.call(() => this.ports.summarize(watchSummaryPrompt(plan.entries), WATCH_SUMMARY_SYSTEM_PROMPT, signal));
    if (!this.planner.isCurrent(job)) { this.stats.droppedLate++; return; }
    const reply = answer && !signal.aborted ? parseSummaryReply(answer.value, lines) : null;
    if (!reply) { this.stats.summariesFailed++; return; }
    if (!this.timeline.applySummary(plan, reply.text, this.ports.now())) { this.stats.droppedLate++; return; }
    this.stats.summaries++;
    await this.keep(character, 'summary', `s${plan.upTo.toString(36)}${Math.random().toString(36).slice(2, 6)}`, plan.upTo, reply);
  }

  private async keep(character: string, kind: 'frame' | 'summary', id: string, at: number, reply: WatchReply): Promise<void> {
    const note = { id, kind, at, text: reply.text, keywords: reply.keywords };
    try { if (await this.ports.notes.add(character, note)) this.ports.kept?.(character, note); } catch { /* The timeline still has it. */ }
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
}
