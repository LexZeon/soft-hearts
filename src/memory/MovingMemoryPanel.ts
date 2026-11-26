// 最打动她的一件事 (I-139 A3, electron/memory/moving-memory/) in the control window: what she opens each new conversation with, the older ones she
// held, and two buttons: delete the current one, bring an older one back. All text is textContent; the host sends plain views
// (shared/memory/moving-memory.ts) and the window names a version only by its `chosenAt` (security review 2026-11-15: not a list position, which a
// handoff landing meanwhile could move). The panel stays hidden while the host says it is not active.
import type { MovingMemoryView, MovingMemoryVersionView } from '../../shared/memory/moving-memory';
import { uiText } from '../foundation/ui-language';
import { RecentlyDeleted, type RecycleApi } from '../foundation/recently-deleted';

type Tr = (source: string, ...values: readonly unknown[]) => string;

export interface MovingMemoryPanelPorts {
  get(): Promise<MovingMemoryView>;
  remove(chosenAt: number): Promise<MovingMemoryView>;
  restore(chosenAt: number): Promise<MovingMemoryView>;
  /** I-144 回收站: 「最近删除的」 next to 「删掉这一件」 (the host puts a deleted one in the bin). Without both, no such list. */
  recycle?: RecycleApi;
  currentCharacterId?(): string;
  error(message: string): void;
}

/** One line: the date, then her words as they are in the record. */
export function movingMemoryLine(version: MovingMemoryVersionView, tr: Tr = uiText): string { return tr('{0}，{1}', version.date, version.text); }

/** The status under the title. */
export function movingMemoryStatus(view: MovingMemoryView | null, busy = false, tr: Tr = uiText): string {
  if (busy) return tr('正在处理…');
  if (!view) return tr('正在读取…');
  if (!view.versions.length) return tr('她还没有记着哪一件。换新一段 Claude 接手时，她会从你们的聊天里挑一件。');
  return view.versions[0]!.current ? tr('她现在记着这一件，每次新的一段开始都会先想起它。') : tr('你删掉了她记着的那件事，她现在没有记着哪一件。');
}

type Doc = Pick<Document, 'createElement'>;

export class MovingMemoryPanel {
  private view: MovingMemoryView | null = null;
  private busy = false;
  private readonly status: HTMLElement;
  private readonly currentLine: HTMLElement;
  private readonly why: HTMLElement;
  private readonly removeButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly olderHeading: HTMLElement;
  private recentlyDeleted: RecentlyDeleted | null = null;

  constructor(private readonly root: HTMLElement, private readonly ports: MovingMemoryPanelPorts, private readonly doc: Doc = document) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
      const value = doc.createElement(tag); if (className) value.className = className; if (text) value.textContent = text; return value;
    };
    const heading = el('h3', '', uiText('最打动她的一件事'));
    const note = el('p', 'hint', uiText('一件你们之间的真事，带日期，原话来自你们的聊天记录。每一段新的 Claude 接手时会先读到它；交班时她自己决定换不换，只有出现更打动她的事才换。你可以删掉当前这一件，也可以把以前的找回来。'));
    this.status = el('p', 'hint'); this.status.setAttribute('role', 'status');
    this.currentLine = el('p', 'moving-memory-current');
    this.why = el('p', 'hint');
    this.removeButton = el('button', 'subtle', uiText('删掉这一件'));
    this.removeButton.type = 'button'; this.removeButton.dataset.movingMemory = 'delete';
    this.removeButton.onclick = () => { const shown = this.view?.versions.find(v => v.current); if (shown) void this.run(() => this.ports.remove(shown.chosenAt)); };
    this.olderHeading = el('h4', '', uiText('以前记着的'));
    this.list = el('ol', 'moving-memory-versions');
    const recycleBox = el('div');
    root.replaceChildren(heading, note, this.status, this.currentLine, this.why, this.removeButton, recycleBox, this.olderHeading, this.list);
    if (ports.recycle && ports.currentCharacterId) {
      this.recentlyDeleted = new RecentlyDeleted(recycleBox, { api: ports.recycle, kinds: ['moving-memory'], characterId: ports.currentCharacterId, doc,
        onRestored: () => this.refresh(), onError: message => ports.error(message) });
      void this.recentlyDeleted.init();
    } else recycleBox.hidden = true;
    this.render();
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error(String(error)); this.render(); });
  }

  /** Read again (the control window shows this page: a handoff may have changed it meanwhile). */
  refresh(): void { void this.run(() => this.ports.get()); }

  private async run(operation: () => Promise<MovingMemoryView>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await operation(); }
    catch (error) { this.ports.error(String(error instanceof Error ? error.message : error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view;
    this.root.hidden = !view?.active;
    this.status.textContent = movingMemoryStatus(view, this.busy);
    const current = view?.versions.find(v => v.current) ?? null;
    this.currentLine.textContent = current ? movingMemoryLine(current) : '';
    this.currentLine.hidden = !current;
    this.why.textContent = current?.why ? uiText('她说：{0}', current.why) : '';
    this.why.hidden = !current?.why;
    this.removeButton.hidden = !current;
    this.removeButton.disabled = this.busy;
    const older = (view?.versions ?? []).filter(version => !version.current);
    this.olderHeading.hidden = !older.length;
    this.list.replaceChildren(...older.map(version => {
      const item = this.doc.createElement('li');
      const line = this.doc.createElement('span'); line.textContent = movingMemoryLine(version);
      const button = this.doc.createElement('button');
      button.type = 'button'; button.className = 'subtle'; button.dataset.movingMemory = 'restore'; button.textContent = uiText('找回这一件'); button.disabled = this.busy;
      button.onclick = () => { void this.run(() => this.ports.restore(version.chosenAt)); };
      item.append(line, button);
      return item;
    }));
  }
}
