// 给你留点东西 (I-050 第 2 步): things she makes for her folder on her own, not from a chat turn.
//  - 特别的日子: a date the user told her (their profile, only while 「允许记录」 is on), a few days before she prepares something with one
//    model call and leaves it in the folder; on the day she says one light line ("去我的文件夹看看") through the normal proactive path.
//    Once per date per year. No date, recording off or the folder off: nothing.
//  - 偶尔留一份: one more candidate in her opening choice (shared/behaviors/opening-choice/, id 'keepsake'). Chosen, the cue is hers
//    and stays spent like any proactive cue (the same interval and hourly limits, nothing on top); the writing is quiet and runs in the
//    background. If she wants to mention it, the light line waits for one of the next ordinary speech cues.
// The folder's own checks (ticket bound to the switch and the real folder, names, sizes, links, versions, journal) stay in host.ts `keep`.
// Docs: docs/claude/2026-11-08-i050-her-folder.md (第 2 步).
import { randomUUID } from 'node:crypto';
import { herVoiceRelaxed } from '../../../shared/voice';
import { withSpeechLanguage } from '../../../shared/brain';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { readFile } from 'node:fs/promises';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { dropEntries, putEntries, putKeyed, takeEntries, takeKeyed, type KeyedPart, type ListedPart } from '../../foundation/keyed-part';
import type { MoodTendency } from '../../../shared/foundation/mood';
import {
  KEEPSAKE_KNOBS, daysUntil, drawForm, drawGapMs, emptyCharacter, emptyLedger, ledgerKey, leadDaysFor, parseSpecialDates, readLedger, specialKey,
  startOfDay, tellDeadline, type CharacterKeepsakes, type KeepsakeLedger, type PendingTell, type SpecialDate,
} from '../../../shared/memory';
import type { HerKeepOutcome, HerKeepTicket } from './host';
import { keepsakePrompt, parseKeepsake } from './keepsake-prompt';

/** The slice of HerFolderHost a keepsake uses. */
export interface KeepsakeFolderPort {
  beginKeepsake(): HerKeepTicket | null;
  keepsakeCurrent(ticket: HerKeepTicket | null | undefined): boolean;
  keep(ticket: HerKeepTicket | null | undefined, name: unknown, content: unknown): Promise<HerKeepOutcome>;
  fileNames(): Promise<string[]>;
}

export interface KeepsakeHostOptions {
  folder: KeepsakeFolderPort;
  /** <profile>/her-keepsakes.json; null before the app is ready. */
  file(): string | null;
  characterId(): string | null;
  /** The profile's entry texts while 「允许记录」 is on for the current scope; null when it is off (then she knows no date and uses no profile). */
  recordingTexts(): readonly string[] | null;
  persona(): string;
  /** The active card's language (cardLanguageOf): an English card writes its keepsake and its one line in English. Absent: Chinese. */
  speechLanguage?(): CardLanguage;
  moodWords(): string;
  personality(): Partial<Record<MoodTendency, number>>;
  /** 「她主动找你说话」: 1 = 适中, > 1 = 少一点 (her own keepsakes get farther apart). */
  talkScale?(): number;
  /** The same gates proactive talk uses for background work: not asleep, the user not busy, no chat or other model call going, Claude reachable. */
  calm(): boolean;
  /** The one model call: the whole answer text. Throws or returns '' on failure. */
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  now?(): number;
  random?(): number;
  writeAtomic?: AtomicFileWriter;
  timeoutMs?: number;
  /**
   * 心情第二批 (electron/mood/mood-moments.ts): her light line about a keepsake was really shown: she said it out ('keepsake', C a little
   * down); when it was for the user's special day, also 'special-day' (D, O a little up). `key` is the line's message id.
   */
  moment?(kind: 'keepsake' | 'special-day', characterId: string, key: string): void;
}

const TICK_MS = 10 * 60_000;

export class KeepsakeHost {
  private ledger: KeepsakeLedger = emptyLedger();
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private delivering: { cue: string; tell: string } | null = null;
  private saving: Promise<void> = Promise.resolve();
  private running: Promise<void> = Promise.resolve();
  private readonly writeAtomic: AtomicFileWriter;
  constructor(private readonly options: KeepsakeHostOptions) { this.writeAtomic = options.writeAtomic ?? atomicWriteFile; }

  private now(): number { const value = (this.options.now ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); }
  private random(): number { try { const value = (this.options.random ?? Math.random)(); return Number.isFinite(value) ? value : 0; } catch { return 0; } }
  private self(): string | null { try { return this.options.characterId(); } catch { return null; } }
  private char(id: string): CharacterKeepsakes { return this.ledger.characters[id] ??= emptyCharacter(); }

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) return;
    try { this.ledger = readLedger(JSON.parse(await readFile(file, 'utf8')), this.now()); } catch { this.ledger = emptyLedger(); }
  }

  /** The ticker for special days (the occasional ones need no timer: they ride on her speech opportunities). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => { void this.tick().catch(() => {}); }, 30_000);
    this.first.unref?.();
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = this.first = null;
  }
  /** Waits for the keepsake being written and the ledger writes (tests, quitting). */
  async idle(): Promise<void> { await this.running; await this.saving; }

  private save(): void {
    const file = this.options.file();
    if (!file) return;
    const text = JSON.stringify(this.ledger);
    this.saving = this.saving.then(() => this.writeAtomic(file, text)).catch(() => {});
  }

  // ------------------------------------------------------------------ I-144 回收站 (electron/memory/recycle-wiring.ts)

  /** What the ledger keeps for this character (her counts and her special days), copied with their places; null when nothing. */
  recycleCopy(characterId: string): { character: KeyedPart | null; specials: ListedPart<[string, unknown]> | null } | null {
    const character = takeKeyed(this.ledger.characters as Record<string, unknown>, characterId);
    const specials = takeEntries(this.ledger.specials as Record<string, unknown>, key => key.startsWith(`${characterId}|`));
    return character || specials ? { character, specials } : null;
  }
  /** Forgets this character (the deletion of her memories); written at once. */
  forgetCharacter(characterId: string): Promise<void> {
    delete this.ledger.characters[characterId];
    this.ledger.specials = dropEntries(this.ledger.specials, key => key.startsWith(`${characterId}|`));
    this.save();
    return this.saving;
  }
  /** Puts what recycleCopy copied back at its places. */
  recycleRestore(characterId: string, captured: unknown): Promise<void> {
    const value = captured as { character?: KeyedPart | null; specials?: ListedPart<[string, unknown]> | null } | null;
    if (!value || typeof value !== 'object') throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    if (value.character) this.ledger.characters = putKeyed(this.ledger.characters as Record<string, unknown>, characterId, value.character) as KeepsakeLedger['characters'];
    if (value.specials) this.ledger.specials = putEntries(this.ledger.specials as Record<string, unknown>, value.specials) as KeepsakeLedger['specials'];
    this.save();
    return this.saving;
  }

  // ------------------------------------------------------------------ what the opening choice sees

  /** The live light line she holds for this character, or null. A special-day line also needs 「允许记录」 still on. */
  private liveTell(characterId: string, now: number): PendingTell | null {
    const c = this.ledger.characters[characterId], tell = c?.tell;
    if (!c || !tell) return null;
    if (now >= tell.until || (tell.kind === 'special' && this.options.recordingTexts() === null)) { c.tell = null; this.save(); return null; }
    return now >= tell.from ? tell : null;
  }

  /** Look, don't take: 'tell' = she holds a line about something she left; 'write' = she may leave a new one; null = neither (or the folder is off). */
  peek(characterId: string): 'write' | 'tell' | null {
    if (!characterId || characterId !== this.self() || !this.options.folder.beginKeepsake()) return null;
    const now = this.now();
    if (this.liveTell(characterId, now)) return 'tell';
    if (this.busy) return null;
    const c = this.char(characterId);
    if (c.nextAt === null) {
      // First sight with the folder on: she does not write the moment it is given to her.
      c.nextAt = now + drawGapMs(this.options.personality(), this.talkScale(), () => this.random(), KEEPSAKE_KNOBS) / 2;
      this.save();
      return null;
    }
    return now >= c.nextAt ? 'write' : null;
  }

  /** The opening choice picked "给你留点东西" with the 'write' mode: start the quiet writing (background). True when it started. */
  write(characterId: string, _cue: { readonly id: string; readonly at: number }): boolean {
    if (this.peek(characterId) !== 'write' || !this.options.calm()) return false;
    const c = this.char(characterId), now = this.now();
    // The next one is drawn now, so a failed call does not make her try again at once.
    c.nextAt = now + drawGapMs(this.options.personality(), this.talkScale(), () => this.random(), KEEPSAKE_KNOBS);
    this.save();
    this.running = this.make(characterId, null).then(() => {}, () => {});
    return true;
  }

  /** The inner loop asks for the written line (focus 'keepsake'). */
  line(claim: { readonly id: string; readonly characterId: string }): string | null {
    const tell = this.liveTell(claim.characterId, this.now());
    if (!tell) return null;
    this.delivering = { cue: claim.id, tell: tell.id };
    return tell.text;
  }

  /** The line was really shown and archived: it is told, once. */
  noteDelivered(messageId: unknown): void {
    const delivering = this.delivering;
    if (!delivering || delivering.cue !== messageId) return;
    this.delivering = null;
    const told: { characterId: string; special: boolean }[] = [];
    for (const [characterId, c] of Object.entries(this.ledger.characters)) {
      if (c.tell?.id !== delivering.tell) continue;
      const ledger = c.tell.ledger;
      c.tell = null;
      if (ledger && this.ledger.specials[ledger]) this.ledger.specials[ledger].told = true;
      told.push({ characterId, special: !!ledger });
    }
    this.save();
    for (const { characterId, special } of told) {
      try { this.options.moment?.('keepsake', characterId, String(messageId)); if (special) this.options.moment?.('special-day', characterId, String(messageId)); }
      catch { /* her mood never changes what she kept */ }
    }
  }

  /** What the inner loop host (electron/initiative/inner-loop/host.ts `keepsake`) gets. `on`: the app setting 「内心循环」; off, she has no such candidate. */
  port(on: () => boolean): {
    peek(characterId: string): 'write' | 'tell' | null;
    write(characterId: string, cue: { readonly id: string; readonly at: number }): boolean;
    line(claim: { readonly id: string; readonly characterId: string }): string | null;
    counts(characterId: string): string;
  } {
    const enabled = () => { try { return on() === true; } catch { return false; } };
    return {
      peek: id => (enabled() ? this.peek(id) : null),
      write: (id, cue) => enabled() && this.write(id, cue),
      line: claim => this.line(claim),
      counts: id => this.counts(id),
    };
  }

  /** Counts only, for the developer view. */
  counts(characterId: string): string {
    const c = this.ledger.characters[characterId] ?? emptyCharacter();
    return `给你留点东西：特别的日子 ${c.special} 份，平时 ${c.occasional} 份，${c.tell ? '手里有 1 件还没说' : '没有等着说的'}`;
  }

  // ------------------------------------------------------------------ special days

  /** Looks at the dates she knows; prepares at most one thing per look. Cheap when there is nothing to do. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const id = this.self(), texts = this.options.recordingTexts();
    if (!id || texts === null || !this.options.folder.beginKeepsake()) return;
    const dates = parseSpecialDates(texts);
    if (!dates.length) return;
    const now = this.now();
    for (const date of dates) {
      const key = specialKey(date), { days, year } = daysUntil(now, date.month, date.day);
      const ledger = ledgerKey(id, key, year), record = this.ledger.specials[ledger];
      if (record && (record.done || record.attempts >= KEEPSAKE_KNOBS.maxAttempts || now - record.lastAttemptAt < KEEPSAKE_KNOBS.retryGapMs)) continue;
      if (days > leadDaysFor(id, key, year)) continue;
      if (!this.options.calm()) return;
      await this.make(id, { date, days, ledger });
      return;
    }
  }

  // ------------------------------------------------------------------ the one call

  private talkScale(): number { try { return this.options.talkScale?.() ?? 1; } catch { return 1; } }

  private async make(characterId: string, special: { date: SpecialDate; days: number; ledger: string } | null): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const ticket = this.options.folder.beginKeepsake();
      if (!ticket) return false;
      const started = this.now();
      if (special) {
        // Counted before the call: a crash or a failed answer still uses up one of the attempts for this date this year.
        const record = this.ledger.specials[special.ledger] ??= { attempts: 0, lastAttemptAt: 0, done: false, told: false };
        record.attempts++; record.lastAttemptAt = started;
        this.save();
      }
      const form = drawForm(this.options.personality(), this.char(characterId).lastForm, () => this.random());
      const names = await this.options.folder.fileNames();
      const texts = this.options.recordingTexts();
      const profile = texts ? texts.filter(text => typeof text === 'string' && text.length <= 80).slice(0, 10) : [];
      const prompt = withSpeechLanguage(keepsakePrompt({ persona: this.options.persona(), moodWords: this.options.moodWords(), today: dateWords(started), form,
        special: special ? { date: special.date, daysLeft: special.days } : null, points: profile, names, ...(herVoiceRelaxed() ? { relaxed: true } : {}) }), (() => { try { return this.options.speechLanguage?.() ?? 'zh-CN'; } catch { return 'zh-CN'; } })());
      if (!this.options.folder.keepsakeCurrent(ticket) || characterId !== this.self()) return false;
      const control = new AbortController(), timer = setTimeout(() => control.abort(), this.options.timeoutMs ?? 150_000);
      timer.unref?.();
      let answer = '';
      try { answer = await this.options.ask(prompt, control.signal); } catch { answer = ''; } finally { clearTimeout(timer); }
      const parsed = parseKeepsake(answer);
      if (!parsed || characterId !== this.self()) return false;
      // Recording turned off while she was writing: a special-day gift is not written (she no longer knows the date).
      if (special && this.options.recordingTexts() === null) return false;
      const outcome = await this.options.folder.keep(ticket, parsed.name, parsed.content);
      if (!outcome.ok) return false;
      const now = this.now(), c = this.char(characterId);
      c.lastForm = form.id;
      if (special) {
        c.special++;
        const record = this.ledger.specials[special.ledger];
        record.done = true; record.file = outcome.name;
        if (parsed.say) c.tell = { id: randomUUID(), text: parsed.say, from: startOfDay(now, special.days), until: tellDeadline(now, special.days), kind: 'special', ledger: special.ledger };
        else record.told = true;
      } else {
        c.occasional++;
        // She mentions it lightly or not at all, as she wished; a special-day line already waiting is not replaced.
        if (parsed.say && !c.tell) c.tell = { id: randomUUID(), text: parsed.say, from: now, until: now + KEEPSAKE_KNOBS.mentionKeepMs, kind: 'mention', ledger: null };
      }
      this.save();
      return true;
    } finally { this.busy = false; }
  }
}

function dateWords(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
