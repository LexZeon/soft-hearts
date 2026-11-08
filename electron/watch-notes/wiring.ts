// I-048 / I-049 step 2: puts the pieces together so electron/main.ts adds only a few lines. One object holds the keyword recall, the
// watch notes and screenshot cache, the watch session (「和她一起看」) and the ports the listen core and the notebook take. The only
// Electron-specific parts come in as ports (the screen sampler, the picture maker, the current character, the switches).
//
// Brain interface (docs/claude/brain-interface.md): the two model calls here are `quickLineWithClaude` (single tool-less haiku call,
// the picture inline for a frame). Everything else is plain code and files under the profile directory given.

import { quickLineWithClaude } from '../inner-loop/model';
import { KeywordIndexStore } from '../memory-keywords/store';
import { KeywordRecall } from '../memory-keywords/recall';
import { ScreenshotCache } from './screenshots';
import { WatchNotesStore, type WatchNote } from './store';
import { RecallTexts } from './recall-texts';
import { WatchSession, emptyWatchStats, type WatchConditions } from './session';
import type { ListenCoreDeps } from '../listen-together/core';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../../shared/behaviors/watch-timeline/knobs';

export interface WatchTogetherPorts {
  /** The profile directory (the keyword index, watch notes and screenshots live in their own folders under it). */
  directory: string;
  characterId(): string | null;
  /** 和她一起看 and the screen state, read at the moment (electron/main.ts). */
  conditions(): WatchConditions;
  /** One frame from the existing screen sampler (screenSnapshots.sampleOnce), as a data URL. */
  capture(signal: AbortSignal): Promise<string | null>;
  /** The small grayscale thumbnail and the smaller picture for the model (electron nativeImage). */
  prepare(dataUrl: string): { thumb: Uint8Array; picture: string } | null;
  /** A listen note by id (the listen core's readNote). */
  readListenNote(id: string): { gist: string; points: readonly string[]; characterId: string } | null;
  /** The lines before the user's current one, newest first (for the keyword match). */
  previousLines?(): readonly string[];
  now?(): number;
  knobs?: WatchTimelineKnobs;
}

export interface WatchTogetherView {
  active: boolean;
  /** Counts and timings only (no text, no pictures). */
  session: WatchSession['stats'];
  planner: { queued: number; running: number; framesLastHour: number };
  timelineEntries: number;
  keywords: KeywordRecall['stats'];
  cache: { files: number; bytes: number };
}

export class WatchTogether {
  readonly keywordStore: KeywordIndexStore;
  readonly keywords: KeywordRecall;
  readonly screenshots: ScreenshotCache;
  readonly notes: WatchNotesStore;
  readonly texts: RecallTexts;
  readonly session: WatchSession;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ports: WatchTogetherPorts) {
    this.now = ports.now ?? Date.now;
    const knobs = ports.knobs ?? WATCH_TIMELINE_KNOBS;
    this.keywordStore = new KeywordIndexStore(ports.directory);
    this.keywords = new KeywordRecall(this.keywordStore, this.now);
    this.screenshots = new ScreenshotCache(ports.directory, this.now, knobs.notes);
    // The notes store writes its keywords through the recall, so the in-memory index a turn matches against stays the one on disk.
    const through: Pick<KeywordIndexStore, 'update' | 'removeSource'> = {
      update: async <T>(characterId: string, change: (index: Parameters<Parameters<KeywordIndexStore['update']>[1]>[0]) => T): Promise<T> => {
        let result!: T;
        await this.keywords.update(characterId, index => { result = change(index); });
        return result;
      },
      removeSource: async (characterId, source) => {
        let removed = 0;
        await this.keywords.update(characterId, index => { removed = index.removeSource(source); });
        return removed;
      },
    };
    this.notes = new WatchNotesStore(ports.directory, { keywords: through, screenshots: this.screenshots }, knobs.notes);
    this.texts = new RecallTexts({ readNote: id => ports.readListenNote(id) }, this.notes);
    this.session = new WatchSession({
      now: this.now, characterId: ports.characterId, conditions: ports.conditions, capture: ports.capture, prepare: ports.prepare,
      describe: async (picture, prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal, undefined, [picture])).text,
      summarize: async (prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal)).text,
      notes: this.notes, screenshots: this.screenshots, kept: (character, note) => this.texts.added(character, note), knobs,
    });
  }

  /** Every second from the host timer (the work is asynchronous and never throws). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.session.tick().catch(() => undefined); }, 1_000);
    this.timer.unref?.();
    void this.screenshots.sweep().catch(() => undefined); // screenshots past their time go at startup too
  }
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.session.dispose();
    await this.session.settled().catch(() => undefined);
  }

  /** The ports the listen core and the listen host take. */
  listenPorts(): NonNullable<import('../listen-together/host').ListenTogetherDeps['ports']> {
    return {
      heard: (text, at) => this.session.heard(text, at),
      timeline: (character, options) => this.session.render(character, options),
      keywords: info => { void this.keywords.set(info.characterId, info.noteId, 'listen', info.at, info.keywords); },
      keywordsRemoved: (character, ids) => { void (ids === 'all' ? this.keywords.removeSource(character, 'listen') : this.keywords.remove(character, ids)); },
      recall: (text, character) => this.recall(text, character),
    };
  }

  /** What the keywords found of the listened and watched, as the block for a turn (local; loads the character's data off the reply path). */
  private recall(text: string, character: string): { text: string; still(): boolean } | null {
    void this.keywords.ensure(character);
    void this.texts.ensure(character);
    const lines = [text, ...(this.ports.previousLines?.() ?? [])];
    const block = this.keywords.block(character, lines, this.texts);
    if (!block) return null;
    const epoch = this.texts.epoch;
    return { text: block, still: () => this.texts.epoch === epoch };
  }

  /** "Forget her memories" for a character: watch notes, keywords of every kind, cached screenshots (and what is running for her). */
  async forgetCharacter(characterId: string): Promise<void> {
    this.texts.forget(characterId);
    await this.session.forget(characterId);
    await this.keywords.forgetCharacter(characterId);
  }

  /** Watch notes only (descriptions, summaries, their keywords, cached screenshots): gone now. */
  async forgetWatch(characterId: string): Promise<void> {
    this.texts.forget(characterId);
    await this.session.forget(characterId);
  }

  /** The recycle bin's port (electron/recoverable-forget.ts): the notes ride in the chat entry; the screenshot cache is ephemeral and just goes. */
  recyclePort(): { snapshot(characterId: string): Promise<unknown[]>; remove(characterId: string): Promise<void>; restore(characterId: string, notes: readonly unknown[]): Promise<void> } {
    return {
      snapshot: characterId => this.notes.list(characterId),
      remove: characterId => this.forgetWatch(characterId),
      restore: async (characterId, notes) => {
        for (const note of notes) {
          const item = note as WatchNote;
          if (await this.notes.add(characterId, item)) this.texts.added(characterId, item);
        }
      },
    };
  }

  private lastTally = { ...emptyWatchStats(), hits: 0 };

  /**
   * The counts since the last call, for the experience journal's one line a minute (numbers and timings only); null when nothing
   * happened and nothing is cached (a quiet minute writes no line).
   */
  async tally(): Promise<{ described: number; skipped: number; failed: number; late: number; summaries: number; heard: number; haikuCalls: number; haikuMs: number;
    keywordHits: number; cacheFiles: number; cacheKb: number } | null> {
    const now = this.session.stats, before = this.lastTally, hits = this.keywords.stats.hits;
    const cache = await this.screenshots.stats().catch(() => ({ files: 0, bytes: 0 }));
    const out = { described: now.framesDescribed - before.framesDescribed, skipped: now.gateRefused + now.budgetRefused - before.gateRefused - before.budgetRefused,
      failed: now.framesFailed + now.framesInvalid + now.summariesFailed - before.framesFailed - before.framesInvalid - before.summariesFailed,
      late: now.droppedLate - before.droppedLate, summaries: now.summaries - before.summaries, heard: now.heard - before.heard,
      haikuCalls: now.haikuCalls - before.haikuCalls, haikuMs: Math.round(now.haikuMs - before.haikuMs), keywordHits: hits - before.hits,
      cacheFiles: cache.files, cacheKb: Math.round(cache.bytes / 1024) };
    this.lastTally = { ...now, hits };
    const moved = out.described || out.skipped || out.failed || out.late || out.summaries || out.heard || out.haikuCalls || out.keywordHits;
    return moved || out.cacheFiles ? out : null;
  }

  /** Counts and timings for the developer panel and the experience journal. */
  async view(): Promise<WatchTogetherView> {
    return { active: this.session.active, session: { ...this.session.stats }, planner: this.session.planning, timelineEntries: this.session.timelineSize,
      keywords: { ...this.keywords.stats }, cache: await this.screenshots.stats().catch(() => ({ files: 0, bytes: 0 })) };
  }
}

export type { ListenCoreDeps };
