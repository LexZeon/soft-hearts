// The part runner (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md sections 2 and 3; docs/claude/2026-11-16-wiring-step-3.md;
// isolation: step 7, docs/claude/2026-11-17-isolation-step7.md). Each part's wiring (electron/wiring/<part>-wiring.ts) returns a PartHandle with
// its units (one per createX) and its core units; electron/main.ts declares every handle to the runner (add) and hands the runner to the
// wiring (useRunner). Work of a unit is run through it: a ready-chain start (startUnit / startUnitSync), a clock entry (tickUnit), an event
// callback or a step of an ordered list (unitStep), a cleanup step (cleanupStep).
//
// Two modes.
// - strict (the rewrite, steps 3 to 6): a failure is what it was before the rewrite. Nothing is caught, counted or switched off.
// - isolate (step 7, the app's mode): a unit that is not core is switched off alone when its start throws, or when its ticks or callbacks
//   throw 3 times in a row (a success in between starts the count again). Off: its ticks and callbacks are skipped, its desk: handlers
//   answer PART_OFF (electron/wiring/ipc-wiring.ts partIpc; the agent channel reuses the same handler, so its operation fails the same
//   way), and the reason keeps only a category and error.name, never the message. A cleanup step always runs (releasing a camera or
//   a microphone must never be skipped); its error is caught and counted, and the next step runs. IPC errors never count (many are
//   deliberate validation failures).
// - Core units (a part's `core`, a part the runner was not told about, a unit the part did not declare) are never switched off: their
//   failure is fatal exactly as before (the ready chain's 「soft hearts 启动失败」 dialog, a throw out of the clock or the callback).
// SOFT_HEARTS_FAIL_PART=<part>:<unit> (failPartRequest: only when not packaged and in a temporary profile) makes that unit's first run
// throw, for tests and the pretrial.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import path from 'node:path';
import type { PartIpc } from './ipc-wiring';
import type { PartHealthView, PartOffView } from '../../shared/foundation/ports';

export type PartRunnerMode = 'strict' | 'isolate';
/** What a switched-off unit's desk: handlers answer (and the agent channel's same operation). */
export const PART_OFF = 'PART_OFF';
/** How many failures in a row switch a unit off from its ticks or callbacks. */
export const PART_FAILURES_TO_OFF = 3;

/** A switched-off unit's handler throws this: the message is PART_OFF and where, nothing of the failure itself. */
export class PartOffError extends Error {
  readonly code = PART_OFF;
  constructor(readonly part: string, readonly unit: string) {
    super(`${PART_OFF} ${part}/${unit}`);
    this.name = 'PartOffError';
  }
}
/** SOFT_HEARTS_FAIL_PART's failure: what a unit's run throws once when it was asked to fail. */
export class InjectedPartFailure extends Error {
  constructor() { super('SOFT_HEARTS_FAIL_PART'); this.name = 'InjectedPartFailure'; }
}

/** What one part's wiring hands back (plan section 2). */
export interface PartHandle<P = unknown> {
  readonly id: string;
  /** The part's units (one per createX): what isolation can switch off alone. */
  readonly units: readonly string[];
  /** Units isolation must never switch off: their failure stays fatal (plan section 3: the help card, the stage core, ...). */
  readonly core?: readonly string[];
  /** Which unit each desk: handler belongs to (unit → methods): a handler of a switched-off unit answers PART_OFF. Unlisted: always answered. */
  readonly ipc?: Readonly<Record<string, readonly string[]>>;
  /** Runs while electron/main.ts is evaluated, where the old module-level code ran. */
  early?(): void;
  /** Runs in the ready chain, where the old code ran. */
  start?(): Promise<void> | void;
  /** Registers the part's desk: handlers (inside the agent channel's recorder when the old ones were). */
  register?(ipc: PartIpc): void;
  /** Before-quit, where the old code ran. */
  quit?(): void;
  flush?(): Promise<void>;
  /** What other parts and the wiring use from this part. */
  readonly provides: P;
}
/** What the runner needs to know of a part (a handle is one; a part without a handle declares just this). */
export type PartDeclaration = Pick<PartHandle, 'id' | 'units' | 'core' | 'ipc'>;

/** One unit that was switched off (the journal's part-off line and the notices read it). */
export interface PartOffEntry extends PartOffView {}

export interface PartRunnerOptions {
  readonly mode: PartRunnerMode;
  /** Called once for each unit switched off: the journal line, the notices. Its own failure is ignored. */
  readonly onOff?: (entry: PartOffEntry) => void;
  /** A failure's line for the developer log; `error` is the failure itself (the caller decides whether to print more than the line). */
  readonly log?: (line: string, error: unknown) => void;
  /** SOFT_HEARTS_FAIL_PART, already checked by failPartRequest. */
  readonly inject?: { readonly part: string; readonly unit: string } | null;
  readonly now?: () => number;
}

export interface PartRunner {
  readonly mode: PartRunnerMode;
  /** Tells the runner a part's units, core units and handlers (electron/main.ts, once per part, before its work runs). */
  add(part: PartDeclaration): void;
  early(part: PartHandle): void;
  start(part: PartHandle): Promise<void>;
  /** A ready-chain step of a unit, awaited. Isolate: a unit that is not core and throws is switched off; the result is then undefined. */
  startUnit<T>(part: string, unit: string, run: () => Promise<T> | T): Promise<T | undefined>;
  /** The same for a step that runs synchronously (so the ready chain's timing does not change). */
  startUnitSync<T>(part: string, unit: string, run: () => T): T | undefined;
  /** A clock entry or a timer of a unit. Isolate: skipped while the unit is off; a throw is counted. */
  tick<T>(part: PartHandle | string, unit: string, run: () => T): T | undefined;
  /** An event callback of a unit. Strict: the same function. Isolate: skipped while off; a throw is counted. */
  callback<A extends unknown[], R>(part: PartHandle | string, unit: string, fn: (...args: A) => R): (...args: A) => R | undefined;
  /** A cleanup step of a unit: always runs, even while the unit is off. Isolate: a throw is caught and counted, the caller goes on. */
  cleanup<A extends unknown[], R>(part: string, unit: string, fn: (...args: A) => R): (...args: A) => R | undefined;
  /** Step 8: the ready chain's starts are over (registerQuit, the last registration): an injected failure now reaches every tick and callback. */
  startsDone(): void;
  /** Whether a unit is switched off (never in strict mode). */
  isOff(part: string, unit: string): boolean;
  /** The first of these units that is off, or null. */
  firstOff(units: readonly { readonly part: string; readonly unit: string }[]): PartOffEntry | null;
  /** The unit a part's desk: handler belongs to, or null (always answered). */
  unitOf(part: string, method: string): string | null;
  /** A unit's desk: handlers (its PartHandle `ipc`). */
  methodsOf(part: string, unit: string): readonly string[];
  health(): PartHealthView;
  /** Called after each change of health(); returns the unsubscribe. */
  onHealth(listener: (view: PartHealthView) => void): () => void;
}

/** error.name when it is a plain identifier, else a fixed word: never the message, never text a caller wrote. */
export function failureName(error: unknown): string {
  if (!(error instanceof Error)) return 'NonError';
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'Error';
}

export function createPartRunner(options: PartRunnerOptions): PartRunner {
  const { mode } = options;
  if (mode !== 'strict' && mode !== 'isolate') throw new Error(`Part runner mode ${String(mode)} is not known.`);
  const now = options.now ?? Date.now;
  const declared = new Map<string, PartDeclaration>();
  const started = new Set<string>();
  const failures = new Map<string, number>();
  const off = new Map<string, PartOffEntry>();
  const listeners = new Set<(view: PartHealthView) => void>();
  let inject = options.inject ?? null;
  const key = (part: string, unit: string) => `${part}\u0000${unit}`;
  const idOf = (part: PartHandle | string) => (typeof part === 'string' ? part : part.id);
  /** Core: declared core, or anything the runner was not told about (the safe default: fatal as before). */
  const isCore = (part: string, unit: string): boolean => {
    const p = declared.get(part);
    return !p || !p.units.includes(unit) || !!p.core?.includes(unit);
  };
  const isolating = (part: string, unit: string) => mode === 'isolate' && !isCore(part, unit);
  const health = (): PartHealthView => ({ mode, started: [...started], off: [...off.values()] });
  const publish = () => { const view = health(); for (const listener of [...listeners]) { try { listener(view); } catch { /* a listener never stops the others */ } } };
  const switchOff = (part: string, unit: string, category: PartOffEntry['category'], error: unknown) => {
    if (off.has(key(part, unit))) return;
    const errorName = failureName(error);
    const entry: PartOffEntry = { part, unit, category, when: category === 'start' ? 'start' : 'running', reason: `${category}:${errorName}`, at: now() };
    off.set(key(part, unit), entry);
    options.log?.(`[parts] ${part}/${unit} switched off (${entry.reason})`, error);
    try { options.onOff?.(entry); } catch { /* the journal or a notice failing never undoes the switch-off */ }
    publish();
  };
  /** SOFT_HEARTS_FAIL_PART: every run of that unit throws (its start once; a tick or callback each time, so it is off after three). */
  const injected = (part: string, unit: string) => {
    if (inject && inject.part === part && inject.unit === unit) throw new InjectedPartFailure();
  };
  // Step 8: the windows load while the parts start, so a unit's callbacks (a window event's step, the mood publish) may run before its own
  // start. An injected failure stands for a unit broken from its start: its ticks and callbacks fail only once its start was tried, or
  // once the ready chain's starts are over (startsDone; a unit with no start then fails on its third tick or callback, as before).
  const triedStart = new Set<string>();
  let startsOver = false;
  const injectedLater = (part: string, unit: string) => { if (startsOver || triedStart.has(key(part, unit))) injected(part, unit); };
  /** A failure of a tick or a callback: counted; the third in a row switches the unit off. */
  const failed = (part: string, unit: string, category: 'tick' | 'callback', error: unknown) => {
    const count = (failures.get(key(part, unit)) ?? 0) + 1;
    failures.set(key(part, unit), count);
    if (count >= PART_FAILURES_TO_OFF) switchOff(part, unit, category, error);
    else options.log?.(`[parts] ${part}/${unit} ${category} failed (${failureName(error)}, ${count} in a row)`, error);
  };
  const succeeded = (part: string, unit: string) => { if (failures.get(key(part, unit))) failures.set(key(part, unit), 0); };
  const guarded = <A extends unknown[], R>(part: string, unit: string, category: 'tick' | 'callback', fn: (...args: A) => R, always: boolean) =>
    (...args: A): R | undefined => {
      if (!isolating(part, unit)) return fn(...args);
      if (!always && off.has(key(part, unit))) return undefined;
      try {
        injectedLater(part, unit);
        const result = fn(...args);
        // A cleanup step that returns a promise (a flush) is awaited by its list: its rejection is caught and counted the same way.
        if (always && result && typeof (result as { then?: unknown }).then === 'function')
          return (result as unknown as Promise<unknown>).then(value => { succeeded(part, unit); return value; },
            error => { failed(part, unit, category, error); return undefined; }) as R;
        succeeded(part, unit);
        return result;
      } catch (error) {
        failed(part, unit, category, error);
        return undefined;
      }
    };
  return {
    mode,
    add(part) {
      declared.set(part.id, part);
      if (inject && inject.part === part.id && isCore(part.id, inject.unit)) {
        options.log?.(`[parts] SOFT_HEARTS_FAIL_PART ${inject.part}:${inject.unit} ignored: not a unit that can be switched off`, null);
        inject = null;
      }
    },
    early(part) { part.early?.(); },
    async start(part) {
      await part.start?.();
      started.add(part.id);
    },
    async startUnit(part, unit, run) {
      triedStart.add(key(part, unit));
      if (!isolating(part, unit)) return await run();
      try {
        injected(part, unit);
        return await run();
      } catch (error) {
        switchOff(part, unit, 'start', error);
        return undefined;
      }
    },
    startUnitSync(part, unit, run) {
      triedStart.add(key(part, unit));
      if (!isolating(part, unit)) return run();
      try {
        injected(part, unit);
        return run();
      } catch (error) {
        switchOff(part, unit, 'start', error);
        return undefined;
      }
    },
    tick(part, unit, run) { return guarded(idOf(part), unit, 'tick', run, false)(); },
    callback(part, unit, fn) { return mode === 'strict' ? fn : guarded(idOf(part), unit, 'callback', fn, false); },
    cleanup(part, unit, fn) { return mode === 'strict' ? fn : guarded(part, unit, 'callback', fn, true); },
    startsDone() { startsOver = true; },
    isOff(part, unit) { return off.has(key(part, unit)); },
    firstOff(units) {
      for (const { part, unit } of units) { const entry = off.get(key(part, unit)); if (entry) return entry; }
      return null;
    },
    unitOf(part, method) {
      const ipc = declared.get(part)?.ipc;
      if (!ipc) return null;
      for (const [unit, methods] of Object.entries(ipc)) if (methods.includes(method)) return unit;
      return null;
    },
    methodsOf(part, unit) { return declared.get(part)?.ipc?.[unit] ?? []; },
    health,
    onHealth(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

// ---- the app's runner, for the wiring files ------------------------------------------------------------------------------------
// electron/main.ts makes one runner and hands it here (useRunner) before any wire call; until then (and in tests that never set one)
// every helper below runs its function as is, which is strict mode. scripts/dev/wiring-golden.mjs reads a call to one of these helpers as
// the function it is given, so wrapping a step never changes the golden's order lists.

let appRunner: PartRunner | null = null;

/** electron/main.ts: the app's runner, once, while it is evaluated. */
export function useRunner(runner: PartRunner | null): void { appRunner = runner; }
/** The app's runner (null before useRunner). */
export function partRunner(): PartRunner | null { return appRunner; }

/** A ready-chain step of a unit, awaited: `await startUnit('mood', 'reactions', () => reactions.load())`. */
export function startUnit<T>(part: string, unit: string, run: () => Promise<T> | T): Promise<T | undefined> {
  return appRunner ? appRunner.startUnit(part, unit, run) : (async () => await run())();
}
/** A synchronous ready-chain step of a unit: runs now, as the old line did. */
export function startUnitSync<T>(part: string, unit: string, run: () => T): T | undefined {
  return appRunner ? appRunner.startUnitSync(part, unit, run) : run();
}
/** A clock entry of a unit (electron/wiring/clock-wiring.ts). */
export function tickUnit<T>(part: string, unit: string, run: () => T): T | undefined {
  return appRunner ? appRunner.tick(part, unit, run) : run();
}
/** An event callback of a unit; the runner is read when it is called, so a callback made before useRunner is guarded too. */
export function unitCallback<A extends unknown[], R>(part: string, unit: string, fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => (appRunner ? appRunner.callback(part, unit, fn)(...args) : fn(...args));
}
/** A cleanup step of a unit: always runs; isolate: its throw is caught and counted (the steps after it still run). */
export function cleanupUnit<A extends unknown[], R>(part: string, unit: string, fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => (appRunner ? appRunner.cleanup(part, unit, fn)(...args) : fn(...args));
}

// ---- the ordered step lists' steps (window events, before-quit, sync, the mood publish) -----------------------------------------
// electron/wiring/steps-wiring.ts says which unit each step belongs to (unitSteps, called by wireHealth before any list is used); the
// wire function of each list keeps `stepAs(step, kind)` in place of the step, which looks its unit up when it runs. A step of no unit (the
// trunk's, a core unit's) runs as it is. The lists' order and their text in electron/main.ts do not change (the wiring golden reads them).

type AnyStep = (...args: any[]) => unknown;
let stepUnitTable: Map<AnyStep, { part: string; unit: string }> | null = null;
/** These steps belong to that unit. */
export function unitSteps(part: string, unit: string, ...steps: readonly AnyStep[]): void {
  stepUnitTable ??= new Map();
  for (const step of steps) stepUnitTable.set(step, { part, unit });
}
/** The unit a step belongs to, or null. */
export function stepUnitOf(step: AnyStep): { part: string; unit: string } | null {
  return stepUnitTable?.get(step) ?? null;
}
/**
 * A list's step, run through the runner as its unit's: 'cleanup' (a window's or the quit's release: always runs; isolate: its throw, or its
 * promise's rejection, is caught and counted, and the next step runs) or 'callback' (sync, the mood publish: skipped while the unit is off).
 */
export function stepAs<S extends AnyStep>(step: S, kind: 'cleanup' | 'callback'): S {
  return ((...args: Parameters<S>) => {
    const owner = stepUnitOf(step);
    if (!owner || !appRunner) return step(...args);
    return kind === 'cleanup' ? appRunner.cleanup(owner.part, owner.unit, step)(...args) : appRunner.callback(owner.part, owner.unit, step)(...args);
  }) as S;
}

/**
 * SOFT_HEARTS_FAIL_PART=<part>:<unit>, honoured only when the app is not packaged and its profile folder is inside the system temporary
 * folder (an isolated temporary profile: tests and the pretrial). Anything else: null (the variable is ignored).
 */
export function failPartRequest(env: Readonly<Record<string, string | undefined>>, at: { packaged: boolean; profile: string; temp: string }): { part: string; unit: string } | null {
  const raw = env.SOFT_HEARTS_FAIL_PART?.trim();
  if (!raw || at.packaged) return null;
  const match = /^([a-z][a-z-]{0,39}):([a-z][a-z0-9-]{0,39})$/.exec(raw);
  if (!match) return null;
  const profile = path.resolve(at.profile), temp = path.resolve(at.temp);
  const inside = path.relative(temp, profile);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return { part: match[1], unit: match[2] };
}
