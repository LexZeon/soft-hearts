import { randomUUID } from 'node:crypto';
import type { MoodValues } from '../../shared/mood';
import {
  FEED_IMAGE_LATE_MS, feedDiaryLine, feedHistoryLabel, feedLinePrompt, feedMomentLine, feedMoodLift, feedRecognitionPrompt, feedTasteExcerpt,
  parseFeedLine, parseFeedRecognition, readFeedSnackInput, type FeedCategory, type FeedJournalOutcome, type FeedLiking, type FeedLineMessage,
  type FeedVerdict,
} from '../../shared/feed-recognition';
import type { FeedImage } from './image';
import type { FeedRecognitionStore } from './store';

/** The bite the mood host accepted last (electron/mood.ts lastAcceptedFood): its interaction session and what it gave her. */
export interface AcceptedFood { sessionId: string; characterId: string; at: number; delta: Partial<MoodValues> | null }
export interface FeedJournalEntry { outcome: FeedJournalOutcome; category?: FeedCategory; liking?: FeedLiking }
export interface FeedTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface FeedRecognitionHostOptions {
  store: Pick<FeedRecognitionStore, 'recognize' | 'note' | 'fed' | 'last'>;
  acceptedFood(): AcceptedFood | null;
  /** The active card: its id, compiled persona and language habits ('' when none). */
  character(): { id: string; persona: string; language: string } | null;
  /** Her mood label in plain words (MOOD_LABELS) and the chat's mood context (companion.mood.chatContext()). */
  moodLabel(): string;
  moodContext(): string;
  /** MoodView.snapshot.phase: 'idle' once the eating is over. */
  moodPhase(): string;
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string }, characterId: string): void;
  /** Speech scope (character, provider, model): a change makes every pending result stale. */
  identity(): string;
  shrink(bytes: Uint8Array): FeedImage | null;
  /** The small model looks once (model.ts recognizeWithClaude). */
  recognize(prompt: string, imageDataUrl: string, signal: AbortSignal): Promise<string>;
  /** The chat model says her line (model.ts feedLineWithClaude); null when chat is not on Claude. */
  line(prompt: string, signal: AbortSignal): Promise<string> | null;
  /** Claude answers now (electron/chat-availability.ts). */
  available(): boolean;
  /** The user profile's "允许记录": the list of what you fed her grows only then. */
  recording(): boolean;
  /** She may speak now: pet shown, no chat turn, no reply or other line being read, the user not typing, no game. */
  free(): boolean;
  /** To the pet window (desk:feed-line). */
  publish(message: FeedLineMessage): boolean;
  /** Freeze the voice style for her line before it is read (main.ts beginInitiativeSpeech). */
  speechStyle(id: string): void;
  /** One record "you fed her X" + her line (memory, the control window's chat); `current` rechecks the scope inside the archive. */
  archive(message: FeedLineMessage, current: () => boolean): Promise<void>;
  journal?(characterId: string, entry: FeedJournalEntry): void;
  clock?: () => number;
  timers?: FeedTimers;
  createId?: () => string;
}

/** The small model gets this long for its look; her line this long. */
export const FEED_RECOGNIZE_TIMEOUT_MS = 20_000;
export const FEED_LINE_TIMEOUT_MS = 30_000;
/** She speaks only after the bite and its chewing are over (B06: accepted 0.9 s, then the host's eating phase ends). */
export const FEED_LINE_AFTER_MS = 1_800;
/** Once her line is ready, it waits at most this long for the eating to end and for her to be free; then it is dropped. */
export const FEED_LINE_WAIT_MS = 20_000;
/** The pet window reports the line shown (or not) within this. */
export const FEED_SHOW_MS = 15_000;
const POLL_MS = 150;
/** As long as I-017 tells a snack "a moment ago" (shared/her-state.ts HER_CONTACT_RECENT_MS), plus the seconds the look takes. */
export const FEED_RECENT_NAME_MS = 60_000;

interface Job {
  sessionId: string;
  characterId: string;
  identity: string;
  acceptedAt: number;
  biteDelta: Partial<MoodValues> | null;
  controller: AbortController;
}
interface Showing { job: Job; message: FeedLineMessage; timer: unknown; resolve: (shown: boolean) => void }

/**
 * I-019 on the host: one accepted bite's picture → the look → the mood shift and her list → her line after the eating →
 * one archive. Every step rechecks that the context is the same (character, speech scope, the switch); a result that comes
 * back late, for another character, or after a newer bite never speaks and never overwrites anything newer. No cap on how
 * many times (user: "不设上限"); a newer bite takes the line over from an older one that has not spoken yet.
 */
export class FeedRecognitionHost {
  private readonly seen: string[] = [];
  private latest: Job | null = null;
  private readonly jobs = new Set<Job>();
  private showing: Showing | null = null;
  private disposed = false;
  /** Pictures still waiting for their bite to land (a flood of made-up sessions cannot pile up timers). */
  private waiting = 0;
  /** The last recognized food (memory only): for the next chat turn's "用户刚才喂你吃了…". */
  private lastFed: { characterId: string; name: string; at: number } | null = null;
  /** Counts only, for tests and the record. */
  readonly stats = { accepted: 0, looked: 0, recognized: 0, said: 0, quiet: 0, unclear: 0, failed: 0, missed: 0, lines: 0 };
  constructor(private readonly options: FeedRecognitionHostOptions) {}

  private now(): number { return (this.options.clock ?? Date.now)(); }
  private get timers(): FeedTimers {
    return this.options.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  get enabled(): boolean { try { return this.options.store.recognize === true; } catch { return false; } }

  /**
   * #32 (shared/behaviors/feed-cue/): a bite landing now will probably get her line (the switch is on and Claude answers), so the
   * sound right after the bite stays a sound and never says a word like "好吃～" that her line might contradict. Reads only.
   */
  lineMayFollow(): boolean { return !this.disposed && this.enabled && this.safe(() => this.options.available(), false); }

  /**
   * The narrow IPC (pet window only): exactly { sessionId, image } for the bite just accepted, at most once per bite, and only
   * while the switch is on. false: refused (nothing happens; she has eaten as before). The work goes on in the background.
   */
  async accept(fromPet: boolean, value: unknown): Promise<boolean> {
    if (this.disposed || fromPet !== true || !this.enabled) return false;
    const input = readFeedSnackInput(value);
    if (!input || this.seen.includes(input.sessionId) || this.waiting >= 2) return false;
    // The pet window sends the bite to the mood host before it reads the picture; give that a moment to land.
    this.waiting++;
    let food: AcceptedFood | null;
    try { food = await this.acceptedBite(input.sessionId); } finally { this.waiting--; }
    const character = this.safe(() => this.options.character(), null), identity = this.safe(() => this.options.identity(), '');
    if (!food || !character || food.characterId !== character.id || !identity || this.now() - food.at > FEED_IMAGE_LATE_MS || this.seen.includes(input.sessionId)) return false;
    this.seen.push(input.sessionId);
    if (this.seen.length > 64) this.seen.shift();
    const job: Job = { sessionId: input.sessionId, characterId: character.id, identity, acceptedAt: food.at, biteDelta: food.delta, controller: new AbortController() };
    this.latest = job;
    this.jobs.add(job);
    this.stats.accepted++;
    let image: Uint8Array | null = input.image;
    void this.run(job, () => { const bytes = image; image = null; return bytes; }).finally(() => this.jobs.delete(job));
    return true;
  }

  /** The pet window: her line `id` was shown (and read) or could not be. Archives once, only when shown and still current. */
  done(fromPet: boolean, value: unknown): boolean {
    const showing = this.showing;
    if (fromPet !== true || !showing || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.id !== showing.message.id || typeof record.shown !== 'boolean') return false;
    this.showing = null;
    this.timers.clear(showing.timer);
    showing.resolve(record.shown);
    return true;
  }

  /** The diary's line for one day (electron/diary/diary-writer.ts `feeds`), or ''. */
  diaryLine(characterId: string, start: number, end: number): string {
    return feedDiaryLine(this.safe(() => this.options.store.fed(characterId), []), start, end);
  }

  /** "用户约 5 分钟前喂你吃了草莓蛋糕。" for the current character (shared/feed-recognition.ts feedMomentLine), or ''. */
  momentLine(characterId: string, now = this.now()): string {
    const fed = this.lastFed?.characterId === characterId ? this.lastFed : null;
    const last = fed ? { name: fed.name, at: fed.at } : (() => { const item = this.safe(() => this.options.store.last(characterId), null); return item ? { name: item.name, at: item.lastAt } : null; })();
    return feedMomentLine(last, now);
  }

  /**
   * I-017's perception line (electron/her-state-host.ts `food`): the name of the snack this character was just fed, once it was
   * recognized, for as long as that bite counts as "a moment ago"; null otherwise. In memory only (her list follows the profile switch).
   */
  recentFoodName(characterId: string, now = this.now()): string | null {
    const fed = this.lastFed;
    return fed && fed.characterId === characterId && now - fed.at >= -1_000 && now - fed.at <= FEED_RECENT_NAME_MS ? fed.name : null;
  }

  /** The switch turned off, a character switch, quitting: nothing pending speaks. */
  cancel(): void {
    for (const job of this.jobs) job.controller.abort();
    this.latest = null;
    const showing = this.showing; this.showing = null;
    if (showing) { this.timers.clear(showing.timer); showing.resolve(false); }
  }
  dispose(): void { this.disposed = true; this.cancel(); }

  private async run(job: Job, takeImage: () => Uint8Array | null): Promise<void> {
    let verdict: FeedVerdict | null = null;
    try {
      const bytes = takeImage();
      const image = bytes ? this.safe(() => this.options.shrink(bytes), null) : null;
      if (!image || !this.current(job)) return this.end(job, image ? 'missed' : 'failed');
      if (!this.safe(() => this.options.available(), false)) return this.end(job, 'failed');
      const character = this.safe(() => this.options.character(), null);
      if (!character || character.id !== job.characterId) return this.end(job, 'missed');
      const prompt = feedRecognitionPrompt({ taste: feedTasteExcerpt(character.persona), mood: this.safe(() => this.options.moodLabel(), '') });
      this.stats.looked++;
      const raw = await this.within(job, signal => this.options.recognize(prompt, image.dataUrl, signal), FEED_RECOGNIZE_TIMEOUT_MS);
      verdict = raw === null ? null : parseFeedRecognition(raw);
      if (!this.current(job)) return this.end(job, 'missed', verdict);
      if (!verdict) return this.end(job, 'failed');
      if (verdict.category === '看不清') return this.end(job, 'unclear', verdict);
      this.stats.recognized++;
      if (verdict.edible) this.lastFed = { characterId: job.characterId, name: verdict.name, at: job.acceptedAt };
      // The bite already counted (B06); what she was fed shifts it (a not-food picture is taken back out).
      const lift = feedMoodLift(verdict, job.biteDelta);
      if (lift) { try { this.options.lift({ id: `feed-taste-${job.sessionId}`, ...lift }, job.characterId); } catch { /* The mood host refused; the line still comes. */ } }
      const before = verdict.edible ? this.safe(() => this.options.store.note(job.characterId, verdict!, this.now(), this.safe(() => this.options.recording(), false)), 0) : 0;
      if (this.latest !== job) return this.end(job, 'missed', verdict); // A newer bite speaks instead.
      if (!this.safe(() => this.options.available(), false)) return this.end(job, 'failed', verdict);
      const linePrompt = feedLinePrompt({ persona: character.persona, language: character.language, mood: this.safe(() => this.options.moodContext(), ''), verdict, before });
      const rawLine = await this.within(job, signal => this.options.line(linePrompt, signal), FEED_LINE_TIMEOUT_MS);
      if (!this.current(job) || this.latest !== job) return this.end(job, 'missed', verdict);
      const text = rawLine === null ? null : parseFeedLine(rawLine);
      if (text === null) return this.end(job, 'failed', verdict);
      if (text === 'quiet') return this.end(job, 'quiet', verdict);
      if (!await this.untilFree(job)) return this.end(job, 'missed', verdict);
      const id = `feed-${(this.options.createId ?? randomUUID)()}`, at = Math.floor(this.now());
      const message: FeedLineMessage = { id, text, origin: { kind: 'proactive', id, at, sources: ['feed'], labels: [feedHistoryLabel(verdict)] } };
      const shown = await this.show(job, message);
      if (!shown || !this.current(job)) return this.end(job, 'missed', verdict);
      this.stats.lines++;
      // Shown once: archived once. A failed archive never repeats the line.
      try { void this.options.archive(structuredClone(message), () => this.current(job)).catch(() => {}); } catch { /* The text stays visible; only the record is lost. */ }
      return this.end(job, 'said', verdict);
    } catch {
      return this.end(job, verdict ? 'missed' : 'failed', verdict);
    }
  }

  private show(job: Job, message: FeedLineMessage): Promise<boolean> {
    const previous = this.showing;
    if (previous) { this.showing = null; this.timers.clear(previous.timer); previous.resolve(false); }
    return new Promise<boolean>(resolve => {
      const showing: Showing = { job, message, resolve, timer: null };
      showing.timer = this.timers.set(() => { if (this.showing === showing) { this.showing = null; resolve(false); } }, FEED_SHOW_MS);
      this.showing = showing;
      const abort = () => { if (this.showing === showing) { this.showing = null; this.timers.clear(showing.timer); resolve(false); } };
      job.controller.signal.addEventListener('abort', abort, { once: true });
      let sent = false;
      try { this.options.speechStyle(message.id); sent = this.options.publish(structuredClone(message)) !== false; } catch { sent = false; }
      if (!sent) abort();
    });
  }

  /** Waits for the eating to end and for her to be free; false when it does not happen in time or the bite went stale. */
  private async untilFree(job: Job): Promise<boolean> {
    const deadline = this.now() + FEED_LINE_WAIT_MS;
    for (;;) {
      if (!this.current(job) || this.latest !== job) return false;
      const eaten = this.now() - job.acceptedAt >= FEED_LINE_AFTER_MS && this.safe(() => this.options.moodPhase(), '') === 'idle';
      if (eaten && this.safe(() => this.options.free(), false)) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(job, POLL_MS);
    }
  }

  private current(job: Job): boolean {
    if (this.disposed || job.controller.signal.aborted || !this.enabled) return false;
    const character = this.safe(() => this.options.character(), null);
    return !!character && character.id === job.characterId && this.safe(() => this.options.identity(), '') === job.identity;
  }

  /** The call's text, or null on timeout, abort or failure. */
  private async within(job: Job, call: (signal: AbortSignal) => Promise<string> | null, ms: number): Promise<string | null> {
    if (job.controller.signal.aborted) return null;
    const controller = new AbortController();
    const stop = () => controller.abort();
    job.controller.signal.addEventListener('abort', stop, { once: true });
    const timer = this.timers.set(stop, ms);
    try {
      const pending = call(controller.signal);
      if (!pending) return null;
      return await new Promise<string | null>(resolve => {
        controller.signal.addEventListener('abort', () => resolve(null), { once: true });
        void pending.then(text => resolve(controller.signal.aborted ? null : text), () => resolve(null));
      });
    } catch { return null; }
    finally { this.timers.clear(timer); job.controller.signal.removeEventListener('abort', stop); }
  }

  private sleep(job: Job, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = this.timers.set(resolve, ms);
      job.controller.signal.addEventListener('abort', () => { this.timers.clear(timer); resolve(); }, { once: true });
    });
  }

  private async acceptedBite(sessionId: string): Promise<AcceptedFood | null> {
    for (let waited = 0; ; waited += 50) {
      const food = this.safe(() => this.options.acceptedFood(), null);
      if (food && food.sessionId === sessionId) return food;
      if (waited >= 1500 || this.disposed) return null;
      await new Promise<void>(resolve => this.timers.set(resolve, 50));
    }
  }

  private end(job: Job, outcome: FeedJournalOutcome, verdict?: FeedVerdict | null): void {
    this.stats[outcome]++;
    if (this.latest === job) this.latest = null;
    const entry: FeedJournalEntry = { outcome, ...(verdict ? { category: verdict.category, liking: verdict.liking } : {}) };
    try { this.options.journal?.(job.characterId, entry); } catch { /* A record never changes a feed. */ }
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
}
