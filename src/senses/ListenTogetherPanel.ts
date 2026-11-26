import { uiText, uiTemplate } from '../foundation/ui-language';
import { RecentlyDeleted, recycleKeepNote, type RecycleApi } from '../foundation/recently-deleted';
import type { ListenNoteView, ListenTogetherView } from '../../shared/senses/listen-together';

/**
 * I-016 一起听 in the control window (docs/claude/2026-11-03-listen-together.md): how many recent segments of raw text are kept
 * (the text itself is not shown here), a one-click clear for them, and her notes of what you listened to and watched together,
 * each deletable. The host owns everything; this view only reads and asks.
 */
export interface ListenTogetherPanelActions {
  view(): Promise<ListenTogetherView>;
  clearRaw(): Promise<ListenTogetherView>;
  deleteNote(id: string): Promise<ListenTogetherView>;
  /** I-077 step 2: the songs she recognises (numbers only, on this computer): how many, and forget them all. Absent: no such row. */
  songs?: { count(): Promise<number>; clear(): Promise<number> };
  /** I-144 回收站: 「最近删除的」 under the notes (a deleted note goes into the bin). Without both, no such list. */
  recycle?: RecycleApi;
  currentCharacterId?(): string;
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
  private readonly songLine = make('p');
  private readonly songClear = make('button', uiText('清除她记得的歌'));
  private readonly status = make('output');
  private request = 0;
  private disposed = false;
  private recentlyDeleted: RecentlyDeleted | null = null;

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
    // I-077 step 2: the songs she knows by their numbers (tempo, tone, section lengths); no audio, no titles, never exported or sent anywhere.
    this.songLine.dataset.role = 'song-memory';
    this.songClear.type = 'button'; this.songClear.dataset.role = 'song-memory-clear';
    this.songClear.onclick = () => { void this.clearSongs(); };
    const songTools = make('div'); songTools.className = 'memory-tools'; songTools.hidden = !actions.songs; songTools.append(this.songLine, this.songClear);
    const songHint = make('p', uiText('她认得你常放的歌：每首歌只记前奏的几个数（速度、音色、乐段长度），不存声音和歌名，只在这台电脑上，不随角色卡导出，不发给任何人。')); songHint.className = 'hint'; songHint.hidden = !actions.songs;
    const recycleBox = make('div');
    container.replaceChildren(heading, hint, tools, songHint, songTools, this.list, recycleBox, this.status);
    if (actions.recycle && actions.currentCharacterId) {
      this.recentlyDeleted = new RecentlyDeleted(recycleBox, { api: actions.recycle, kinds: ['listen-note', 'listen-raw', 'song-memory'], characterId: actions.currentCharacterId,
        onRestored: () => { void this.refresh(); }, onError: message => actions.onError(message) });
    } else recycleBox.hidden = true;
  }

  async init(): Promise<void> { await this.refresh(); await this.recentlyDeleted?.init(); }
  async refresh(): Promise<void> {
    const request = ++this.request;
    void this.refreshSongs();
    try { const view = await this.actions.view(); if (!this.disposed && request === this.request) this.render(view); }
    catch (error) { if (!this.disposed) this.actions.onError(error instanceof Error ? error.message : uiText('一起听的记录没能读取。')); }
  }
  /** A confirm question; where deleting goes into the bin it also says so (I-144b). */
  private keepAsk(question: string): string { return this.recentlyDeleted ? `${question} ${recycleKeepNote(this.recentlyDeleted.days())}` : question; }
  private async refreshSongs(): Promise<void> {
    if (!this.actions.songs) return;
    try { const count = await this.actions.songs.count(); if (!this.disposed) this.showSongs(count); } catch { /* the row just keeps what it showed */ }
  }
  private showSongs(count: number): void {
    this.songLine.textContent = count ? uiTemplate`她记得的歌：${String(count)} 首` : uiText('她记得的歌：没有');
    this.songClear.disabled = !count;
  }
  private async clearSongs(): Promise<void> {
    if (this.disposed || !this.actions.songs || !this.actions.confirm(this.keepAsk(uiText('清除她记得的所有歌？清除后她要重新听过几遍才会再认得。（这些只是几个数，不是声音。）')))) return;
    try { await this.actions.songs.clear(); if (!this.disposed) { this.showSongs(0); this.status.textContent = uiText('她记得的歌已清除。'); } }
    catch (error) { if (!this.disposed) this.actions.onError(error instanceof Error ? error.message : uiText('没能清除，请重试。')); }
  }
  dispose(): void { this.disposed = true; this.request++; this.recentlyDeleted?.dispose(); this.clear.onclick = null; this.songClear.onclick = null; this.container.replaceChildren(); }

  private async clearRaw(): Promise<void> {
    if (this.disposed || !this.actions.confirm(this.keepAsk(uiText('清空所有攒着的转写原文？她记下的笔记会留着。')))) return;
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
