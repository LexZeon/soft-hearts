import { streamClaude } from '../claude';
import { userProfileScopeId, type DiaryTicket, type UserProfileScope, type UserProfileStore } from '../user-profile';
import { DIARY_LIMITS } from './diary-data';
import { localDateKey, localDayRange, recentDiaryDates } from './diary-dates';
import { buildDiaryPrompt, diaryMaterial, parseDiaryResult, type DiaryChatLine } from './diary-prompt';

export type DiaryProfiles = Pick<UserProfileStore, 'diaryTicket' | 'diaryTicketValid' | 'diaryDue' | 'noteDiaryAttempt' | 'saveDiary' | 'recentDiaryPoints'>;
export interface DiaryCharacter { persona: string; language: string }
export type DiaryWriterEvent =
  | { type: 'skip'; date: string }
  | { type: 'call' | 'written' | 'invalid' | 'failed'; date: string };

export interface DiaryWriterOptions {
  /** The user-profile store: its "允许记录" switch is the diary's consent. */
  profiles: DiaryProfiles;
  /** The current chat scope (character + chat-model partition), or null while switching. */
  scope(): UserProfileScope | null;
  /** That scope's ordinary chat originals whose time falls in [start, end). */
  messages(scope: UserProfileScope, start: number, end: number): readonly DiaryChatLine[];
  /** The scope's own character, compiled; null when the active card is another one. */
  character(scope: UserProfileScope): DiaryCharacter | null;
  /** The chat model as saved (store.current.provider.model), or null when chat is not Claude. */
  model(): string | null;
  /** One tool-free model call; resolves to the raw text. */
  generate(request: { prompt: string; model: string }, signal: AbortSignal): Promise<string>;
  /** A day was written (by its local date); publish the profile view. */
  written(date: string): void;
  /** 她自己的生活: one line of what she did on her own that day ('' when nothing). No extra call. */
  herLife?(scope: UserProfileScope, start: number, end: number): string;
  /** G1 猜拳: one line of the games played that day and a habit that may become their joke ('' when none). A day with games and no chat is still written. */
  games?(scope: UserProfileScope, start: number, end: number): string;
  /** I-019 喂食认图: one line of what the user fed her that day and anything fed often enough to be their joke ('' when none). A day with feeds and no chat is still written. */
  feeds?(scope: UserProfileScope, start: number, end: number): string;
  now?: () => number;
  /** How long after a failed or malformed attempt the same day is tried again (default 30 minutes). */
  retryDelayMs?: number;
  /** Outcome metadata only, never text. */
  report?(event: DiaryWriterEvent): void;
}

const relative = (today: string, date: string): string =>
  ['昨天', '前天', '三天前'][recentDiaryDates(today, DIARY_LIMITS.backfillDays).indexOf(date)] ?? date;

/**
 * L3: writes the last few days' diary while the user profile's recording is on.
 * Driven by the host's existing one-second mood clock and by profile changes —
 * it owns no timer. A pass runs at most once per scope and local day (plus
 * bounded retries): when the local date changes, or the first time recording is
 * turned on that day. Days without chat are skipped without a model call; one
 * call per day written, one at a time.
 */
export class DiaryWriter {
  private running: { ticket: DiaryTicket; controller: AbortController } | null = null;
  private passKey = '';
  private retryAt = Number.POSITIVE_INFINITY;
  private disposed = false;
  private readonly now: () => number;
  constructor(private readonly options: DiaryWriterOptions) { this.now = options.now ?? Date.now; }

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
    const now = this.now(), today = localDateKey(now), key = `${ticket.scopeId}|${today}`;
    if (key === this.passKey && now < this.retryAt) return; // The steady state: nothing more per second.
    let scope: UserProfileScope | null = null;
    try { scope = this.options.scope(); if (scope && userProfileScopeId(scope) !== ticket.scopeId) scope = null; } catch { scope = null; }
    if (!scope) return; // Switching: try again on a later tick.
    this.passKey = key; this.retryAt = Number.POSITIVE_INFINITY;
    const due = this.options.profiles.diaryDue(ticket, recentDiaryDates(today, DIARY_LIMITS.backfillDays));
    if (!due.length) return;
    const run = { ticket, controller: new AbortController() };
    this.running = run;
    void this.pass(run, scope, today, due)
      .catch(() => { this.retryAt = this.now() + this.retryDelay; })
      .finally(() => { if (this.running === run) this.running = null; });
  }

  /**
   * Developer test command ("测试：写日记", electron/test-commands/): run the pass now instead of waiting for the next
   * local day. Nothing is bypassed: the user profile's "允许记录" is still the consent ('recording-off' without it), only
   * days that still need an entry are written (at most the usual attempts per day), and a day without chat makes no call.
   */
  writeNow(): 'started' | 'recording-off' | 'nothing-due' | 'busy' | 'unavailable' {
    if (this.disposed) return 'unavailable';
    if (this.running) return 'busy';
    const ticket = this.options.profiles.diaryTicket();
    if (!ticket) return 'recording-off';
    let scope: UserProfileScope | null = null;
    try { scope = this.options.scope(); if (scope && userProfileScopeId(scope) !== ticket.scopeId) scope = null; } catch { scope = null; }
    if (!scope || this.options.model() === null || !this.options.character(scope)) return 'unavailable';
    if (!this.options.profiles.diaryDue(ticket, recentDiaryDates(localDateKey(this.now()), DIARY_LIMITS.backfillDays)).length) return 'nothing-due';
    this.passKey = ''; this.retryAt = Number.POSITIVE_INFINITY;
    this.tick();
    return this.running ? 'started' : 'nothing-due';
  }

  /** For the inner loop and other host callers: '' while recording is off or for another scope. */
  recentDiaryPoints(scope: UserProfileScope, now: number, maxChars: number): string {
    return this.options.profiles.recentDiaryPoints(scope, now, maxChars);
  }

  get busy(): boolean { return !!this.running; }

  dispose(): void { this.disposed = true; this.running?.controller.abort(); this.running = null; }

  private get retryDelay(): number { return this.options.retryDelayMs ?? 30 * 60_000; }
  private report(event: DiaryWriterEvent): void { try { this.options.report?.(event); } catch { /* Diagnostics never affect writing. */ } }

  private async pass(run: { ticket: DiaryTicket; controller: AbortController }, scope: UserProfileScope, today: string, dates: readonly string[]): Promise<void> {
    const { profiles } = this.options, signal = run.controller.signal;
    let retry = false;
    for (const date of dates) {
      if (signal.aborted || this.disposed || !profiles.diaryTicketValid(run.ticket)) break;
      const { start, end } = localDayRange(date);
      const material = diaryMaterial(this.options.messages(scope, start, end), DIARY_LIMITS.materialChars);
      let games = '';
      try { games = this.options.games?.(scope, start, end) ?? ''; } catch { games = ''; }
      let feeds = '';
      try { feeds = this.options.feeds?.(scope, start, end) ?? ''; } catch { feeds = ''; }
      if (!material && !games && !feeds) { this.report({ type: 'skip', date }); continue; }
      const character = this.options.character(scope), model = this.options.model();
      if (!character || model === null) { retry = true; break; }
      if (!await profiles.noteDiaryAttempt(run.ticket, date)) break;
      this.report({ type: 'call', date });
      let output: string, herLife = '';
      try { herLife = this.options.herLife?.(scope, start, end) ?? ''; } catch { herLife = ''; }
      try { output = await this.options.generate({ prompt: buildDiaryPrompt({ ...character, date, relative: relative(today, date), material, herLife, games, feeds }), model }, signal); }
      catch {
        if (signal.aborted) break;
        // Login, quota or timeout: the next day would fail the same way; try again later.
        this.report({ type: 'failed', date }); retry = true; break;
      }
      if (signal.aborted) break;
      const result = parseDiaryResult(output);
      if (!result) { this.report({ type: 'invalid', date }); retry = true; continue; }
      if (await profiles.saveDiary(run.ticket, date, result.entry, result.meme ?? undefined)) { this.report({ type: 'written', date }); this.options.written(date); }
    }
    if (signal.aborted) this.passKey = ''; // Recording came back on later the same day: try the remaining days then.
    else if (retry) this.retryAt = this.now() + this.retryDelay;
  }
}

/** The app's adapter: the user's own Claude Code, one headless tool-free process (streamClaude as is). */
export async function generateDiaryWithClaude(request: { prompt: string; model: string }, signal: AbortSignal,
  run: typeof streamClaude = streamClaude): Promise<string> {
  let output = '';
  await run({ kind: 'chat', model: request.model, workingDirectory: '', writable: false, prompt: request.prompt }, signal,
    (type, text) => { if (type === 'delta') output += text; });
  return output;
}
