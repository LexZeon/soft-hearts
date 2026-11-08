import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_PROFILE_VERSION, validateStoredModelProfile, type ModelProfile } from '../shared/model-profile';

export const MAX_MODEL_PROFILES = 32;
const MAX_FILE_BYTES = 2_500_000;
interface StoredProfiles { version: 1; profiles: { modelKey: string; profile: ModelProfile }[] }
const isKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/**
 * Local cache of generated model profiles, keyed only by model content hash
 * (the same identity as the blush calibration store). It holds bone/morph names
 * and measured numbers, never paths, and is not part of any export. A changed
 * model has a different hash, so it is simply recomputed; profiles from another
 * algorithm version are dropped on load. Losing the file only costs a recompute.
 */
export class ModelProfileStore {
  private readonly file: string;
  private readonly profiles = new Map<string, ModelProfile>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) { this.file = path.join(directory, 'model-profiles.json'); }

  load(): Promise<void> {
    return this.serialize(async () => {
      this.profiles.clear();
      try {
        const info = await stat(this.file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredProfiles>;
        if (raw?.version !== 1 || !Array.isArray(raw.profiles)) return;
        for (const row of raw.profiles.slice(-MAX_MODEL_PROFILES)) {
          try {
            if (!isKey(row?.modelKey) || row.profile?.version !== MODEL_PROFILE_VERSION) continue;
            this.profiles.set(row.modelKey, validateStoredModelProfile(row.profile));
          } catch { /* One bad row is skipped; the renderer recomputes that model. */ }
        }
      } catch { /* Missing or unreadable cache: every model is recomputed. */ }
    });
  }

  get(key: string | null): ModelProfile | null {
    if (!isKey(key)) return null;
    const profile = this.profiles.get(key);
    return profile ? JSON.parse(JSON.stringify(profile)) as ModelProfile : null;
  }

  /** Validates renderer data, keeps the newest MAX_MODEL_PROFILES entries and writes atomically. */
  set(key: string, value: unknown): Promise<boolean> {
    if (!isKey(key)) return Promise.reject(new Error('模型档案需要当前模型的内容身份。'));
    const profile = validateStoredModelProfile(value);
    return this.serialize(async () => {
      if (JSON.stringify(this.profiles.get(key)) === JSON.stringify(profile)) return true;
      const next = new Map(this.profiles); next.delete(key); next.set(key, profile);
      while (next.size > MAX_MODEL_PROFILES) next.delete(next.keys().next().value!);
      const stored: StoredProfiles = { version: 1, profiles: [...next].map(([modelKey, saved]) => ({ modelKey, profile: saved })) };
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(stored), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
      } catch { await rm(temporary, { force: true }).catch(() => {}); return false; }
      this.profiles.clear(); for (const [modelKey, saved] of next) this.profiles.set(modelKey, saved);
      return true;
    });
  }

  async flush(): Promise<void> { await this.queue; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending;
  }
}
