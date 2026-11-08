import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MemoryScope } from '../../shared/memory';
import {
  NEUTRAL_TENDENCIES, RELATIONSHIP_LIMITS, RELATIONSHIP_STAGES, classifyNicknameReply, cleanNickname, dayNumber, effectiveDays, milestoneFor,
  relationshipOpeningText, relationshipSessionTag, sanitizeRelationshipDiagnostic, stageAtLeast, stageProgress, stageThresholds,
  withBackfill, withFreshStart, withQuality, withRound, withTouch,
  type RelationshipData, type RelationshipDiagnostic, type RelationshipDiagnosticKind, type RelationshipStage, type RelationshipView, type Tendencies,
} from '../../shared/relationship';
import { localDateKey } from '../diary/diary-dates';
import type { AtomicFileWriter } from '../atomic-file';
import { appendBounded } from '../reply-latency';
import { RelationshipStore } from './store';

/** What the host needs from the character card; null while the card is unknown (then: the default, familiar from day one). */
export interface RelationshipCard { slowWarmUp: boolean; tendencies: Tendencies }

/** Older chats of one chat scope, for the one-time backfill (electron/memory.ts `chatActivity`). */
export interface ChatActivity { first: number | null; rounds: ReadonlyMap<string, number> }

export interface RelationshipOpening {
  /** The lines placed right after the persona when a session opens. */
  text: string;
  /** Changes when the session must restart (switch, stage, nickname), not when the day number does. */
  tag: string;
  /** The memes of her diary may ride along (default: always; slowly warming up: from "熟悉"). */
  memes: boolean;
}

export interface RelationshipNicknameContext {
  conversationId: string;
  /** Her current read of the user (shared/user-state.ts), or null. */
  userState: string | null;
}

export interface RelationshipHostOptions {
  directory: string;
  now?: () => number;
  developerMode(): boolean;
  /** The developer-panel numbers changed. */
  changed?(characterId: string): void;
  write?: AtomicFileWriter;
  diagnosticsWrite?: (file: string, line: string) => Promise<void>;
  /** 体验记录 (electron/journal/sources.ts relationshipInput): the same numbers, in every mode (never the nickname). */
  journal?(characterId: string, entry: RelationshipDiagnostic): void;
}

const HEAVY_STATES = new Set(['low', 'annoyed', 'tired']);

/**
 * 熟悉度 policy (docs/claude/2026-11-02-familiarity-plan.md). Counts real days, decides what the
 * session-opening lines say, runs the one-time nickname question and keeps the developer numbers.
 * The default is familiar from the first day: stages exist only for a card that switched
 * "关系慢慢升温" on, and nothing here ever goes down.
 */
export class RelationshipHost {
  private readonly store: RelationshipStore;
  private readonly clock: () => number;
  private cardSource: (characterId: string) => RelationshipCard | null = () => null;
  private stageOverride: RelationshipStage | null = null;
  private pending: { characterId: string; conversationId: string; nickname: string } | null = null;
  private readonly offered = new Set<string>();
  private offeredDay = '';

  constructor(private readonly options: RelationshipHostOptions) {
    this.clock = options.now ?? Date.now;
    this.store = new RelationshipStore(options.directory, { today: () => this.today(), ...(options.write ? { write: options.write } : {}) });
  }

  setCardSource(source: (characterId: string) => RelationshipCard | null): void { this.cardSource = source; }
  private today(): string { return localDateKey(this.clock()); }
  private card(characterId: string): RelationshipCard {
    try { return this.cardSource(characterId) ?? { slowWarmUp: false, tendencies: { ...NEUTRAL_TENDENCIES } }; }
    catch { return { slowWarmUp: false, tendencies: { ...NEUTRAL_TENDENCIES } }; }
  }

  // ---- the numbers ----

  /** Reads this character's file (nothing is counted); the panels and the nickname need the numbers before a first chat. */
  async ensure(characterId: string): Promise<void> {
    try { await this.store.load(characterId); this.changed(characterId); } catch { /* A missing file simply starts today. */ }
  }

  /** Loads this character's file and, once per chat scope, counts the chats that already exist. */
  async prepare(scope: MemoryScope, activity: (dayOf: (ms: number) => string) => ChatActivity): Promise<void> {
    const id = scope.characterId;
    await this.store.load(id);
    const key = createHash('sha256').update(JSON.stringify([id, scope.providerScope])).digest('hex').slice(0, 24);
    if (this.store.peek(id)?.backfilled.includes(key)) return;
    let found: ChatActivity = { first: null, rounds: new Map() };
    try { found = activity(ms => localDateKey(ms)); } catch { /* Counting simply starts today. */ }
    const first = found.first === null ? null : localDateKey(found.first);
    const before = this.store.peek(id);
    const data = await this.store.update(id, current => withBackfill(withFreshStart(current, this.today()), key, first, found.rounds));
    this.record(id, 'backfill', data);
    if (before && data.days.length !== before.days.length) this.afterChange(id, before, data);
    this.changed(id);
  }

  /** Evaluation seam only (scripts/lib/prompt-eval-runner.ts): replaces a character's numbers. The app never calls it. */
  async seed(characterId: string, data: RelationshipData): Promise<void> {
    await this.store.load(characterId);
    // The scopes already scanned stay scanned, so an older chat the scenario plants cannot move the seeded numbers.
    await this.store.update(characterId, current => ({ ...structuredClone(data), backfilled: current.backfilled }));
  }

  noteRound(characterId: string): Promise<void> { return this.change(characterId, 'day', data => withRound(data, this.today())); }
  /** A touch, a cheek pinch or a feeding. */
  noteTouch(characterId: string): Promise<void> { return this.change(characterId, 'day', data => withTouch(data, this.today())); }
  /** A quality moment today, or on `date` (the day a diary entry was written for). */
  noteQuality(characterId: string, date: string = this.today()): Promise<void> { return this.change(characterId, 'quality', data => withQuality(data, date)); }

  private async change(characterId: string, kind: RelationshipDiagnosticKind, change: (data: RelationshipData) => RelationshipData): Promise<void> {
    try {
      const before = this.store.peek(characterId) ?? await this.store.load(characterId);
      const data = await this.store.update(characterId, change);
      const grew = data.days.length !== before.days.length || data.qualityDays.length !== before.qualityDays.length;
      if (grew) { this.record(characterId, kind, data); this.afterChange(characterId, before, data); this.changed(characterId); }
    } catch { /* Counting never blocks a reply. */ }
  }

  private afterChange(characterId: string, before: RelationshipData, after: RelationshipData): void {
    const card = this.card(characterId);
    if (!card.slowWarmUp) return;
    const a = this.stageFor(before, card), b = this.stageFor(after, card);
    if (a !== b) this.record(characterId, 'stage', after);
  }

  private stageFor(data: RelationshipData, card: RelationshipCard): RelationshipStage {
    return stageProgress(effectiveDays(data), stageThresholds(card.tendencies)).stage;
  }
  /** The stage in use: the hand-set one in developer mode, else the real one; null when the card does not warm up slowly. */
  stage(characterId: string): RelationshipStage | null {
    const card = this.card(characterId), data = this.store.peek(characterId);
    if (!card.slowWarmUp || !data) return null;
    if (this.stageOverride && this.options.developerMode()) return this.stageOverride;
    return this.stageFor(data, card);
  }

  view(characterId: string): RelationshipView | null {
    const data = this.store.peek(characterId);
    if (!data) return null;
    const card = this.card(characterId), effective = effectiveDays(data);
    const base = { dayNumber: dayNumber(data.metDate, this.today()), togetherDays: data.days.length, qualityDays: data.qualityDays.filter(date => data.days.includes(date)).length,
      effectiveDays: effective, slowWarmUp: card.slowWarmUp, hasNickname: data.nickname !== null, nicknameAsked: data.nicknameAsked };
    if (!card.slowWarmUp) return base;
    const thresholds = stageThresholds(card.tendencies), progress = stageProgress(effective, thresholds);
    const overridden = this.stageOverride !== null && this.options.developerMode();
    return { ...base, stage: overridden ? this.stageOverride! : progress.stage, nextStage: progress.next, daysToNext: progress.daysToNext, thresholds, ...(overridden ? { overridden } : {}) };
  }

  /** Developer mode only; kept until the app restarts. */
  setStageOverride(stage: unknown): void {
    if (!this.options.developerMode()) throw Error('只有开发者模式可以临时改变关系阶段。');
    if (stage !== null && !(RELATIONSHIP_STAGES as readonly unknown[]).includes(stage)) throw Error('关系阶段不正确。');
    this.stageOverride = stage as RelationshipStage | null;
    this.options.changed?.('');
  }

  // ---- what she is told ----

  /**
   * The relationship lines for a session that is about to open. `firstTurn` is the first message of a
   * conversation: only then can a milestone be added, and only once that day.
   */
  opening(characterId: string, options: { firstTurn: boolean }): RelationshipOpening | null {
    const data = this.store.peek(characterId);
    if (!data) return null;
    const card = this.card(characterId), today = this.today();
    const stage = this.stage(characterId) ?? undefined;
    let milestone = options.firstTurn ? milestoneFor(data.metDate, today) : null;
    const mark = milestone ? `${today}#${milestone.key}` : '';
    if (milestone && data.milestones.includes(mark)) milestone = null;
    if (milestone) {
      void this.store.update(characterId, current => ({ ...current, milestones: [...current.milestones, mark].slice(-RELATIONSHIP_LIMITS.milestones) }))
        .then(updated => this.record(characterId, 'milestone', updated)).catch(() => {});
    }
    const input = { dayNumber: dayNumber(data.metDate, today), slowWarmUp: card.slowWarmUp, ...(stage ? { stage } : {}), nickname: data.nickname, herNickname: data.herNickname, milestone };
    return { text: relationshipOpeningText(input), tag: relationshipSessionTag(input), memes: this.memesAllowed(characterId) };
  }

  /** Memes ride along by default from the first day; a slowly warming card holds them back until "熟悉". */
  memesAllowed(characterId: string): boolean {
    const card = this.card(characterId);
    if (!card.slowWarmUp) return true;
    const stage = this.stage(characterId);
    return stage !== null && stageAtLeast(stage, 'familiar');
  }

  // ---- nickname: she asks once, only a clear yes saves it ----

  /** May this turn's reply tail carry the one-time nickname question? Marks the offer, so it is made at most once per conversation and day. */
  nicknameAsk(characterId: string, context: RelationshipNicknameContext): boolean {
    const data = this.store.peek(characterId);
    if (!data || data.nicknameAsked || data.nickname) return false;
    const card = this.card(characterId), stage = this.stage(characterId);
    if (card.slowWarmUp && (stage === null || !stageAtLeast(stage, 'warming'))) return false;
    if (context.userState && HEAVY_STATES.has(context.userState)) return false;
    // Not in the very first exchange of the day: she has talked with the user a little first.
    if (data.today.date !== this.today() || data.today.rounds < 2) return false;
    if (this.offered.has(context.conversationId) || this.offeredDay === this.today()) return false;
    this.offered.add(context.conversationId);
    if (this.offered.size > 64) this.offered.delete(this.offered.values().next().value!);
    this.offeredDay = this.today();
    return true;
  }

  /** The finished reply asked about `raw` (its tail's `nick`). From now on she never asks again. */
  captureNicknameAsk(characterId: string, conversationId: string, raw: unknown): void {
    const nickname = cleanNickname(raw);
    if (!nickname) return;
    this.pending = { characterId, conversationId, nickname };
    void this.store.update(characterId, data => ({ ...data, nicknameAsked: true }))
      .then(data => { this.record(characterId, 'nickname-ask', data); this.changed(characterId); }).catch(() => {});
  }

  /**
   * The user's very next message after the question. Only a plain yes saves the nickname; a no, a
   * different subject or silence (any later message) saves nothing, and she does not ask again.
   */
  async resolveNickname(characterId: string, conversationId: string, text: string): Promise<'saved' | 'declined' | 'ignored' | null> {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    if (pending.characterId !== characterId || pending.conversationId !== conversationId) return 'ignored';
    const verdict = classifyNicknameReply(text);
    if (verdict === 'affirm') {
      const data = await this.store.update(characterId, current => ({ ...current, nickname: pending.nickname, nicknameAsked: true }));
      this.record(characterId, 'nickname-saved', data); this.changed(characterId);
      return 'saved';
    }
    const data = this.store.peek(characterId);
    if (data) this.record(characterId, verdict === 'refuse' ? 'nickname-declined' : 'nickname-ignored', data);
    return verdict === 'refuse' ? 'declined' : 'ignored';
  }
  /** A question that was asked but never answered (the conversation changed) is dropped. */
  dropPendingNickname(): void { this.pending = null; }

  nickname(characterId: string): string | null { return this.store.peek(characterId)?.nickname ?? null; }
  herNickname(characterId: string): string | null { return this.store.peek(characterId)?.herNickname ?? null; }

  /**
   * The user said how they want to be called ("叫我 Y"): their own words are the consent, so it is saved without asking. The newest
   * explicit request wins (the journal then says 'nickname-changed'); the same name again changes nothing and restarts nothing.
   */
  async noteUserNickname(characterId: string, raw: unknown): Promise<'saved' | 'changed' | 'same' | 'invalid'> {
    const nickname = cleanNickname(raw);
    if (!nickname) return 'invalid';
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (before.nickname === nickname) return 'same';
    if (this.pending?.characterId === characterId) this.pending = null; // The user answered the question by themselves.
    const data = await this.store.update(characterId, current => ({ ...current, nickname, nicknameAsked: true }));
    this.record(characterId, before.nickname ? 'nickname-changed' : 'nickname-saved', data); this.changed(characterId);
    return before.nickname ? 'changed' : 'saved';
  }

  /** The user gave her a nickname (or keeps using one): she remembers it from now on. The newest wins; the same one changes nothing. */
  async noteHerNickname(characterId: string, raw: unknown): Promise<'saved' | 'same' | 'invalid'> {
    const herNickname = cleanNickname(raw);
    if (!herNickname) return 'invalid';
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (before.herNickname === herNickname) return 'same';
    const data = await this.store.update(characterId, current => ({ ...current, herNickname }));
    this.record(characterId, 'her-nickname-saved', data); this.changed(characterId);
    return 'saved';
  }

  /** The profile panel: view / change / delete. `null` clears it; deleting never makes her ask again. */
  async setNickname(characterId: string, value: unknown): Promise<string | null> {
    const nickname = value === null ? null : cleanNickname(value);
    if (value !== null && nickname === null) throw Error('称呼需要是 1 到 8 个字的普通文字。');
    await this.store.load(characterId);
    const data = await this.store.update(characterId, current => ({ ...current, nickname, nicknameAsked: true }));
    this.record(characterId, 'nickname-changed', data); this.changed(characterId);
    return data.nickname;
  }

  /**
   * C2 角色页: "认识第 N 天" for a card, read only (nothing is counted). null while they have not chatted yet: no
   * counted day, no round today and no earlier chats scanned.
   */
  async knownDay(characterId: string): Promise<number | null> {
    const data = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (!data.days.length && !data.today.rounds && !data.qualityDays.length && !data.backfilled.length) return null;
    return dayNumber(data.metDate, this.today());
  }
  /** C2 删除角色时"同时删除她的记忆": the days they have known each other and her name for the user go. */
  async forget(characterId: string): Promise<void> {
    if (this.pending?.characterId === characterId) this.pending = null;
    await this.store.forget(characterId);
    this.changed(characterId);
  }

  // ---- diagnostics ----

  private record(characterId: string, kind: RelationshipDiagnosticKind, data: RelationshipData): void {
    try {
      const card = this.card(characterId);
      const entry = sanitizeRelationshipDiagnostic({ at: this.clock(), kind, dayNumber: dayNumber(data.metDate, this.today()), togetherDays: data.days.length,
        qualityDays: data.qualityDays.length, ...(card.slowWarmUp ? { stage: this.stageFor(data, card) } : {}) } satisfies RelationshipDiagnostic);
      if (!entry) return;
      try { this.options.journal?.(characterId, entry); } catch { /* Keeping a record never blocks a reply. */ }
      if (!this.options.developerMode()) return;
      const file = path.join(this.options.directory, 'dev', 'relationship.jsonl');
      void (this.options.diagnosticsWrite ?? appendBounded)(file, JSON.stringify(entry) + '\n').catch(() => {});
    } catch { /* Diagnostics never block a reply. */ }
  }
  private changed(characterId: string): void { try { this.options.changed?.(characterId); } catch { /* A closed panel misses one update. */ } }

  flush(): Promise<void> { return this.store.flush(); }
}
