/**
 * R01 物理调参台: the per-model physics tuning the user saved in the lab ("保存为这个模型的设置"), one sidecar beside the settings
 * (physics-tuning.json). Keyed only by the model's content hash (the same identity as the model profile cache); it holds multipliers
 * and knobs, never paths, names or model bytes. Not part of any character card or its export (data map: cardExport 'never').
 * "恢复原样" removes the model's entry; with no entry the companion's physics is exactly as without the lab. Every value is validated and
 * clamped on the way in and on load (shared/stage/physics-tuning.ts). Missing or unreadable file: no tuning, and nothing is created.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelPhysicsTuning, type ModelPhysicsTuning } from '../../shared/stage/physics-tuning';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';

export const PHYSICS_TUNING_FILE = 'physics-tuning.json';
export const MAX_TUNED_MODELS = 32;
const MAX_FILE_BYTES = 2_000_000;
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

interface Stored { version: 1; models: { modelKey: string; tuning: ModelPhysicsTuning }[] }

export class PhysicsTuningStore {
  private readonly file: string;
  private readonly models = new Map<string, ModelPhysicsTuning>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {
    this.file = path.join(directory, PHYSICS_TUNING_FILE);
  }

  load(): Promise<void> {
    return this.serialize(async () => {
      this.models.clear();
      try {
        const info = await stat(this.file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Stored>;
        if (raw?.version !== 1 || !Array.isArray(raw.models)) return;
        for (const row of raw.models.slice(-MAX_TUNED_MODELS)) {
          const tuning = normalizeModelPhysicsTuning(row?.tuning);
          if (isKey(row?.modelKey) && tuning) this.models.set(row.modelKey, tuning);
        }
      } catch { /* Missing or unreadable: no model has a tuning. */ }
    });
  }

  get(key: string | null | undefined): ModelPhysicsTuning | null {
    if (!isKey(key)) return null;
    const tuning = this.models.get(key);
    return tuning ? structuredClone(tuning) : null;
  }

  /** Validates (clamps) and saves one model's tuning; returns what was stored. */
  set(key: string, input: unknown): Promise<ModelPhysicsTuning> {
    if (!isKey(key)) return Promise.reject(new Error('物理调参需要当前模型的内容身份。'));
    const tuning = normalizeModelPhysicsTuning(input);
    if (!tuning) return Promise.reject(new Error('物理调参的数据不对。'));
    return this.serialize(async () => {
      const next = new Map(this.models); next.delete(key); next.set(key, tuning);
      while (next.size > MAX_TUNED_MODELS) next.delete(next.keys().next().value!);
      await this.write(next);
      return structuredClone(tuning);
    });
  }

  /** "恢复原样": the model goes back to running exactly as without the lab. True when there was something to remove. */
  remove(key: string): Promise<boolean> {
    if (!isKey(key)) return Promise.resolve(false);
    return this.serialize(async () => {
      if (!this.models.has(key)) return false;
      const next = new Map(this.models); next.delete(key);
      await this.write(next);
      return true;
    });
  }

  async flush(): Promise<void> { await this.queue; }

  private async write(next: Map<string, ModelPhysicsTuning>): Promise<void> {
    const stored: Stored = { version: 1, models: [...next].map(([modelKey, tuning]) => ({ modelKey, tuning })) };
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.writeAtomic(this.file, JSON.stringify(stored, null, 1));
    this.models.clear();
    for (const [key, tuning] of next) this.models.set(key, tuning);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
}
