/**
 * Unbound v1 step 1B: quality tiers that pick themselves (docs/claude/2026-11-15-unbound-v1-step1-perf.md).
 *
 * Pure logic, no DOM: the tiers, the first-open self-test, the adapt-down watcher, the quiet frame-rate governor and the
 * stored record. The page (src/unbound/perf.ts) wires them to the renderer, the physics and localStorage.
 *
 * Experience first: the highest tier the machine sustains is the default; saving happens only where it does not hurt
 * (nothing moves, so 30 fps costs nothing she can show), or where the machine cannot hold the frame rate anyway.
 * A self-test result below high is provisional (a busy minute must not lower her for good): it is tested again at the next start and
 * only trusted after two starts agree; a drop inside a session lasts for that session only; after a sustained comfortable stretch
 * she goes back up one tier (and falls back if it goes over budget). Only the budget numbers below are fixed; the rest follows the measurements.
 * (docs/claude/2026-11-23-unbound-quality-tier.md)
 */
import type { PhysicsQuality } from '../stage';

export type PerfTierId = 'high' | 'medium' | 'low';
export interface PerfTier {
  id: PerfTierId;
  /** Plain words for the developer view. */
  label: string;
  /** The renderer's pixel ratio is min(devicePixelRatio, this). */
  pixelRatioCap: number;
  /** The most frames per second she is drawn at while something moves. */
  fps: number;
  /** Hair/chest physics is held to at most this quality (the companion's own setting still wins when it is lower). */
  physicsCap: PhysicsQuality;
  /** Antialiasing is decided when the canvas is made, so a tier change inside a session cannot flip it (it applies from the next start). */
  antialias: boolean;
}
export const PERF_TIERS: readonly PerfTier[] = Object.freeze([
  Object.freeze({ id: 'high', label: '高', pixelRatioCap: 1.5, fps: 60, physicsCap: 'high', antialias: true }),
  Object.freeze({ id: 'medium', label: '中', pixelRatioCap: 1, fps: 60, physicsCap: 'standard', antialias: true }),
  Object.freeze({ id: 'low', label: '低', pixelRatioCap: 0.75, fps: 30, physicsCap: 'low', antialias: false }),
] as PerfTier[]);
export const DEFAULT_TIER: PerfTierId = 'high';
export const tierOf = (id: unknown): PerfTier | null => PERF_TIERS.find(t => t.id === id) ?? null;
/** The tier below, or the same one at the bottom. */
export const higherTier = (id: PerfTierId): PerfTierId => PERF_TIERS[Math.max(0, PERF_TIERS.findIndex(t => t.id === id) - 1)]!.id;
export const lowerTier = (id: PerfTierId): PerfTierId => PERF_TIERS[Math.min(PERF_TIERS.length - 1, PERF_TIERS.findIndex(t => t.id === id) + 1)]!.id;

/** A frame interval counts as late when it is over this many times the interval the tier asks for. */
export const OVER_BUDGET = 1.25;
export const frameBudgetMs = (fps: number): number => 1000 / fps * OVER_BUDGET;
/** Frames longer than this are a stall (hidden window, a load), not a rate, and are left out of the numbers. */
export const STALL_MS = 250;
export const QUIET_FPS = 30;
/** How long nothing may move before the quiet rate starts. */
export const QUIET_AFTER_MS = 1_500;
/** Self-test: the first stretch of each tier is thrown away (shaders, the pixel-ratio change), the next one is measured. */
export const SELF_TEST_WARMUP_MS = 1_500, SELF_TEST_MEASURE_MS = 2_500;
/** Adapt: over budget for this long drops one tier; after a drop the watcher waits this long before it looks again. */
export const ADAPT_WINDOW_MS = 10_000, ADAPT_GRACE_MS = 3_000;
/** A tier below high is trusted only after this many self-tests on different starts agreed (a single one may have run on a busy machine). */
export const CONFIRM_TESTS = 2;
/** Nothing busy (a reply, reading aloud, a call, voice capture, a load) for this long before a self-test starts. */
export const CALM_BEFORE_TEST_MS = 2_000;
/**
 * Going back up inside a session: this many full-rate seconds in a row whose p95 lateness is within COMFORT (and no bad second in
 * between) raise her one tier. 45 s is long enough that a hitch or a short load is gone, short enough that a calm machine gets her
 * best look within the first minute of being left alone. A raise that goes over budget within RAISE_TRIAL_MS doubles the wait
 * (up to RAISE_MAX_S), so a machine that cannot hold the higher tier is not tried every minute.
 */
export const COMFORT = 1.1, RAISE_AFTER_S = 45, RAISE_TRIAL_MS = 60_000, RAISE_MAX_S = 360;

const QUALITY_ORDER: readonly PhysicsQuality[] = ['low', 'standard', 'high'];
/** The physics quality she runs at: the companion's own setting, held down to the tier's cap (never raised above what the user chose). */
export const capQuality = (wanted: PhysicsQuality, cap: PhysicsQuality): PhysicsQuality => QUALITY_ORDER[Math.min(QUALITY_ORDER.indexOf(wanted), QUALITY_ORDER.indexOf(cap))] ?? 'standard';

/** Nearest-rank percentile (0..1) of the finite values; null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}
/** How late a frame was: its interval over the interval the rate asks for (1 = on time). */
export const lateness = (intervalMs: number, fps: number): number => intervalMs / (1000 / fps);

// ---- the stored record (per profile: the Unbound page's localStorage) ---------------------------------------------------------
export interface StoredPerf { v: 1; tier: PerfTierId; key: string; at: number; adapted: boolean; /** How many starts' self-tests agreed on this tier (absent in older records: 1). */ tests: number }
export const PERF_STORAGE_KEY = 'unbound.perf.v1';
/** Display and model identity: a different screen size, pixel density or model means a new test. */
export const perfKey = (width: number, height: number, dpr: number, modelSignature: string): string => `${Math.round(width)}x${Math.round(height)}@${Math.round(dpr * 100) / 100}|${modelSignature}`;
export function serializePerf(tier: PerfTierId, key: string, at: number, adapted: boolean, tests = 1): string {
  return JSON.stringify({ v: 1, tier, key, at, adapted, tests } satisfies StoredPerf);
}
export function parsePerf(raw: string | null): StoredPerf | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.v !== 1 || !tierOf(value.tier) || typeof value.key !== 'string' || value.key.length > 200 || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    return { v: 1, tier: value.tier as PerfTierId, key: value.key, at: value.at, adapted: value.adapted === true, tests: Number.isInteger(value.tests) && (value.tests as number) >= 1 ? Math.min(99, value.tests as number) : 1 };
  } catch { return null; }
}
/**
 * The tier to start at, or null when the machine has to be tested: nothing stored, another display or model, a record an older build
 * wrote for a drop inside a session (a drop is never kept), or a self-test result below high that fewer than CONFIRM_TESTS starts
 * have agreed on. `key` null (the model is not loaded yet) skips the key check; it is checked again once known.
 */
export function startingTier(stored: StoredPerf | null, key: string | null): PerfTierId | null {
  if (!stored) return null;
  if (key !== null && stored.key !== key) return null;
  if (stored.adapted) return null;
  if (stored.tier !== DEFAULT_TIER && stored.tests < CONFIRM_TESTS) return null;
  return stored.tier;
}
/** The test count a finished self-test stores: one more than the last start's when it came to the same tier on the same display and model. */
export function confirmedTests(prior: StoredPerf | null, key: string, done: PerfTierId, fromTop: boolean): number {
  if (done === DEFAULT_TIER || !fromTop || !prior || prior.adapted || prior.key !== key || prior.tier !== done) return 1;
  return Math.min(99, prior.tests + 1);
}

// ---- first-open self-test --------------------------------------------------------------------------------------------------------
export interface SelfTestStep { /** Switch to this tier now (warm-up of a tier starts). */ apply: PerfTierId | null; /** The test is over: this is the tier she keeps. */ done: PerfTierId | null }
/**
 * Runs a tier for a warm-up (thrown away) and a measuring stretch; the first tier whose p95 lateness fits OVER_BUDGET is kept,
 * and the lowest one is kept when none does. `from` is the tier it starts at (a re-test inside a session starts at the current
 * one, so a test never raises her).
 */
export class SelfTest {
  private index: number;
  private since = 0;
  private samples: number[] = [];
  private started = false;
  /** Every tier's measured p95 lateness (for the record). */
  readonly results: { tier: PerfTierId; p95: number | null }[] = [];
  constructor(from: PerfTierId = DEFAULT_TIER) { this.index = Math.max(0, PERF_TIERS.findIndex(t => t.id === from)); }
  get tier(): PerfTierId { return PERF_TIERS[this.index]!.id; }
  feed(now: number, intervalMs: number): SelfTestStep {
    if (!this.started) { this.started = true; this.since = now; return { apply: this.tier, done: null }; }
    const tier = PERF_TIERS[this.index]!;
    const age = now - this.since;
    if (age < SELF_TEST_WARMUP_MS) return { apply: null, done: null };
    if (intervalMs < STALL_MS) this.samples.push(lateness(intervalMs, tier.fps));
    if (age < SELF_TEST_WARMUP_MS + SELF_TEST_MEASURE_MS) return { apply: null, done: null };
    const p95 = percentile(this.samples, 0.95);
    this.results.push({ tier: tier.id, p95 });
    if (p95 === null || p95 <= OVER_BUDGET || this.index === PERF_TIERS.length - 1) return { apply: null, done: tier.id };
    this.index++; this.since = now; this.samples = [];
    return { apply: this.tier, done: null };
  }
}

// ---- adapt down ------------------------------------------------------------------------------------------------------------------
/**
 * Watches the frames a session draws, one second at a time. A second is bad when its p95 lateness is above OVER_BUDGET (more than
 * one frame in twenty late). Nine of the last ten seconds bad ("stays over budget for about ten seconds") means drop one tier; a
 * hitch of a second or two (another program, a load) never does. It has no way to ask for a higher tier. The frame where the asked
 * rate changed (the quiet rate starting or ending) is skipped, so a rate change never looks like a slow machine.
 */
export class AdaptDown {
  private bin: number[] = [];
  private binStart = 0;
  private bad: boolean[] = [];
  private graceUntil = 0;
  private lastFps = 0;
  private readonly bins: number;
  constructor(windowMs = ADAPT_WINDOW_MS, private readonly graceMs = ADAPT_GRACE_MS) { this.bins = Math.max(1, Math.round(windowMs / 1000)); }
  /** How many of the last seconds were over budget (for the journal). */
  get badSeconds(): number { return this.bad.filter(Boolean).length; }
  /** After a drop, a scene change or a pause: forget what was seen and give the new setting time to settle. */
  reset(now: number): void { this.bin = []; this.bad = []; this.binStart = 0; this.graceUntil = now + this.graceMs; this.lastFps = 0; }
  /** True when the last seconds say: drop a tier (the caller drops it, then calls reset). `fps`: the rate this frame was asked for. */
  feed(now: number, intervalMs: number, fps: number): boolean {
    const changed = fps !== this.lastFps;
    this.lastFps = fps;
    if (now < this.graceUntil || changed) return false;
    if (!this.binStart) this.binStart = now;
    if (now - this.binStart >= 1_000) {
      if (this.bin.length) { this.bad.push((percentile(this.bin, 0.95) ?? 0) > OVER_BUDGET); if (this.bad.length > this.bins) this.bad.shift(); }
      this.bin = []; this.binStart = now;
    }
    this.bin.push(lateness(intervalMs, fps));
    return this.bad.length >= this.bins - 1 && this.bad.filter(Boolean).length >= this.bins - 1;
  }
}

// ---- frame-rate governor ---------------------------------------------------------------------------------------------------------
/**
 * Decides, on every animation-frame tick, whether to draw. While something moves it draws at the tier's rate; once nothing has
 * moved for QUIET_AFTER_MS it draws at QUIET_FPS (never above the tier's own rate); anything that moves wakes it that same tick
 * (the next draw is due at once). Due times accumulate, so a 144 Hz display still averages the asked rate.
 */
export class FrameGovernor {
  private due = 0;
  private calmSince: number | null = null;
  private fpsNow: number;
  private cap: number | null = null;
  constructor(private tierFps: number, private quietEnabled = true) { this.fpsNow = tierFps; }
  setTier(fps: number): void { this.tierFps = fps; this.due = 0; }
  setQuietEnabled(on: boolean): void { this.quietEnabled = on; }
  /**
   * 三人同框别卡 (shared/unbound/company/extra-pace.ts): an idle extra on a crowded stage is drawn at most this many frames a second, busy or not,
   * until the cap is lifted (null); lifting it wakes her at once (the next tick draws). It never raises the rate above the tier's.
   */
  setCap(fps: number | null): void { this.cap = fps !== null && fps > 0 ? fps : null; }
  /** An idle extra's cap holds now. */
  get capped(): boolean { return this.cap !== null; }
  /** The rate the last admitted frame was asked for. */
  get fps(): number { return this.fpsNow; }
  get quiet(): boolean { return this.fpsNow < this.tierFps; }
  /** `busy`: she moves, speaks, is touched or a peek runs. */
  admit(now: number, busy: boolean): boolean {
    if (busy) this.calmSince = null; else if (this.calmSince === null) this.calmSince = now;
    const quiet = this.quietEnabled && this.calmSince !== null && now - this.calmSince >= QUIET_AFTER_MS && this.tierFps > QUIET_FPS;
    const asked = quiet ? QUIET_FPS : this.tierFps;
    const fps = this.cap === null ? asked : Math.min(asked, this.cap);
    if (fps > this.fpsNow) this.due = 0; // waking: draw this very tick
    this.fpsNow = fps;
    const interval = 1000 / fps;
    if (now < this.due - 1.5) return false;
    this.due = this.due === 0 || now - this.due > interval ? now + interval : this.due + interval;
    return true;
  }
}
