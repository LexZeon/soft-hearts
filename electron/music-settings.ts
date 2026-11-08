import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeMusicSettings, type MusicSettings } from '../shared/music-settings';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';

/** Independent of the legacy settings file rewritten by the fixed delivery. */
export class MusicSettingsStore {
  private value = normalizeMusicSettings(undefined);
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string, private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {}
  get current(): MusicSettings { return { ...this.value }; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  load(): Promise<MusicSettings> {
    return this.enqueue(async () => {
      let next = normalizeMusicSettings(undefined);
      try {
        const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'version' in raw && raw.version === 1
          && 'settings' in raw && raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings))
          next = normalizeMusicSettings(raw.settings);
      } catch { /* Missing or malformed sidecars are preserved and use the default. */ }
      this.value = next;
      return this.current;
    });
  }
  persist(input: unknown): Promise<MusicSettings> {
    // Capture only a setting primitive before waiting for another commit.
    const field = (key: string) => input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, key)
      ? (input as Record<string, unknown>)[key] : undefined;
    const strength = field('strength'), alwaysDance = field('alwaysDance');
    const snapshot = { strength: typeof strength === 'number' ? strength : undefined,
      alwaysDance: typeof alwaysDance === 'boolean' ? alwaysDance : undefined };
    return this.enqueue(async () => {
      const next = normalizeMusicSettings(snapshot, this.value);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await this.writeAtomic(this.filePath, JSON.stringify({ version: 1, settings: next }, null, 2));
      this.value = next;
      return this.current;
    });
  }
}
