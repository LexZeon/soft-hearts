import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { acceptWakeEvent, advanceFatigue, createFatigue, DEFAULT_FATIGUE_PARAMETERS, fatigueSnapshot, fatigueTerms,
  type FatigueChannels, type FatigueClock, type FatigueParameters, type FatiguePhase, type FatigueState,
  type SleepEntryBlockers, type WakeEvent } from '../shared/fatigue';
import type { FatigueRestNote, FatigueView } from '../shared/fatigue-runtime';
import { FATIGUE_TEST_F, FATIGUE_TEST_HOLD_MS, type TestFatiguePhase } from '../shared/mood-presets';
import { closedSpan, type LastStop } from '../shared/app-session';

export interface FatigueHostClock { monotonicMs(): number; wallMs(): number; localMinute(wallMs: number): number }
export const SYSTEM_FATIGUE_CLOCK: FatigueHostClock = {
  monotonicMs: () => performance.now(), wallMs: () => Date.now(),
  localMinute: wall => { const date = new Date(wall); return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60; },
};
interface SavedProfile { A: number; F: number; W: number; phase: FatiguePhase; wallMs: number }
/** `wallMs`: the saved high-water mark (never goes back); `lastWall`: the wall clock at the last advance (for a long pause). */
interface LiveProfile { state: Readonly<FatigueState>; channels: FatigueChannels; baseline: FatigueChannels; wallMs: number; lastWall: number }
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteWall = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15;
const copyChannels = (v: FatigueChannels): FatigueChannels => ({ D: v.D, O: v.O, E: v.E, N: v.N, C: v.C });
// A fresh owned logical epoch can represent one bounded offline interval even
// when performance.now() is near zero. Old-process monotonic values are not read.
const LOGICAL_EPOCH_MS = 86_400_000;
const CLOSED: SleepEntryBlockers = Object.freeze({ chat: true, tts: true, manualMotion: true });

/** Character-scoped sidecar; no provider identity, timer, renderer capability or reward. */
export class FatigueHost {
  private readonly file: string;
  private readonly session = randomUUID();
  private readonly saved = new Map<string, SavedProfile>();
  private readonly live = new Map<string, LiveProfile>();
  private active = '';
  /** Developer test look (setTestPhase): memory only. */
  private testPhase: { id: string; phase: TestFatiguePhase; until: number } | null = null;
  private blockers: SleepEntryBlockers = CLOSED;
  /** I-022: how the previous run ended (electron/app-session/), for the first return of the character it had on screen. */
  private lastStop: Readonly<{ characterId: string | null; closedMs: number; exact: boolean }> | null = null;
  private lastStopUsed = false;
  /** I-022: per character, the last time off screen counted as rest (the developer panel; memory only). */
  private readonly rests = new Map<string, FatigueRestNote>();
  private ready = false;
  /** 体验记录: told when the active character's phase changes (A, F, W and the clock and mood terms; numbers only). */
  private phaseObserver: ((change: { characterId: string; from: FatiguePhase; to: FatiguePhase; A: number; F: number; W: number; clock: number; mood: number }) => void) | null = null;
  setPhaseObserver(observer: FatigueHost['phaseObserver']): void { this.phaseObserver = observer; }
  private blockedSave = false;
  private notice = '';
  private queue: Promise<boolean> = Promise.resolve(true);
  constructor(private readonly directory: string, private readonly clock: FatigueHostClock = SYSTEM_FATIGUE_CLOCK,
    private readonly parameters: Readonly<FatigueParameters> = DEFAULT_FATIGUE_PARAMETERS) {
    this.file = path.join(directory, 'fatigue-state.json');
  }
  private now(): FatigueClock {
    const monotonic = this.clock.monotonicMs(), wall = this.clock.wallMs();
    if (!Number.isFinite(monotonic) || monotonic < 0 || !finiteWall(wall)) throw new Error('疲倦时钟不正确。');
    return { monotonicMs: LOGICAL_EPOCH_MS + monotonic, localMinute: this.clock.localMinute(wall) };
  }
  async load(): Promise<void> {
    const pending = new Map<string, SavedProfile>();
    try {
      const info = await stat(this.file);
      if (info.size > 262144) throw new Error('Fatigue sidecar too large');
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!object(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 128)
        throw new Error('Invalid fatigue store');
      for (const row of value.profiles) {
        if (!object(row) || Object.keys(row).length !== 6 || !idValid(row.characterId) || pending.has(row.characterId)
          || !finiteWall(row.wallMs)) throw new Error('Invalid fatigue profile');
        const restored = createFatigue(this.now(), { A: row.A as number, F: row.F as number, W: row.W as number, phase: row.phase as FatiguePhase }, this.parameters);
        // Undefined dimensions would otherwise use the new-character defaults.
        if (['A', 'F', 'W', 'phase'].some(key => !Object.hasOwn(row, key))) throw new Error('Incomplete fatigue profile');
        pending.set(row.characterId, { A: restored.A, F: restored.F, W: restored.W, phase: restored.phase, wallMs: row.wallMs });
      }
      this.saved.clear(); for (const [id, value] of pending) this.saved.set(id, value);
      this.blockedSave = false; this.notice = '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.blockedSave = true;
      this.notice = '疲倦状态无法读取，原 fatigue-state.json 已保留；本次疲倦更改仅留在内存。';
    }
  }
  activate(id: string, channels: FatigueChannels, baseline: FatigueChannels): FatigueView {
    if (!idValid(id)) throw new Error('疲倦角色编号不正确。');
    const clock = this.now(), wall = this.clock.wallMs();
    let profile = this.live.get(id);
    if (!profile) {
      if (new Set([...this.saved.keys(), ...this.live.keys(), id]).size > 128) throw new Error('疲倦角色存档已达到上限。');
      const saved = this.saved.get(id);
      // I-022: how long she was off screen, counted as rest. The first character back after a start, when the previous run had
      // her on screen, gets the app's closed time (the same number as the journal's 应用启动 line); otherwise her own last save.
      let stop: { readonly closedMs: number; readonly exact: boolean } | null = null;
      if (this.lastStop && !this.lastStopUsed) { this.lastStopUsed = true; if (saved && this.lastStop.characterId === id) stop = this.lastStop; }
      const closedMs = !saved ? 0 : stop ? stop.closedMs : closedSpan(saved.wallMs, wall).ms;
      const counted = Math.min(this.parameters.maxOfflineMs, closedMs);
      // The rest starts at the local time she left (not now's), so the night part of it is the night.
      let state = createFatigue({ monotonicMs: clock.monotonicMs - counted, localMinute: this.clock.localMinute(wall - counted) }, saved, this.parameters);
      const before = state;
      state = advanceFatigue(state, { clock, channels, baseline, blockers: this.blockers, mode: 'offline' }, this.parameters);
      if (saved && closedMs > 0) this.noteRest(id, stop ? 'closed' : 'away', closedMs, counted, stop ? stop.exact : true, before, state, wall);
      profile = { state, channels: copyChannels(channels), baseline: copyChannels(baseline), wallMs: Math.max(saved?.wallMs ?? 0, wall), lastWall: wall };
      this.live.set(id, profile); this.saved.delete(id);
    } else {
      const before = profile.state, mode = this.active === id ? 'active' : 'offline';
      profile.state = advanceFatigue(profile.state, { clock, channels, baseline, blockers: this.blockers, mode }, this.parameters);
      // Back from another character: the time with the other one was rest for her.
      const away = Math.max(0, clock.monotonicMs - before.monotonicMs);
      if (mode === 'offline' && away > 0) this.noteRest(id, 'away', away, Math.min(this.parameters.maxOfflineMs, away), true, before, profile.state, wall);
      profile.channels = copyChannels(channels); profile.baseline = copyChannels(baseline); profile.wallMs = Math.max(profile.wallMs, wall); profile.lastWall = wall;
    }
    this.active = id;
    return this.view(id)!;
  }
  update(id: string, channels: FatigueChannels, baseline: FatigueChannels): FatigueView | undefined {
    const profile = this.live.get(id);
    if (!profile || id !== this.active) return undefined;
    const clock = this.now(), wall = this.clock.wallMs();
    // I-022: a long pause while the app stays open (the computer asleep, the process frozen): both clocks moved on by more than an
    // active gap. The shorter of the two counts as time off screen. A changed system clock moves only the wall one, so it never
    // counts; a wall clock that went back is no pause at all.
    const monoGap = clock.monotonicMs - profile.state.monotonicMs, wallGap = wall - profile.lastWall;
    if (monoGap > this.parameters.maxActiveGapMs && wallGap > this.parameters.maxActiveGapMs) {
      const away = Math.min(monoGap, wallGap), before = profile.state;
      profile.state = advanceFatigue(profile.state, { clock: { monotonicMs: before.monotonicMs + away, localMinute: clock.localMinute }, channels, baseline,
        blockers: this.blockers, mode: 'offline' }, this.parameters);
      this.noteRest(id, 'paused', away, Math.min(this.parameters.maxOfflineMs, away), true, before, profile.state, wall);
    }
    const phaseBefore = profile.state.phase;
    profile.state = advanceFatigue(profile.state, { clock, channels, baseline, blockers: this.blockers, mode: 'active' }, this.parameters);
    if (this.phaseObserver && profile.state.phase !== phaseBefore) {
      try {
        const s = profile.state, terms = fatigueTerms(s, { clock, channels, baseline, blockers: this.blockers, mode: 'active' }, this.parameters);
        this.phaseObserver({ characterId: id, from: phaseBefore, to: s.phase, A: s.A, F: s.F, W: s.W, ...terms });
      } catch { /* Keeping a record never changes her rest. */ }
    }
    profile.channels = copyChannels(channels); profile.baseline = copyChannels(baseline); profile.wallMs = Math.max(profile.wallMs, wall); profile.lastWall = wall;
    return this.view(id);
  }
  /**
   * I-022: how the previous run ended (electron/app-session/ begin(), before the first character wakes). Only `closedMs` and
   * whether it is exact are used, for the character that run had on screen, once.
   */
  setLastStop(value: Pick<LastStop, 'characterId' | 'closedMs' | 'exact'> | null): void {
    if (value === null) { this.lastStop = null; return; }
    if (!object(value) || !(value.characterId === null || idValid(value.characterId)) || typeof value.exact !== 'boolean'
      || typeof value.closedMs !== 'number' || !Number.isFinite(value.closedMs) || value.closedMs < 0) return;
    this.lastStop = Object.freeze({ characterId: value.characterId, closedMs: value.closedMs, exact: value.exact });
  }
  /** I-022: the last time off screen counted as rest for this character (the developer panel shows it; memory only). */
  restNote(id = this.active): FatigueRestNote | undefined { return this.rests.get(id); }
  private noteRest(id: string, kind: FatigueRestNote['kind'], awayMs: number, countedMs: number, exact: boolean,
    before: Readonly<FatigueState>, after: Readonly<FatigueState>, wall: number): void {
    this.rests.set(id, Object.freeze({ kind, at: wall, awayMs, countedMs, exact, before: Object.freeze({ A: before.A, F: before.F }),
      after: Object.freeze({ A: after.A, F: after.F }) }));
  }
  /** Internal host activity, never a MoodInput or a new renderer approval path. */
  setBlockers(value: SleepEntryBlockers): void {
    if (!object(value) || Object.keys(value).length !== 3 || ['chat', 'tts', 'manualMotion'].some(key => typeof value[key] !== 'boolean'))
      throw new Error('疲倦活动状态不正确。');
    this.blockers = Object.freeze({ chat: value.chat, tts: value.tts, manualMotion: value.manualMotion }); this.ready = true;
  }
  accept(id: string, kind: WakeEvent['kind'], acceptedId: string): FatigueView | undefined {
    const profile = this.live.get(id);
    if (!profile || this.active !== id || typeof acceptedId !== 'string' || !acceptedId || acceptedId.length > 512) return undefined;
    this.update(id, profile.channels, profile.baseline);
    const eventId = `${this.session}:${createHash('sha256').update(JSON.stringify([id, kind, acceptedId])).digest('hex')}`;
    profile.state = acceptWakeEvent(profile.state, { id: eventId, kind, acceptedAtMonotonicMs: profile.state.monotonicMs }, this.parameters);
    // A pat or a message wakes a test sleep too (the look ends; the model's own state was never changed).
    if (this.testPhase?.id === id && this.testPhase.phase === 'asleep') this.testPhase = null;
    return this.view(id);
  }
  /**
   * Developer test command ("测试：困了", electron/test-commands/): for FATIGUE_TEST_HOLD_MS the view of the active character
   * shows (light-)drowsy. Only the view: the sleep model's own state is untouched and the temporary look is never saved.
   * `null` cancels it. False: not the active character.
   */
  setTestPhase(id: string, phase: TestFatiguePhase | null): boolean {
    if (phase === null) { this.testPhase = null; return true; }
    if (!this.live.has(id) || id !== this.active || !(phase in FATIGUE_TEST_F)) return false;
    this.testPhase = { id, phase, until: this.clock.monotonicMs() + FATIGUE_TEST_HOLD_MS };
    return true;
  }
  view(id = this.active): FatigueView | undefined {
    const profile = this.live.get(id);
    if (!profile) return undefined;
    const base = fatigueSnapshot(profile.state);
    let test = this.testPhase;
    if (test && (test.id !== id || this.clock.monotonicMs() >= test.until)) { if (test.id === id) this.testPhase = null; test = null; }
    // "测试：睡着了" (asleep) looks asleep: eyes closed, the sleep pose, no gaze; the others only look sleepy.
    const asleep = test?.phase === 'asleep';
    const snapshot = test ? Object.freeze({ ...base, phase: test.phase, F: FATIGUE_TEST_F[test.phase], fatigueIntensity: FATIGUE_TEST_F[test.phase],
      sleeping: asleep, gazeAllowed: !asleep }) : base;
    return Object.freeze({ ...snapshot, sleepEntryReady: this.ready, ...(this.notice ? { storageError: this.notice } : {}) });
  }
  /** Called by the existing mood save queue. There is no second periodic timer. */
  flush(): Promise<boolean> {
    if (this.blockedSave) return Promise.resolve(false);
    const profiles = new Map(this.saved);
    for (const [id, p] of this.live) profiles.set(id, { A: p.state.A, F: p.state.F, W: p.state.W, phase: p.state.phase, wallMs: p.wallMs });
    const data = JSON.stringify({ version: 1, profiles: [...profiles].map(([characterId, value]) => ({ characterId, ...value })) });
    const operation = async (): Promise<boolean> => {
      try {
        await mkdir(this.directory, { recursive: true });
        const temp = this.file + '.tmp'; await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file);
        this.notice = ''; return true;
      } catch { this.notice = '疲倦状态保存失败，本次更改仅留在内存。'; return false; }
    };
    this.queue = this.queue.then(operation, operation); return this.queue;
  }
}
