import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { appendBounded } from '../reply-latency';
import type { FatiguePhase } from '../../shared/fatigue';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters, type MoodPhase } from '../../shared/mood';
import {
  HER_LIFE_LINE_TTL_MS, HER_LIFE_LOG_KEEP_MS, HER_LIFE_LOG_MAX, herLifeChatLine, herLifeDiaryLine, herLifeIdleAfterMs, herLifeSwitchOffer,
  herLifeLookUpStyle, isHerLifeActivity, noteHerLifeReturn, pickHerLifeActivity, readHerLifeLog, readHerLifeRecord, startHerLife, stepHerLife,
  type HerLifeActivity, type HerLifeBusy, type HerLifeLogEntry, type HerLifeLookUpKind, type HerLifeLookUpStyle, type HerLifeRecord, type HerLifeSwitchOffer, type HerLifeView,
  type HerLifeWatchKind,
} from '../../shared/her-life';

/** What one host tick reads (CompanionService.herLifeTick builds it from the mood view). */
export interface HerLifeTickInput {
  now: number;
  /** "自动表现" (MoodView.expressions). */
  expressions: boolean;
  /** The existing companionCanExpress gate: visible, no typing, chat, speech or drag. */
  canExpress: boolean;
  phase: MoodPhase;
  /** MoodSnapshot.lastInteractionAt: the last chat, pat or feeding. */
  lastInteractionAt: number | null;
  fatigue: FatiguePhase | null | undefined;
  parameters: Pick<MoodParameters, 'frequency' | 'weights'>;
  mood: string | null | undefined;
  localMinute: number;
  /** I-006: the user is absorbed (shared/behaviors/user-activity/effects.ts herLifeBusy); absent = not. Read only to weigh and lengthen her own things. */
  busy?: HerLifeBusy;
  /** I-006 step 3: what the user is watching or playing on the shared screen (screen sharing on, the rough look says so); absent = nothing she follows. */
  watch?: HerLifeWatchKind;
}

/** One developer diagnostic line: state names and times only. */
export interface HerLifeDiagnostic { at: number; from: HerLifeActivity; to: HerLifeActivity; until: number | null }

interface Character {
  record: HerLifeRecord;
  log: HerLifeLogEntry[];
  /** The last interaction this host has seen (mood's lastInteractionAt, or a direct note); null = never. */
  lastSeen: number | null;
  primed: boolean;
  /** The card's "away long enough" (herLifeIdleAfterMs), refreshed every tick. */
  idleAfterMs: number;
  /** Her mood and her card's tendency weights as of the last tick: how she looks up (herLifeLookUpStyle). */
  mood: string | null | undefined;
  weights: MoodParameters['weights'] | null;
  lookUp: { id: string; at: number; style: HerLifeLookUpStyle } | null;
  /** The look she gave last time, so the next one differs. */
  lookUpKind: HerLifeLookUpKind | null;
  line: { text: string; at: number } | null;
  /** `since` of a state a developer test command started: its time never reaches the diary material. */
  testSince: number | null;
  /** I-006 step 3 (memory only): what she follows as of the last tick, and the kind she last had the chance to turn to. */
  watchNow: HerLifeWatchKind | null;
  watchSeen: HerLifeWatchKind | null;
}

export interface HerLifeHostOptions {
  /** `<profile>/her-life.json`; null keeps everything in memory. */
  file: () => string | null;
  /** `<profile>/dev/her-life.jsonl`, written in developer mode only. */
  diagnosticsFile: () => string | null;
  developerMode: () => boolean;
  /** Her state for this character changed (the mood view republishes it). */
  changed: (characterId: string) => void;
  clock?: () => number;
  random?: () => number;
  write?: AtomicFileWriter;
  append?: (file: string, line: string) => Promise<void>;
  /** 体验记录 (electron/journal/sources.ts herLifeInput): every change of what she is doing, in every mode. */
  journal?: (characterId: string, entry: HerLifeDiagnostic, test: boolean) => void;
  /** P1 第二阶段: her own small moments while the user was at the computer (electron/pose-reactions/host.ts diaryLine), '' when none. */
  moments?: (characterId: string, start: number, end: number) => string;
}

const LOOK_UP_MS = 5_000;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

/**
 * 她自己的生活, host side (docs/claude/2026-11-02-her-life.md): one record per character (what she is doing,
 * since when, until about when), persisted in `<profile>/her-life.json` with a short log for the diary.
 * Driven by the existing one-second mood tick; owns no timer except a debounced save.
 */
export class HerLifeHost {
  private readonly characters = new Map<string, Character>();
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly recentDiagnostics: HerLifeDiagnostic[] = [];
  constructor(private readonly options: HerLifeHostOptions) {}

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private random(): number { return (this.options.random ?? Math.random)(); }

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const rows = value?.characters;
      if (!value || value.version !== 1 || !rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Invalid her-life file');
      for (const [id, row] of Object.entries(rows as Record<string, unknown>).slice(0, 128)) {
        if (!validId(id) || !row || typeof row !== 'object' || Array.isArray(row) || this.characters.has(id)) continue;
        const record = readHerLifeRecord((row as Record<string, unknown>).record);
        // Reopened: she carries on with what she was doing; the tick replaces it once its time is up.
        if (record) this.characters.set(id, this.fresh(record, readHerLifeLog((row as Record<string, unknown>).log)));
      }
      this.loaded = 'ready';
    } catch (error) {
      // Missing: a first launch. Unreadable: keep the user's file untouched and run in memory only.
      this.loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  private fresh(record: HerLifeRecord, log: HerLifeLogEntry[] = []): Character {
    return { record, log, lastSeen: null, primed: false, idleAfterMs: herLifeIdleAfterMs(DEFAULT_MOOD_PARAMETERS), mood: null, weights: null, lookUp: null, lookUpKind: null, line: null, testSince: null, watchNow: null, watchSeen: null };
  }
  private character(characterId: string, now: number): Character {
    let entry = this.characters.get(characterId);
    // A new character keeps the user company until the user has been away once.
    if (!entry) this.characters.set(characterId, entry = this.fresh({ activity: 'company', since: now, until: now, source: 'start' }));
    return entry;
  }

  /** The existing one-second mood tick. */
  tick(characterId: string, input: HerLifeTickInput): void {
    if (!validId(characterId) || !Number.isFinite(input.now)) return;
    const entry = this.character(characterId, input.now);
    entry.idleAfterMs = herLifeIdleAfterMs(input.parameters); entry.mood = input.mood; entry.weights = input.parameters.weights ?? null;
    if (!entry.primed) { entry.primed = true; entry.lastSeen = input.lastInteractionAt; }
    // Any interaction the mood model saw (a pat, feeding, a chat) counts, even one no caller reported directly.
    if (input.phase !== 'idle') this.interact(characterId, input.now);
    else if (input.lastInteractionAt !== null && Number.isFinite(input.lastInteractionAt) && (entry.lastSeen === null || input.lastInteractionAt > entry.lastSeen))
      this.interact(characterId, input.lastInteractionAt);
    // I-006 step 3: she may turn to a new kind of watching at once (once per kind); the stage hears when it starts or ends.
    const watching = input.watch ?? null, watch = watching ? { kind: watching, ...(entry.watchSeen !== watching ? { fresh: true as const } : {}) } : undefined;
    const watchChanged = entry.watchNow !== watching;
    entry.watchNow = watching;
    const { record, reason } = stepHerLife(entry.record, { now: input.now, expressions: input.expressions, idle: this.idle(entry, input),
      fatigue: input.fatigue, parameters: input.parameters, mood: input.mood, localMinute: input.localMinute, ...(input.busy ? { busy: input.busy } : {}),
      ...(watch ? { watch } : {}) }, () => this.random());
    if (reason !== 'frozen' && reason !== 'busy') entry.watchSeen = watching;
    if (record !== entry.record) this.commit(characterId, entry, record, input.now);
    else if (watchChanged && (entry.record.activity === 'watching' || !watching)) { try { this.options.changed(characterId); } catch { /* A closed window just misses this update. */ } }
  }

  private idle(entry: Character, input: Pick<HerLifeTickInput, 'now' | 'canExpress' | 'phase'>): boolean {
    const away = entry.lastSeen === null ? Infinity : input.now - entry.lastSeen;
    return input.canExpress && input.phase === 'idle' && away >= entry.idleAfterMs;
  }

  /**
   * The user just interacted (typing, chat, a touch, feeding). Returns true when she was at her own thing: she looks up
   * from it (in a way of her own this time) and the next chat turn gets one line about what she was doing.
   */
  interact(characterId: string, now = this.now()): boolean {
    if (!validId(characterId) || !Number.isFinite(now)) return false;
    const entry = this.character(characterId, now);
    entry.primed = true;
    entry.lastSeen = entry.lastSeen === null ? now : Math.max(entry.lastSeen, now);
    const result = noteHerLifeReturn(entry.record, now);
    if (result.record === entry.record) return false;
    if (result.lookUp) {
      const style = herLifeLookUpStyle({ from: entry.record.activity, mood: entry.mood, weights: entry.weights, previous: entry.lookUpKind }, () => this.random());
      entry.lookUpKind = style.kind;
      entry.lookUp = { id: randomUUID(), at: now, style };
    }
    const line = herLifeChatLine(result.interrupted);
    entry.line = line ? { text: line, at: now } : null;
    this.commit(characterId, entry, result.record, now);
    return result.lookUp;
  }

  /** One chat turn: notes the interaction and returns its one-turn line ('' when there is none). Taken once. */
  chatTurn(characterId: string, now = this.now()): string {
    this.interact(characterId, now);
    const entry = this.characters.get(characterId), line = entry?.line;
    if (!entry || !line) return '';
    entry.line = null;
    return now - line.at <= HER_LIFE_LINE_TTL_MS ? line.text : '';
  }

  /** "换件事做" for the inner loop's motion opportunity, or null. */
  offer(characterId: string, input: Omit<HerLifeTickInput, 'mood' | 'localMinute' | 'lastInteractionAt'>): HerLifeSwitchOffer | null {
    const entry = this.characters.get(characterId);
    if (!entry || !Number.isFinite(input.now)) return null;
    return herLifeSwitchOffer(entry.record, { now: input.now, expressions: input.expressions, idle: this.idle(entry, input),
      fatigue: input.fatigue, parameters: input.parameters });
  }

  /** The inner loop chose; applied only if the same offer still stands. */
  switchTo(characterId: string, activity: unknown, input: Omit<HerLifeTickInput, 'mood' | 'localMinute' | 'lastInteractionAt'>): boolean {
    const offer = this.offer(characterId, input);
    if (!offer || !isHerLifeActivity(activity) || !offer.choices.includes(activity)) return false;
    const entry = this.characters.get(characterId)!;
    this.commit(characterId, entry, startHerLife(activity, input.now, 'inner', input.parameters, () => this.random()), input.now);
    return true;
  }

  /**
   * Developer test command (electron/test-commands/): start a state right now. `null` lets her pick one of her own things
   * (never "陪着你") by the same weights the host tick uses. The user is here, so it simply holds until the user interacts (she looks up and goes
   * back to "陪着你") or has been away long enough for the rules to take over. Its time is not written into the diary material.
   */
  startNow(characterId: string, activity: HerLifeActivity | null, input: Pick<HerLifeTickInput, 'parameters' | 'mood' | 'localMinute'>): HerLifeActivity | null {
    if (!validId(characterId) || (activity !== null && !isHerLifeActivity(activity)) || activity === 'watching') return null; // 跟着看 needs something real to follow
    const now = this.now(), entry = this.character(characterId, now);
    // "去忙自己的事" (pretrial issue 10): one of her own things by her own weights, never "陪着你".
    const chosen = activity ?? pickHerLifeActivity({ current: entry.record.activity, localMinute: input.localMinute, mood: input.mood, weights: input.parameters.weights, ownOnly: true }, () => this.random());
    // "陪着你" has no end of its own, exactly as after a return; the others run the card's own duration.
    const record: HerLifeRecord = chosen === 'company'
      ? { activity: 'company', since: now, until: Number.MAX_SAFE_INTEGER, source: 'return' }
      : startHerLife(chosen, now, 'rule', input.parameters, () => this.random());
    entry.primed = true;
    entry.mood = input.mood; entry.weights = input.parameters.weights ?? null;
    this.commit(characterId, entry, record, now, true);
    return chosen;
  }

  view(characterId: string): HerLifeView | null {
    const entry = this.characters.get(characterId);
    if (!entry) return null;
    const now = this.now(), lookUp = entry.lookUp && now - entry.lookUp.at <= LOOK_UP_MS ? { ...entry.lookUp, style: { ...entry.lookUp.style } } : null;
    // I-006 step 3: "跟着看" shows only while what she follows is still there (sharing may have gone off since the last change of state).
    const following = entry.record.activity === 'watching';
    if (following && entry.watchNow) return { activity: 'watching', since: entry.record.since, until: entry.record.until, source: entry.record.source, lookUp, watch: { kind: entry.watchNow } };
    return { activity: following ? 'company' : entry.record.activity, since: entry.record.since, until: entry.record.until, source: entry.record.source, lookUp };
  }

  /** One material line for that day's diary ('' when nothing lasted long enough). */
  diaryLine(characterId: string, start: number, end: number, localMinute: (ms: number) => number): string {
    const entry = this.characters.get(characterId);
    if (!entry) return '';
    const current = { activity: entry.record.activity, from: entry.record.since, to: Math.max(entry.record.since, Math.min(this.now(), end)) };
    let moments = '';
    try { moments = this.options.moments?.(characterId, start, end) ?? ''; } catch { moments = ''; }
    return [herLifeDiaryLine([...entry.log, current], start, end, localMinute), moments].filter(Boolean).join('\n');
  }

  /** Developer panel: newest last. */
  recent(): HerLifeDiagnostic[] { return this.recentDiagnostics.map(entry => ({ ...entry })); }

  private commit(characterId: string, entry: Character, record: HerLifeRecord, now: number, test = false): void {
    const previous = entry.record;
    if (previous.activity !== record.activity || previous.since !== record.since) {
      // Following the shared screen is never written down (not here, not in the diary material): only the category lives in memory.
      if (now > previous.since && entry.testSince !== previous.since && previous.activity !== 'watching') entry.log.push({ activity: previous.activity, from: previous.since, to: now });
      entry.testSince = test ? record.since : null;
      entry.log = entry.log.filter(row => now - row.to <= HER_LIFE_LOG_KEEP_MS).slice(-HER_LIFE_LOG_MAX);
      const change = { at: now, from: previous.activity, to: record.activity, until: record.until >= Number.MAX_SAFE_INTEGER ? null : record.until };
      this.diagnose(change);
      try { this.options.journal?.(characterId, change, test); } catch { /* Keeping a record never changes what she does. */ }
    }
    entry.record = record;
    this.scheduleSave();
    try { this.options.changed(characterId); } catch { /* A closed window just misses this update. */ }
  }

  private diagnose(entry: HerLifeDiagnostic): void {
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
    const characters: Record<string, { record: HerLifeRecord; log: HerLifeLogEntry[] }> = {};
    // "跟着看" is not saved: reopened, she simply starts with her own things (the record would otherwise say what the user was watching).
    for (const [id, entry] of this.characters) characters[id] = { record: entry.record.activity === 'watching' ? { activity: 'company', since: entry.record.since, until: entry.record.since, source: 'start' } : { ...entry.record },
      log: entry.log.map(row => ({ ...row })) };
    const data = JSON.stringify({ version: 1, characters });
    const write = this.options.write ?? atomicWriteFile;
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await write(file, data); }).catch(() => {});
    await this.queue;
  }

  /** A pending save is written now and a write in flight is awaited; unchanged state writes nothing (CompanionService.flush). */
  settle(): Promise<void> { return this.saveTimer ? this.flush() : this.queue; }

  dispose(): void { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } }
}
