/**
 * I-077 step 2: the host's side of "她认得你常放的歌" (docs/claude/2026-11-11-i077-step2.md). One small file per character in the profile
 * directory (`song-memory-<character id>.json`): version, and per song a handful of numbers (shared/senses/song-memory/index.ts). No audio, no
 * titles, no words. Never exported with the card, never sent anywhere, never read by Claude (the agent channel can only clear it).
 *
 * The companion window asks "is this one I know?" (match) and says "this song ended" (learn), each with the character it is for: a request
 * for a character that is not the current one is refused (a switch while a song played never teaches the new character). The control
 * window shows the count and clears. A clear is a delete: from the control window it is the button, from the agent channel it needs the
 * user's words (electron/safety/agent-channel/app-tools.ts); it keeps the cleared numbers in memory so the channel's undo can put them back.
 * Never throws into the caller's window.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { SongMemory, parseSongMemory, serializeSongMemory, validateSketch, type SongPrint } from '../../shared/senses/song-memory';

const ID = /^[A-Za-z0-9._-]{8,80}$/u;

export interface SongMemoryHostOptions {
  /** The profile directory, or null (tests, no profile yet: nothing is kept). */
  directory(): string | null;
  /** The current character ('' or null: none). */
  characterId(): string | null;
  clock?(): number;
  write?: AtomicFileWriter;
  random?(): number;
}
export type SongMemoryReply = { id: string } | null | { count: number } | { cleared: number };

export class SongMemoryHost {
  private readonly loaded = new Map<string, SongMemory>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SongMemoryHostOptions) {}

  private file(characterId: string): string | null {
    const dir = this.options.directory();
    return dir && ID.test(characterId) ? path.join(dir, `song-memory-${characterId}.json`) : null;
  }
  private today(): number { try { return Math.floor((this.options.clock?.() ?? Date.now()) / 86_400_000); } catch { return 0; } }
  private current(): string { try { return this.options.characterId() || ''; } catch { return ''; } }
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }

  private async memory(characterId: string): Promise<SongMemory | null> {
    const have = this.loaded.get(characterId);
    if (have) return have;
    const file = this.file(characterId);
    if (!file) return null;
    let prints: SongPrint[] = [];
    try { prints = parseSongMemory(await readFile(file, 'utf8')); } catch { prints = []; } // missing or damaged: she simply does not know any song yet
    const memory = new SongMemory(prints, this.options.random);
    this.loaded.set(characterId, memory);
    return memory;
  }
  private async save(characterId: string, memory: SongMemory): Promise<void> {
    const file = this.file(characterId);
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    await (this.options.write ?? atomicWriteFile)(file, serializeSongMemory(memory));
  }

  /**
   * One request from a window. `from`: which window asked (match and learn only from the companion window, clear only from the control
   * window). The reply is numbers or a match id; anything else is refused with null.
   */
  async handle(from: 'pet' | 'control' | 'other', request: unknown): Promise<SongMemoryReply> {
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
      const r = request as { op?: unknown; characterId?: unknown; sketch?: unknown };
      const characterId = this.current();
      if (!characterId) return r.op === 'count' ? { count: 0 } : null;
      if (r.op === 'count') return { count: (await this.memory(characterId))?.size ?? 0 };
      if (r.op === 'clear') return from === 'control' ? { cleared: (await this.clear(characterId)).count } : null;
      if ((r.op !== 'match' && r.op !== 'learn') || from !== 'pet') return null;
      if (r.characterId !== characterId) return null;
      const sketch = validateSketch(r.sketch);
      if (!sketch) return null;
      return await this.serial(async () => {
        const memory = await this.memory(characterId);
        if (!memory) return null;
        if (r.op === 'match') { const found = memory.match(sketch); return found ? { id: found.id } : null; }
        memory.learn(sketch, this.today());
        await this.save(characterId, memory);
        return { count: memory.size };
      });
    } catch { return null; }
  }

  /** How many songs the current character knows. */
  async count(characterId = this.current()): Promise<number> { return characterId ? (await this.memory(characterId))?.size ?? 0 : 0; }

  /** I-144 回收站: her file was written back from the bin; what is held here for her is read again from it. */
  reload(characterId: string): Promise<void> { return this.serial(async () => { this.loaded.delete(characterId); }); }

  /** I-144b 「清除她记得的歌」 through the recycle bin: her file's bytes (base64) and how many songs; null when she knows none. Nothing changes. */
  songsCopy(characterId = this.current()): Promise<{ characterId: string; file: string; count: number } | null> {
    return this.serial(async () => {
      const file = characterId ? this.file(characterId) : null;
      if (!file) return null;
      let bytes: Buffer;
      try { bytes = await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const count = (await this.memory(characterId))?.size ?? 0;
      return count ? { characterId, file: bytes.toString('base64'), count } : null;
    });
  }
  /** Writes what songsCopy copied back byte for byte; resolves to the file it replaced (base64; the caller keeps it in the bin), or null. */
  restoreSongs(characterId: string, base64: string): Promise<string | null> {
    return this.serial(async () => {
      const file = this.file(characterId);
      if (!file || typeof base64 !== 'string') throw new Error('回收站里这一项的数据不完整，原文件已保留。');
      const bytes = Buffer.from(base64, 'base64');
      parseSongMemory(bytes.toString('utf8'));
      let replaced: string | null = null;
      try { const now = await readFile(file); replaced = !now.equals(bytes) ? now.toString('base64') : null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await mkdir(path.dirname(file), { recursive: true });
      await (this.options.write ?? atomicWriteFile)(file, bytes.toString('utf8'));
      this.loaded.delete(characterId);
      return replaced;
    });
  }

  /** Forgets every song of a character (the file goes too). `restore()` puts the same numbers back. */
  clear(characterId = this.current()): Promise<{ count: number; restore(): Promise<void> }> {
    return this.serial(async () => {
      if (!characterId) return { count: 0, restore: async () => {} };
      const memory = await this.memory(characterId);
      const prints = memory ? memory.list() : [];
      memory?.clear();
      const file = this.file(characterId);
      if (file) await rm(file, { force: true });
      return { count: prints.length, restore: () => this.serial(async () => {
        if (!prints.length) return;
        const mem = await this.memory(characterId);
        if (!mem || mem.size) return; // she has learned something since: the undo does not overwrite it
        const back = new SongMemory(prints, this.options.random);
        this.loaded.set(characterId, back);
        await this.save(characterId, back);
      }) };
    });
  }
}
