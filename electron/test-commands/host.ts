import { randomUUID } from 'node:crypto';
import { t } from '../../shared/ui-language';
import { parseTestCommand, TEST_NOTE_MAX, type TestCommandNote, type TestCommandOutcome } from '../../shared/test-command';
import { appendBounded } from '../reply-latency';
import { buildTestEntries, type TestCommandDeps, type TestEntries, type TestEntry } from './entries';
import { entryById, matchTestEntry, testHelpLines } from './match';
import { pickTestEntry } from './model-pick';

/** One developer diagnostic line: when, which entry, and how it was found. Never the user's words. */
export interface TestCommandDiagnostic { at: number; entry: string; via: 'local' | 'claude' | 'help' | 'none' | 'error' }

export interface TestCommandHostOptions {
  /** Read at every command; false makes "测试：…" an ordinary chat message (the window sends it on). */
  developerMode(): boolean;
  /** The entries and the features' existing interfaces they call. */
  deps: TestCommandDeps;
  /** Delivers a note line to the window that asked. A closed window just misses it. */
  note(owner: number, note: TestCommandNote): void;
  /** `<profile>/dev/test-commands.jsonl`; null writes nothing. */
  diagnosticsFile(): string | null;
  /** The model's pick when no alias matched (default: electron/test-commands/model-pick.ts). */
  pick?: (entries: readonly TestEntry[], body: string, signal: AbortSignal) => Promise<string | null>;
  append?: (file: string, line: string) => Promise<void>;
  clock?: () => number;
  createId?: () => string;
  /** How long the model gets (default 25 s). */
  pickTimeoutMs?: number;
}

const PICK_TIMEOUT_MS = 25_000;

/**
 * D2 / I-008, host side. A "测试：xxx" message of a developer-mode window is answered here instead of going to chat:
 * local alias match first (no model, no quota, nothing archived), and only when that finds nothing one small model call
 * with the entry list. The answer is a note line under the user's message. Nothing here touches the chat memory,
 * the mood or the reply pipeline.
 */
export class TestCommandHost {
  private readonly built: TestEntries;
  private picking: AbortController | null = null;
  private disposed = false;

  constructor(private readonly options: TestCommandHostOptions) {
    this.built = buildTestEntries(options.deps);
  }

  get entries(): readonly TestEntry[] { return this.built.entries; }

  /**
   * The window's ask (its literal text). Answers at once whether this is a test command; the notes follow by `options.note`.
   * Not handled: developer mode is off, or the text is not "测试：…" (the window then sends it as ordinary chat, unchanged).
   */
  accept(owner: number, text: unknown): TestCommandOutcome {
    const parsed = parseTestCommand(text);
    let enabled = false;
    try { enabled = this.options.developerMode() === true; } catch { enabled = false; }
    if (!parsed || !enabled || this.disposed) return { handled: false, id: '' };
    const id = (this.options.createId ?? randomUUID)();
    this.picking?.abort();
    this.picking = null;
    void this.process(owner, id, parsed.body).catch(() => { this.send(owner, id, t('（测试：这个入口出错了，没有执行。）')); });
    return { handled: true, id };
  }

  dispose(): void {
    this.disposed = true;
    this.picking?.abort();
    this.picking = null;
    this.built.dispose();
  }

  private async process(owner: number, id: string, body: string): Promise<void> {
    const entries = this.built.entries;
    const match = matchTestEntry(entries, body);
    if (match.kind === 'help') {
      this.record('help', 'help');
      this.send(owner, id, [t('（测试：下面是所有的测试入口。打“测试：”加名字，或者大概的意思就行。）'), ...testHelpLines(entries, t)].join('\n'));
      return;
    }
    if (match.kind === 'entry') {
      this.record(match.entry.id, 'local');
      await this.run(owner, id, match.entry);
      return;
    }
    // No single local match: one small model call with the list, for this message only.
    this.send(owner, id, t('（测试：本地没对上，正在请 Claude 帮忙找入口…）'));
    const controller = new AbortController();
    this.picking = controller;
    const timer = setTimeout(() => controller.abort(), this.options.pickTimeoutMs ?? PICK_TIMEOUT_MS);
    timer.unref?.();
    let picked: string | null;
    try {
      picked = await (this.options.pick ?? ((list, text, signal) => pickTestEntry(list, text, signal)))(entries, body, controller.signal);
    } catch {
      clearTimeout(timer);
      if (this.picking !== controller) return;
      this.picking = null;
      this.record('none', 'error');
      this.send(owner, id, t('（测试：Claude 现在没能帮忙找入口。可以打“测试：帮助”，照清单里的名字再试。）'));
      return;
    }
    clearTimeout(timer);
    // A newer command (or closing) made this answer late: it is dropped.
    if (this.picking !== controller || controller.signal.aborted) return;
    this.picking = null;
    const entry = entryById(entries, picked);
    if (!entry) {
      this.record('none', 'none');
      this.send(owner, id, t('（测试：没找到对应的入口。打“测试：帮助”看清单。）'));
      return;
    }
    this.record(entry.id, 'claude');
    this.send(owner, id, t('（测试：Claude 帮忙选了“{0}”。）', { 0: t(entry.name) }));
    await this.run(owner, id, entry);
  }

  private async run(owner: number, id: string, entry: TestEntry): Promise<void> {
    let text: string;
    try { text = await entry.run({ note: later => this.send(owner, id, later) }); }
    catch { text = t('（测试：这个入口出错了，没有执行。）'); }
    this.send(owner, id, text);
  }

  private send(owner: number, id: string, text: string): void {
    if (this.disposed) return;
    try { this.options.note(owner, { id, text: [...text].slice(0, TEST_NOTE_MAX).join('') }); } catch { /* A closed window just misses the line. */ }
  }

  private record(entry: string, via: TestCommandDiagnostic['via']): void {
    let file: string | null = null;
    try { file = this.options.diagnosticsFile(); } catch { file = null; }
    if (!file) return;
    const line: TestCommandDiagnostic = { at: (this.options.clock ?? Date.now)(), entry, via };
    void (this.options.append ?? appendBounded)(file, JSON.stringify(line) + '\n').catch(() => {});
  }
}
