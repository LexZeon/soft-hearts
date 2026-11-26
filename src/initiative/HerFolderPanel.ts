// 她的文件夹 (I-050, electron/initiative/her-folder/) in the control window, and the small note under her reply. All text is textContent; the
// host sends plain views (shared/initiative/her-folder.ts). The switch turns on only through the host's native folder dialog: the renderer
// never sends a path. A restore names an action id the host gave; opening only shows the folder (the host checks it is on).
import {
  HER_FOLDER_KEEP_DAYS, isHerFolderActionKind,
  type HerFolderActionKind, type HerFolderActionView, type HerFolderNoteView, type HerFolderView,
} from '../../shared/initiative/her-folder';
import { uiText } from '../foundation/ui-language';

type Tr = (source: string, ...values: readonly unknown[]) => string;

const ACTION_WORD: Readonly<Record<HerFolderActionKind, string>> = {
  created: '新放了', changed: '改了', appended: '接着写了', trashed: '挪进她的回收站', restored: '你恢复了',
};

/** The page's status line. */
export function herFolderStatus(view: HerFolderView | null, busy = false, tr: Tr = uiText): string {
  if (busy) return tr('正在处理…');
  if (!view) return tr('正在读取…');
  if (!view.enabled) return view.folder ? tr('已关闭 · 她不会再往里面放东西，里面的文件都还在') : tr('已关闭 · 打开时选一个文件夹给她（推荐新建一个空的）');
  return tr('已开启 · 她用了 {0} MB，上限 {1} MB', (view.usedBytes / 1048576).toFixed(1), String(Math.round(view.limitBytes / 1048576)));
}

/** One line of "她最近做了什么": time, what, which file, its size. */
export function herFolderActionLine(action: HerFolderActionView, tr: Tr = uiText): string {
  const time = new Date(action.at), two = (n: number) => String(n).padStart(2, '0');
  const when = `${time.getMonth() + 1}/${time.getDate()} ${two(time.getHours())}:${two(time.getMinutes())}`;
  const size = action.bytes >= 1024 ? `${(action.bytes / 1024).toFixed(1)} KB` : `${action.bytes} B`;
  const user = action.userFile && action.kind !== 'restored' ? tr('（你的文件，原来的留了一份）') : '';
  return tr('{0} {1}「{2}」· {3}{4}', when, tr(ACTION_WORD[action.kind]), action.name, size, user);
}

export function herFolderRestoreLabel(action: HerFolderActionView, tr: Tr = uiText): string | null {
  if (action.restore === 'version') return tr('恢复改之前的版本');
  if (action.restore === 'trash') return tr('从她的回收站拿回来');
  return null;
}

export interface HerFolderPanelPorts {
  get(): Promise<HerFolderView>;
  choose(): Promise<HerFolderView>;
  turnOff(): Promise<HerFolderView>;
  restore(actionId: string): Promise<HerFolderView>;
  open(): Promise<boolean>;
  changed(callback: (view: HerFolderView) => void): () => void;
  error(message: string): void;
}

type Doc = Pick<Document, 'createElement'>;

export class HerFolderPanel {
  private readonly toggle: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private readonly folder: HTMLParagraphElement;
  private readonly actions: HTMLElement;
  private readonly openButton: HTMLButtonElement;
  private readonly changeButton: HTMLButtonElement;
  private readonly list: HTMLOListElement;
  private view: HerFolderView | null = null;
  private busy = false;
  private readonly unsubscribe: () => void;

  constructor(root: HTMLElement, private readonly ports: HerFolderPanelPorts, private readonly doc: Doc = document) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
      const value = doc.createElement(tag); if (className) value.className = className; if (text) value.textContent = text; return value;
    };
    const heading = el('h3', '', uiText('她的文件夹'));
    const row = el('label', 'toggle-row');
    const copy = el('span');
    copy.append(el('strong', '', uiText('给她一个只属于她的文件夹')),
      el('small', '', uiText('她可以在里面写信、记东西、准备小礼物，不用每次问你；只写 .md 和 .txt 文字，不运行任何东西，碰不到文件夹外面。你放进去的文件她也能改，改之前先留一份原来的；她删的东西先挪进「.她的回收站」，{0} 天后才真删。默认关闭。', HER_FOLDER_KEEP_DAYS)));
    this.toggle = el('input');
    this.toggle.type = 'checkbox'; this.toggle.id = 'her-folder-enabled'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.run(this.toggle.checked ? () => this.ports.choose() : () => this.ports.turnOff()); };
    row.append(copy, this.toggle);
    this.status = el('p', 'hint'); this.status.setAttribute('role', 'status');
    this.folder = el('p', 'hint her-folder-path');
    this.actions = el('div', 'action-line');
    this.openButton = el('button', 'subtle', uiText('打开她的文件夹'));
    this.openButton.type = 'button'; this.openButton.dataset.herFolder = 'open';
    this.openButton.onclick = () => { void this.ports.open().catch(error => this.ports.error(String(error instanceof Error ? error.message : error))); };
    this.changeButton = el('button', 'subtle', uiText('换一个文件夹'));
    this.changeButton.type = 'button'; this.changeButton.dataset.herFolder = 'change';
    this.changeButton.onclick = () => { void this.run(() => this.ports.choose()); };
    this.actions.append(this.openButton, this.changeButton);
    const recentHeading = el('h4', '', uiText('她最近做了什么'));
    this.list = el('ol', 'her-folder-actions');
    root.replaceChildren(heading, row, this.status, this.folder, this.actions, recentHeading, this.list);
    this.unsubscribe = ports.changed(view => { this.view = view; this.render(); });
    this.render();
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error(String(error)); this.render(); });
  }

  dispose(): void { this.unsubscribe(); }

  private async run(operation: () => Promise<HerFolderView>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await operation(); }
    catch (error) { this.ports.error(String(error instanceof Error ? error.message : error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view;
    this.toggle.checked = !!view?.enabled;
    this.toggle.disabled = !view || this.busy;
    this.status.textContent = herFolderStatus(view, this.busy);
    this.folder.textContent = view?.folder ? uiText('文件夹：{0}', view.folder) : '';
    this.openButton.disabled = !view?.enabled || this.busy;
    this.changeButton.disabled = !view?.enabled || this.busy;
    this.actions.hidden = !view?.enabled;
    const items = (view?.actions ?? []).map(action => {
      const item = this.doc.createElement('li');
      const line = this.doc.createElement('span'); line.textContent = herFolderActionLine(action);
      item.append(line);
      const label = herFolderRestoreLabel(action);
      if (label && view?.enabled) {
        const button = this.doc.createElement('button');
        button.type = 'button'; button.className = 'subtle'; button.dataset.herFolder = 'restore'; button.textContent = label; button.disabled = this.busy;
        button.onclick = () => { void this.run(() => this.ports.restore(action.id)); };
        item.append(button);
      }
      return item;
    });
    if (!items.length) { const empty = this.doc.createElement('li'); empty.className = 'hint'; empty.textContent = uiText('还没有'); items.push(empty); }
    this.list.replaceChildren(...items);
  }
}

// ------------------------------------------------------------------ the note under her reply

/** Strict shape check of host data before any DOM work; anything else is ignored. */
export function readHerFolderNote(value: unknown): HerFolderNoteView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'her-folder-note' || v.version !== 1 || typeof v.noteId !== 'string' || !v.noteId || v.noteId.length > 120
    || !isHerFolderActionKind(v.action) || typeof v.name !== 'string' || !v.name || v.name.length > 120 || (v.state !== 'open' && v.state !== 'gone')) return null;
  return { kind: 'her-folder-note', version: 1, noteId: v.noteId, action: v.action, name: v.name, state: v.state };
}

const NOTE_WORD: Readonly<Record<HerFolderActionKind, string>> = {
  created: '已放进她的文件夹：{0}', changed: '她改了文件夹里的：{0}', appended: '她接着写了：{0}', trashed: '已挪进她的回收站：{0}', restored: '已恢复：{0}',
};
export function herFolderNoteText(view: HerFolderNoteView, tr: Tr = uiText): string { return tr(NOTE_WORD[view.action], view.name); }

export interface HerFolderNotePorts {
  open(request: { noteId: string }): Promise<boolean>;
  container(): HTMLElement | null;
  error?(message: string): void;
  prepend?: boolean;
}

export class HerFolderNotes {
  private shown: { root: HTMLElement; noteId: string } | null = null;
  constructor(private readonly ports: HerFolderNotePorts, private readonly doc: Doc = document) {}

  present(raw: unknown): void {
    const view = readHerFolderNote(raw);
    if (!view) return;
    if (view.state === 'gone') { if (this.shown?.noteId === view.noteId) this.clear(); return; }
    this.clear();
    const container = this.ports.container();
    if (!container) return;
    const root = this.doc.createElement('section');
    root.className = 'take-me-there her-folder-note';
    root.setAttribute('role', 'group');
    const text = this.doc.createElement('span');
    text.className = 'her-folder-note__text';
    text.textContent = herFolderNoteText(view);
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = 'take-me-there__button';
    button.textContent = uiText('打开她的文件夹');
    button.onclick = () => {
      button.disabled = true;
      void this.ports.open({ noteId: view.noteId }).then(ok => { if (!ok) this.clear(); },
        error => this.ports.error?.(String(error instanceof Error ? error.message : error))).finally(() => { button.disabled = false; });
    };
    root.append(text, button);
    this.shown = { root, noteId: view.noteId };
    if (this.ports.prepend) container.prepend(root); else container.append(root);
  }

  clear(): void { this.shown?.root.remove(); this.shown = null; }
}
