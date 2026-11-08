import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { appendBounded } from '../reply-latency';
import type { FatiguePhase } from '../../shared/fatigue';
import { innerLoopQuiet } from '../../shared/inner-loop';
import { localDateKey } from '../diary/diary-dates';
import type { MoodParameters, MoodPhase, MoodValues } from '../../shared/mood';
import {
  HER_NEED_TABLE, createHerNeedState, herNeedRelief, herNeedSpeechLine, herNeedView, isHerNeedId, noteHerNeedInteraction, readHerNeedSaved, restoreHerNeedState,
  peekHerNeedSpeech, serializeHerNeedState, stepHerNeed, takeHerNeedChatLine, takeHerNeedSpeech,
  type HerNeedEvent, type HerNeedId, type HerNeedKind, type HerNeedLimitFn, type HerNeedSaved, type HerNeedState, type HerNeedTriggerFn, type HerNeedView,
} from '../../shared/her-needs';

/** What one host tick reads (CompanionService.herLifeTick builds it from the mood view). */
export interface HerNeedsTickInput {
  now: number;
  /** The local date key of `now` (YYYY-MM-DD). */
  day: string;
  /** "自动表现" (MoodView.expressions). */
  expressions: boolean;
  /** The existing companionCanExpress gate: visible, no typing, chat, speech or drag. */
  canExpress: boolean;
  phase: MoodPhase;
  /** MoodSnapshot.lastInteractionAt: the last chat, pat or feeding (it survives restarts; offline time never counts here). */
  lastInteractionAt: number | null;
  fatigue: FatiguePhase | null | undefined;
  /** Fatigue F (0..1) and the missing-the-user number (MoodSnapshot.longing), for the wants. */
  fatigueF?: number | null;
  longing?: number;
  boredom: number;
  mood: string | null | undefined;
  channels: MoodValues;
  parameters: Pick<MoodParameters, 'baseline' | 'weights'>;
  localMinute: number;
}

/** One developer diagnostic line: what happened and to which need, never any text. */
export interface HerNeedDiagnostic { at: number; type: HerNeedEvent['type']; id: HerNeedId; via?: HerNeedKind; snubbed?: boolean }

/** A host-owned shift of the mood (MoodHost.lift). */
export interface HerNeedMoodShift { id: string; delta: Partial<MoodValues>; reason: string; relief?: number }

interface Character {
  state: HerNeedState;
  /** The last time the host saw the user do anything with her (an interaction, or a mood phase other than idle). */
  lastTouch: number | null;
  sleepingSince: number | null;
  wake: { at: number; sleptMs: number } | null;
  expressions: boolean;
}

export interface HerNeedsHostOptions {
  /** `<profile>/her-needs.json`; null keeps everything in memory. */
  file: () => string | null;
  /** `<profile>/dev/her-needs.jsonl`, written in developer mode only. */
  diagnosticsFile: () => string | null;
  developerMode: () => boolean;
  /** Her state for this character changed (the mood view republishes it). */
  changed: (characterId: string) => void;
  /** She was soothed, nobody answered, or the user came after that: shift the mood (MoodHost.lift). */
  lift: (characterId: string, lift: HerNeedMoodShift) => void;
  clock?: () => number;
  random?: () => number;
  write?: AtomicFileWriter;
  append?: (file: string, line: string) => Promise<void>;
  /** The default wants unless the T-106 version replaces them. */
  trigger?: HerNeedTriggerFn;
  /** The default limit function (tests may replace it). */
  limits?: HerNeedLimitFn;
  /** I-010 互动余额: the budget's room for a need now, 0..1 (passed to the limit function); absent or null: the old per-day curve. */
  balance?: (characterId: string) => number | null;
  /** I-010: a need really began on its own (never the developer test command): the budget pays for it. */
  spent?: (characterId: string, id: HerNeedId, at: number) => void;
  /** 体验记录 (electron/journal/sources.ts herNeedInput): each start, soothing, fading, end and relief, in every mode. */
  journal?: (characterId: string, event: HerNeedEvent | { type: 'relieved'; relief: number }) => void;
}

const WAKE_KEEP_MS = 10 * 60_000;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

/**
 * 她也会需要你, host side (docs/claude/2026-11-03-she-needs-you.md): one small state per character, driven by the existing
 * one-second mood tick, by the touch / feeding / chat that can soothe her, and by the inner loop's one speech chance.
 * Persists only today's counts and the time of the last start (`<profile>/her-needs.json`) so a restart is no way round the
 * limits. Owns no timer except a debounced save.
 */
export class HerNeedsHost {
  private readonly characters = new Map<string, Character>();
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly saved = new Map<string, HerNeedSaved>();
  private readonly recentDiagnostics: HerNeedDiagnostic[] = [];
  /** This run of the app began now: the warm-up and "ignored" count from here, never from the time the app was closed. */
  private readonly startedAt: number;
  constructor(private readonly options: HerNeedsHostOptions) { this.startedAt = this.now(); }

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private random(): number { return (this.options.random ?? Math.random)(); }

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const rows = value?.characters;
      if (!value || value.version !== 1 || !rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Invalid her-needs file');
      for (const [id, row] of Object.entries(rows as Record<string, unknown>).slice(0, 128)) {
        const saved = validId(id) ? readHerNeedSaved(row) : null;
        if (saved) this.saved.set(id, saved);
      }
      this.loaded = 'ready';
    } catch (error) {
      // Missing: a first launch. Unreadable: keep the user's file untouched and run in memory only.
      this.loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  private character(characterId: string, day: string): Character {
    let entry = this.characters.get(characterId);
    if (!entry) {
      const saved = this.saved.get(characterId);
      // A reopened app is the user being back: no need carries over, today's counts and the last start do.
      entry = { state: saved ? restoreHerNeedState(saved) : createHerNeedState(day), lastTouch: null, sleepingSince: null, wake: null, expressions: true };
      this.characters.set(characterId, entry);
    }
    return entry;
  }

  /** The existing one-second mood tick. */
  tick(characterId: string, input: HerNeedsTickInput): void {
    if (!validId(characterId) || !Number.isFinite(input.now)) return;
    const entry = this.character(characterId, input.day), now = input.now;
    entry.expressions = input.expressions;
    // Waking from a sleep she was seen to have (a bad dream needs a real sleep behind it).
    const sleeping = input.fatigue === 'asleep' || input.fatigue === 'micro-awake';
    if (sleeping && entry.sleepingSince === null) entry.sleepingSince = now;
    else if (!sleeping && entry.sleepingSince !== null) { entry.wake = { at: now, sleptMs: Math.max(0, now - entry.sleepingSince) }; entry.sleepingSince = null; }
    if (entry.wake && now - entry.wake.at > WAKE_KEEP_MS) entry.wake = null;
    // The user did something with her: an interaction the mood model saw, or a contact in progress.
    if (input.phase !== 'idle') entry.lastTouch = Math.max(entry.lastTouch ?? 0, now);
    if (input.lastInteractionAt !== null && Number.isFinite(input.lastInteractionAt) && input.lastInteractionAt <= now)
      entry.lastTouch = Math.max(entry.lastTouch ?? 0, input.lastInteractionAt);
    // Ignored = the app has been open, and nothing from the user, for this long. Days the app was closed add nothing.
    const ignoredMs = Math.max(0, now - Math.max(this.startedAt, entry.lastTouch ?? 0));
    const night = innerLoopQuiet({ phase: input.fatigue ?? null, localMinute: input.localMinute }).night;
    const balance = this.options.balance ? this.options.balance(characterId) : null;
    const result = stepHerNeed(entry.state, { now, day: input.day, expressions: input.expressions, idle: input.canExpress && input.phase === 'idle',
      startedAt: this.startedAt, ...(this.options.trigger ? { trigger: this.options.trigger } : {}), ...(this.options.limits ? { limits: this.options.limits } : {}), balance,
      signals: { now, localMinute: input.localMinute, night, fatiguePhase: input.fatigue, fatigueF: input.fatigueF, boredom: input.boredom, longing: input.longing, ignoredMs,
        mood: input.mood, channels: input.channels, baseline: input.parameters.baseline, weights: input.parameters.weights, wake: entry.wake } }, () => this.random());
    const visible = result.state.active?.id !== entry.state.active?.id || result.state.glow?.id !== entry.state.glow?.id;
    this.commit(characterId, entry, result.state, result.events, now, visible);
    // I-010: a need that began on its own draws from the interaction budget (the test command's startNow never does).
    for (const event of result.events) if (event.type === 'started') {
      try { this.options.spent?.(characterId, event.id, now); } catch { /* Bookkeeping never changes what shows on her. */ }
    }
    // A need faded unanswered: the mood goes down a little (more the more has piled up; mood-loop design). Said nowhere in words.
    for (const event of result.events) if (event.type === 'faded' && event.snubbed && event.dip)
      this.shift(characterId, { id: `need-dip:${event.id}:${now}`, delta: event.dip, reason: '一个人待了一会儿，有点低落' });
  }

  /**
   * The user patted her, fed her or sent a message. Always "the user is here" (another need may come, later); soothes the one she has,
   * and ends 低落 if any had piled up (a relief). Returns the need this soothed, if any.
   */
  interact(characterId: string, kind: HerNeedKind, amount: number, now = this.now()): HerNeedId | null {
    return this.apply(characterId, kind, amount, now)?.soothed ?? null;
  }
  private apply(characterId: string, kind: HerNeedKind, amount: number, now: number): { soothed: HerNeedId | null; relieved: number | null } | null {
    // An invalid amount is rejected before anything is touched: it is not "the user is here" and re-arms nothing (T-112 round-007).
    if (!validId(characterId) || !Number.isFinite(now) || !(amount > 0) || !Number.isFinite(amount)) return null;
    const entry = this.character(characterId, localDateKey(now));
    entry.lastTouch = Math.max(entry.lastTouch ?? 0, now);
    const result = noteHerNeedInteraction(entry.state, kind, amount, now);
    const changed = !!entry.state.active && (result.state.active?.progress !== entry.state.active.progress || !result.state.active) || result.relieved !== null;
    const events: HerNeedEvent[] = result.soothed ? [{ type: 'soothed', id: result.soothed, via: kind }] : [];
    this.commit(characterId, entry, result.state, events, now, changed);
    // The user came after she was left unanswered: 释然, as much as had piled up. Then, if this soothed a need, the comfort too.
    if (result.relieved !== null) {
      try { this.options.journal?.(characterId, { type: 'relieved', relief: result.relieved }); } catch { /* Keeping a record never changes her. */ }
      this.shift(characterId, { id: `need-relief:${now}`, delta: herNeedRelief(result.relieved), reason: '用户来了，松了口气', relief: result.relieved });
    }
    if (result.soothed) this.shift(characterId, { id: `need-soothed:${result.soothed}:${now}`, delta: { ...HER_NEED_TABLE[result.soothed].comfort }, reason: '被用户哄好了' });
    return { soothed: result.soothed, relieved: result.relieved };
  }

  /**
   * Developer test command ("测试：有点闷", electron/test-commands/): she has this small need right now, as if it had just started. It counts
   * for nothing against the day (no start is recorded, so no limit tightens), replaces any need or glow she had, and then lives
   * exactly like a real one: pats, snacks and chat soothe it, left unanswered it fades and leaves her a little down.
   * False: unknown character, or "自动表现" is off (nothing shows then).
   */
  startNow(characterId: string, id: HerNeedId, now = this.now()): boolean {
    if (!validId(characterId) || !isHerNeedId(id) || !Number.isFinite(now)) return false;
    const entry = this.character(characterId, localDateKey(now));
    if (!entry.expressions) return false;
    this.commit(characterId, entry, { ...entry.state, active: { id, since: now, progress: 0, spoke: false, told: false }, glow: null }, [{ type: 'started', id }], now, true);
    return true;
  }

  /** One chat turn: counts as a message to her and returns the one private line for this turn ('' when there is none). */
  chatTurn(characterId: string, now = this.now()): string {
    if (!validId(characterId) || !Number.isFinite(now)) return '';
    const entry = this.character(characterId, localDateKey(now));
    const result = this.apply(characterId, 'chat', 1, now);
    if (!entry.expressions || !result) return '';
    const told = takeHerNeedChatLine(entry.state, result.soothed, result.relieved, now);
    entry.state = told.state;
    return told.line;
  }

  /**
   * Look, don't take (I-020 #10): she has a need she could speak about now, the one speechChance would give. Changes nothing, so the
   * opening choice can weigh it before choosing; a choice that goes to the screen or a listen line leaves the chance for later.
   */
  hasSpeechChance(characterId: string, now = this.now()): boolean {
    const entry = this.characters.get(characterId);
    return !!entry && entry.expressions && peekHerNeedSpeech(entry.state, now) !== null;
  }

  /** The inner loop's one speech chance for the need she has now ('' when there is none or it was given). Consumes the chance. */
  speechChance(characterId: string, now = this.now()): string {
    const entry = this.characters.get(characterId);
    if (!entry || !entry.expressions) return '';
    const taken = takeHerNeedSpeech(entry.state, now);
    entry.state = taken.state;
    return taken.id ? herNeedSpeechLine(taken.id) : '';
  }

  view(characterId: string): HerNeedView | null {
    const entry = this.characters.get(characterId);
    return entry ? herNeedView(entry.state, this.now()) : null;
  }

  /** Developer panel: newest last. */
  recent(): HerNeedDiagnostic[] { return this.recentDiagnostics.map(entry => ({ ...entry })); }

  private shift(characterId: string, shift: HerNeedMoodShift): void {
    try { this.options.lift(characterId, shift); } catch { /* A mood that cannot be shifted just stays as it is; what shows on her still shows. */ }
  }

  private commit(characterId: string, entry: Character, state: HerNeedState, events: readonly HerNeedEvent[], now: number, visible: boolean): void {
    const before = entry.state;
    entry.state = state;
    // The file holds the day's starts, the interaction counts and the 被晾过 memory; patting changes the counts all the time, so only whole steps save.
    if (before.day !== state.day || before.lastStartAt !== state.lastStartAt || before.used.length !== state.used.length
      || Math.floor(before.interactions) !== Math.floor(state.interactions) || Object.keys(before.snubs).join() !== Object.keys(state.snubs).join()
      || Object.values(before.snubs).map(snub => snub.at).join() !== Object.values(state.snubs).map(snub => snub.at).join()) this.scheduleSave();
    for (const event of events) {
      this.diagnose({ at: now, type: event.type, id: event.id, ...(event.via ? { via: event.via } : {}), ...(event.snubbed ? { snubbed: true } : {}) });
      try { this.options.journal?.(characterId, event); } catch { /* Keeping a record never changes her. */ }
    }
    if (visible || events.length) { try { this.options.changed(characterId); } catch { /* A closed window just misses this update. */ } }
  }

  private diagnose(entry: HerNeedDiagnostic): void {
    let enabled = false;
    try { enabled = this.options.developerMode() === true; } catch { enabled = false; }
    if (!enabled) return;
    this.recentDiagnostics.push(entry);
    while (this.recentDiagnostics.length > 20) this.recentDiagnostics.shift();
    let file: string | null = null;
    try { file = this.options.diagnosticsFile(); } catch { file = null; }
    if (file) void (this.options.append ?? appendBounded)(file, JSON.stringify(entry) + '\n').catch(() => {});
  }

  private scheduleSave(): void {
    if (this.loaded === 'blocked' || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush(); }, 1_000);
    this.saveTimer.unref?.();
  }

  /** Writes now (tests and the quit path); a failed write is retried by the next change. */
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.options.file();
    // Never write before the stored file was read (or found missing), and never over an unreadable one.
    if (!file || this.loaded !== 'ready') return;
    const characters: Record<string, HerNeedSaved> = Object.fromEntries(this.saved);
    for (const [id, entry] of this.characters) characters[id] = serializeHerNeedState(entry.state);
    const data = JSON.stringify({ version: 1, characters });
    const write = this.options.write ?? atomicWriteFile;
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await write(file, data); }).catch(() => {});
    await this.queue;
  }

  /** A pending save is written now and a write in flight is awaited; unchanged state writes nothing (CompanionService.flush). */
  settle(): Promise<void> { return this.saveTimer ? this.flush() : this.queue; }

  dispose(): void { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } }
}

