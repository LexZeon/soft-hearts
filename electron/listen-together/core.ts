// I-016 B part (docs/claude/2026-11-03-listen-together.md): what the computer plays, cut into segments by the shared listen-kind
// contract (shared/listen-kind.ts, produced by the music-detection half), kept as raw material for the latest few segments, and
// noted (摘要) once per segment by a small model. "Just talk" is never kept. No audio is ever stored.
//
// Segments: a song is one segment (it stopped, or a new song began: the producer gives a new `since` or a quiet gap); a show is one
// continuous viewing (an interruption longer than LISTEN_LIMITS.showGapMs starts the next one), with a rolling note about every
// ten minutes. A show and a song can be open at once: a song between two episodes keeps the viewing open.
//
// Ordering: each note request carries the generation it started in and a sequence per segment; a late, superseded, cleared or
// deleted result never lands (one reply is filed once; cancellation, lateness or a changed context cannot revive it).
//
// Disk (Codex T-207 round 2, X-257): the host may still take an open song back (a voice over a steady loop it first heard as
// music: unsure from the song's own start), and then the song is dropped as if never kept. So an open song lives in memory only
// and is written once it has ended (an ended song is never taken back): a song taken back was never on disk at any moment. A show
// is never taken back and is written while it plays. The cost: the words of a song still playing at quit or a crash are not kept.

import { randomUUID } from 'node:crypto';
import type { ListenKind, ListenKindView } from '../../shared/listen-kind';
import {
  LISTEN_LIMITS, letterCount, noteView, rawSegmentsToKeep, segmentLanguages, segmentText,
  type ListenLanguage, type ListenNote, type ListenNoteBody, type ListenPiece, type ListenSegment, type ListenSegmentKind,
  type ListenTogetherView,
} from '../../shared/listen-together';
import { noteDecision, parseListenNote, withoutRecital, type NoteRequest } from '../../shared/listen-note';
import { listenAskBlock, listenAskEntries, listenAskStill, listenWatchRefuses, matchListenAsk, type ListenAsk, type ListenAskEntry } from '../../shared/listen-ask';
import { WATCH_TIMELY_KNOBS, watchBlock as watchBlockText, timelineBlock as timelineBlockText, type WatchTimelyKnobs, everydayShowQuestion } from '../../shared/watch-timely';
import { TalkMemory } from './talk-memory';
import { WatchWindow } from './watch-window';
import { extractKeywordsField, type Keyword } from '../../shared/memory-keywords/keyword';

export interface ListenFile { version: 1; segments: ListenSegment[]; notes: ListenNote[]; deletedNotes: string[] }
export const emptyListenFile = (): ListenFile => ({ version: 1, segments: [], notes: [], deletedNotes: [] });

/** A chat turn's 一起听 block, and the same block as it may still go out (I-021 the late window, see ListenTogetherCore.askTurn). */
export interface ListenAskTurn {
  /** Put into the turn when it is composed ('' for an ordinary message). */
  readonly block: string;
  /** Read where the message is written: `persona` with the block as it may go out now; nothing taken back: `persona` itself. */
  current(persona: string): string;
}
export const NO_LISTEN_ASK: ListenAskTurn = Object.freeze({ block: '', current: (persona: string) => persona });

export type ListenCount = 'segment' | 'note' | 'note-local' | 'note-failed' | 'talk-dropped';

export interface ListenCoreDeps {
  kinds: { current(): ListenKindView };
  /** The active character; null while none. Segments and notes belong to the character they were heard with. */
  characterId(): string | null;
  /** The switch's words part is on (transcripts can arrive). When it goes off, open segments end. */
  listening(): boolean;
  /** One small-model call (haiku); its raw answer. Throwing or an invalid answer is simply no note. */
  note(request: NoteRequest, signal: AbortSignal): Promise<string>;
  save(file: ListenFile): Promise<void>;
  /** Optional local tempo for a pure-music note (the music-detection half may supply it). */
  tempo?(): 'fast' | 'medium' | 'slow' | null;
  /** A natural pause with a note worth mentioning (step 5). */
  pausePoint?(note: ListenNote, pause: 'ended' | 'paused'): void;
  /** The control window's view changed. */
  changed?(): void;
  /** Categories and counts only (no text) for the experience record. */
  count?(category: ListenCount, kind: ListenSegmentKind): void;
  now?(): number;
  createId?(): string;
  /** I-047 knobs (tests); default WATCH_TIMELY_KNOBS. */
  watchKnobs?: Partial<WatchTimelyKnobs>;
  /** I-048: a transcribed piece of the computer's sound (memory only: the watch timeline's 'heard'). Told for every piece kept, waiting or talk. */
  heard?(text: string, at: number): void;
  /** I-048: the watch timeline as the block's material (a local read, never waits). null/absent: the I-047 block as before. */
  timeline?(character: string, options: { heard: boolean }): { text: string } | null;
  /** I-049: what the keywords found for this user line, as a data block, and a check that nothing it shows has been forgotten since. */
  recall?(text: string, character: string): { text: string; still(): boolean } | null;
  /** I-049: a note was written and its writer also gave keywords (kept in the separate keyword index, never in the note). */
  keywords?(info: { characterId: string; noteId: string; at: number; keywords: readonly Keyword[] }): void;
}

type Job = { segmentId: string; characterId: string; upTo: number; seq: number; generation: number; reason: 'final' | 'roll' | 'pause'; request: NoteRequest };
const noteId = (segmentId: string) => `ln-${segmentId}`;

export class ListenTogetherCore {
  private file: ListenFile = emptyListenFile();
  private readonly now: () => number;
  private last: { kind: ListenKind; since: number; revision: number } | null = null;
  private music: { id: string; since: number; leftAt: number | null } | null = null;
  private show: { id: string; lastAt: number; paused: boolean } | null = null;
  private pending: ListenPiece[] = [];
  private character: string | null = null;
  private generation = 0;
  private readonly seqs = new Map<string, number>();
  private readonly applied = new Map<string, number>();
  private queue: Job[] = [];
  private running: { job: Job; controller: AbortController } | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** I-021: moves whenever a note or raw text goes away (deleted, cleared, forgotten, taken back, let go); see askTurn. */
  private takenBack = 0;
  /** 2026-11-07: the words of "just talk", memory only, the latest 10 minutes (electron/listen-together/talk-memory.ts). Never saved. */
  private readonly talk = new TalkMemory();
  private talkLive = false;
  /** I-047: the "talking about the show" window (memory only, electron/listen-together/watch-window.ts). */
  readonly watch: WatchWindow;
  private readonly watchKnobs: WatchTimelyKnobs;
  /** When a transcribed piece of the computer's sound last arrived (any kind): "someone is talking" for her hearing line. */
  private lastSpeechAt = -Infinity;

  constructor(private readonly deps: ListenCoreDeps) {
    this.now = deps.now ?? Date.now;
    this.watchKnobs = { ...WATCH_TIMELY_KNOBS, ...deps.watchKnobs };
    this.watch = new WatchWindow(this.watchKnobs);
  }

  /** Loaded file (already validated). Segments open at shutdown are closed where they were last heard, without a note. */
  load(file: ListenFile): void {
    this.file = { version: 1, segments: file.segments.map(s => s.endedAt === null ? { ...s, endedAt: s.lastHeardAt, notedUpTo: s.lastHeardAt } : s),
      notes: [...file.notes], deletedNotes: [...file.deletedNotes] };
    this.takenBack++;
    this.retain();
  }
  snapshot(): ListenFile { return structuredClone(this.file); }

  // ---- what plays ----

  /** One second tick: follows the kind, closes, rolls, expires. Cheap: no scan of notes. */
  tick(): void {
    const now = this.now();
    const character = this.safe(() => this.deps.characterId(), null);
    if (character !== this.character) { this.closeAll(now); this.character = character; this.pending = []; this.clearTalk(); }
    if (!this.safe(() => this.deps.listening(), false)) { if (this.music || this.show) this.closeAll(now); this.pending = []; this.clearTalk(); this.lastSpeechAt = -Infinity; return; }
    this.observe(now);
    const music = this.music && this.segment(this.music.id);
    if (this.music && music) {
      if (this.last?.kind === 'music') music.lastHeardAt = Math.max(music.lastHeardAt, now); // pure music brings no transcript
      if (this.music.leftAt !== null && now - this.music.leftAt > LISTEN_LIMITS.musicGapMs) this.closeMusic(music.lastHeardAt);
      else if (now - music.startedAt >= LISTEN_LIMITS.musicMaxMs) { const producerSince = this.music.since; this.closeMusic(now); if (this.last?.kind === 'music') this.openMusic(now, now, producerSince); }
    }
    const show = this.show && this.segment(this.show.id);
    if (this.show && show) {
      if (this.last?.kind === 'show') { this.show.lastAt = now; this.show.paused = false; show.lastHeardAt = now; }
      else {
        if (now - this.show.lastAt > LISTEN_LIMITS.showGapMs) this.closeShow(this.show.lastAt);
        else if (!this.show.paused && now - this.show.lastAt >= LISTEN_LIMITS.pauseMs) { this.show.paused = true; this.paused(show); }
      }
      if (this.show && now - show.notedAt >= LISTEN_LIMITS.rollMs && letterCount(segmentText(show, show.notedUpTo)) >= LISTEN_LIMITS.lyricLetters)
        this.requestNote(show, 'roll');
    }
    this.pending = this.pending.filter(p => now - p.end <= LISTEN_LIMITS.pendingMs);
    this.pump();
  }

  /** One recognized transcript piece from the computer's sound. 'talk': dropped, never kept. */
  accept(input: { at: number; end: number; text: string; language: ListenLanguage }): 'kept' | 'pending' | 'talk' | 'dropped' {
    const now = this.now();
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, LISTEN_LIMITS.pieceChars) : '';
    if (!text || !Number.isFinite(input.at) || !Number.isFinite(input.end) || input.end < input.at || !this.safe(() => this.deps.listening(), false)) return 'dropped';
    const character = this.safe(() => this.deps.characterId(), null);
    if (!character) return 'dropped';
    if (character !== this.character) { this.closeAll(now); this.character = character; this.pending = []; this.clearTalk(); }
    this.observe(now);
    this.lastSpeechAt = now;
    this.safe(() => this.deps.heard?.(text, input.at), undefined); // I-048: the watch timeline's heard lines (memory only; ignored unless watching together)
    const piece: ListenPiece = { at: input.at, end: input.end, text, language: input.language };
    const kind = this.last?.kind ?? 'unsure';
    // 2026-11-07: "just talk" is still not a segment, a note or a file; its words wait in memory for the latest 10 minutes (see TalkMemory).
    if (kind === 'talk') { this.talk.add(character, text, now); this.talkLive = true; this.safe(() => this.deps.count?.('talk-dropped', 'show'), undefined); return 'talk'; }
    const target = kind === 'music' ? this.music?.id : kind === 'show' ? this.show?.id
      : this.show && !this.show.paused && now - this.show.lastAt < LISTEN_LIMITS.pauseMs ? this.show.id
      : this.music && this.music.leftAt !== null && now - this.music.leftAt <= LISTEN_LIMITS.musicGapMs ? this.music.id : undefined;
    const segment = target ? this.segment(target) : undefined;
    if (!segment) { this.pending.push(piece); return 'pending'; }
    this.append(segment, piece);
    return 'kept';
  }

  /** The user cleared the raw text (控制窗口「清空原文」): every segment goes, open ones too; notes stay. */
  clearRaw(): void {
    this.generation++; this.abortAll(); this.takenBack++; this.clearTalk(); // the in-memory talk words go with the rest of the raw text
    this.file.segments = []; this.music = null; this.show = null; this.pending = []; this.last = null;
    this.changed(); this.save(true);
  }

  /** One note deleted by the user. It never comes back (a late or rolling result for it is dropped). */
  deleteNote(characterId: string, id: string): boolean {
    const note = this.file.notes.find(n => n.id === id && n.characterId === characterId);
    if (!note) return false;
    this.file.notes = this.file.notes.filter(n => n !== note); this.takenBack++;
    if (!this.file.deletedNotes.includes(id)) this.file.deletedNotes.push(id);
    if (this.file.deletedNotes.length > 5_000) this.file.deletedNotes.splice(0, this.file.deletedNotes.length - 5_000);
    if (this.running?.job.segmentId === note.segmentId) this.running.controller.abort();
    this.queue = this.queue.filter(job => job.segmentId !== note.segmentId);
    this.changed(); this.save(true);
    return true;
  }

  /** A character deleted with "forget her memories": her notes and raw segments go, and none of them comes back. */
  forgetCharacter(characterId: string): void {
    const notes = this.file.notes.filter(n => n.characterId === characterId), segments = new Set(this.file.segments.filter(s => s.characterId === characterId).map(s => s.id));
    for (const n of notes) { segments.add(n.segmentId); if (!this.file.deletedNotes.includes(n.id)) this.file.deletedNotes.push(n.id); }
    for (const id of segments) if (!this.file.deletedNotes.includes(`ln-${id}`)) this.file.deletedNotes.push(`ln-${id}`);
    this.file.notes = this.file.notes.filter(n => n.characterId !== characterId);
    this.file.segments = this.file.segments.filter(s => s.characterId !== characterId); this.takenBack++;
    if (this.character === characterId) this.clearTalk();
    if (this.music && segments.has(this.music.id)) this.music = null;
    if (this.show && segments.has(this.show.id)) this.show = null;
    this.queue = this.queue.filter(job => !segments.has(job.segmentId));
    if (this.running && segments.has(this.running.job.segmentId)) this.running.controller.abort();
    this.changed(); this.save(true);
  }

  /** She mentioned it and the user answered (R14: the chat memory keeps the words; this only marks it). */
  markTalked(id: string, at: number): void {
    const note = this.file.notes.find(n => n.id === id);
    if (!note || note.talkedAt !== null) return;
    note.talkedAt = at; this.changed(); this.save();
  }

  // ---- reading ----

  readNote(id: string): ListenNote | null { const n = this.file.notes.find(note => note.id === id); return n ? structuredClone(n) : null; }
  notesFor(characterId: string): ListenNote[] { return this.file.notes.filter(n => n.characterId === characterId); }
  segmentsFor(characterId: string): ListenSegment[] { return this.file.segments.filter(s => s.characterId === characterId); }

  /** This chat turn's block for a matched question ('' otherwise). Synchronous and local: the first character is unchanged. */
  askContext(text: unknown): string { return this.askTurn(text).block; }

  /**
   * The block (as askContext) and its check where the message is written: I-021 删除一致性, the late window (the same shape as
   * electron/recall-late-check.ts, Codex T-222 E04; docs/claude/2026-11-05-listen-late-window.md). The message may wait for the
   * Claude process after the turn was put together; what the user deleted meanwhile (a note, the raw text, the character's
   * memories) is dropped from the block then (shared/listen-ask.ts listenAskStill), and nothing is added. When nothing went away
   * (every ordinary turn) current() is one number comparison and returns the persona it was given.
   */
  askTurn(text: unknown, scope = '', watchingTogether = false): ListenAskTurn {
    const ask = matchListenAsk(text);
    const character = this.safe(() => this.deps.characterId(), null);
    if (!character) return NO_LISTEN_ASK;
    const now = this.now(), listening = this.safe(() => this.deps.listening(), false);
    let entries: ListenAskEntry[] = [];
    if (ask) {
      const talk = ask.speech && listening ? this.talk.view(character, now) : null;
      entries = listenAskEntries(ask, { now, segments: this.segmentsFor(character), notes: this.notesFor(character), talk }, typeof text === 'string' ? text : '');
    }
    const askBlock = listenAskBlock(entries);
    // I-047: the "talking about the show" window may add the latest heard words and haiku's summary (local, no await).
    const watchPart = this.watchTurn(text, ask, character, scope, now, listening, entries.some(entry => entry.segmentId !== null || entry.talkEpoch != null), watchingTogether);
    // I-049: what the keywords found of everything she heard and watched (local, 0 ms, within the same 3-record limit as the chat recall).
    const recalled = this.safe(() => this.deps.recall?.(typeof text === 'string' ? text : '', character) ?? null, null);
    const recallPart = recalled?.text ?? '';
    const block = askBlock + watchPart + recallPart;
    if (!block) return NO_LISTEN_ASK;
    let checkedAt = this.takenBack, kept = entries, currentAsk = askBlock, currentWatch = watchPart, currentRecall = recallPart;
    const watchEpoch = this.watch.epoch;
    return Object.freeze({ block, current: (persona: string) => {
      if (this.takenBack !== checkedAt) {
        checkedAt = this.takenBack;
        try {
          kept = listenAskStill(kept, { note: id => this.file.notes.some(n => n.id === id), segment: id => this.file.segments.some(s => s.id === id),
            talk: epoch => epoch === this.talk.epoch });
          currentAsk = listenAskBlock(kept);
        } catch { kept = []; currentAsk = ''; } // cannot check: nothing rather than something deleted
        currentWatch = ''; // the heard words or the summary may be what went away: nothing added, nothing kept
        currentRecall = '';
      }
      if (currentRecall && !this.safe(() => recalled?.still() ?? false, false)) currentRecall = ''; // a note or a watch note it showed was forgotten meanwhile
      if (currentWatch && this.watch.epoch !== watchEpoch) currentWatch = ''; // the window closed (a refusal, switched off, another conversation)
      const current = currentAsk + currentWatch + currentRecall;
      if (current === block) return persona;
      const at = persona.indexOf(block);
      return at < 0 ? persona : persona.slice(0, at) + current + persona.slice(at + block.length);
    } });
  }

  /**
   * I-047 陪看要及时: this turn's share of the "talking about the show" window ('' for none). A message that refuses quoting or
   * discussing closes the window and brings nothing; a local match that may carry raw text (a show or voices, not a song) starts or
   * renews it; an unclear match (`raw: false`) brings no heard words and changes nothing. While it is open the turn carries the last
   * heardMs of the heard words (unless the ask block already carries raw text) and haiku's summary if it is young enough.
   */
  private watchTurn(text: unknown, ask: ListenAsk | null, character: string, scope: string, now: number, listening: boolean, askHasRaw: boolean, watchingTogether = false): string {
    const knobs = this.watchKnobs;
    if (knobs.enabled !== true || !listening) return '';
    if (listenWatchRefuses(text)) { this.watch.close(); return ''; }
    if (ask && !ask.raw) return '';
    // Only a question about the voices or the show (speech), as for the talk words: a bare "你听到了吗" or a song question does not start it.
    if (ask && ask.when === 'now' && ask.speech) this.watch.open(character, scope, now);
    // on (screen sharing and 一起听 both) means "we are watching together": every message keeps the window open.
    // With 一起听 alone, everyday words about the show ("视频没看懂") open it too. A refusal was already handled above.
    // Only when the local matcher found no question at all (its own rules for songs, earlier times and quotes stay as they are), and
    // never for words inside quotes (someone else's words, a sentence to translate: shared/listen-ask.ts T-207).
    else if (!ask && (watchingTogether || everydayShowQuestion(text))) this.watch.open(character, scope, now);
    if (!this.watch.isOpen(character, scope, now)) return '';
    // I-048: while watching together the timeline (heard, seen, summaries, in time order) stands where the last heard words stood; with
    // nothing on it yet (or switched off) the block is what I-047 made. Both are local reads: nothing here waits for a model.
    const timeline = this.safe(() => this.deps.timeline?.(character, { heard: !askHasRaw }) ?? null, null);
    const block = timeline?.text ? timelineBlockText(timeline.text)
      : watchBlockText({ heard: askHasRaw ? null : this.heardSince(character, now, knobs.heardMs, knobs.heardChars), summary: this.watch.summary(character, scope, now) }, knobs);
    if (block) { this.watch.stats.blocks++; this.watch.stats.blockChars += block.length; }
    return block;
  }

  /** haiku (I-040) judged that the user is talking about what is playing: starts or renews the window (not for a refusing or unclear message). */
  watchOpen(text: unknown, scope: string): boolean {
    if (this.watchKnobs.enabled !== true || !this.safe(() => this.deps.listening(), false)) return false;
    const character = this.safe(() => this.deps.characterId(), null);
    if (!character) return false;
    if (listenWatchRefuses(text)) { this.watch.close(); return false; }
    const ask = matchListenAsk(text);
    if (ask && !ask.raw) return false;
    this.watch.open(character, scope, this.now());
    return true;
  }

  /** haiku's summary of the show (the one written for her second line): kept for the window's later turns, in memory only. */
  watchSummary(text: unknown, scope: string): boolean {
    const character = this.safe(() => this.deps.characterId(), null);
    return !!character && typeof text === 'string' && this.watch.setSummary(character, scope, text, this.now());
  }

  /** The words heard in the last `ms` for this character (talk memory and segments' raw text), newest last, the end of them cut to `maxChars`. */
  private heardSince(character: string, now: number, ms: number, maxChars: number): string | null {
    const since = now - ms, pieces: { at: number; text: string }[] = [];
    const talk = this.talk.view(character, now, ms);
    if (talk) pieces.push({ at: talk.endedAt, text: talk.text });
    for (const segment of this.segmentsFor(character)) {
      const text = segment.lastHeardAt >= since ? segmentText(segment, since) : '';
      if (text.trim()) pieces.push({ at: segment.lastHeardAt, text });
    }
    const all = pieces.sort((a, b) => a.at - b.at).map(piece => piece.text.trim()).join('\n').trim();
    return all ? all.slice(-Math.max(1, maxChars)) : null;
  }

  /**
   * I-040 看一眼、听一下: the words heard lately for the current character (the talk words and the raw text of segments still in memory,
   * within LISTEN_LIMITS.talkMemoryMs), newest last, at most `maxChars` from the end; null while 一起听 is off or nothing was heard.
   * Read only for one haiku summary when the user asks about it; never kept.
   */
  recentHeard(maxChars = 1_500): string | null {
    if (!this.safe(() => this.deps.listening(), false)) return null;
    const character = this.safe(() => this.deps.characterId(), null);
    if (!character) return null;
    const now = this.now(), since = now - LISTEN_LIMITS.talkMemoryMs;
    const pieces: { at: number; text: string }[] = [];
    const talk = this.talk.view(character, now);
    if (talk) pieces.push({ at: talk.endedAt, text: talk.text });
    for (const segment of this.segmentsFor(character)) {
      const text = segment.lastHeardAt >= since ? segmentText(segment, since) : '';
      if (text.trim()) pieces.push({ at: segment.lastHeardAt, text });
    }
    const all = pieces.sort((a, b) => a.at - b.at).map(piece => piece.text.trim()).join('\n').trim();
    return all ? all.slice(-Math.max(1, maxChars)) : null;
  }

  /** Someone is talking: a transcribed piece of the computer's sound arrived within `ms` (her hearing line; false while the switch is off). */
  spokenWithin(ms: number = LISTEN_LIMITS.speechRecentMs): boolean {
    return this.safe(() => this.deps.listening(), false) && this.now() - this.lastSpeechAt <= ms;
  }

  /** Quit: nothing held in memory outlives the process, and this lets go of it first. */
  dropMemory(): void { this.clearTalk(); this.lastSpeechAt = -Infinity; }

  view(characterId: string | null, limit = 100): ListenTogetherView {
    const segments = this.file.segments;
    const notes = characterId ? this.notesFor(characterId).sort((a, b) => b.endedAt - a.endedAt) : [];
    return { raw: { segments: segments.length, characters: segments.reduce((sum, s) => sum + s.pieces.reduce((n, p) => n + p.text.length, 0), 0),
      oldestAt: segments.length ? Math.min(...segments.map(s => s.startedAt)) : null }, notes: notes.slice(0, limit).map(noteView), total: notes.length };
  }

  /** Waits for the note queue and the last save (tests and quit). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && (this.running || this.queue.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await this.flush();
  }
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty) this.save(true);
    await this.saving;
  }

  // ---- internals ----

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  private segment(id: string): ListenSegment | undefined { return this.file.segments.find(s => s.id === id); }
  /** The talk words go; a turn composed earlier (askTurn) drops its copy where its message is written. */
  private clearTalk(): void { this.watch.close(); if (!this.talkLive) return; this.talkLive = false; this.talk.clear(); this.takenBack++; }
  private changed(): void { this.safe(() => this.deps.changed?.(), undefined); }
  private count(category: ListenCount, kind: ListenSegmentKind): void { this.safe(() => this.deps.count?.(category, kind), undefined); }

  private observe(now: number): void {
    const view = this.safe(() => this.deps.kinds.current(), null);
    if (!view) return;
    if (this.last && this.last.revision === view.revision && this.last.since === view.since && this.last.kind === view.kind) return;
    this.last = { kind: view.kind, since: view.since, revision: view.revision };
    const kind = view.kind, since = Number.isFinite(view.since) && view.since > 0 ? Math.min(view.since, now) : now;
    // Codex T-207: the producer took the song back — unsure from the song's own start (a voice over a steady loop it first heard
    // as music; electron/listen-kind-source.ts takeBack). It never was a song: its raw text goes, with no note (宁可少记，不误记通话).
    // An ordinary "the song ended into something unclear" is unsure from later on, and ends the song as before.
    if (this.music && kind === 'unsure' && Number.isFinite(view.since) && view.since > 0 && view.since <= this.music.since) this.discardMusic();
    if (this.music) {
      if (kind === 'music') {
        if (since !== this.music.since && this.music.leftAt === null) { this.closeMusic(this.segment(this.music.id)?.lastHeardAt ?? now); this.openMusic(since, now); }
        else if (since !== this.music.since && now - (this.music.leftAt ?? now) > LISTEN_LIMITS.musicGapMs) { this.closeMusic(this.segment(this.music.id)?.lastHeardAt ?? now); this.openMusic(since, now); }
        else { this.music.since = since; this.music.leftAt = null; }
      } else if (kind === 'unsure') this.music.leftAt ??= now;
      else this.closeMusic(this.segment(this.music.id)?.lastHeardAt ?? now);
    } else if (kind === 'music') this.openMusic(since, now);
    if (kind === 'show') {
      if (this.show && now - this.show.lastAt > LISTEN_LIMITS.showGapMs) this.closeShow(this.show.lastAt);
      if (!this.show) this.openShow(since, now);
      this.show!.lastAt = now; this.show!.paused = false;
    }
    if (kind === 'music' || kind === 'show') {
      const target = this.segment(kind === 'music' ? this.music!.id : this.show!.id);
      if (target) { for (const piece of this.pending) this.append(target, piece); }
      this.pending = [];
    } else if (kind === 'talk' || kind === 'quiet') {
      // The first seconds of narration are "unsure" while the kind settles: once it is talk, they belong to the talk memory (not to a segment).
      if (kind === 'talk' && this.character) for (const p of this.pending) { this.talk.add(this.character, p.text, now); this.talkLive = true; }
      this.pending = []; // quiet (T-207): what was undecided is over, it never joins the next song
    }
  }

  /** The open song was never one (see observe): it goes without a note, as if never kept. It was never written (persisted). */
  private discardMusic(): void {
    const id = this.music!.id; this.music = null; this.pending = [];
    this.file.segments = this.file.segments.filter(s => s.id !== id); this.takenBack++;
    this.queue = this.queue.filter(job => job.segmentId !== id);
    if (this.running?.job.segmentId === id) this.running.controller.abort();
    this.changed(); this.save(true);
  }

  private open(kind: ListenSegmentKind, since: number, now: number): ListenSegment | null {
    const character = this.character ?? this.safe(() => this.deps.characterId(), null);
    if (!character) return null;
    const segment: ListenSegment = { id: (this.deps.createId ?? randomUUID)(), characterId: character, kind, startedAt: since, lastHeardAt: now,
      endedAt: null, pieces: [], notedUpTo: since - 1, notedAt: now };
    this.file.segments.push(segment); this.count('segment', kind); this.retain(); this.save();
    return segment;
  }
  /** `producerSince` is the listen-kind view's since (a cut mix keeps it, so the same view does not look like a new song). */
  private openMusic(start: number, now: number, producerSince = start): void { const s = this.open('music', start, now); this.music = s ? { id: s.id, since: producerSince, leftAt: null } : null; }
  private openShow(since: number, now: number): void { const s = this.open('show', since, now); this.show = s ? { id: s.id, lastAt: now, paused: false } : null; }

  private append(segment: ListenSegment, piece: ListenPiece): void {
    segment.pieces.push(piece);
    segment.pieces.sort((a, b) => a.at - b.at);
    if (piece.at < segment.startedAt) segment.startedAt = piece.at;
    segment.lastHeardAt = Math.max(segment.lastHeardAt, piece.end);
    let chars = segment.pieces.reduce((n, p) => n + p.text.length, 0);
    while (chars > LISTEN_LIMITS.segmentChars && segment.pieces.length > 1) chars -= segment.pieces.shift()!.text.length;
    if (segment.id !== this.music?.id) this.save(); // the open song is written when it ends (see persisted)
  }

  private closeMusic(at: number): void {
    const segment = this.music && this.segment(this.music.id); this.music = null;
    if (segment) this.close(segment, at);
  }
  private closeShow(at: number): void {
    const segment = this.show && this.segment(this.show.id); this.show = null;
    if (segment) this.close(segment, at);
  }
  private closeAll(now: number): void {
    if (this.music) this.closeMusic(this.segment(this.music.id)?.lastHeardAt ?? now);
    if (this.show) this.closeShow(this.show.lastAt);
  }
  private close(segment: ListenSegment, at: number): void {
    if (segment.endedAt !== null) return;
    segment.endedAt = Math.max(segment.startedAt, Math.min(at, this.now()));
    this.requestNote(segment, 'final');
    this.retain(); this.changed(); this.save(true);
  }

  private paused(segment: ListenSegment): void {
    const fresh = segmentText(segment, segment.notedUpTo);
    if (letterCount(fresh) >= LISTEN_LIMITS.pauseLetters) { this.requestNote(segment, 'pause'); return; }
    const note = this.file.notes.find(n => n.id === noteId(segment.id));
    if (note?.mention) this.safe(() => this.deps.pausePoint?.(structuredClone(note), 'paused'), undefined);
  }

  /** Decide and enqueue a note for a segment (step 3's timing and skip rules). */
  private requestNote(segment: ListenSegment, reason: Job['reason']): void {
    const now = this.now(), id = noteId(segment.id);
    segment.notedAt = now;
    if (this.file.deletedNotes.includes(id)) return;
    const existing = this.file.notes.find(n => n.id === id);
    const end = segment.endedAt ?? now, fresh = segmentText(segment, segment.notedUpTo);
    if (existing && letterCount(fresh) < LISTEN_LIMITS.lyricLetters) {
      if (reason === 'final' && existing.mention) this.safe(() => this.deps.pausePoint?.(structuredClone(existing), 'ended'), undefined);
      return;
    }
    const decision = existing ? { kind: 'model' as const } : noteDecision(segment.kind, end - segment.startedAt, segmentText(segment), this.safe(() => this.deps.tempo?.() ?? null, null));
    if (decision.kind === 'none') return;
    if (decision.kind === 'local') {
      if (reason !== 'final') return;
      this.write(segment, decision.body, true, now); this.count('note-local', segment.kind);
      return;
    }
    const upTo = Math.max(segment.notedUpTo, ...segment.pieces.map(p => p.end));
    const seq = (this.seqs.get(segment.id) ?? 0) + 1; this.seqs.set(segment.id, seq);
    const job: Job = { segmentId: segment.id, characterId: segment.characterId, upTo, seq, generation: this.generation, reason,
      request: { kind: segment.kind, durationMs: end - segment.startedAt, languages: segmentLanguages(segment),
        text: existing ? fresh : segmentText(segment), earlier: existing ? body(existing) : null } };
    this.queue = this.queue.filter(j => j.segmentId !== segment.id);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift()!;
    const controller = new AbortController();
    this.running = { job, controller };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    void Promise.resolve().then(() => this.deps.note(job.request, signal)).then(answer => {
      if (signal.aborted) return;
      const parsed = parseListenNote(answer), clean = parsed && withoutRecital(parsed, job.request.text);
      if (!clean) { this.count('note-failed', job.request.kind); return; }
      this.land(job, clean, answer);
    }).catch(() => { if (!controller.signal.aborted) this.count('note-failed', job.request.kind); })
      .finally(() => { if (this.running?.job === job) this.running = null; this.pump(); });
  }

  /** Apply a finished note only if it is still the newest for a living segment of this generation, and not deleted. */
  private land(job: Job, note: ListenNoteBody, answer = ''): void {
    const id = noteId(job.segmentId);
    if (job.generation !== this.generation || this.file.deletedNotes.includes(id) || job.seq <= (this.applied.get(job.segmentId) ?? 0)) return;
    const segment = this.segment(job.segmentId);
    if (!segment || segment.characterId !== job.characterId) return;
    this.applied.set(job.segmentId, job.seq);
    segment.notedUpTo = Math.max(segment.notedUpTo, job.upTo);
    const written = this.write(segment, note, false, this.now());
    this.keep(written, [job.request.text, note.gist, ...note.points].join('\n'), answer);
    this.count('note', segment.kind);
    if ((job.reason === 'final' || job.reason === 'pause') && written.mention)
      this.safe(() => this.deps.pausePoint?.(structuredClone(written), job.reason === 'pause' ? 'paused' : 'ended'), undefined);
    else if (job.reason === 'roll' && segment.endedAt !== null && written.mention)
      this.safe(() => this.deps.pausePoint?.(structuredClone(written), 'ended'), undefined);
  }

  /** I-049: the keywords the writer gave with this note go to the keyword index (checked against what the note is about). Best effort. */
  private keep(note: ListenNote, source: string, answer: string): void {
    if (!this.deps.keywords || !answer) return;
    const keywords = this.safe(() => extractKeywordsField(answer, source), [] as Keyword[]);
    this.safe(() => this.deps.keywords?.({ characterId: note.characterId, noteId: note.id, at: note.endedAt, keywords }), undefined);
  }

  private write(segment: ListenSegment, content: ListenNoteBody, local: boolean, now: number): ListenNote {
    const id = noteId(segment.id), existing = this.file.notes.find(n => n.id === id);
    const note: ListenNote = { ...content, points: [...content.points], id, characterId: segment.characterId, segmentId: segment.id, kind: segment.kind,
      startedAt: segment.startedAt, endedAt: segment.endedAt ?? Math.max(segment.lastHeardAt, now), local, languages: segmentLanguages(segment),
      createdAt: existing?.createdAt ?? now, updatedAt: now, rolls: existing ? existing.rolls + 1 : 0, talkedAt: existing?.talkedAt ?? null };
    this.file.notes = existing ? this.file.notes.map(n => n === existing ? note : n) : [...this.file.notes, note];
    const mine = this.file.notes.filter(n => n.characterId === segment.characterId);
    if (mine.length > LISTEN_LIMITS.notesPerCharacter) {
      const drop = new Set(mine.sort((a, b) => a.endedAt - b.endedAt).slice(0, mine.length - LISTEN_LIMITS.notesPerCharacter).map(n => n.id));
      this.file.notes = this.file.notes.filter(n => !drop.has(n.id)); this.takenBack++;
    }
    this.changed(); this.save(true);
    return note;
  }

  private retain(): void {
    const keep = rawSegmentsToKeep(this.file.segments, this.now());
    if (keep.size === this.file.segments.length) return;
    this.file.segments = this.file.segments.filter(s => keep.has(s.id)); this.takenBack++;
    if (this.music && !keep.has(this.music.id)) this.music = null;
    if (this.show && !keep.has(this.show.id)) this.show = null;
  }

  private abortAll(): void { this.queue = []; this.running?.controller.abort(); }

  /**
   * What may be written: everything but the open song (Codex T-207 round 2). The host can still take an open song back; an ended
   * one never is, and close() writes it then. Every save goes through here, whatever triggered it (a note landing, a deletion,
   * flush at quit), so no snapshot on disk ever holds a song before it has ended.
   */
  private persisted(): ListenFile {
    const open = this.music?.id;
    return { version: 1, segments: structuredClone(this.file.segments.filter(s => s.id !== open)), notes: structuredClone(this.file.notes),
      deletedNotes: [...this.file.deletedNotes] };
  }

  private save(now = false): void {
    this.dirty = true;
    if (!now) { this.saveTimer ??= setTimeout(() => { this.saveTimer = null; this.save(true); }, 1_500); this.saveTimer.unref?.(); return; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.dirty = false;
    const file = this.persisted();
    this.saving = this.saving.then(() => this.deps.save(file)).catch(() => { this.dirty = true; });
  }
}

const body = (note: ListenNote): ListenNoteBody => ({ what: note.what, gist: note.gist, mood: note.mood, points: [...note.points], mention: note.mention, hook: note.hook });
