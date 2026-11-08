import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from './atomic-file';
import { parseUiLanguagePreference, resolveUiLanguage, type UiLanguage, type UiLanguagePreference, type UiLanguageView } from '../shared/ui-language';

/** Separate sidecar so older complete deliveries can keep writing legacy AppSettings safely. */
export class UiLanguageStore {
  private preference: UiLanguagePreference = 'system';
  private language: UiLanguage;
  private notice: UiLanguageView['notice'];
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly systemLocale: string,
    private readonly writeAtomic: AtomicFileWriter = atomicWriteFile) {
    this.language = resolveUiLanguage('system', systemLocale);
  }
  get current(): UiLanguageView {
    return { preference: this.preference, language: this.language, ...(this.notice ? { notice: this.notice } : {}) };
  }
  async load(): Promise<UiLanguageView> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)
        && 'version' in raw && raw.version === 1 && 'preference' in raw)
        this.preference = parseUiLanguagePreference(raw.preference);
      else this.notice = 'preference-unavailable';
    } catch (error) {
      // A missing sidecar is an ordinary first run; a read/parse failure stays visible.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        this.notice = 'preference-unavailable';
    }
    this.language = resolveUiLanguage(this.preference, this.systemLocale);
    return this.current;
  }
  persist(input: unknown): Promise<UiLanguageView> {
    const preference = parseUiLanguagePreference(input);
    const operation = async (): Promise<UiLanguageView> => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await this.writeAtomic(this.file, JSON.stringify({ version: 1, preference }, null, 2));
      this.preference = preference;
      this.notice = undefined;
      return this.current;
    };
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
