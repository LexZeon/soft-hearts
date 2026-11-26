// I-059 特别的日子 without 「她的文件夹」: on the user's birthday or an anniversary (dates the user told her, 「允许记录」 on; shared/memory/keepsake.ts
// parseSpecialDates, the same source as I-050) she may say something herself.
//  - The first daytime turn the user talks to her that day: one private line in that turn's context (like I-056's hint). She decides
//    whether and how. If her shown reply touches the day (a local word check) the day is done; otherwise at most two more turns carry it.
//  - Before the user has talked to her: one short line she writes herself (one model call, only when she is calm) goes out through the
//    existing opening choice / inner loop as a 'tell' (the same quotas, quiet hours, asleep and busy checks as every proactive line).
//  - The experience journal gets closed lines (hinted / said / expired / user-first) with who spoke of the day first; never any text.
// Only while her folder is OFF (with it on, I-050's keepsake path is the one that speaks). Every other turn's prompt is untouched.
import { readFile } from 'node:fs/promises';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { dropEntries, putEntries, takeEntries, type ListedPart } from '../../foundation/keyed-part';
import {
  SPECIAL_DAY_LIMITS, cleanSpokenLine, datesToday, dayStamp, emptyBook, freshRecord, isQuietHour, mentionsDay, readBook, recordKey,
  specialDayHintLine, type SpecialDayBook, type SpecialDayEvent, type SpecialDayRecord, type SpecialKind,
} from '../../../shared/memory/special-day';

export interface SpecialDayHostOptions {
  /** <profile>/special-day.json; null before the app is ready. */
  file(): string | null;
  characterId(): string | null;
  /** Her folder is on (then I-050 speaks and this stays silent). */
  folderOn(): boolean;
  /** The profile's entry texts while 「允许记录」 is on; null when it is off (then she knows no date). */
  recordingTexts(): readonly string[] | null;
  /** Closed journal line; never any text. */
  journal(input: { characterId: string | null; event: SpecialDayEvent; kind: SpecialKind; first: 'her' | 'user' | null }): void;
  /** The same gates proactive talk uses for background work (not asleep, the user not busy, no chat or model call going, Claude reachable). */
  calm?(): boolean;
  /** The one model call for her own line (step 4): her answer text. Throws or returns '' on failure. Omitted: no line of her own, only the hint. */
  ask?(kind: SpecialKind, signal: AbortSignal, language?: CardLanguage): Promise<string>;
  /** I-071: her language now; English gets the English hint and writes her own line in English. Omitted or failing: Chinese, as before. */
  language?(): CardLanguage;
  now?(): number;
  writeAtomic?: AtomicFileWriter;
  timeoutMs?: number;
}

/** What a hint turn carries to the end of the turn. */
export interface SpecialDayHintTurn { characterId: string; day: string; kind: SpecialKind; line: string }

const TICK_MS = 10 * 60_000;
const MAX_LINE_TRIES = 2;

export class SpecialDayHost {
  private book: SpecialDayBook = emptyBook();
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private pretend: SpecialKind | null = null;
  private busy = false;
  /** The line she wrote for today (memory only: never on disk), and the cue it was handed to. */
  private pending: { key: string; text: string; kind: SpecialKind } | null = null;
  private delivering: { cue: string; key: string; kind: SpecialKind } | null = null;
  private tries = new Map<string, number>();
  private readonly writeAtomic: AtomicFileWriter;
  constructor(private readonly options: SpecialDayHostOptions) { this.writeAtomic = options.writeAtomic ?? atomicWriteFile; }

  private now(): number { const value = (this.options.now ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); }
  private language(): CardLanguage { try { return this.options.language?.() ?? 'zh-CN'; } catch { return 'zh-CN'; } }
  private self(): string | null { try { return this.options.characterId(); } catch { return null; } }
  private texts(): readonly string[] | null { try { return this.options.recordingTexts(); } catch { return null; } }
  private folderOn(): boolean { try { return this.options.folderOn() === true; } catch { return true; } }
  private journal(characterId: string | null, event: SpecialDayEvent, record: SpecialDayRecord): void {
    try { this.options.journal({ characterId, event, kind: record.kind, first: record.first }); } catch { /* the journal never changes what she says */ }
  }

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) return;
    try { this.book = readBook(JSON.parse(await readFile(file, 'utf8')), this.now()); } catch { this.book = emptyBook(); }
  }
  start(): void {
    if (this.timer || !this.options.ask) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => { void this.tick().catch(() => {}); }, 45_000);
    this.first.unref?.();
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = this.first = null;
  }
  async idle(): Promise<void> { await this.saving; }
  private save(): void {
    const file = this.options.file();
    if (!file) return;
    const text = JSON.stringify(this.book);
    this.saving = this.saving.then(() => this.writeAtomic(file, text)).catch(() => {});
  }

  // ---- I-144 回收站 (electron/memory/recycle-wiring.ts) ----
  /** This character's days (each with its place in the book), or null. */
  recycleCopy(characterId: string): ListedPart<[string, unknown]> | null { return takeEntries(this.book.records as Record<string, unknown>, key => key.startsWith(`${characterId}|`)); }
  /** Forgets this character's days (the deletion of her memories); written at once. */
  forgetCharacter(characterId: string): Promise<void> {
    this.book.records = dropEntries(this.book.records, key => key.startsWith(`${characterId}|`));
    if (this.pending?.key.startsWith(`${characterId}|`)) this.pending = null;
    if (this.delivering?.key.startsWith(`${characterId}|`)) this.delivering = null;
    this.save();
    return this.saving;
  }
  /** Puts what recycleCopy copied back at its places. */
  recycleRestore(characterId: string, captured: unknown): Promise<void> {
    const part = captured as ListedPart<[string, unknown]>;
    if (!part?.items?.every(item => Array.isArray(item?.value) && String(item.value[0]).startsWith(`${characterId}|`))) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    this.book.records = putEntries(this.book.records as Record<string, unknown>, part) as SpecialDayBook['records'];
    this.save();
    return this.saving;
  }

  /** Days that ended with the chances unused: one 'expired' line each (once). Cheap; called on every look. */
  private sweep(): void {
    const today = dayStamp(this.now());
    let changed = false;
    for (const [key, record] of Object.entries(this.book.records)) {
      const day = key.split('|').at(-1) ?? '';
      if (day >= today || record.done || record.closed || record.hints === 0) continue;
      record.closed = true; changed = true;
      this.journal(key.slice(0, key.length - day.length - 1) || null, 'expired', record);
    }
    if (changed) this.save();
  }

  /** Today's record for this character, when today is a day she should know of and her folder is off; else null (and nothing is created). */
  private today(characterId: string, create: boolean): { key: string; record: SpecialDayRecord } | null {
    if (this.folderOn()) return null;
    const now = this.now(), dates = datesToday(now, this.texts(), this.pretend);
    if (!dates.length) return null;
    const key = recordKey(characterId, dayStamp(now));
    let record = this.book.records[key];
    if (!record) {
      if (!create) return { key, record: freshRecord(dates[0].kind) };
      record = this.book.records[key] = freshRecord(dates[0].kind);
    }
    return { key, record };
  }

  // ------------------------------------------------------------------ the first turn of the day

  /**
   * Called for every user chat turn with the user's text. Returns this turn's private line (or null: the usual, byte-identical turn).
   * A user who speaks of the day first is noted ('user-first') and gets no line.
   */
  beginHint(userText: unknown): SpecialDayHintTurn | null {
    const characterId = this.self();
    if (!characterId) return null;
    this.sweep();
    const day = this.today(characterId, false);
    if (!day) return null;
    const { key } = day, quiet = isQuietHour(this.now());
    const record = this.book.records[key] ?? (this.book.records[key] = freshRecord(day.record.kind));
    if (record.done) return null;
    if (!record.first && mentionsDay(record.kind, userText)) {
      // The user said it first: she will answer in her own way anyway; nothing is added to her prompt.
      record.first = 'user'; record.done = true; record.spoke = !quiet || record.spoke;
      this.journal(characterId, 'user-first', record);
      this.save();
      return null;
    }
    if (quiet || record.hints >= SPECIAL_DAY_LIMITS.maxHints) return null;
    record.hints++; record.spoke = true;
    this.pending = null; // she is talking to the user now: the line of her own is not needed
    this.journal(characterId, 'hinted', record);
    this.save();
    return { characterId, day: dayStamp(this.now()), kind: record.kind, line: specialDayHintLine(record.kind, this.language()) };
  }

  /** After a complete reply of a hint turn: her shown reply touched the day (the day is done), or the chances ran out. */
  hintDone(turn: SpecialDayHintTurn | null | undefined, reply: unknown): boolean {
    if (!turn || this.self() !== turn.characterId) return false;
    const key = recordKey(turn.characterId, turn.day), record = this.book.records[key];
    if (!record || record.done) return false;
    if (mentionsDay(record.kind, reply)) {
      record.done = true; record.first ??= 'her';
      this.journal(turn.characterId, 'said', record);
      this.save();
      return true;
    }
    if (record.hints >= SPECIAL_DAY_LIMITS.maxHints) {
      record.done = true; record.closed = true;
      this.journal(turn.characterId, 'expired', record);
      this.save();
    }
    return false;
  }

  // ------------------------------------------------------------------ before the user has talked (step 4)

  /** Writes her own line once she is calm and the day is on (one model call). Cheap when there is nothing to do. */
  async tick(): Promise<void> {
    const characterId = this.self(), ask = this.options.ask;
    if (!characterId || !ask || this.busy || this.pending) return;
    this.sweep();
    if (isQuietHour(this.now()) || !(this.options.calm?.() ?? true)) return;
    const day = this.today(characterId, false);
    if (!day || day.record.done || day.record.spoke || (this.tries.get(day.key) ?? 0) >= MAX_LINE_TRIES) return;
    this.busy = true;
    this.tries.set(day.key, (this.tries.get(day.key) ?? 0) + 1);
    const control = new AbortController(), timer = setTimeout(() => control.abort(), this.options.timeoutMs ?? 120_000);
    timer.unref?.();
    try {
      let text = '';
      try { const language = this.language(); text = cleanSpokenLine(await ask(day.record.kind, control.signal, language), language); } catch { text = ''; }
      // Checked again where it takes effect: the user talked, the folder came on, recording went off or the day changed while she wrote.
      const again = this.today(characterId, false);
      if (!text || !again || again.key !== day.key || again.record.done || again.record.spoke || this.self() !== characterId || isQuietHour(this.now())) return;
      this.pending = { key: day.key, text, kind: day.record.kind };
    } finally { clearTimeout(timer); this.busy = false; }
  }

  private live(characterId: string): { key: string; text: string; kind: SpecialKind } | null {
    const pending = this.pending;
    if (!pending || isQuietHour(this.now())) return null;
    const day = this.today(characterId, false);
    if (!day || day.key !== pending.key || day.record.done || day.record.spoke) { this.pending = null; return null; }
    return pending;
  }

  /** The opening choice looks (not takes): 'tell' = she holds her own line for today. */
  peek(characterId: string): 'tell' | null {
    return characterId && characterId === this.self() && this.live(characterId) ? 'tell' : null;
  }
  /** The inner loop asks for the line (focus 'keepsake'). */
  line(claim: { readonly id: string; readonly characterId: string }): string | null {
    const live = claim.characterId === this.self() ? this.live(claim.characterId) : null;
    if (!live) return null;
    this.delivering = { cue: claim.id, key: live.key, kind: live.kind };
    return live.text;
  }
  /** The line was really shown and archived: the day is done, and she was the first (unless the user already spoke of it). */
  noteDelivered(messageId: unknown): void {
    const delivering = this.delivering;
    if (!delivering || delivering.cue !== messageId) return;
    this.delivering = null; this.pending = null;
    const record = this.book.records[delivering.key] ??= freshRecord(delivering.kind);
    if (record.done) return;
    record.done = true; record.first ??= 'her';
    this.journal(delivering.key.slice(0, delivering.key.lastIndexOf('|')) || null, 'said', record);
    this.save();
  }
  counts(characterId: string): string {
    const record = this.book.records[recordKey(characterId, dayStamp(this.now()))];
    return record ? `特别的日子（没开文件夹）：提示 ${record.hints} 次，${record.done ? '已说过' : '还没说'}` : '';
  }

  /** I-086: today is a birthday or anniversary the user told her about (needs 「允许记录」, like everything here; her folder does not matter). */
  isSpecialToday(): boolean {
    try { return datesToday(this.now(), this.texts(), this.pretend).length > 0; } catch { return false; }
  }

  /** The same shape as KeepsakeHost.port, to be combined with it. */
  port(on: () => boolean): {
    peek(characterId: string): 'tell' | null;
    line(claim: { readonly id: string; readonly characterId: string }): string | null;
    counts(characterId: string): string;
  } {
    const enabled = () => { try { return on() === true; } catch { return false; } };
    return { peek: id => (enabled() ? this.peek(id) : null), line: claim => (enabled() ? this.line(claim) : null), counts: id => this.counts(id) };
  }

  // ------------------------------------------------------------------ developer test command

  /**
   * 「测试：今天是生日」: pretend today is that kind of day. Follows the same switches (recording on, folder off); today's record starts over so it
   * can be tried again. 'recording-off' / 'folder-on' refuse; the made-up day lasts until the app quits.
   */
  testPretend(kind: SpecialKind): 'ok' | 'recording-off' | 'folder-on' | 'no-character' {
    const characterId = this.self();
    if (!characterId) return 'no-character';
    if (this.texts() === null) return 'recording-off';
    if (this.folderOn()) return 'folder-on';
    this.pretend = kind;
    delete this.book.records[recordKey(characterId, dayStamp(this.now()))];
    this.pending = null; this.tries.clear();
    this.save();
    return 'ok';
  }
}

/** The turn's one-line hint slot: every line that applies, joined; undefined when none (so an ordinary turn passes exactly what it did before). */
export const joinHintLines = (...lines: readonly (string | null | undefined)[]): string | undefined => lines.filter((line): line is string => !!line).join('\n') || undefined;

/** One 'tell' source added to another (the keepsake port): hers first, then this one; 'write' stays with the keepsake. */
export function combineTellPorts<K extends {
  peek(characterId: string): 'write' | 'tell' | null;
  write(characterId: string, cue: { readonly id: string; readonly at: number }): boolean;
  line(claim: { readonly id: string; readonly characterId: string }): string | null;
  counts(characterId: string): string;
}>(keepsake: K, special: { peek(characterId: string): 'tell' | null; line(claim: { readonly id: string; readonly characterId: string }): string | null; counts(characterId: string): string }): K {
  return {
    ...keepsake,
    peek: id => { const a = keepsake.peek(id); return a === 'tell' ? a : special.peek(id) ?? a; },
    line: claim => keepsake.line(claim) ?? special.line(claim),
    counts: id => [keepsake.counts(id), special.counts(id)].filter(Boolean).join('；'),
  };
}
