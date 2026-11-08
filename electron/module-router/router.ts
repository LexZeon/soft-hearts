import { MODULE_ROUTER_KNOBS, type ModuleRouterKnobs } from '../../shared/module-router/knobs';
import { ROUTED_MODULES } from '../../shared/module-router/modules';
import { ROUTER_SYSTEM_PROMPT, parseRouterAnswer, routerPlan, routerPrompt, routerVerdictFor } from '../../shared/module-router/choose';
import type { ModuleRouterWhy, RoutedModule, RouterAnswer, RouterAnswerStatus, RouterCall, RouterDecision, RouterSkip,
  RouterVerdict } from '../../shared/module-router/interface';
import type { RouterAsk } from '../../shared/module-router/fake';

export interface RouterTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface ModuleRouterOptions {
  /** The small model's one short call (electron/inner-loop/model.ts quickLineWithClaude, its text). */
  ask: RouterAsk;
  /** Claude answers now (electron/chat-availability.ts): otherwise nobody is asked. */
  available(): boolean;
  /** Only then is anything kept for the developer panel (memory only). */
  developerMode(): boolean;
  /** The panel's line changed (developer mode only). */
  changed?(): void;
  /** Default: shared/module-router/modules.ts. Tests pass their own (a fake module shows up in haiku's list). */
  registry?: readonly RoutedModule[];
  knobs?: Partial<ModuleRouterKnobs>;
  clock?: () => number;
  timers?: RouterTimers;
  /** The local date key for the day's call count. */
  localDate?(ms: number): string;
}

interface WhyRecord {
  requestId: string;
  at: number;
  asked: string[];
  skipped: RouterSkip | null;
  local: { module: string; kind: 'called' | 'refused' }[];
  answer: { status: RouterAnswerStatus | 'pending'; called: RouterCall[]; ms: number | null } | null;
  decisions: { module: string; by: RouterDecision['by']; action: string }[];
}
interface Turn {
  readonly requestId: string;
  readonly startedAt: number;
  /** Module ids haiku was asked about. */
  readonly asked: readonly string[];
  /** Why each registered module was not asked (local, prefilter, unavailable…). */
  readonly skips: ReadonlyMap<string, RouterSkip>;
  answer: RouterAnswer | null;
  readonly settled: Promise<RouterAnswer | null>;
  resolve(answer: RouterAnswer | null): void;
  controller: AbortController | null;
  timeout: unknown;
  /** The delayed start of haiku's call, until it fires. */
  starting: unknown;
  why: WhyRecord | null;
}

const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * I-023 haiku 调度台, host side (shared/module-router/interface.ts has the contract).
 *
 * One user message at a time: userTurn starts haiku's one call in the background and returns at once, so Opus's first
 * character never waits for it. A newer message aborts the call still running and voids its answer. Modules ask
 * verdict() after her reply; errors, timeouts and malformed answers are `unknown` (the module keeps its local rules).
 * Nothing here stores the user's words: the developer panel's record holds module names, verdicts and times only.
 */
export class ModuleRouter {
  private turn: Turn | null = null;
  private readonly whys: WhyRecord[] = [];
  private calls = { date: '', count: 0 };
  private notifyHandle: unknown = null;
  private disposed = false;
  private readonly registry: readonly RoutedModule[];
  private readonly knobs: ModuleRouterKnobs;
  private readonly clock: () => number;
  private readonly timers: RouterTimers;
  /** Counts for tests and the record. */
  readonly stats = { asked: 0, answered: 0, failed: 0, superseded: 0 };

  constructor(private readonly options: ModuleRouterOptions) {
    this.registry = options.registry ?? ROUTED_MODULES;
    this.knobs = { ...MODULE_ROUTER_KNOBS, ...options.knobs };
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /**
   * A user message (the same text Opus gets). Returns at once: haiku, when asked at all, runs in the background.
   * Any earlier message's call is aborted and its answer voided.
   */
  userTurn(requestId: string, text: unknown): void {
    if (this.disposed) return;
    this.supersede();
    const now = this.clock();
    const plan = routerPlan(this.registry, text, this.knobs);
    let skipped: RouterSkip | null = plan.skipped;
    if (!skipped && !this.safe(() => this.options.available(), false)) skipped = 'unavailable';
    if (!skipped && !this.quotaLeft(now)) skipped = 'quota';
    const asked = skipped ? [] : [...plan.asked];
    const skips = new Map<string, RouterSkip>();
    for (const entry of this.registry) {
      const local = plan.local.find(item => item.module === entry.id);
      if (local) skips.set(entry.id, 'local');
      else if (!asked.includes(entry.id)) skips.set(entry.id, skipped ?? 'prefilter');
    }
    let resolve!: (answer: RouterAnswer | null) => void;
    const settled = new Promise<RouterAnswer | null>(done => { resolve = done; });
    const turn: Turn = { requestId, startedAt: now, asked, skips, answer: null, settled, resolve, controller: null, timeout: null, starting: null, why: null };
    this.turn = turn;
    if (this.safe(() => this.options.developerMode(), false)) {
      turn.why = { requestId, at: now, asked: asked.map(id => this.name(id)), skipped, local: plan.local.map(item => ({ module: this.name(item.module), kind: item.kind })),
        answer: asked.length ? { status: 'pending', called: [], ms: null } : null, decisions: [] };
      this.whys.unshift(turn.why);
      this.whys.length = Math.min(this.whys.length, Math.max(1, this.knobs.whyKept));
      this.notify();
    }
    if (!asked.length) { resolve(null); return; }
    const controller = new AbortController();
    turn.controller = controller;
    turn.timeout = this.timers.set(() => this.finish(turn, 'timeout'), Math.max(0, this.knobs.timeoutMs));
    // The whole list (it helps haiku tell modules apart); only the asked modules' verdicts are used.
    const prompt = routerPrompt(this.registry, String(text).trim());
    // Started knobs.startDelayMs later, on a timer: the chat handler that called this returns first, and the Opus turn is written out
    // before haiku's process start holds the main thread (~20 ms measured on this machine). Never awaited by the chat turn.
    turn.starting = this.timers.set(() => {
      turn.starting = null;
      if (controller.signal.aborted || this.disposed) return;
      this.noteCall(this.clock());
      this.stats.asked++;
      let call: Promise<string>;
      try { call = Promise.resolve(this.options.ask(prompt, ROUTER_SYSTEM_PROMPT, controller.signal)); } catch { this.finish(turn, 'error'); return; }
      void call.then(raw => {
        const called = parseRouterAnswer(raw, this.registry);
        this.finish(turn, called ? 'answered' : 'bad-json', called ?? []);
      }, () => { this.finish(turn, 'error'); });
    }, Math.max(0, this.knobs.startDelayMs));
  }

  /**
   * One module's verdict for message `requestId`: as soon as haiku answered (or failed, timed out, was voided by a newer
   * message), waiting at most `waitMs` from now (default knobs.graceAfterReplyMs); past that it is `unknown` ('late').
   */
  verdict(requestId: string, moduleId: string, waitMs = this.knobs.graceAfterReplyMs): Promise<RouterVerdict> {
    const turn = this.turn;
    if (this.disposed || !turn || turn.requestId !== requestId) return Promise.resolve({ kind: 'unknown', reason: 'other-turn' });
    if (!turn.asked.includes(moduleId)) return Promise.resolve({ kind: 'unknown', reason: turn.skips.get(moduleId) ?? 'prefilter' });
    const read = (answer: RouterAnswer | null): RouterVerdict => answer ? routerVerdictFor(answer, moduleId, this.knobs.minConfidence) : { kind: 'unknown', reason: 'error' };
    if (turn.answer) return Promise.resolve(read(turn.answer));
    return new Promise<RouterVerdict>(done => {
      let over = false;
      const handle = this.timers.set(() => { if (over) return; over = true; done({ kind: 'unknown', reason: 'late' }); }, Math.max(0, waitMs));
      void turn.settled.then(answer => { if (over) return; over = true; this.timers.clear(handle); done(read(answer)); });
    });
  }

  /** The module's final call for this message ("最后谁说了算"), for the developer panel. */
  decided(requestId: string, moduleId: string, decision: RouterDecision): void {
    const why = this.whys.find(item => item.requestId === requestId);
    if (!why) return;
    const module = this.name(moduleId);
    why.decisions = why.decisions.filter(item => item.module !== module);
    why.decisions.push({ module, by: decision.by, action: String(decision.action).slice(0, 40) });
    this.notify();
  }

  /** The developer panel's lines, newest first (copies; developer mode only, memory only). */
  recent(): readonly ModuleRouterWhy[] {
    if (!this.safe(() => this.options.developerMode(), false)) return [];
    return this.whys.map(({ requestId: _id, ...why }) => structuredClone(why));
  }

  dispose(): void {
    if (this.disposed) return;
    this.supersede();
    this.disposed = true;
    if (this.notifyHandle !== null) { this.timers.clear(this.notifyHandle); this.notifyHandle = null; }
    this.turn = null;
    this.whys.length = 0;
  }

  // ------------------------------------------------------------

  private name(id: string): string { return this.registry.find(entry => entry.id === id)?.name ?? id; }

  private supersede(): void {
    const turn = this.turn;
    // Only a message haiku was asked about has a call to stop (one that was not asked keeps "没问" in the record).
    if (turn && !turn.answer && turn.controller) { this.finish(turn, 'superseded'); this.stats.superseded++; }
  }

  private finish(turn: Turn, status: RouterAnswerStatus, called: readonly RouterCall[] = []): void {
    if (turn.answer) return; // The first result counts; a late one changes nothing.
    turn.answer = { status, called: status === 'answered' ? called : [], ms: Math.max(0, this.clock() - turn.startedAt) };
    if (turn.timeout !== null) { this.timers.clear(turn.timeout); turn.timeout = null; }
    if (turn.starting !== null) { this.timers.clear(turn.starting); turn.starting = null; } // Voided before it started: no call at all.
    if (status !== 'answered' && turn.controller && !turn.controller.signal.aborted) turn.controller.abort();
    if (status === 'answered') this.stats.answered++; else if (status !== 'superseded') this.stats.failed++;
    if (turn.why) {
      turn.why.answer = { status, called: turn.answer.called.map(item => ({ module: this.name(item.module), confidence: item.confidence })), ms: turn.answer.ms };
      this.notify();
    }
    turn.resolve(turn.answer);
  }

  private quotaLeft(now: number): boolean {
    const today = (this.options.localDate ?? localDay)(now);
    if (this.calls.date !== today) this.calls = { date: today, count: 0 };
    return this.calls.count < this.knobs.callsPerDay;
  }
  private noteCall(now: number): void {
    const today = (this.options.localDate ?? localDay)(now);
    if (this.calls.date !== today) this.calls = { date: today, count: 0 };
    this.calls.count++;
  }

  /** The panel hears about it on a later tick (coalesced): userTurn runs inside the chat handler and never does panel work there. */
  private notify(): void {
    if (this.disposed || this.notifyHandle !== null || !this.options.changed) return;
    this.notifyHandle = this.timers.set(() => {
      this.notifyHandle = null;
      if (this.disposed) return;
      try { this.options.changed?.(); } catch { /* The panel line never disturbs a chat turn. */ }
    }, 0);
  }
}
