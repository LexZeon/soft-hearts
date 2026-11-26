// I-134 step 3: the writer of her note about the user. Driven by the host's existing one-second clock like the diary writer
// (electron/memory/diary/diary-writer.ts): `tick()` is cheap, owns no timer, and starts at most one background call at a time.
//
// When: the local "day" starts at `dayStartHour` (04:00), so a chat that runs past midnight still belongs to the day before. Once per
// day per scope, when the user has not chatted for `quietMs`, when the long-chat switch is on (`enabled`) and the diary's "允许记录"
// is on (the diary ticket is the consent). First note from all of the chat; afterwards a rewrite from her last page and the messages
// after its cutoff, skipped for the day when there are fewer than `minNewMessages`. A failed or unusable answer is tried again after
// `retryDelayMs`; MAX_CALLS_PER_DAY is a hard stop on spend (it is only a fallback: a day with two bad answers waits for tomorrow).
// What goes in: her ordinary chat with leaked drafts left out and time markers added (electron/brain/long-chat/history.ts), her persona only
// as a voice reference. What comes out is checked (not empty, at most 3000 characters, not itself a leaked draft); otherwise the old
// version stays. `report` carries closed outcomes only, never text.
import { userProfileScopeId, type DiaryTicket, type UserProfileScope, type UserProfileStore } from '../user-profile';
import { localDateKey } from '../diary/diary-dates';
import { isLeakedDraft, markTimes } from '../../brain/long-chat/history';
import type { Timed } from '../../brain';
import { buildFirstNotePrompt, buildRewritePrompt, firstNoteInstruction, rewriteNoteInstruction } from './prompt';
import { HER_NOTE_MAX_CHARS, type HerNoteForm, type HerNoteStore, type HerNoteVersion } from './store';
import { HER_NOTE_RAW_EVERY } from '../../../shared/brain';
import { herVoiceRelaxed } from '../../../shared/voice';

export type HerNoteEvent =
  | { type: 'call' | 'written' | 'invalid' | 'failed'; mode: 'first' | 'rewrite' | 'raw' }
  | { type: 'skipped'; why: 'few-messages' };

export interface HerNoteAskInput { system: string; prompt: string; model: string }

export interface HerNoteWriterOptions {
  /** The long-chat knob (shared/behaviors/long-chat/knobs.ts), wired by the host. */
  enabled(): boolean;
  /** The user profile store: its "允许记录" switch is the consent (the diary's ticket). */
  profiles: Pick<UserProfileStore, 'diaryTicket' | 'diaryTicketValid'>;
  store: Pick<HerNoteStore, 'current' | 'add'> & Partial<Pick<HerNoteStore, 'versions'>>;
  /** The current chat scope (character + chat-model partition), or null while switching. */
  scope(): UserProfileScope | null;
  /** That scope's ordinary chat originals with createdAt in [start, end), oldest first. */
  messages(scope: UserProfileScope, start: number, end: number): readonly Timed[];
  /** The scope's own character, compiled (a voice reference only); null when the active card is another one. */
  character(scope: UserProfileScope): { persona: string; english?: boolean } | null;
  /** The chat model as saved, or null when chat is not Claude. */
  model(): string | null;
  /** One tool-free model call; resolves to the raw text. */
  ask(input: HerNoteAskInput, signal: AbortSignal): Promise<string>;
  /** When the user last chatted (ms), or null. */
  lastChatAt(): number | null;
  now?: () => number;
  dayStartHour?: number;
  quietMs?: number;
  minNewMessages?: number;
  retryDelayMs?: number;
  report?(event: HerNoteEvent): void;
  /** I-139: the "我注意到……" form is in use. Default: the prompt switch (shared/voice/her-voice.ts herVoiceRelaxed). */
  relaxed?(): boolean;
  /** I-139: every N versions the page is written again from the whole raw chat (default HER_NOTE_RAW_EVERY = 5, kept within 2..5: the store keeps five versions). */
  rawEvery?: number;
}

/**
 * I-139: is the next write due to be a raw one (from the whole chat archive instead of her previous page plus the new chat)? Yes when the
 * newest page was not written in the new form yet (the first write after the switch is turned on, once), and every `every` versions after
 * that: the newest pages are counted back to the last raw one.
 */
export function rawRewriteDue(versions: readonly Pick<HerNoteVersion, 'form'>[], every: number = HER_NOTE_RAW_EVERY): boolean {
  const head = versions[0];
  if (!head) return false;
  if (head.form !== 'relaxed' && head.form !== 'raw') return true;
  const n = Math.min(5, Math.max(2, Math.round(Number.isFinite(every) ? every : HER_NOTE_RAW_EVERY)));
  let since = 0;
  for (const version of versions) { if (version.form === 'raw') break; since++; }
  return since >= n - 1;
}

export const HER_NOTE_MAX_CALLS_PER_DAY = 2;
const HOUR = 3_600_000;

interface ScopeState { doneDay: string; callsDay: string; calls: number; retryAt: number }

export class HerNoteWriter {
  private running: { ticket: DiaryTicket; controller: AbortController } | null = null;
  private readonly state = new Map<string, ScopeState>();
  private disposed = false;
  private readonly now: () => number;
  constructor(private readonly options: HerNoteWriterOptions) { this.now = options.now ?? Date.now; }

  /** Cheap; safe to call every second. */
  tick(): void {
    if (this.disposed) return;
    const running = this.running;
    if (running) {
      // Consent turned off, switched scope or disposed: the late answer is never written.
      if (!this.options.profiles.diaryTicketValid(running.ticket) || !this.safe(() => this.options.enabled())) running.controller.abort();
      return;
    }
    if (!this.safe(() => this.options.enabled())) return;
    const ticket = this.options.profiles.diaryTicket();
    if (!ticket) return;
    const now = this.now(), day = localDateKey(now - (this.options.dayStartHour ?? 4) * HOUR);
    const st = this.stateFor(ticket.scopeId);
    if (st.doneDay === day || now < st.retryAt) return; // The steady state: nothing more per second.
    if (st.callsDay !== day) { st.callsDay = day; st.calls = 0; }
    if (st.calls >= HER_NOTE_MAX_CALLS_PER_DAY) { st.doneDay = day; return; }
    const last = this.safe(() => this.options.lastChatAt(), null);
    if (last !== null && now - last < (this.options.quietMs ?? 10 * 60_000)) return; // Still chatting: later.
    if (this.safe(() => this.options.model(), null) === null) return;
    let scope: UserProfileScope | null = null;
    try { scope = this.options.scope(); if (scope && userProfileScopeId(scope) !== ticket.scopeId) scope = null; } catch { scope = null; }
    if (!scope) return; // Switching: try again on a later tick.
    const run = { ticket, controller: new AbortController() };
    this.running = run;
    void this.pass(run, scope, st, day, now)
      .catch(() => { st.retryAt = this.now() + this.retryDelay; })
      .finally(() => { if (this.running === run) this.running = null; });
  }

  get busy(): boolean { return !!this.running; }
  dispose(): void { this.disposed = true; this.running?.controller.abort(); this.running = null; }

  private get retryDelay(): number { return this.options.retryDelayMs ?? 30 * 60_000; }
  private stateFor(scopeId: string): ScopeState {
    let st = this.state.get(scopeId);
    if (!st) { st = { doneDay: '', callsDay: '', calls: 0, retryAt: 0 }; this.state.set(scopeId, st); }
    return st;
  }
  private safe<T>(read: () => T, fallback: T | boolean = false): T {
    try { return read(); } catch { return fallback as T; }
  }
  private report(event: HerNoteEvent): void { try { this.options.report?.(event); } catch { /* Diagnostics never affect writing. */ } }

  private async pass(run: { ticket: DiaryTicket; controller: AbortController }, scope: UserProfileScope, st: ScopeState, day: string, now: number): Promise<void> {
    const { profiles, store } = this.options, signal = run.controller.signal;
    const character = this.options.character(scope), model = this.options.model();
    if (!character || model === null) { st.retryAt = now + this.retryDelay; return; }
    const previous = store.current(scope);
    const all = this.options.messages(scope, 0, now + 1);
    // Leaked drafts are left out first, then markers are decided on what is left, so a message reads the same wherever the window starts.
    const language = character.english === true ? 'en' : null; // I-071: an English character's English replies are her words, not leaked drafts (2026-11-21)
    const clean = markTimes(all.filter(message => !isLeakedDraft(message, { language })));
    const fresh = previous ? clean.filter(message => message.createdAt > previous.cutoffAt) : clean;
    if (fresh.length < (this.options.minNewMessages ?? 10)) { st.doneDay = day; this.report({ type: 'skipped', why: 'few-messages' }); return; }
    const cutoffAt = all.reduce((latest, message) => Math.max(latest, message.createdAt), 0);
    const relaxed = this.safe(() => (this.options.relaxed ?? herVoiceRelaxed)(), false), english = character.english === true;
    // I-139: a raw rewrite (the whole chat, the first-note instruction) on the first write after the switch is turned on and every N versions.
    const raw = relaxed && previous !== null && rawRewriteDue(this.safe(() => this.options.store.versions?.(scope) ?? [previous], [previous]), this.options.rawEvery);
    const mode = !previous ? 'first' as const : raw ? 'raw' as const : 'rewrite' as const;
    const form: HerNoteForm | undefined = !relaxed ? undefined : mode === 'rewrite' ? 'relaxed' : 'raw';
    const input: HerNoteAskInput = mode === 'rewrite'
      ? { system: rewriteNoteInstruction(relaxed, english), prompt: buildRewritePrompt(previous!.text, fresh, character.persona), model }
      : { system: firstNoteInstruction(relaxed, english), prompt: buildFirstNotePrompt(mode === 'raw' ? clean : fresh, character.persona), model };
    st.calls++;
    this.report({ type: 'call', mode });
    let output: string;
    try { output = await this.options.ask(input, signal); }
    catch {
      if (signal.aborted) return;
      this.report({ type: 'failed', mode }); st.retryAt = this.now() + this.retryDelay; return;
    }
    if (signal.aborted || this.disposed || !profiles.diaryTicketValid(run.ticket) || !this.safe(() => this.options.enabled())) return;
    const text = output.trim();
    // Her note is written about this person in third person on purpose, so the I-139 listener-word rule ("这个人……回复") is not applied to it; the old draft checks are.
    if (!text || text.length > HER_NOTE_MAX_CHARS || isLeakedDraft({ role: 'assistant', content: text }, { listenerWords: false, language })) {
      this.report({ type: 'invalid', mode }); st.retryAt = this.now() + this.retryDelay; return; // The old version stays.
    }
    if (await store.add(scope, { text, writtenAt: this.now(), cutoffAt, ...(form ? { form } : {}) })) { st.doneDay = day; this.report({ type: 'written', mode }); }
    else st.retryAt = this.now() + this.retryDelay;
  }
}
