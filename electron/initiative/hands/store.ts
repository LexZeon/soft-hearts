/**
 * I-087 牵手、拉钩、击掌：按角色记的小账（shared/behaviors/hands/choose.ts HandsLedger）——今天伸了几次手、上一次什么时候、第一次牵手
 * 有没有过、拉过钩的计划编号。存在 `<配置>/hands/<角色>.json`，原子写入；不混进她的记忆、日记或画像文件；没有任何对话内容。
 * 读不出来的文件这一次会话只在内存里用、不覆盖。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../../foundation/atomic-file';
import { emptyHandsLedger, readHandsLedger, type HandsLedger } from '../../../shared/behaviors/hands/choose';

const CHARACTER = /^[A-Za-z0-9_-]{1,100}$/u;

export class HandsStore {
  private readonly rows = new Map<string, HandsLedger>();
  private readonly blocked = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { directory(): string | null; write?: AtomicFileWriter }) {}

  private file(characterId: string): string | null {
    const root = this.options.directory();
    return root && CHARACTER.test(characterId) ? path.join(root, 'hands', `${characterId}.json`) : null;
  }

  load(characterId: string): Promise<void> {
    if (!CHARACTER.test(characterId) || this.rows.has(characterId)) return Promise.resolve();
    const running = this.loading.get(characterId);
    if (running) return running;
    const job = (async () => {
      const file = this.file(characterId);
      let ledger = emptyHandsLedger();
      if (file) {
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as { v?: unknown; ledger?: unknown };
          const read = raw && raw.v === 1 ? readHandsLedger(raw.ledger) : null;
          if (!read) throw new Error('bad hands file');
          ledger = read;
        } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.blocked.add(characterId); }
      }
      this.rows.set(characterId, ledger);
    })().finally(() => this.loading.delete(characterId));
    this.loading.set(characterId, job);
    return job;
  }

  loaded(characterId: string): boolean { return this.rows.has(characterId); }
  ledger(characterId: string): HandsLedger | null { return this.rows.get(characterId) ?? null; }

  /** The new ledger, in memory at once and on disk in order (an unreadable file is never overwritten this session). */
  set(characterId: string, ledger: HandsLedger): Promise<boolean> {
    if (!CHARACTER.test(characterId)) return Promise.resolve(false);
    this.rows.set(characterId, ledger);
    const run = this.queue.then(async () => {
      const file = this.file(characterId);
      if (!file || this.blocked.has(characterId)) return false;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await (this.options.write ?? atomicWriteFile)(file, JSON.stringify({ v: 1, ledger: this.rows.get(characterId) ?? ledger }) + '\n');
        return true;
      } catch { return false; }
    });
    this.queue = run.catch(() => false);
    return run;
  }

  /**
   * I-144 (删角色并勾选「同时删除她的记忆」, through the recycle bin): this character's ledger goes, file and memory. Also what the bin
   * calls before writing her file back, so no copy held here writes over it. After the queue, so a pending write cannot bring it back.
   */
  forget(characterId: string): Promise<void> {
    const run = this.queue.then(async () => {
      this.rows.delete(characterId); this.blocked.delete(characterId);
      const file = this.file(characterId);
      if (file) await rm(file, { force: true });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every character this session knows (recording off clears their promises). */
  known(): string[] { return [...this.rows.keys()]; }
  settled(): Promise<unknown> { return this.queue; }
}
