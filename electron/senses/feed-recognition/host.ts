import type { CardLanguage } from '../../../shared/foundation/character-card';
import { withSpeechLanguage } from '../../../shared/brain';
import { randomUUID } from 'node:crypto';
import { herVoiceRelaxed } from '../../../shared/voice';
import type { MoodValues } from '../../../shared/foundation/mood';
import {
  FEED_IMAGE_LATE_MS, feedDiaryLine, feedHistoryLabel, feedLinePrompt, feedMomentLine, feedMoodLift, feedRecognitionPrompt, feedTasteExcerpt,
  parseFeedLine, parseFeedRecognition, readFeedSnackInput, type FeedCategory, type FeedJournalOutcome, type FeedLiking, type FeedLineMessage,
  type FeedVerdict,
} from '../../../shared/senses/feed-recognition';
import type { FeedImage } from './image';
import type { FeedRecognitionStore } from './store';

/** The bite the mood host accepted last (electron/mood/mood.ts lastAcceptedFood): its interaction session and what it gave her. */
export interface AcceptedFood { sessionId: string; characterId: string; at: number; delta: Partial<MoodValues> | null }
export interface FeedJournalEntry { outcome: FeedJournalOutcome; category?: FeedCategory; liking?: FeedLiking }
export interface FeedTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface FeedRecognitionHostOptions {
  store: Pick<FeedRecognitionStore, 'recognize' | 'note' | 'fed' | 'last'>;
  acceptedFood(): AcceptedFood | null;
  /** The active card: its id, compiled persona and language habits ('' when none). */
  character(): { id: string; persona: string; language: string; /** The card's language (cardLanguageOf): an English card's line is asked for in English. Absent: Chinese. */ speech?: CardLanguage } | null;
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
  /** Claude answers now (electron/brain/chat-availability.ts). */
  available(): boolean;
  /** The user profile's "允许记录": the list of what you fed her grows only then. */
  recording(): boolean;
  /** She may speak now: companion shown, no chat turn, no reply or other line being read, the user not typing, no game. */
  free(): boolean;
  /** To the companion window (desk:feed-line). */
  publish(message: FeedLineMessage): boolean;
  /** Freeze the voice style for her line before it is read (main.ts beginInitiativeSpeech). */
  speechStyle(id: string): void;
  /** One record "you fed her X" + her line (memory, the control window's chat); `current` rechecks the scope inside the archive. */
  archive(message: FeedLineMessage, current: () => boolean): Promise<void>;
  journal?(characterId: string, entry: FeedJournalEntry): void;
  /**
   * I-086 我们的小东西 (electron/initiative/give/host.ts keepFed): a picture recognised as food, once her line was shown (or she chose to stay
   * quiet): the name, her line, whether she loves it, and the picture feeding already shrank (in memory; the keeper makes a 256 px copy
   * and keeps it only while "允许记录" is on). Never a picture that was not food, never the original file. Omitted: nothing is kept.
   */
  keep?(entry: { characterId: string; name: string; line: string | null; at: number; loved: boolean; image: string }): void;
  clock?: () => number;
  timers?: FeedTimers;
  createId?: () => string;
}

/** The small model gets this long for its look; her line this long. */
export const FEED_RECOGNIZE_TIMEOUT_MS = 20_000;
export const FEED_LINE_TIMEOUT_MS = 30_000;
/** She speaks only after the bite and its chewing are over (B06: accepted 0.9 s, then the host's eating phase ends). */
export const FEED_LINE_AFTER_MS = 1_800;
/** As long as I-017 tells a snack "a moment ago" (shared/mood/her-state.ts HER_CONTACT_RECENT_MS), plus the seconds the look takes. */
export const FEED_RECENT_NAME_MS = 60_000;
/**
 * Once her line is ready it waits for the eating to end and for her to be free: at least this long, and until the bite stops being
 * "a moment ago" (FEED_RECENT_NAME_MS after it), whichever is later; then it is dropped as "busy". Fallback only.
 */
export const FEED_LINE_WAIT_MS = 20_000;
/** The companion window reports the line shown (or not) within this. */
export const FEED_SHOW_MS = 15_000;
/** The companion window said "not now" (a reply is still on screen or being read, the user is typing): the host asks again after this. */
export const FEED_RETRY_MS = 1_000;
/** A bite is chewed within about two seconds; if the mood host still says "eating" this long after that, the phase is stuck and no longer holds her line. */
export const FEED_EATING_MAX_MS = 8_000;
const POLL_MS = 150;

interface Job {
  sessionId: string;
  characterId: string;
  identity: string;
  acceptedAt: number;
  biteDelta: Partial<MoodValues> | null;
  controller: AbortController;
}
/** shown: the companion window put it up; refused: it reported "not now"; lost: no report in time, aborted or never sent. */
type ShowResult = 'shown' | 'refused' | 'lost';
interface Showing { job: Job; message: FeedLineMessage; timer: unknown; resolve: (result: ShowResult) => void }

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
  readonly stats = { accepted: 0, looked: 0, recognized: 0, said: 0, quiet: 0, unclear: 0, failed: 0, missed: 0, superseded: 0, busy: 0, lines: 0 };
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
   * The narrow IPC (companion window only): exactly { sessionId, image } for the bite just accepted, at most once per bite, and only
   * while the switch is on. false: refused (nothing happens; she has eaten as before). The work goes on in the background.
   */
  async accept(fromPet: boolean, value: unknown): Promise<boolean> {
    if (this.disposed || fromPet !== true || !this.enabled) return false;
    const input = readFeedSnackInput(value);
    if (!input || this.seen.includes(input.sessionId) || this.waiting >= 2) return false;
    // The companion window sends the bite to the mood host before it reads the picture; give that a moment to land.
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

  /** The companion window: her line `id` was shown (and read) or could not be. Archives once, only when shown and still current. */
  done(fromPet: boolean, value: unknown): boolean {
    const showing = this.showing;
    if (fromPet !== true || !showing || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.id !== showing.message.id || typeof record.shown !== 'boolean') return false;
    this.showing = null;
    this.timers.clear(showing.timer);
    showing.resolve(record.shown ? 'shown' : 'refused');
    return true;
  }

  /** The diary's line for one day (electron/memory/diary/diary-writer.ts `feeds`), or ''. */
  diaryLine(characterId: string, start: number, end: number): string {
    return feedDiaryLine(this.safe(() => this.options.store.fed(characterId), []), start, end);
  }

  /** "用户约 5 分钟前喂你吃了草莓蛋糕。" for the current character (shared/senses/feed-recognition.ts feedMomentLine), or ''. */
  momentLine(characterId: string, now = this.now()): string {
    const fed = this.lastFed?.characterId === characterId ? this.lastFed : null;
    const last = fed ? { name: fed.name, at: fed.at } : (() => { const item = this.safe(() => this.options.store.last(characterId), null); return item ? { name: item.name, at: item.lastAt } : null; })();
    return feedMomentLine(last, now);
  }

  /**
   * I-017's perception line (electron/mood/her-state-host.ts `food`): the name of the snack this character was just fed, once it was
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
    if (showing) { this.timers.clear(showing.timer); showing.resolve('lost'); }
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
      if (this.latest !== job) return this.end(job, this.lostOutcome(job), verdict); // A newer bite speaks instead.
      if (!this.safe(() => this.options.available(), false)) return this.end(job, 'failed', verdict);
      const linePrompt = withSpeechLanguage(feedLinePrompt({ persona: character.persona, language: character.language, mood: this.safe(() => this.options.moodContext(), ''), verdict, before, ...(herVoiceRelaxed() ? { relaxed: true } : {}) }), character.speech);
      const rawLine = await this.within(job, signal => this.options.line(linePrompt, signal), FEED_LINE_TIMEOUT_MS);
      if (!this.current(job) || this.latest !== job) return this.end(job, this.lostOutcome(job), verdict);
      const text = rawLine === null ? null : parseFeedLine(rawLine);
      if (text === null) return this.end(job, 'failed', verdict);
      if (text === 'quiet') { this.keep(job, verdict, null, image.dataUrl); return this.end(job, 'quiet', verdict); }
      // One line per feeding moment: asked again while the companion window says "not now" (a chat reply on screen, being read, the user
      // typing), each try under a new id, until the bound; never stacked, and a newer bite ends this loop (latest !== job).
      const deadline = Math.max(this.now() + FEED_LINE_WAIT_MS, job.acceptedAt + FEED_RECENT_NAME_MS);
      let message: FeedLineMessage;
      for (;;) {
        const wait = await this.untilFree(job, deadline);
        if (wait !== 'free') return this.end(job, wait === 'late' ? 'busy' : this.lostOutcome(job), verdict);
        const id = `feed-${(this.options.createId ?? randomUUID)()}`, at = Math.floor(this.now());
        message = { id, text, origin: { kind: 'proactive', id, at, sources: ['feed'], labels: [feedHistoryLabel(verdict)] } };
        const result = await this.show(job, message);
        if (!this.current(job)) return this.end(job, this.lostOutcome(job), verdict);
        if (result === 'shown') break;
        if (this.latest !== job) return this.end(job, 'superseded', verdict);
        if (result === 'lost') return this.end(job, 'missed', verdict);
        await this.sleep(job, FEED_RETRY_MS); // refused: not now
      }
      this.stats.lines++;
      this.keep(job, verdict, text, image.dataUrl);
      // Shown once: archived once. A failed archive never repeats the line.
      try { void this.options.archive(structuredClone(message), () => this.current(job)).catch(() => {}); } catch { /* The text stays visible; only the record is lost. */ }
      return this.end(job, 'said', verdict);
    } catch {
      return this.end(job, verdict ? 'missed' : 'failed', verdict);
    }
  }

  /** Why a job did not go on though nothing failed: a newer bite took over (superseded), or the context changed / the switch went off (missed). */
  private lostOutcome(job: Job): FeedJournalOutcome { return this.current(job) && this.latest !== job ? 'superseded' : 'missed'; }

  private show(job: Job, message: FeedLineMessage): Promise<ShowResult> {
    const previous = this.showing;
    if (previous) { this.showing = null; this.timers.clear(previous.timer); previous.resolve('lost'); }
    return new Promise<ShowResult>(resolve => {
      const showing: Showing = { job, message, resolve, timer: null };
      showing.timer = this.timers.set(() => { if (this.showing === showing) { this.showing = null; resolve('lost'); } }, FEED_SHOW_MS);
      this.showing = showing;
      const abort = () => { if (this.showing === showing) { this.showing = null; this.timers.clear(showing.timer); resolve('lost'); } };
      job.controller.signal.addEventListener('abort', abort, { once: true });
      let sent = false;
      try { this.options.speechStyle(message.id); sent = this.options.publish(structuredClone(message)) !== false; } catch { sent = false; }
      if (!sent) abort();
    });
  }

  /** Waits for the eating to end and for her to be free: 'free', 'late' (the bound passed first) or 'stale' (the bite went stale or a newer one took over). */
  private async untilFree(job: Job, deadline: number): Promise<'free' | 'late' | 'stale'> {
    for (;;) {
      if (!this.current(job) || this.latest !== job) return 'stale';
      const age = this.now() - job.acceptedAt;
      const eaten = age >= FEED_LINE_AFTER_MS && (this.safe(() => this.options.moodPhase(), '') === 'idle' || age >= FEED_LINE_AFTER_MS + FEED_EATING_MAX_MS);
      if (eaten && this.safe(() => this.options.free(), false)) return 'free';
      if (this.now() >= deadline) return 'late';
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

  private keep(job: Job, verdict: FeedVerdict, line: string | null, image: string): void {
    if (!verdict.edible || !this.options.keep) return;
    try { this.options.keep({ characterId: job.characterId, name: verdict.name, line, at: job.acceptedAt, loved: verdict.liking === '爱吃', image }); }
    catch { /* Keeping a copy never changes the feed. */ }
  }

  private end(job: Job, outcome: FeedJournalOutcome, verdict?: FeedVerdict | null): void {
    this.stats[outcome]++;
    if (this.latest === job) this.latest = null;
    const entry: FeedJournalEntry = { outcome, ...(verdict ? { category: verdict.category, liking: verdict.liking } : {}) };
    try { this.options.journal?.(job.characterId, entry); } catch { /* A record never changes a feed. */ }
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
}
