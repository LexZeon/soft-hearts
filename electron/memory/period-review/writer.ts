// I-088 第 1 条 她的"这阵子"回顾: the writer. After a week is over (the local Monday has begun) and has enough in it, she writes one short look-back
// of it; after a month is over and every week in it has had its turn, one of the month. One call each, the same model and the same
// path as the diary writer (a tool-free call on the user's own Claude Code), only while "允许记录" is on for the shown character.
//
// It owns no timer: the host's existing one-second clock calls `tick()`, which is cheap (one pass per character and local day, plus a
// retry after a failed call). Nothing is ever written twice: a period that has a look-back (written or edited by the user) or that the
// user deleted is not due, a late answer of a call that was cancelled (recording off, another character) is not written, and the save
// itself checks all of it again inside the store's queue. A failed call (offline, signed out, quota) is not counted and is asked
// again later; an answer that could not be used is counted and the period gets REVIEW_LIMITS.attemptsPerPeriod of them.
import { userProfileScopeId, type DiaryTicket, type UserProfileScope } from '../user-profile';
import { localDateKey } from '../diary/diary-dates';
import { dueMonth, dueWeeks, reviewId, withTry, withWritten, type ReviewData } from './data';
import { monthLast, monthOf, weekDates, weekRange, type ReviewKind } from './period';
import { herVoiceRelaxed } from '../../../shared/voice';
import { buildReviewPrompt, monthHasMaterial, monthMaterial, parseReviewResult, reviewEntry, spanText, weekHasMaterial, weekMaterial, type ReviewDiaryDay, type ReviewNoteLine } from './prompt';
import type { ReviewStore } from './store';

export interface ReviewCharacter { persona: string; language: string; english: boolean }
/** Closed outcomes only, never text. `why` of a skip: not enough to write about yet. */
export type ReviewWriterEvent =
  | { type: 'call' | 'written' | 'invalid' | 'failed'; kind: ReviewKind; key: string }
  | { type: 'skipped'; kind: ReviewKind; key: string; why: 'thin' };

export interface PeriodReviewWriterOptions {
  /** The user profile store: its "允许记录" switch is the consent (the diary's ticket), and the diary days are read through it. */
  profiles: {
    diaryTicket(): DiaryTicket | null;
    diaryTicketValid(ticket: DiaryTicket | null): boolean;
    diaryDays(ticket: DiaryTicket, from: string, to: string): ReviewDiaryDay[];
  };
  store: Pick<ReviewStore, 'ensure' | 'change'>;
  /** The current chat scope (character + chat-model partition), or null while switching. */
  scope(): UserProfileScope | null;
  /** That scope's chat notes (title and summary only) whose chat began in [start, end). */
  notes(scope: UserProfileScope, start: number, end: number): readonly ReviewNoteLine[];
  /** The scope's own character, compiled; null when the active card is another one. */
  character(scope: UserProfileScope): ReviewCharacter | null;
  /** The chat model as saved, or null when chat is not Claude. */
  model(): string | null;
  /** One tool-free model call; resolves to the raw text. */
  generate(request: { prompt: string; model: string }, signal: AbortSignal): Promise<string>;
  /** The diary writer is running: the look-back waits (the last day of the week may be about to get its diary). */
  diaryBusy?(): boolean;
  /** A look-back was written; publish the profile view. */
  written?(kind: ReviewKind, key: string): void;
  now?: () => number;
  /** How long after a failed or malformed call the period is tried again (default 30 minutes). */
  retryDelayMs?: number;
  report?(event: ReviewWriterEvent): void;
}

export class PeriodReviewWriter {
  private running: { ticket: DiaryTicket; controller: AbortController } | null = null;
  private passKey = '';
  private retryAt = Number.POSITIVE_INFINITY;
  private disposed = false;
  /** Periods whose "not enough yet" was already reported in this run (it is looked at again each day; said once). */
  private readonly thin = new Set<string>();
  private readonly now: () => number;
  constructor(private readonly options: PeriodReviewWriterOptions) { this.now = options.now ?? Date.now; }

  /** Cheap; safe to call every second and on every profile change. */
  tick(): void {
    if (this.disposed) return;
    const running = this.running;
    if (running) {
      // Recording turned off, switched scope or disposed: the late answer is never written.
      if (!this.options.profiles.diaryTicketValid(running.ticket)) running.controller.abort();
      return;
    }
    const ticket = this.options.profiles.diaryTicket();
    if (!ticket) return;
    if (this.safe(() => this.options.diaryBusy?.() === true, false)) return;
    const now = this.now(), today = localDateKey(now), key = `${ticket.scopeId}|${today}`;
    if (key === this.passKey && now < this.retryAt) return; // The steady state: nothing more per second.
    let scope: UserProfileScope | null = null;
    try { scope = this.options.scope(); if (scope && userProfileScopeId(scope) !== ticket.scopeId) scope = null; } catch { scope = null; }
    if (!scope) return; // Switching: try again on a later tick.
    this.passKey = key; this.retryAt = Number.POSITIVE_INFINITY;
    const run = { ticket, controller: new AbortController() };
    this.running = run;
    void this.pass(run, scope, today)
      .catch(() => { this.retryAt = this.now() + this.retryDelay; })
      .finally(() => { if (this.running === run) this.running = null; });
  }

  get busy(): boolean { return !!this.running; }
  dispose(): void { this.disposed = true; this.running?.controller.abort(); this.running = null; }

  private get retryDelay(): number { return this.options.retryDelayMs ?? 30 * 60_000; }
  private report(event: ReviewWriterEvent): void { try { this.options.report?.(event); } catch { /* Diagnostics never affect writing. */ } }
  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  private async pass(run: { ticket: DiaryTicket; controller: AbortController }, scope: UserProfileScope, today: string): Promise<void> {
    const { store, profiles } = this.options, signal = run.controller.signal, scopeId = run.ticket.scopeId;
    const live = () => !signal.aborted && !this.disposed && profiles.diaryTicketValid(run.ticket);
    let retry = false;
    const state = await store.ensure(scopeId);
    if (!state) return; // The file does not read: it is left exactly as it is.
    for (const week of dueWeeks(state, today)) {
      if (!live()) break;
      const days = profiles.diaryDays(run.ticket, week, weekDates(week)[6]!);
      const { start, end } = weekRange(week);
      const notes = this.options.notes(scope, start, end);
      if (!weekHasMaterial(days, notes)) { this.skip('week', week); continue; }
      const outcome = await this.write(run, scope, 'week', week, spanText('week', week, weekDates(week)[6]!), weekMaterial(days, notes));
      if (outcome === 'stop') { retry = true; break; }
      if (outcome === 'invalid') retry = true;
    }
    if (live() && !retry) {
      const fresh = await store.ensure(scopeId);
      const month = fresh ? dueMonth(fresh, today) : null;
      if (fresh && month) {
        const weeks = fresh.items.filter(item => item.kind === 'week' && monthOf(item.key) === month);
        const days = profiles.diaryDays(run.ticket, `${month}-01`, monthLast(month));
        if (!monthHasMaterial(weeks, days)) this.skip('month', month);
        else {
          const outcome = await this.write(run, scope, 'month', month, spanText('month', month, monthLast(month)), monthMaterial(weeks, days));
          if (outcome !== 'written') retry = true;
        }
      }
    }
    if (signal.aborted) this.passKey = ''; // Recording came back on later the same day: look again then.
    else if (retry) this.retryAt = this.now() + this.retryDelay;
  }

  private skip(kind: ReviewKind, key: string): void {
    const id = reviewId(kind, key);
    if (this.thin.has(id)) return;
    this.thin.add(id);
    this.report({ type: 'skipped', kind, key, why: 'thin' });
  }

  /** One call for one period. 'stop': the call could not be made or failed (try again later, the rest waits). */
  private async write(run: { ticket: DiaryTicket; controller: AbortController }, scope: UserProfileScope, kind: ReviewKind, key: string, span: string, material: string): Promise<'written' | 'invalid' | 'stop' | 'dropped'> {
    const { store, profiles } = this.options, signal = run.controller.signal, scopeId = run.ticket.scopeId;
    const character = this.safe(() => this.options.character(scope), null), model = this.safe(() => this.options.model(), null);
    if (!character || model === null || !material) return 'stop';
    this.report({ type: 'call', kind, key });
    let output: string;
    try { output = await this.options.generate({ prompt: buildReviewPrompt({ kind, persona: character.persona, language: character.language, span, material, english: character.english, ...(herVoiceRelaxed() ? { relaxed: true } : {}) }), model }, signal); }
    catch {
      if (signal.aborted) return 'dropped';
      // Login, quota or timeout: not this period's fault, so no attempt is counted; the next one would fail the same way.
      this.report({ type: 'failed', kind, key });
      return 'stop';
    }
    if (signal.aborted || this.disposed || !profiles.diaryTicketValid(run.ticket)) return 'dropped';
    const result = parseReviewResult(output, kind, character.english);
    if (!result) {
      await store.change(scopeId, state => withTry(state, kind, key), 'her', () => profiles.diaryTicketValid(run.ticket));
      this.report({ type: 'invalid', kind, key });
      return 'invalid';
    }
    const saved = await store.change(scopeId, (state, at) => withWritten(state, reviewEntry(kind, key, result, at)), 'her', () => profiles.diaryTicketValid(run.ticket));
    if (!saved) return 'dropped';
    this.report({ type: 'written', kind, key });
    try { this.options.written?.(kind, key); } catch { /* A closed window is fine. */ }
    return 'written';
  }
}
