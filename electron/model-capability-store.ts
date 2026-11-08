import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { acceptCapabilityRecord, emptyCapabilityRecord, type ModelCapabilityRecord } from '../shared/model-capability-check';

export const MODEL_CAPABILITIES_FILE = 'model-capabilities.json';
export const MAX_MODEL_CAPABILITY_RECORDS = 64;
const MAX_FILE_BYTES = 1_000_000;
interface StoredCapabilities { version: 1; models: { modelKey: string; record: ModelCapabilityRecord }[] }
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;

export interface ModelCapabilityStoreOptions { write?: AtomicFileWriter; copy?: typeof copyFile; now?: () => number }

/**
 * I-024 模型体检 records (shared/model-capability-check.ts), one per model, keyed only by its content hash (the A1 profile
 * cache's identity). Names and choices only: no path, no chat, nothing exported with a character card. Writes are atomic and
 * serialized. A file this version cannot read is never overwritten in place: it is copied aside once
 * (model-capabilities.unreadable-<time>.json) before the first new write, and its models are simply checked again. If even
 * that copy fails, or the file cannot be read at all, the records live in memory only for this session.
 */
export class ModelCapabilityStore {
  private readonly file: string;
  private readonly records = new Map<string, ModelCapabilityRecord>();
  private state: 'unloaded' | 'ready' | 'memory-only' = 'unloaded';
  /** The file on disk holds something this version could not read: keep a copy before replacing it. */
  private preserve = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly write: AtomicFileWriter;
  private readonly copy: typeof copyFile;
  private readonly now: () => number;
  /** Where an unreadable file was copied (for the record; tests read it). */
  preservedAs: string | null = null;

  constructor(private readonly directory: string, options: ModelCapabilityStoreOptions = {}) {
    this.file = path.join(directory, MODEL_CAPABILITIES_FILE);
    this.write = options.write ?? atomicWriteFile;
    this.copy = options.copy ?? copyFile;
    this.now = options.now ?? Date.now;
  }

  /** Never throws: a missing file is empty, an unreadable one counts as no records (and is kept). */
  load(): Promise<void> {
    return this.serialize(async () => {
      this.records.clear(); this.preserve = false; this.preservedAs = null;
      let text: string;
      try {
        const info = await stat(this.file);
        if (!info.isFile()) { this.state = 'memory-only'; return; }
        if (info.size > MAX_FILE_BYTES) { this.preserve = true; this.state = 'ready'; return; }
        text = await readFile(this.file, 'utf8');
      } catch (error) { this.state = errorCode(error) === 'ENOENT' ? 'ready' : 'memory-only'; return; }
      this.state = 'ready';
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { this.preserve = true; return; }
      if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.models)) { this.preserve = true; return; }
      for (const row of raw.models.slice(-MAX_MODEL_CAPABILITY_RECORDS)) {
        const record = isObject(row) && isKey(row.modelKey) ? acceptCapabilityRecord(row.record) : null;
        if (!record) { this.preserve = true; continue; }
        this.records.delete(row.modelKey as string); this.records.set(row.modelKey as string, record);
      }
    });
  }

  get(key: string | null): ModelCapabilityRecord | null {
    if (!isKey(key)) return null;
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  /**
   * Changes one model's record (a new one starts empty), keeps the newest MAX_MODEL_CAPABILITY_RECORDS and writes the file.
   * Returns the record as it now stands; `unchanged` skips the write when the change gives back the same record.
   */
  update(key: string, change: (record: ModelCapabilityRecord) => ModelCapabilityRecord): Promise<{ record: ModelCapabilityRecord; changed: boolean }> {
    if (!isKey(key)) return Promise.reject(new Error('模型体检需要当前模型的内容身份。'));
    return this.serialize(async () => {
      const before = this.records.get(key) ?? emptyCapabilityRecord(this.now());
      const proposed = change(structuredClone(before));
      const accepted = acceptCapabilityRecord({ ...proposed, updatedAt: this.now() });
      if (!accepted) throw new Error('模型体检记录不正确。');
      const same = this.records.has(key) && JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...accepted, updatedAt: 0 });
      if (same) return { record: structuredClone(before), changed: false };
      this.records.delete(key); this.records.set(key, accepted);
      while (this.records.size > MAX_MODEL_CAPABILITY_RECORDS) this.records.delete(this.records.keys().next().value!);
      await this.persist();
      return { record: structuredClone(accepted), changed: true };
    });
  }

  async flush(): Promise<void> { await this.queue; }

  private async persist(): Promise<void> {
    if (this.state !== 'ready') return;
    try {
      await mkdir(this.directory, { recursive: true });
      if (this.preserve) {
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        const target = path.join(this.directory, `model-capabilities.unreadable-${stamp}.json`);
        try { await this.copy(this.file, target, constants.COPYFILE_EXCL); this.preservedAs = target; }
        catch (error) { if (errorCode(error) !== 'ENOENT') { this.state = 'memory-only'; return; } }
        this.preserve = false;
      }
      const stored: StoredCapabilities = { version: 1, models: [...this.records].map(([modelKey, record]) => ({ modelKey, record })) };
      await this.write(this.file, JSON.stringify(stored));
    } catch { /* The record stays in memory; the next change tries the write again. */ }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
}
