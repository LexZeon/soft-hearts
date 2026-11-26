import { createHash, randomUUID } from 'node:crypto';
import { chatLanguageSessionLine } from '../../../shared/brain';
import { slowWarmUpOf, type CardLanguage, type CharacterCard } from '../../../shared/foundation/character-card';
import { NOTE_LIMITS, cleanNoteText, effectiveCharacterMood, planNewNotes } from '../../../shared/cards';
import path from 'node:path';
import type { MemoryScope } from '../../../shared/memory/memory';
import {
  NEUTRAL_TENDENCIES, RELATIONSHIP_LIMITS, isDateKey, RELATIONSHIP_STAGES, classifyNicknameReply, cleanNickname, dayNumber, effectiveDays, milestoneFor,
  relationshipOpeningText, relationshipSessionTag, sanitizeRelationshipDiagnostic, stageAtLeast, stageProgress, stageReference, stageThresholds, todayLine,
  withBackfill, withFreshStart, withQuality, withRound, withTouch,
  type ObjectNote, type RelationshipData, type RelationshipDiagnostic, type RelationshipDiagnosticKind, type RelationshipStage, type RelationshipView, type Tendencies,
} from '../../../shared/memory/relationship';
import { localDateKey } from '../diary/diary-dates';
import type { AtomicFileWriter } from '../../foundation/atomic-file';
import { appendBounded } from '../../brain';
import { RelationshipStore, readObjectNotes, validateRelationship } from './store';
import { HER_NICKNAMES_MAX, withHerNickname, withoutHerNickname } from '../../../shared/memory/nickname-table';

/** The names the user calls her: the table, or (older files) the one name. */
const herNicknameList = (data: Pick<RelationshipData, 'herNickname' | 'herNicknames'>): string[] => data.herNicknames ? [...data.herNicknames] : data.herNickname ? [data.herNickname] : [];

/** The id a chat scope's backfill is remembered by in the relationship file (once per character and connection). */
export function relationshipBackfillKey(scope: MemoryScope): string {
  return createHash('sha256').update(JSON.stringify([scope.characterId, scope.providerScope])).digest('hex').slice(0, 24);
}

/** What the host needs from the character card; null while the card is unknown (then: the default, familiar from day one). */
export interface RelationshipCard { slowWarmUp: boolean; tendencies: Tendencies }
/**
 * The host's view of a stored character card (the wiring's card source). 慢慢熟悉 is on unless the card saved an explicit off
 * the stage then comes from the numbers already on file, so turning it on never resets a relationship.
 */
export function relationshipCardOf(card: (Pick<CharacterCard, 'mood'> & { slowWarmUp?: boolean }) | null | undefined): RelationshipCard | null {
  return card ? { slowWarmUp: slowWarmUpOf(card), tendencies: { ...effectiveCharacterMood(card).weights } } : null;
}
/** I-144b: a deleted nickname as the bin keeps it (RelationshipHost.nicknameCopy). */
export interface NicknamePart { nickname: string; nicknameAsked: boolean }

/** Older chats of one chat scope, for the one-time backfill (electron/memory/memory.ts `chatActivity`). */
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
  /** Her current read of the user (shared/senses/user-state.ts), or null. */
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
  /** 体验记录 (electron/memory/journal/sources.ts relationshipInput): the same numbers, in every mode (never the nickname). */
  journal?(characterId: string, entry: RelationshipDiagnostic): void;
}

const HEAVY_STATES = new Set(['low', 'annoyed', 'tired']);

/**
 * 熟悉度 policy (docs/claude/2026-11-02-familiarity-plan.md). Counts real days, decides what the
 * session-opening lines say, runs the one-time nickname question and keeps the developer numbers.
 * The default is familiar from the first day: stages exist only for a card that switched
 * "慢慢熟悉" on, and nothing here ever goes down.
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
  /** I-071: her language now; English adds one line to the session opening (a language change is a new session through the persona in the session key). */
  setLanguageSource(source: () => CardLanguage): void { this.languageSource = source; }
  private languageSource: () => CardLanguage = () => 'zh-CN';
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
    const key = relationshipBackfillKey(scope);
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
  /** The stage in use: the hand-set one in developer mode, else the real one; null when the card does not get familiar slowly. */
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
    const language = this.safeLanguage();
    // I-210: the two reference numbers come from the real days; a hand-set stage (developer mode) would not fit them, so then she gets none.
    const reference = stage && !(this.stageOverride && this.options.developerMode()) ? stageReference(effectiveDays(data), stageThresholds(card.tendencies)) : undefined;
    // The date line is in the text, never in the tag: a new day or hour must not restart an open chat.
    return { text: relationshipOpeningText({ ...input, ...(reference ? { reference } : {}), language, dateLine: todayLine(this.clock(), language), languageLine: chatLanguageSessionLine(language) }), tag: relationshipSessionTag(input), memes: this.memesAllowed(characterId) };
  }

  private safeLanguage(): CardLanguage { try { return this.languageSource(); } catch { return 'zh-CN'; } }

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

  /**
   * The user gave her a nickname (or keeps using one): she remembers it from now on. Unbound v1 step 3: it is added to the nickname
   * table (shared/memory/nickname-table.ts), never replacing the older ones; the newest is still the one her opening line uses.
   */
  async noteHerNickname(characterId: string, raw: unknown): Promise<'saved' | 'same' | 'invalid'> {
    const herNickname = cleanNickname(raw);
    if (!herNickname) return 'invalid';
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (before.herNickname === herNickname && herNicknameList(before).includes(herNickname)) return 'same';
    const data = await this.store.update(characterId, current => ({ ...current, herNickname, herNicknames: withHerNickname(herNicknameList(current), herNickname) }));
    this.record(characterId, 'her-nickname-saved', data); this.changed(characterId);
    return 'saved';
  }

  // ---- Unbound v1 step 3: the nickname table (the control window shows, adds and removes; removing goes into the bin first) ----
  /** What the user calls her, oldest first (after ensure / load). */
  herNicknames(characterId: string): string[] { const data = this.store.peek(characterId); return data ? herNicknameList(data) : []; }
  /** The user added one by hand (their own words). */
  addHerNickname(characterId: string, raw: unknown): Promise<'saved' | 'same' | 'invalid'> { return this.noteHerNickname(characterId, raw); }
  /** Removes one; resolves to the name as it was kept (for the bin), or null when there was none. */
  async removeHerNickname(characterId: string, raw: unknown): Promise<string | null> {
    const name = cleanNickname(raw);
    if (!name) return null;
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    const list = herNicknameList(before), next = withoutHerNickname(list, name);
    if (next.length === list.length) return null;
    const removed = list.find(item => !next.includes(item))!;
    await this.store.update(characterId, current => { const left = withoutHerNickname(herNicknameList(current), name); return { ...current, herNicknames: left, herNickname: left.at(-1) ?? null }; });
    this.changed(characterId);
    return removed;
  }
  /** Puts a removed name back (from the bin) where it was in the list (`at`; the end when absent). */
  async restoreHerNickname(characterId: string, raw: unknown, at?: unknown): Promise<void> {
    const name = cleanNickname(raw);
    if (!name || name !== raw) throw Error('回收站里这一项的数据不完整，原文件已保留。');
    await this.store.load(characterId);
    await this.store.update(characterId, current => {
      const list = withoutHerNickname(herNicknameList(current), name);
      const index = typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 ? Math.min(at, list.length) : list.length;
      list.splice(index, 0, name);
      const kept = list.slice(-HER_NICKNAMES_MAX);
      return { ...current, herNicknames: kept, herNickname: kept.at(-1) ?? null };
    });
    this.changed(characterId);
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

  // ---- I-144b 「删除称呼」 goes into the recycle bin first (electron/memory/recycle/items-wiring.ts) ----
  /** What she calls the user now, and whether she had asked; null when there is no nickname. Nothing changes. */
  async nicknameCopy(characterId: string): Promise<NicknamePart | null> {
    const data = this.store.peek(characterId) ?? await this.store.load(characterId);
    return data.nickname ? { nickname: data.nickname, nicknameAsked: data.nicknameAsked } : null;
  }
  /** Puts a nickname back as it was; resolves to the one it replaced (the caller keeps that in the bin), or null. */
  async restoreNickname(characterId: string, part: NicknamePart): Promise<string | null> {
    const nickname = part && typeof part === 'object' ? cleanNickname(part.nickname) : null;
    if (!nickname || nickname !== part.nickname || typeof part.nicknameAsked !== 'boolean') throw Error('回收站里这一项的数据不完整，原文件已保留。');
    await this.store.load(characterId);
    let replaced: string | null = null;
    const data = await this.store.update(characterId, current => { replaced = current.nickname && current.nickname !== nickname ? current.nickname : null; return { ...current, nickname, nicknameAsked: part.nicknameAsked }; });
    this.record(characterId, 'nickname-changed', data); this.changed(characterId);
    return replaced;
  }

  // ---- I-207 the card's milestone (shared/cards/card-milestone.ts): she decides it happened; recorded once, with the local date ----
  /** The local date it was reached, or null (not yet, or not loaded). Nothing changes. */
  cardMilestoneDate(characterId: string): string | null { return this.store.peek(characterId)?.cardMilestone?.date ?? null; }
  /** Loads the file once (so the line and the page can read it without waiting). */
  async ensureCardMilestone(characterId: string): Promise<string | null> {
    const data = this.store.peek(characterId) ?? await this.store.load(characterId);
    return data.cardMilestone?.date ?? null;
  }
  /** She felt it happened. Resolves to true when this is the first time (a later marker changes nothing and writes no row). */
  async reachCardMilestone(characterId: string): Promise<boolean> {
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (before.cardMilestone) return false;
    const data = await this.store.update(characterId, current => current.cardMilestone ? current : { ...current, cardMilestone: { date: this.today() } });
    this.record(characterId, 'card-milestone', data); this.changed(characterId);
    return true;
  }
  /** The user clears it (the caller has the page's confirm and the recycle bin copy): resolves to the date it had, or null when there was none. */
  async clearCardMilestone(characterId: string): Promise<string | null> {
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    if (!before.cardMilestone) return null;
    await this.store.update(characterId, ({ cardMilestone: _gone, ...rest }) => rest);
    this.changed(characterId);
    return before.cardMilestone.date;
  }
  /** Puts a cleared one back from the bin (the date it had); resolves to the date it replaced, or null. */
  async restoreCardMilestone(characterId: string, date: unknown): Promise<string | null> {
    if (!isDateKey(date)) throw Error('回收站里这一项的数据不完整，原文件已保留。');
    const before = this.store.peek(characterId) ?? await this.store.load(characterId);
    await this.store.update(characterId, current => ({ ...current, cardMilestone: { date } }));
    this.changed(characterId);
    return before.cardMilestone && before.cardMilestone.date !== date ? before.cardMilestone.date : null;
  }

  // ---- I-208 step 3 her margin notes (shared/cards/card-objects.ts): only Claude-side code writes them (the chat reply's hidden marker, and the user's own edit and delete on the archive page) ----
  /** Her notes, oldest first (loads the file once; a character with none gets []). */
  async objectNotes(characterId: string): Promise<ObjectNote[]> {
    const data = this.store.peek(characterId) ?? await this.store.load(characterId);
    return (data.objectNotes ?? []).map(note => ({ ...note }));
  }
  /** The notes of one finished reply (the pure plan decides which are kept); resolves to how many were added. Dated with the local day. */
  async addObjectNotes(characterId: string, markers: readonly (string | null)[], officialPages: readonly number[] = []): Promise<number> {
    const before = await this.objectNotes(characterId);
    const fresh = planNewNotes(before.map(note => note.text), markers);
    if (!fresh.length) return 0;
    // A page the book does not have and she has not used yet is a new page of hers (any number she likes); a page that exists is a note on it.
    const taken = new Set([...officialPages, ...before.filter(note => note.own).map(note => note.page)]);
    const made = fresh.map((note): ObjectNote => {
      const own = note.page !== null && !taken.has(note.page);
      if (own) taken.add(note.page);
      return { id: randomUUID(), date: this.today(), page: note.page, text: note.text, ...(own ? { own: true as const } : {}) };
    });
    await this.store.update(characterId, current => ({ ...current, objectNotes: [...(current.objectNotes ?? []), ...made].slice(-NOTE_LIMITS.stored) }));
    this.changed(characterId);
    return fresh.length;
  }
  /** The user edits one note's words (the page's own edit); resolves to false when the note is gone or the words are empty. */
  async editObjectNote(characterId: string, id: string, text: string): Promise<boolean> {
    const clean = cleanNoteText(text), before = await this.objectNotes(characterId);
    if (!clean || !before.some(note => note.id === id)) return false;
    await this.store.update(characterId, current => ({ ...current, objectNotes: (current.objectNotes ?? []).map(note => note.id === id ? { ...note, text: clean } : note) }));
    this.changed(characterId);
    return true;
  }
  /** The user deletes one (the caller has the page's confirm and the recycle bin copy); resolves to the note it removed, or null. */
  async removeObjectNote(characterId: string, id: string): Promise<ObjectNote | null> {
    const found = (await this.objectNotes(characterId)).find(note => note.id === id) ?? null;
    if (!found) return null;
    await this.store.update(characterId, ({ objectNotes, ...rest }) => { const kept = (objectNotes ?? []).filter(note => note.id !== id); return kept.length ? { ...rest, objectNotes: kept } : rest; });
    this.changed(characterId);
    return found;
  }
  /** Puts a deleted note back from the bin where it was (by its date; the same id is not added twice); resolves to false when it was already there. */
  async restoreObjectNote(characterId: string, value: unknown): Promise<boolean> {
    const [note] = readObjectNotes([value]);
    if (!note) throw Error('回收站里这一项的数据不完整，原文件已保留。');
    const before = await this.objectNotes(characterId);
    if (before.some(item => item.id === note.id) || before.length >= NOTE_LIMITS.stored) return false;
    await this.store.update(characterId, current => ({ ...current, objectNotes: [...(current.objectNotes ?? []), note].sort((a, b) => a.date.localeCompare(b.date)) }));
    this.changed(characterId);
    return true;
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
  /** I-071 转换, host only: this character's numbers as they are (read only: a missing file is not created). */
  async snapshot(characterId: string): Promise<RelationshipData> {
    return this.store.peek(characterId) ?? await this.store.load(characterId);
  }
  /**
   * I-071 转换, host only: a converted card starts with the numbers carried over from the card it came from (days, familiarity,
   * milestones, the nicknames the user chose). Only for a character with nothing yet: one that already has days is refused.
   */
  async adopt(characterId: string, data: RelationshipData): Promise<void> {
    const valid = validateRelationship(structuredClone(data));
    const before = await this.store.load(characterId);
    if (before.days.length || before.qualityDays.length || before.today.rounds || before.backfilled.length || before.nickname || before.herNickname)
      throw new Error('这个角色已经有自己的熟悉度了，没有覆盖。');
    const { cardMilestone: _notCarried, objectNotes: _notesNotCarried, ...carried } = valid; // I-207: whether her card's milestone happened belongs to the character it happened with; I-208: so do her margin notes
    await this.store.update(characterId, () => carried);
    this.changed(characterId);
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
