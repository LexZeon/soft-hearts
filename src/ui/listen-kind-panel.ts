/**
 * I-016 (docs/claude/2026-11-03-listen-kind.md): the developer panel's line for the host's music / show / talk / quiet judgement.
 * The pet window asks once a second, only while the developer line is showing (developer mode with the music settings), and hands
 * the answer to the stage, which appends it to the M1 line. One request at a time; a failure clears the line.
 */
export interface ListenKindPanelOptions {
  /** The developer line is showing (MmdStage.getMusicChoiceLine() is not ''). */
  active(): boolean;
  read(): Promise<unknown>;
  show(line: string): void;
}

export class ListenKindPanelFeed {
  private busy = false;
  private shown = '';
  constructor(private readonly options: ListenKindPanelOptions) {}

  tick(): void {
    let active = false;
    try { active = this.options.active(); } catch { active = false; }
    if (!active) { this.set(''); return; }
    if (this.busy) return;
    this.busy = true;
    let pending: Promise<unknown>;
    try { pending = Promise.resolve(this.options.read()); } catch { this.busy = false; this.set(''); return; }
    void pending.then(value => this.set(typeof value === 'string' ? value.slice(0, 200) : ''), () => this.set(''))
      .finally(() => { this.busy = false; });
  }

  private set(line: string): void {
    if (line === this.shown) return;
    this.shown = line;
    try { this.options.show(line); } catch { /* the panel never changes what she does */ }
  }
}
