/**
 * Unbound v1 step 1B: the page's performance manager (docs/claude/2026-11-15-unbound-v1-step1-perf.md, and the tier rules of
 * docs/claude/2026-11-23-unbound-quality-tier.md).
 *
 * Wires the pure parts (shared/unbound/perf-tiers.ts, perf-raise.ts) to a clock, the profile's localStorage and a callback that
 * applies a tier (pixel ratio, physics quality). One call per animation-frame tick: admit() says whether to draw; frame() takes the
 * interval of a frame that was drawn. It decides: the tier she starts at (a tier below high is stored only after two starts' self-tests
 * agreed; until then every start tests again), a first-open self-test that never runs while the app is busy, a drop when the machine
 * cannot keep up (kept for this session only), a raise back up one tier after a sustained comfortable stretch, and the quiet frame rate.
 */
import {
  AdaptDown, CALM_BEFORE_TEST_MS, DEFAULT_TIER, FrameGovernor, PERF_STORAGE_KEY, PERF_TIERS, SelfTest, confirmedTests, higherTier, lowerTier, parsePerf, serializePerf,
  startingTier, tierOf, type PerfTier, type PerfTierId,
} from '../../shared/unbound/perf-tiers';
import { PERF_JOURNAL_KEY, RaiseUp, appendJournal, type TierJournalRow } from '../../shared/unbound/perf-raise';

export interface PerfStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface PerfOptions {
  storage: PerfStorage | null;
  /** Wall clock (ms) for the stored record. */
  wallClock?: () => number;
  /** A tier takes effect (the page sets the pixel ratio, the physics quality). */
  onTier: (tier: PerfTier) => void;
  /** Measurement runs: pin a tier (no test, no drop, nothing stored) and/or switch the quiet rate off. */
  pin?: PerfTierId | null;
  quiet?: boolean;
  /** The app is busy with something a self-test must not share the machine with (a reply, reading aloud, a call, voice capture, a load). Absent: never busy. */
  busy?: () => boolean;
  /** 三人同框别卡: her pixel ratio changed because she became an idle extra or stopped being one (the page applies perf.pixelTier). */
  onPixel?: () => void;
  /** Measurement runs: false ignores setPace (the idle-extra cap and the lower pixel tier). */
  pace?: boolean;
}

export class PerfManager {
  private tierNow: PerfTier;
  private readonly governor: FrameGovernor;
  private readonly adapt = new AdaptDown();
  private readonly raise = new RaiseUp();
  private test: SelfTest | null = null;
  private testStart: PerfTierId = DEFAULT_TIER;
  private testFromTop = false;
  private waitingTest = false;
  private calmSince: number | null = null;
  private key: string | null = null;
  private resolved = false;
  /** How many tiers this session has dropped (for the developer view). */
  drops = 0;
  /** How many tiers this session has gone back up. */
  raises = 0;
  /** A one-line note of what the self-test found, for the developer view. */
  note = '';
  /** The graphics chip's closed words once the page has read them (the developer view says so when it is software). */
  gpu: { kind: string; vendor: string } | null = null;
  private pixelLowered = false;
  private readonly pinned: boolean;
  private readonly wall: () => number;

  constructor(private readonly options: PerfOptions) {
    this.wall = options.wallClock ?? (() => Date.now());
    this.pinned = !!options.pin && !!tierOf(options.pin);
    const stored = this.pinned ? null : this.read();
    const start = this.pinned ? options.pin! : startingTier(stored, null) ?? DEFAULT_TIER;
    this.tierNow = tierOf(start)!;
    this.governor = new FrameGovernor(this.tierNow.fps, options.quiet !== false);
  }

  get tier(): PerfTier { return this.tierNow; }
  /** The tier whose pixel ratio the canvas uses now: one lower than the tier while she is an idle extra on a crowded stage (shared/unbound/company/extra-pace.ts). */
  get pixelTier(): PerfTier { return this.pixelLowered ? tierOf(lowerTier(this.tierNow.id))! : this.tierNow; }
  /** She is drawn as an idle extra (capped rate and/or lower pixel tier). */
  get paced(): boolean { return this.governor.capped || this.pixelLowered; }
  /** A self-test is running or waiting for a quiet moment. */
  get testing(): boolean { return this.test !== null || this.waitingTest; }
  get quiet(): boolean { return this.governor.quiet; }
  get fps(): number { return this.governor.fps; }
  /** What the tier needs before the canvas exists (antialiasing is fixed at creation): high unless a low result has been confirmed. */
  get startTier(): PerfTier { return this.tierNow; }

  /**
   * The display and model identity is known (after she has loaded, and again when either changes). The first time in a session a
   * missing or unconfirmed record means the self-test from the top; later it only ever tests from the current tier downward.
   */
  setKey(key: string): void {
    if (this.pinned || key === this.key) return;
    const first = !this.resolved;
    this.key = key;
    this.resolved = true;
    const keep = startingTier(this.read(), key);
    if (keep !== null) { if (first && keep !== this.tierNow.id) this.apply(keep); return; }
    if (this.test || this.waitingTest) return;
    this.testFromTop = first;
    if (this.options.busy) { this.waitingTest = true; this.note = 'self-test waits for a quiet moment'; } else this.startTest();
  }

  /** Whether this animation-frame tick draws. `busy`: she moves, speaks, a peek runs, the pointer is moving. */
  admit(now: number, busy: boolean): boolean {
    if (this.options.busy && (this.test || this.waitingTest)) {
      const appBusy = this.options.busy() === true;
      if (this.test && appBusy) this.abortTest();
      if (this.waitingTest) {
        if (appBusy) this.calmSince = null;
        else { this.calmSince ??= now; if (now - this.calmSince >= CALM_BEFORE_TEST_MS) this.startTest(); }
      }
    }
    return this.governor.admit(now, busy);
  }

  /**
   * 三人同框别卡: the page's answer for this frame (shared/unbound/company/extra-pace.ts): draw at most `capFps` frames a second (null: no cap) and
   * with the pixel ratio one tier lower. Lifted, she is back at the tier's rate on this very tick and at its pixel ratio before this frame is drawn.
   * Never while a self-test measures (what it measures must be the tier, not the cap).
   */
  setPace(capFps: number | null, lowered: boolean): void {
    const on = this.options.pace !== false && !this.test;
    this.governor.setCap(on ? capFps : null);
    this.setLowered(on && lowered);
  }
  private setLowered(on: boolean): void {
    if (on === this.pixelLowered) return;
    this.pixelLowered = on;
    this.options.onPixel?.();
  }

  /** Forget the recent frames (the window was hidden, a scene is loading): a pause must not read as a slow machine. */
  pause(now: number): void { this.adapt.reset(now); this.raise.reset(now); }

  /** A frame was drawn `intervalMs` after the previous drawn one. */
  frame(now: number, intervalMs: number): void {
    if (this.pinned || !(intervalMs > 0)) return;
    if (this.test) {
      const step = this.test.feed(now, intervalMs);
      if (step.apply) this.apply(step.apply);
      if (step.done) this.finishTest(now, step.done);
      return;
    }
    if (this.adapt.feed(now, intervalMs, this.governor.fps) && this.tierNow.id !== PERF_TIERS[PERF_TIERS.length - 1]!.id) {
      this.drops++;
      const from = this.tierNow.id, seconds = this.adapt.badSeconds;
      this.apply(lowerTier(from)); // for this session only: nothing is stored, the next start begins at the tested tier
      this.note = `over budget: down to ${this.tierNow.id} for this session`;
      this.journal(from, this.tierNow.id, 'adapt', null, seconds);
      this.adapt.reset(now); this.raise.reset(now, true);
      return;
    }
    if (this.raise.feed(now, intervalMs, this.governor.fps, this.governor.quiet) && this.tierNow.id !== DEFAULT_TIER && this.options.busy?.() !== true) {
      const from = this.tierNow.id, seconds = this.raise.seconds;
      this.apply(higherTier(from));
      this.raises++;
      this.note = `smooth for a while: back up to ${this.tierNow.id}`;
      this.journal(from, this.tierNow.id, 'raise', null, seconds);
      this.adapt.reset(now); this.raise.raised(now);
    }
  }

  private startTest(): void {
    this.waitingTest = false; this.calmSince = null;
    this.testStart = this.tierNow.id;
    this.test = new SelfTest(this.testFromTop ? DEFAULT_TIER : this.tierNow.id);
    this.governor.setQuietEnabled(false);
    this.governor.setCap(null); this.setLowered(false);
    this.note = 'self-test running';
  }
  /** The app got busy during the test: what it measured would be the other work, so go back to where she was and wait for a quiet moment. */
  private abortTest(): void {
    this.test = null; this.waitingTest = true; this.calmSince = null;
    this.governor.setQuietEnabled(this.options.quiet !== false);
    if (this.tierNow.id !== this.testStart) this.apply(this.testStart);
    this.note = 'busy again: self-test dropped, retries when quiet';
  }
  private finishTest(now: number, done: PerfTierId): void {
    const test = this.test!;
    const results = test.results.map(r => `${tierOf(r.tier)!.label}:${r.p95 === null ? '-' : r.p95.toFixed(2)}`).join(' ');
    const p95 = test.results[test.results.length - 1]?.p95 ?? null;
    this.test = null;
    this.governor.setQuietEnabled(this.options.quiet !== false);
    if (done !== this.tierNow.id) this.apply(done);
    const tests = this.key ? confirmedTests(this.read(), this.key, done, this.testFromTop) : 1;
    this.note = done === DEFAULT_TIER ? `self-test kept ${done} (p95/budget by tier: ${results})` : `self-test provisional ${done}, test ${tests} (two agreeing starts make it final; ${results})`;
    this.write(tests);
    this.journal(this.testStart, done, 'test', p95, tests);
    this.adapt.reset(now); this.raise.reset(now);
  }

  private apply(id: PerfTierId): void {
    this.tierNow = tierOf(id)!;
    this.governor.setTier(this.tierNow.fps);
    this.options.onTier(this.tierNow);
  }
  private read() {
    try { return parsePerf(this.options.storage?.getItem(PERF_STORAGE_KEY) ?? null); } catch { return null; }
  }
  private write(tests: number): void {
    if (!this.key) return;
    try { this.options.storage?.setItem(PERF_STORAGE_KEY, serializePerf(this.tierNow.id, this.key, this.wall(), false, tests)); } catch { /* no storage: she tests again next time */ }
  }
  /** One closed row per tier change, readable next time: localStorage['unbound.perf.journal.v1'] on the Unbound page. */
  private journal(from: PerfTierId, to: PerfTierId, why: TierJournalRow['why'], p95: number | null, n: number): void {
    try {
      const row: TierJournalRow = { at: this.wall(), from, to, why, p95: p95 === null ? null : Math.round(p95 * 100) / 100, n };
      this.options.storage?.setItem(PERF_JOURNAL_KEY, appendJournal(this.options.storage.getItem(PERF_JOURNAL_KEY), row));
    } catch { /* no storage: no journal */ }
  }
}
