import { uiText, uiTemplate } from './ui-language';
import type { ListenNoteView, ListenTogetherView } from '../../shared/listen-together';

/**
 * I-016 一起听 in the control window (docs/claude/2026-11-03-listen-together.md): how many recent segments of raw text are kept
 * (the text itself is not shown here), a one-click clear for them, and her notes of what you listened to and watched together,
 * each deletable. The host owns everything; this view only reads and asks.
 */
export interface ListenTogetherPanelActions {
  view(): Promise<ListenTogetherView>;
  clearRaw(): Promise<ListenTogetherView>;
  deleteNote(id: string): Promise<ListenTogetherView>;
  onError(message: string): void;
  /** A plain confirm (window.confirm in the app); tests answer it. */
  confirm(message: string): boolean;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
};
const when = (at: number) => { try { return new Date(at).toLocaleString(); } catch { return ''; } };
const minutes = (note: ListenNoteView) => Math.max(1, Math.round((note.endedAt - note.startedAt) / 60_000));

export class ListenTogetherPanel {
  private readonly raw = make('p');
  private readonly clear = make('button', uiText('清空原文'));
  private readonly list = make('div');
  private readonly status = make('output');
  private request = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly actions: ListenTogetherPanelActions) {
    container.classList.add('memory-panel', 'listen-together-panel');
    const heading = make('h2', uiText('和她一起听过、看过的'));
    const hint = make('p', uiText('她记下的笔记，按角色分开，长期保存，可以一条条删。转写原文只留最近的若干段（最近 20 段或最近 3 小时，取多的），只用来整理笔记和回答你的追问，不在这里显示；关掉「和她一起听」也不会清，点下面可以一键清空。不存声音。'));
    hint.className = 'hint';
    this.raw.dataset.role = 'listen-raw';
    this.clear.type = 'button'; this.clear.dataset.role = 'listen-clear-raw';
    this.clear.onclick = () => { void this.clearRaw(); };
    this.list.className = 'memory-messages'; this.list.dataset.role = 'listen-notes';
    this.status.setAttribute('aria-live', 'polite');
    const tools = make('div'); tools.className = 'memory-tools'; tools.append(this.raw, this.clear);
    container.replaceChildren(heading, hint, tools, this.list, this.status);
  }

  async init(): Promise<void> { await this.refresh(); }
  async refresh(): Promise<void> {
    const request = ++this.request;
    try { const view = await this.actions.view(); if (!this.disposed && request === this.request) this.render(view); }
    catch (error) { if (!this.disposed) this.actions.onError(error instanceof Error ? error.message : uiText('一起听的记录没能读取。')); }
  }
  dispose(): void { this.disposed = true; this.request++; this.clear.onclick = null; this.container.replaceChildren(); }

  private async clearRaw(): Promise<void> {
    if (this.disposed || !this.actions.confirm(uiText('清空所有攒着的转写原文？她记下的笔记会留着。'))) return;
    const request = ++this.request;
    try { const view = await this.actions.clearRaw(); if (!this.disposed && request === this.request) { this.render(view); this.status.textContent = uiText('转写原文已清空。'); } }
    catch (error) { if (!this.disposed) this.actions.onError(error instanceof Error ? error.message : uiText('没能清空，请重试。')); }
  }
  private async remove(note: ListenNoteView): Promise<void> {
    if (this.disposed || !this.actions.confirm(uiText('删掉这条笔记？她就不记得这一段了。'))) return;
    const request = ++this.request;
    try { const view = await this.actions.deleteNote(note.id); if (!this.disposed && request === this.request) { this.render(view); this.status.textContent = uiText('已删除。'); } }
    catch (error) { if (!this.disposed) this.actions.onError(error instanceof Error ? error.message : uiText('没能删除，请重试。')); }
  }

  private render(view: ListenTogetherView): void {
    this.raw.textContent = view.raw.segments
      ? uiTemplate`攒着的转写原文：${String(view.raw.segments)} 段，约 ${String(view.raw.characters)} 字`
      : uiText('攒着的转写原文：没有');
    this.clear.disabled = !view.raw.segments;
    const items: HTMLElement[] = view.notes.map(note => {
      const item = make('article'); item.dataset.noteId = note.id;
      const title = make('h3', `${uiText(note.kind === 'music' ? '一首歌' : '一段剧或视频')} · ${when(note.startedAt)} · ${uiTemplate`约 ${String(minutes(note))} 分钟`}`);
      const gist = make('p', note.gist);
      const details = [note.mood, ...note.points].filter(Boolean).join(' · ');
      const remove = make('button', uiText('删除')); remove.type = 'button'; remove.dataset.role = 'listen-delete';
      remove.onclick = () => { void this.remove(note); };
      item.append(title, gist);
      if (details) item.append(make('small', details));
      if (note.talked) item.append(make('small', uiText('你们聊过这一段')));
      item.append(remove);
      return item;
    });
    if (!items.length) items.push(make('p', uiText('还没有一起听过、看过的记录。')));
    this.list.replaceChildren(...items);
    if (view.total > view.notes.length) this.list.append(make('small', uiTemplate`只显示最近 ${String(view.notes.length)} 条，共 ${String(view.total)} 条。`));
  }
}
