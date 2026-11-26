// Wiring for 一起听 (docs/claude/2026-11-03-listen-together.md), so electron/main.ts only adds a few lines: the broker's
// publications land here (not in the long-term transcript archive any more: R13 is now "raw for the latest few segments"),
// chat turns ask here for their block, the mood tick and the companion's ambient bubble reach the pause-point line through
// routeAmbientComments, and the control window reads and clears through three host operations.

import type { AmbientLanguage } from '../../../shared/senses/ambient-audio';
import type { ListenKindView } from '../../../shared/senses/listen-kind';
import type { ListenLanguage, ListenSegment, ListenTogetherView } from '../../../shared/senses/listen-together';
import type { ListedPart } from '../../foundation/keyed-part';
import { LISTEN_NOTE_SYSTEM_PROMPT, listenNotePrompt } from '../../../shared/senses/listen-note';
import type { AudioReadingPublicationTicket } from '../../voice';
import type { AmbientCommentOffer, AmbientCommentSession } from '../ambient-comments';
import { ListenTogetherCore, NO_LISTEN_ASK, type ListenAskTurn, type ListenCharacterPart, type ListenCount, type ListenCoreDeps, type ListenNotePart } from './core';
export { NO_LISTEN_ASK, type ListenAskTurn } from './core';
import { ListenStore } from './store';
import { NowPlayingService, type NowPlayingReader } from '../now-playing/service';
import { ListenProactive, routeAmbientComments, type AmbientCommentsLike, type ListenProactiveDeps } from './proactive';

export interface ListenTogetherDeps {
  directory: string;
  kinds: { current(): ListenKindView };
  characterId(): string | null;
  /** The switch's words part is on (electron/main.ts readingActive). */
  listening(): boolean;
  /** The small model (electron/initiative/inner-loop/model.ts quickLineWithClaude): prompt, system prompt → its text. */
  quick(prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string>;
  changed?(): void;
  tempo?(): 'fast' | 'medium' | 'slow' | null;
  now?(): number;
  /** I-048 / I-049 ports (electron/senses/watch-notes/, electron/memory/memory-keywords/); all optional and best effort. */
  ports?: Pick<ListenCoreDeps, 'heard' | 'timeline' | 'keywords' | 'recall'> & { keywordsRemoved?(characterId: string, noteIds: readonly string[] | 'all'): void };
  /** I-010 互动余额 is wired: her pause-point line's soft cap is the opening choice's budget roll, not the 3-hour count. */
  budgeted?: boolean;
  /** I-089 item 4: how the system's now-playing report is read (tests); default the Windows reader. `false`: not read at all. */
  nowPlaying?: false | { read?: NowPlayingReader; intervalMs?: number };
}

/** What electron/main.ts's own comment dependencies already are (the same object it gives AmbientComments). */
export interface CommentPorts {
  gate: ListenProactiveDeps['gate'];
  currentSession(): AmbientCommentSession | null;
  canComment(): boolean;
  persona(): string;
  moodText(): string;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  offer(comment: AmbientCommentOffer): void;
}

const languageCode = (value: AmbientLanguage | undefined): ListenLanguage =>
  value?.status === 'detected' ? value.language : value?.status === 'mixed' ? value.languages[0] ?? null : null;

export class ListenTogether {
  readonly core: ListenTogetherCore;
  private proactive: ListenProactive | null = null;
  /** I-089 item 4: what the system says is playing (read only while the switch's words are on). */
  readonly playing: NowPlayingService | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly counts: Record<ListenCount, number> = { segment: 0, note: 0, 'note-local': 0, 'note-failed': 0, 'talk-dropped': 0 };

  constructor(private readonly deps: ListenTogetherDeps, private readonly store = new ListenStore(deps.directory, { now: deps.now })) {
    this.playing = deps.nowPlaying === false ? null : new NowPlayingService({ listening: deps.listening, now: deps.now, read: deps.nowPlaying?.read, intervalMs: deps.nowPlaying?.intervalMs });
    this.core = new ListenTogetherCore({ kinds: deps.kinds, characterId: deps.characterId, listening: deps.listening, now: deps.now, tempo: deps.tempo,
      note: (request, signal) => deps.quick(listenNotePrompt(request), LISTEN_NOTE_SYSTEM_PROMPT, signal),
      nowPlaying: () => this.playing?.block() ?? '',
      heard: deps.ports?.heard, timeline: deps.ports?.timeline, keywords: deps.ports?.keywords, recall: deps.ports?.recall,
      save: file => store.save(file), changed: () => deps.changed?.(),
      count: category => { this.counts[category]++; },
      pausePoint: (note, pause) => this.proactive?.candidate(note, pause) });
  }

  async load(): Promise<void> { this.core.load(await this.store.load()); }
  start(): void { this.playing?.start(); if (!this.timer) { this.timer = setInterval(() => this.core.tick(), 1_000); this.timer.unref?.(); } }
  async dispose(): Promise<void> { this.playing?.stop(); if (this.timer) clearInterval(this.timer); this.timer = null; this.proactive?.clear(); this.core.dropMemory(); await this.core.flush(); }
  /** I-040: the words heard lately (memory and raw text, the last 10 minutes), for one haiku summary; null while off or nothing heard. */
  recentHeard(maxChars?: number): string | null { try { return this.core.recentHeard(maxChars); } catch { return null; } }
  /** 2026-11-07: a transcribed piece of the computer's sound arrived lately (her hearing line says someone is talking). */
  spokenWithin(ms?: number): boolean { try { return this.core.spokenWithin(ms); } catch { return false; } }

  /** The broker's single publication point for one recognized piece. Only the computer's sound is kept (no microphone). */
  accept(ticket: AudioReadingPublicationTicket, language?: AmbientLanguage): void {
    const publication = ticket.take();
    if (!publication) { ticket.discard(); return; }
    try {
      if (publication.source !== 'system-audio' || publication.signal.aborted || !publication.currentPurposes().length) return;
      this.core.accept({ at: publication.startedAtMs, end: publication.endedAtMs, text: publication.text, language: languageCode(language) });
    } finally { publication.finish(); }
  }

  /** This chat turn's block ('' for an ordinary message). */
  askContext(text: unknown): string { return this.askTurn(text).block; }
  /** The block and its check where the message is written (I-021 the late window: ListenTogetherCore.askTurn). */
  askTurn(text: unknown, scope = '', watchingTogether = false): ListenAskTurn { try { return this.core.askTurn(text, scope, watchingTogether); } catch { return NO_LISTEN_ASK; } }
  /** I-047: haiku's judgment said the user is talking about what is playing (starts or renews the window); and its summary of the show. */
  watchOpen(text: unknown, scope: string): void { try { this.core.watchOpen(text, scope); } catch { /* Best effort. */ } }
  watchSummary(text: unknown, scope: string): void { try { this.core.watchSummary(text, scope); } catch { /* Best effort. */ } }

  /** The comment object main.ts keeps: the legacy comments plus her pause-point line, sharing main.ts's own ports. */
  comments(ports: CommentPorts, legacy: AmbientCommentsLike, mood: ListenProactiveDeps['mood']): AmbientCommentsLike {
    this.proactive = new ListenProactive({ ...ports, mood, now: this.deps.now, ...(this.deps.budgeted === true ? { budgeted: true } : {}),
      readNote: id => this.core.readNote(id), nowPlaying: () => this.playing?.proactive() ?? '', heardLately: character => this.core.heardLately(character), talked: (id, at) => this.core.markTalked(id, at) });
    return routeAmbientComments(legacy, this.proactive);
  }
  get proactiveCounts() { return this.proactive?.counts ?? null; }

  view(): ListenTogetherView { return this.core.view(this.safeCharacter()); }
  clearRaw(): ListenTogetherView { this.core.clearRaw(); return this.view(); }
  deleteNote(id: unknown): ListenTogetherView {
    if (typeof id !== 'string' || !id.startsWith('ln-') || id.length > 300) throw new Error('这条记录不存在或已经删除。');
    const character = this.safeCharacter();
    if (!character || !this.core.deleteNote(character, id)) throw new Error('这条记录不存在或已经删除。');
    try { this.deps.ports?.keywordsRemoved?.(character, [id]); } catch { /* A keyword left behind never matches a note that is gone. */ }
    return this.view();
  }
  // ---- I-144 回收站 (electron/memory/recycle-wiring.ts) ----
  recycleCopy(characterId: string): ListenCharacterPart | null { return this.core.recycleCopy(characterId); }
  recycleRestore(characterId: string, part: ListenCharacterPart): void { this.core.recycleRestore(characterId, part); }
  /** The shown character's note `id`, before the user deletes it; null when there is none. */
  noteCopy(id: unknown): { characterId: string; part: ListenNotePart } | null {
    const character = this.safeCharacter();
    if (!character || typeof id !== 'string') return null;
    const part = this.core.noteCopy(character, id);
    return part ? { characterId: character, part } : null;
  }
  restoreNote(characterId: string, part: ListenNotePart): boolean { return this.core.restoreNote(characterId, part); }
  /** I-144b 「清空原文」 through the bin: what is kept now (every character's raw segments), and putting it back. */
  rawCopy(): ListedPart<ListenSegment> | null { return this.core.rawCopy(); }
  restoreRaw(part: ListedPart<ListenSegment>): number { return this.core.restoreRaw(part); }

  /** A character deleted with "forget her memories": her notes and raw text go, and her keywords for them (I-016, I-049). */
  forgetCharacter(characterId: string): void {
    this.core.forgetCharacter(characterId);
    try { this.deps.ports?.keywordsRemoved?.(characterId, 'all'); } catch { /* Same. */ }
  }
  private safeCharacter(): string | null { try { return this.deps.characterId(); } catch { return null; } }
}

export const EMPTY_LISTEN_VIEW: ListenTogetherView = Object.freeze({ raw: { segments: 0, characters: 0, oldestAt: null }, notes: [], total: 0 }) as ListenTogetherView;

/** The control window's three operations (control-window only, like the other memory controls). */
export function registerListenTogetherIpc(host: (method: string, operation: (...args: any[]) => unknown) => void, get: () => ListenTogether | null,
  /** I-144: deleting a note goes through the recycle bin (electron/memory/recycle-wiring.ts); absent: deleted as before. */
  recycled?: (id: unknown) => Promise<ListenTogetherView>,
  /** I-144b: 「清空原文」 goes through the recycle bin too; absent: cleared as before. */
  recycledClear?: () => Promise<ListenTogetherView>): void {
  host('getListenTogetherView', () => get()?.view() ?? EMPTY_LISTEN_VIEW);
  host('clearListenRaw', () => { const listen = get(); if (!listen) return EMPTY_LISTEN_VIEW; return recycledClear ? recycledClear() : listen.clearRaw(); });
  host('deleteListenNote', (id: unknown) => { const listen = get(); if (!listen) throw new Error('这条记录不存在或已经删除。'); return recycled ? recycled(id) : listen.deleteNote(id); });
}
