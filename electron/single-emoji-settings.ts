import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_EMOJI_SETTINGS, readEmojiSettings, type EmojiSettings } from '../shared/single-emoji';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';

/** Latest-only host sidecar; no changes to legacy settings or portable cards. */
export class EmojiSettingsStore {
  private value = readEmojiSettings(DEFAULT_EMOJI_SETTINGS);
  private pending: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(directory: string, private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {
    this.filePath = path.join(directory, 'single-emoji-settings.json');
  }

  get current(): EmojiSettings { return readEmojiSettings(this.value); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  load(): Promise<EmojiSettings> {
    return this.enqueue(async () => {
      let next: EmojiSettings;
      try {
        next = readEmojiSettings(JSON.parse(await readFile(this.filePath, 'utf8')));
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        next = readEmojiSettings(DEFAULT_EMOJI_SETTINGS);
      }
      this.value = next;
      return this.current;
    });
  }

  save(input: unknown): Promise<EmojiSettings> {
    let snapshot: EmojiSettings;
    try { snapshot = readEmojiSettings(input); }
    catch (error) { return Promise.reject(error); }
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await this.writeAtomic(this.filePath, JSON.stringify(snapshot, null, 2));
      this.value = snapshot;
      return this.current;
    });
  }
}
