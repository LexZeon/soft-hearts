import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../atomic-file';
import { RPS_RECORD_LIMITS, readRpsGameRecord, type RpsGameRecord } from '../../shared/rps-memory';
import { RPS_MOMENT_CLASSES, RPS_VOICE_MAX, type RpsMomentClass } from '../../shared/rps-voice';

/**
 * G1 猜拳, `<profile>/rps.json`: her own pacing (when she last invited, when they last played, how much she said in
 * games today), a few lines she herself said in games (per card text and kind of moment, for the days the model cannot
 * be asked; never anything the user wrote) and, per character, the finished matches as counts only (hands and results,
 * no text). Matches are added only while the user profile's "允许记录" is on (how-we-work 做事方式 3: remembering the
 * user follows the profile switch); they are kept 30 days, at most 60 per character.
 */
interface Stored {
  version: 1;
  invites: { at: number; date: string }[];
  lastGameAt: number | null;
  /** Today's game lines: model calls made and lines she said (live or remembered). */
  voice: { date: string; calls: number; said: number } | null;
  /** Her own earlier lines: card key → kind of moment → newest last. */
  lines: Record<string, Partial<Record<RpsMomentClass, string[]>>>;
  characters: Record<string, { games: RpsGameRecord[] }>;
}
const empty = (): Stored => ({ version: 1, invites: [], lastGameAt: null, voice: null, lines: {}, characters: {} });
/** Per kind of moment, per card; cards kept. */
export const RPS_REMEMBERED = Object.freeze({ perClass: 4, cards: 8 });
const validCardKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{16,64}$/u.test(value);
const validLine = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  && Array.from(value).length <= RPS_VOICE_MAX + 4 && !/[\u0000-\u001f<>{}\[\]`\\|]/u.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);

export class RpsStore {
  private data: Stored = empty();
  private loaded: 'no' | 'ready' | 'blocked' = 'no';
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: { file: () => string | null; now?: () => number; write?: AtomicFileWriter }) {}

  private now(): number { return (this.options.now ?? Date.now)(); }

  async load(): Promise<void> {
    const file = this.options.file();
    if (!file) { this.loaded = 'ready'; return; }
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('Invalid rps file');
      const data = empty();
      data.invites = (Array.isArray(raw.invites) ? raw.invites : []).filter(row => row && Number.isSafeInteger(row.at) && validDate(row.date)).slice(-16);
      data.lastGameAt = Number.isSafeInteger(raw.lastGameAt) ? raw.lastGameAt! : null;
      const voice = raw.voice;
      data.voice = voice && validDate(voice.date) && [voice.calls, voice.said].every(n => Number.isSafeInteger(n) && n >= 0) ? { date: voice.date, calls: voice.calls, said: voice.said } : null;
      for (const [key, table] of Object.entries(raw.lines ?? {}).slice(-RPS_REMEMBERED.cards)) {
        if (!validCardKey(key) || !table || typeof table !== 'object') continue;
        const kept: Partial<Record<RpsMomentClass, string[]>> = {};
        for (const kind of RPS_MOMENT_CLASSES) {
          const list = (table as Record<string, unknown>)[kind];
          if (Array.isArray(list)) { const clean = list.filter(validLine).slice(-RPS_REMEMBERED.perClass); if (clean.length) kept[kind] = clean; }
        }
        data.lines[key] = kept;
      }
      for (const [id, row] of Object.entries(raw.characters ?? {}).slice(0, 64)) {
        if (!validId(id) || !row || !Array.isArray(row.games)) continue;
        data.characters[id] = { games: row.games.map(readRpsGameRecord).filter((game): game is RpsGameRecord => game !== null) };
      }
      this.data = data; this.loaded = 'ready';
    } catch (error) {
      // Missing: a first launch. Unreadable: leave the file alone and keep this session in memory.
      this.loaded = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'ready' : 'blocked';
    }
  }

  invites(): readonly { at: number; date: string }[] { return this.data.invites.map(row => ({ ...row })); }
  lastGameAt(): number | null { return this.data.lastGameAt; }
  noteInvite(at: number, date: string): void { this.data.invites = [...this.data.invites, { at, date }].slice(-16); this.save(); }
  /** Today's model calls for game lines, and the lines she said in games today. */
  voiceOn(date: string): { calls: number; said: number } { return this.data.voice?.date === date ? { calls: this.data.voice.calls, said: this.data.voice.said } : { calls: 0, said: 0 }; }
  noteVoiceCall(date: string): void { const today = this.voiceOn(date); this.data.voice = { date, calls: today.calls + 1, said: today.said }; this.save(); }
  noteSaid(date: string): void { const today = this.voiceOn(date); this.data.voice = { date, calls: today.calls, said: today.said + 1 }; this.save(); }

  /** Lines she said before at this kind of moment, on this card text (oldest first). */
  remembered(cardKey: string, kind: RpsMomentClass): string[] { return [...(this.data.lines[cardKey]?.[kind] ?? [])]; }
  /** Keeps one of her live lines (newest last, a few per kind, a few cards). */
  remember(cardKey: string, kind: RpsMomentClass, text: string): void {
    if (!validCardKey(cardKey) || !RPS_MOMENT_CLASSES.includes(kind) || !validLine(text)) return;
    const table = this.data.lines[cardKey] ?? {}, list = (table[kind] ?? []).filter(line => line !== text);
    table[kind] = [...list, text].slice(-RPS_REMEMBERED.perClass);
    delete this.data.lines[cardKey];
    this.data.lines[cardKey] = table; // Newest card last.
    const keys = Object.keys(this.data.lines);
    for (const old of keys.slice(0, Math.max(0, keys.length - RPS_REMEMBERED.cards))) delete this.data.lines[old];
    this.save();
  }

  /** Finished matches of this character, oldest first (empty while nothing was recorded). */
  games(characterId: string): RpsGameRecord[] {
    const cutoff = this.now() - RPS_RECORD_LIMITS.keepMs;
    return (this.data.characters[characterId]?.games ?? []).filter(game => game.at >= cutoff).map(game => structuredClone(game));
  }

  /** A match ended: her pacing always; the hands only when `record` (the profile's "允许记录"). */
  finish(characterId: string, game: RpsGameRecord, record: boolean): void {
    this.data.lastGameAt = game.at;
    if (record && validId(characterId) && game.rounds.length) {
      const cutoff = this.now() - RPS_RECORD_LIMITS.keepMs;
      const games = [...(this.data.characters[characterId]?.games ?? []), structuredClone(game)].filter(row => row.at >= cutoff).slice(-RPS_RECORD_LIMITS.games);
      this.data.characters[characterId] = { games };
    }
    this.save();
  }

  /**
   * Privacy (C1 follow-up): the user cleared her diary or turned the profile's "允许记录" off, so this character's
   * match counts go too (they are what she remembers about how the user plays). Her own pacing stays.
   */
  forget(characterId: string): boolean {
    if (!Object.hasOwn(this.data.characters, characterId)) return false;
    delete this.data.characters[characterId];
    this.save();
    return true;
  }

  private save(): void {
    const file = this.options.file();
    if (!file || this.loaded !== 'ready') return;
    const text = JSON.stringify(this.data);
    this.queue = this.queue.then(async () => { await mkdir(path.dirname(file), { recursive: true }); await (this.options.write ?? atomicWriteFile)(file, text); }).catch(() => {});
  }
  flush(): Promise<void> { return this.queue; }
}
