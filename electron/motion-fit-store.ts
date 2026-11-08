import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { acceptMotionFitRecord, mergeMotionFitRecords, type MotionFitRecord } from '../shared/motion-fit-record';

export const MOTION_FITS_FILE = 'motion-fits.json';
export const MAX_MOTION_FIT_MODELS = 32;
const MAX_FILE_BYTES = 4_000_000;
interface StoredMotionFits { version: 1; models: { modelKey: string; record: MotionFitRecord }[] }
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Universal skeleton step 1: each model's library motion scores (shared/motion-fit-record.ts), keyed only by the model's content
 * hash (the same identity as the A1 profile cache, electron/model-profile-store.ts). Standard part words and numbers only: no
 * path, no model names, nothing exported with a character card. The scores are recomputable, so a file this version cannot read
 * simply counts as empty and is replaced by the next save (every model is scored again once). Writes are atomic and serialized.
 */
export class MotionFitStore {
  private readonly file: string;
  private readonly records = new Map<string, MotionFitRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly write: AtomicFileWriter;

  constructor(private readonly directory: string, options: { write?: AtomicFileWriter } = {}) {
    this.file = path.join(directory, MOTION_FITS_FILE);
    this.write = options.write ?? atomicWriteFile;
  }

  /** Never throws: a missing, oversized or unreadable file is no records; a bad row is skipped (that model is scored again). */
  load(): Promise<void> {
    return this.serialize(async () => {
      this.records.clear();
      try {
        const info = await stat(this.file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
        if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.models)) return;
        for (const row of raw.models.slice(-MAX_MOTION_FIT_MODELS)) {
          const record = isObject(row) && isKey(row.modelKey) ? acceptMotionFitRecord(row.record) : null;
          if (!record) continue;
          this.records.delete(row.modelKey as string); this.records.set(row.modelKey as string, record);
        }
      } catch { /* Missing or unreadable: every model is scored again. */ }
    });
  }

  get(key: string | null): MotionFitRecord | null {
    if (!isKey(key)) return null;
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  /**
   * Checks the renderer's record, merges it with this model's stored one (same conversion, check and input: the motions of
   * both; otherwise the new one replaces it), keeps the newest MAX_MOTION_FIT_MODELS models and writes the file.
   * false when the write failed (kept in memory for this session).
   */
  set(key: string, value: unknown): Promise<boolean> {
    if (!isKey(key)) return Promise.reject(new Error('动作评分需要当前模型的内容身份。'));
    const record = acceptMotionFitRecord(value);
    if (!record) return Promise.reject(new Error('动作评分记录不正确。'));
    return this.serialize(async () => {
      const merged = mergeMotionFitRecords(this.records.get(key) ?? null, record);
      if (JSON.stringify(this.records.get(key)) === JSON.stringify(merged)) return true;
      this.records.delete(key); this.records.set(key, merged);
      while (this.records.size > MAX_MOTION_FIT_MODELS) this.records.delete(this.records.keys().next().value!);
      const stored: StoredMotionFits = { version: 1, models: [...this.records].map(([modelKey, saved]) => ({ modelKey, record: saved })) };
      try {
        await mkdir(this.directory, { recursive: true });
        await this.write(this.file, JSON.stringify(stored));
        return true;
      } catch { return false; }
    });
  }

  async flush(): Promise<void> { await this.queue; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
}
