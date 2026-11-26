/**
 * How long entering Unbound waits for her to appear (docs/claude/2026-11-19-unbound-entry-load.md). Was a flat 20 s from the
 * window's creation. Measured: the model itself loads in about 1.5 s even on a busy machine; what can take long is her (hidden)
 * window's page starting at all when the processor is saturated (13 s, 18 s, 32 s, over 60 s seen). Now the page reports how far its
 * load has got (src/unbound/load-progress.ts → `unbound:loading`) and the wait follows it:
 *  - FIRST: up to 45 s for the page to start (its first report);
 *  - QUIET: after that, 20 s without a forward step (a later step, or more bytes of the same file) ends the attempt;
 *  - CAP: 90 s in all ends it however it is going (a load that crawls, a page that keeps reporting the same thing).
 * A report that is not forward (the same step again, fewer bytes, a step back) extends nothing.
 * Pure: the host (electron/unbound/host.ts) feeds it the clock and the reports; the messages are the user's (Chinese).
 */

export const ENTRY_FIRST_MS = 45_000;
export const ENTRY_QUIET_MS = 20_000;
export const ENTRY_CAP_MS = 90_000;
export interface EntryLimits { firstMs: number; quietMs: number; capMs: number }
export const ENTRY_LIMITS: Readonly<EntryLimits> = Object.freeze({ firstMs: ENTRY_FIRST_MS, quietMs: ENTRY_QUIET_MS, capMs: ENTRY_CAP_MS });

/** The page's load, in order. */
export const LOAD_STEPS = Object.freeze(['page', 'model', 'parsed', 'motion', 'textures', 'draw'] as const);
export type LoadStep = typeof LOAD_STEPS[number];
/** What each step is, as the user reads it. */
export const LOAD_STEP_NAMES: Readonly<Record<LoadStep, string>> = Object.freeze({
  page: '打开她的窗口', model: '读模型文件', parsed: '整理模型', motion: '读动作', textures: '读贴图', draw: '第一次画她',
});

export interface LoadProgress { step: LoadStep; loaded?: number; total?: number }

const isStep = (value: unknown): value is LoadStep => typeof value === 'string' && (LOAD_STEPS as readonly string[]).includes(value);
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4e9;

/** A report from the page, read strictly (anything else: null, ignored). */
export function parseLoadProgress(value: unknown): LoadProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'step' && key !== 'loaded' && key !== 'total')) return null;
  if (!isStep(v.step)) return null;
  const out: LoadProgress = { step: v.step };
  if (v.loaded !== undefined) { if (!bytes(v.loaded)) return null; out.loaded = Math.floor(v.loaded); }
  if (v.total !== undefined) { if (!bytes(v.total)) return null; out.total = Math.floor(v.total); }
  return out;
}

export type EntryWaitEnd = { kind: 'first' | 'quiet' | 'cap'; step: LoadStep | null; loaded?: number; total?: number };

export class EntryWait {
  private last: LoadProgress | null = null;
  private lastForwardAt: number;
  constructor(private readonly startedAt: number, private readonly limits: EntryLimits = ENTRY_LIMITS) {
    this.lastForwardAt = startedAt;
  }

  get step(): LoadStep | null { return this.last?.step ?? null; }

  /** A report: true when it is a step forward (the quiet time starts again). */
  progress(report: LoadProgress, now: number): boolean {
    if (this.ended(now)) return false;
    const before = this.last;
    const rank = (step: LoadStep) => LOAD_STEPS.indexOf(step);
    const forward = !before || rank(report.step) > rank(before.step)
      || (report.step === before.step && report.loaded !== undefined && report.loaded > (before.loaded ?? -1));
    if (!forward) return false;
    this.last = { ...report };
    this.lastForwardAt = now;
    return true;
  }

  /** When the wait ends if nothing moves forward before then. */
  deadline(): number {
    const next = this.last ? this.lastForwardAt + this.limits.quietMs : this.startedAt + this.limits.firstMs;
    return Math.min(next, this.startedAt + this.limits.capMs);
  }

  /** Why the wait is over at `now`, or null while it goes on. */
  ended(now: number): EntryWaitEnd | null {
    if (now < this.deadline()) return null;
    const kind = now >= this.startedAt + this.limits.capMs ? 'cap' : this.last ? 'quiet' : 'first';
    const end: EntryWaitEnd = { kind, step: this.last?.step ?? null };
    if (this.last?.loaded !== undefined) end.loaded = this.last.loaded;
    if (this.last?.total !== undefined) end.total = this.last.total;
    return end;
  }
}

const fill = (text: string, params: Record<string, string>) => text.replace(/\{(\w+)\}/g, (whole, key: string) => params[key] ?? whole);
const share = (end: EntryWaitEnd) => end.total && end.loaded !== undefined ? `${Math.min(100, Math.round(100 * end.loaded / end.total))}%` : '';
const seconds = (ms: number) => String(Math.round(ms / 1000));

/** What the user reads when the wait ran out (the developer panel's 「上次没进去」 and the 「她没能出来」 notice). */
export function entryWaitMessage(end: EntryWaitEnd, limits: EntryLimits = ENTRY_LIMITS): string {
  const first = seconds(limits.firstMs), quiet = seconds(limits.quietMs), cap = seconds(limits.capMs);
  if (!end.step) return end.kind === 'cap' ? fill('等了 {cap} 秒，她的窗口还没开始加载（电脑可能太忙了）。', { cap }) : fill('她的窗口 {first} 秒里没有开始加载（电脑可能太忙了）。', { first });
  const step = LOAD_STEP_NAMES[end.step], at = share(end);
  if (end.kind === 'cap') return at ? fill('等了 {cap} 秒她还没出现，停在「{step}」（{at}）。', { cap, step, at }) : fill('等了 {cap} 秒她还没出现，停在「{step}」。', { cap, step });
  return at ? fill('她卡在「{step}」（{at}），{quiet} 秒没有进展（模型没有加载完）。', { step, at, quiet }) : fill('她卡在「{step}」，{quiet} 秒没有进展（模型没有加载完）。', { step, quiet });
}

/**
 * The wait as the host runs it: one timer, moved to the new deadline after each forward report; `onEnd` gets the message once.
 * `report` takes the page's raw value (parsed here). `stop` ends it without a message (she appeared, the entry was cancelled).
 * Unless given, the page gets at least the quiet time to start; the cap is never shorter than the other two (a caller's long
 * times keep their meaning).
 */
export function startEntryWait(onEnd: (message: string) => void, options: Partial<EntryLimits> & { now?: () => number } = {}): { report(value: unknown): boolean; stop(): void } {
  const now = options.now ?? Date.now;
  const quietMs = options.quietMs ?? ENTRY_QUIET_MS, firstMs = options.firstMs ?? Math.max(ENTRY_FIRST_MS, quietMs);
  const limits: EntryLimits = { firstMs, quietMs, capMs: Math.max(options.capMs ?? ENTRY_CAP_MS, firstMs, quietMs) };
  const wait = new EntryWait(now(), limits);
  let timer: ReturnType<typeof setTimeout> | null = null, over = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const end = wait.ended(now());
      if (!end) { arm(); return; }
      over = true;
      onEnd(entryWaitMessage(end, limits));
    }, Math.max(0, wait.deadline() - now()));
  };
  arm();
  return {
    report(value) {
      const progress = parseLoadProgress(value);
      if (over || !progress || !wait.progress(progress, now())) return false;
      arm();
      return true;
    },
    stop() { over = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
