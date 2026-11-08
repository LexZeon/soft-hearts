// I-014 "三方互通":
// the one switch that keeps the user's own Claude, the pet's chat and the settings in step. On by default for every
// edition and profile, including old profiles that never had the file; a user who turned it off keeps it off.
// The file holds no secret: `<profile>/interconnect.json` = { version, chosen, enabled, autoRegistered, repointing? }.
// No Electron import: tests drive it with a temporary folder.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const INTERCONNECT_FILE = 'interconnect.json';
/** The default for a profile whose user never chose (I-014: on). */
export const INTERCONNECT_DEFAULT = true;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

export interface InterconnectState {
  enabled: boolean;
  /** The user (or their Claude) chose `enabled`; false while the default applies. */
  explicit: boolean;
  /**
   * MCP server names this profile has registered in the user's Claude Code by itself. Registered once: if the user
   * removes it from Claude Code later, the app never adds it back on its own (the panel offers 重新接上).
   */
  autoRegistered: string[];
  /**
   * Names whose re-point to this version (agent-channel/claude-code-link.ts) was started and is not over: written before the
   * first change, so a start after a cut-off one finishes or tidies it instead of reading "the user removed it". Absent
   * when empty.
   */
  repointing?: string[];
  /** The file exists but could not be read: kept off (fewer dialogs is never the fallback) until the user chooses. */
  unreadable?: boolean;
}

const fresh = (): InterconnectState => ({ enabled: INTERCONNECT_DEFAULT, explicit: false, autoRegistered: [] });

export class InterconnectStore {
  private state: InterconnectState = fresh();
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(directory: string) { this.file = path.join(directory, INTERCONNECT_FILE); }

  get current(): InterconnectState { return structuredClone(this.state); }
  get enabled(): boolean { return this.state.enabled; }

  /** Missing file or a never-chosen state: the default (on). Unreadable file: off until the user chooses again. */
  load(): Promise<InterconnectState> {
    return this.serial(async () => {
      let text: string;
      try { text = await readFile(this.file, 'utf8'); }
      catch (error) {
        this.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? fresh() : { enabled: false, explicit: false, autoRegistered: [], unreadable: true };
        return this.current;
      }
      try {
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || typeof raw.chosen !== 'boolean' || typeof raw.enabled !== 'boolean') throw Error('shape');
        const names = (value: unknown) => Array.isArray(value) ? [...new Set<string>(value.filter((name: unknown): name is string => typeof name === 'string' && NAME.test(name)))].slice(-8) : [];
        const repointing = names(raw.repointing);
        this.state = { enabled: raw.chosen ? raw.enabled : INTERCONNECT_DEFAULT, explicit: raw.chosen, autoRegistered: names(raw.autoRegistered),
          ...(repointing.length ? { repointing } : {}) };
      } catch {
        this.state = { enabled: false, explicit: false, autoRegistered: [], unreadable: true };
      }
      return this.current;
    });
  }

  /** The user's choice; remembered from now on (an explicit off stays off after updates). */
  setEnabled(enabled: unknown): Promise<InterconnectState> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('三方互通开关不正确。'));
    return this.serial(async () => {
      const next: InterconnectState = { enabled, explicit: true, autoRegistered: this.state.autoRegistered,
        ...(this.state.repointing ? { repointing: this.state.repointing } : {}) };
      await this.write(next);
      this.state = next;
      return this.current;
    });
  }

  /** Remembers that this profile registered `name` in Claude Code by itself. Never throws to the caller. */
  noteAutoRegistered(name: string): Promise<void> {
    if (!NAME.test(name)) return Promise.resolve();
    return this.serial(async () => {
      if (this.state.autoRegistered.includes(name)) return;
      // A default nobody chose stays unchosen; an unreadable file is not overwritten behind the user's back.
      if (this.state.unreadable) return;
      const next: InterconnectState = { ...this.state, autoRegistered: [...this.state.autoRegistered, name].slice(-8) };
      try { await this.write(next); } catch { return; }
      this.state = next;
    });
  }

  /**
   * The re-point mark for `name` (true before its first change, false once nothing is left over). Resolves whether the file
   * now says so; never throws. An unreadable file is not overwritten, so nothing is marked and no re-point starts.
   */
  markRepointing(name: string, pending: boolean): Promise<boolean> {
    if (!NAME.test(name)) return Promise.resolve(false);
    return this.serial(async () => {
      if (this.state.unreadable) return false;
      const now = this.state.repointing ?? [];
      if (now.includes(name) === pending) return true;
      const list = pending ? [...now, name].slice(-8) : now.filter(entry => entry !== name);
      const { repointing: _, ...rest } = this.state;
      const next: InterconnectState = { ...rest, ...(list.length ? { repointing: list } : {}) };
      try { await this.write(next); } catch { return false; }
      this.state = next;
      return true;
    });
  }

  private async write(state: InterconnectState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const data = { version: 1, chosen: state.explicit, enabled: state.enabled, autoRegistered: state.autoRegistered,
      ...(state.repointing?.length ? { repointing: state.repointing } : {}) };
    await writeFile(temporary, JSON.stringify(data) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { await rename(temporary, this.file); }
    catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
