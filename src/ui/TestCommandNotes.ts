// D2 developer test commands: the lines under a "测试：…" message. They are plain notes from the app, not her speech:
// never read aloud, never added to the chat history sent to the model, never archived. textContent only.
import { TEST_NOTE_MAX, type TestCommandNote } from '../../shared/test-command';

export interface TestCommandNotePorts {
  /** Where the rows go: the end of the chat log, or the pet's chat area. */
  container(): HTMLElement | null;
  /** Insert new rows first (the pet's chat area, above the input) instead of last. */
  prepend?: boolean;
  /** Rows are removed this long after their last line (the pet); undefined keeps them (the chat log). */
  lifetimeMs?: number;
}

type Doc = Pick<Document, 'createElement'>;
interface Row { root: HTMLElement; user: HTMLElement | null; timer?: ReturnType<typeof setTimeout> }
const MAX_ROWS = 12;
const MAX_USER = 160;

export class TestCommandNotes {
  private readonly rows = new Map<string, Row>();
  constructor(private readonly ports: TestCommandNotePorts, private readonly doc: Doc = document) {}

  /**
   * The user's own line. The host's first note can arrive before this call (the notes are events, the answer is a
   * reply), so a row may already exist: the user's line then goes on top of it.
   */
  begin(id: string, userText: string): void {
    const row = this.row(id);
    if (!row || row.user) return;
    row.user = this.doc.createElement('div');
    row.user.className = 'test-command-note__user';
    row.user.textContent = [...userText].slice(0, MAX_USER).join('');
    row.root.prepend(row.user);
    this.touch(id, row);
  }

  note(note: TestCommandNote): void {
    if (!note || typeof note.id !== 'string' || typeof note.text !== 'string' || !note.id || note.id.length > 100) return;
    const row = this.row(note.id);
    if (!row) return;
    const line = this.doc.createElement('div');
    line.className = 'test-command-note__line';
    line.setAttribute('role', 'status');
    line.textContent = [...note.text].slice(0, TEST_NOTE_MAX).join('');
    row.root.append(line);
    this.touch(note.id, row);
    const log = this.ports.container();
    if (log && !this.ports.prepend) log.scrollTop = log.scrollHeight;
  }

  /** A new conversation or a character switch: the notes go with the chat they belonged to. */
  clear(): void {
    for (const row of this.rows.values()) { if (row.timer) clearTimeout(row.timer); row.root.remove(); }
    this.rows.clear();
  }

  private row(id: string): Row | null {
    const known = this.rows.get(id);
    if (known) return known;
    const container = this.ports.container();
    if (!container) return null;
    while (this.rows.size >= MAX_ROWS) {
      const oldest = this.rows.keys().next().value!;
      const row = this.rows.get(oldest)!;
      if (row.timer) clearTimeout(row.timer);
      row.root.remove();
      this.rows.delete(oldest);
    }
    const root = this.doc.createElement('section');
    root.className = 'test-command-note';
    root.dataset.testCommand = id;
    const created: Row = { root, user: null };
    this.rows.set(id, created);
    if (this.ports.prepend) container.prepend(root); else container.append(root);
    return created;
  }

  private touch(id: string, row: Row): void {
    if (this.ports.lifetimeMs === undefined) return;
    if (row.timer) clearTimeout(row.timer);
    row.timer = setTimeout(() => { row.root.remove(); this.rows.delete(id); }, this.ports.lifetimeMs);
  }
}
