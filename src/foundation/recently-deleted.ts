// I-144 回收站: 「最近删除的」 next to the place something was deleted. One small shared list:
// this character's entries of the given kinds, newest first, each with 「找回」. It hides itself when there is nothing to bring back.
// The host does the restoring (everything comes back where it was); this list only names the entry in plain words and asks.
// All text is textContent; entries are the host's names, kinds, counts and times (shared/memory/recycle-bin.ts), never the removed data.
import { uiText, uiTemplate, currentUiLanguage } from './ui-language';
import { RECYCLE_DAYS_DEFAULT, type RecycleBinView, RecycleEntryKind, RecycleSummary } from '../../shared/foundation/recycle-bin';

export interface RecycleRestoreResult { view: RecycleBinView; failed: boolean; replaced: boolean }

/** What the list needs from the host (a slice of window.desktop). */
export interface RecycleApi {
  getRecycleBin(): Promise<RecycleBinView>;
  restoreRecycleEntry(id: string): Promise<RecycleRestoreResult>;
  onRecycleBin(callback: (view: RecycleBinView) => void): () => void;
}

const DAY_MS = 86_400_000;

/** Days it can still be brought back, rounded up, at least 1. */
export function recycleDaysLeft(entry: Pick<RecycleSummary, 'expiresAt'>, now = Date.now()): number {
  return Math.max(1, Math.ceil((entry.expiresAt - now) / DAY_MS));
}

/** What the entry is, in plain words (the host's own label is Chinese only, so the window words it itself; never the removed content). */
export function recycleKindText(entry: Pick<RecycleSummary, 'part' | 'memories'> & Partial<Pick<RecycleSummary, 'count' | 'itemAt'>>): string {
  const count = entry.count && entry.count > 0 ? entry.count : 0;
  let date = '';
  if (entry.itemAt) { try { date = new Date(entry.itemAt).toLocaleDateString(currentUiLanguage(), { month: 'long', day: 'numeric' }); } catch { /* no date */ } }
  const dated = (kind: string) => date ? uiTemplate`${kind}（${date}）` : kind;
  switch (entry.part) {
    case 'chat': return uiText('聊天记忆');
    case 'profile': return uiText('画像和日记');
    case 'character': return entry.memories ? uiText('角色卡和她的全部记忆') : uiText('角色卡和模型关联');
    case 'memory-note': return uiText('一条聊天笔记');
    case 'moving-memory': return uiText('最打动她的那一件');
    case 'listen-note': return uiText('一起听的一条笔记');
    case 'chat-record': return dated(uiText('一段聊天记录'));
    case 'ambient-transcript': return dated(uiText('一段听到的声音文字'));
    case 'profile-entry': return dated(uiText('她记下的关于你的一条'));
    case 'diary-day': return date ? uiTemplate`${date}的日记` : uiText('一天的日记');
    case 'review': return dated(uiText('一段回顾'));
    case 'plan': return dated(uiText('她记得的一件计划'));
    case 'text-memorial': return dated(uiText('一条文字纪念'));
    case 'our-thing': return dated(uiText('我们的小东西里的一件'));
    case 'nickname': return uiText('她叫你的称呼');
    case 'her-nickname': return uiText('你对她的一个称呼');
    case 'card-milestone': return uiText('角色卡里那件事的“到了”');
    case 'object-note': return dated(uiText('她写在页边的一条批注'));
    case 'assistant-chat': return count ? uiTemplate`和 Claude 助手的对话（${count} 条）` : uiText('和 Claude 助手的对话');
    case 'listen-raw': return count ? uiTemplate`一起听攒着的原文（${count} 段）` : uiText('一起听攒着的原文');
    case 'song-memory': return count ? uiTemplate`她记得的歌（${count} 首）` : uiText('她记得的歌');
    case 'diary-all': return count ? uiTemplate`全部日记（${count} 天）` : uiText('全部日记');
    case 'plans-all': return count ? uiTemplate`她记得的全部计划（${count} 件）` : uiText('她记得的全部计划');
  }
  return uiText('一项记录');
}

/** 「名字」的聊天记忆; a character is 「名字」（角色卡和…）. `withName` is off where the list is already about one character. The assistant's conversation has no character. */
export function recycleWhat(entry: Pick<RecycleSummary, 'part' | 'memories' | 'characterName'> & Partial<Pick<RecycleSummary, 'count' | 'itemAt'>>, withName: boolean): string {
  const kind = recycleKindText(entry);
  if (entry.part === 'character') return uiTemplate`「${entry.characterName}」（${kind}）`;
  if (entry.part === 'assistant-chat') return kind;
  return withName ? uiTemplate`「${entry.characterName}」的${kind}` : kind;
}

/** 「会放进回收站，N 天内能在旁边的「最近删除的」找回。」: said where a delete asks first (N is the bin's days). */
export function recycleKeepNote(days: number): string {
  return uiTemplate`会放进回收站，${days} 天内能在旁边的「最近删除的」找回。`;
}

/** The whole line: what it is, when it went, how long it stays. */
export function recycleEntryLine(entry: RecycleSummary, withName: boolean, now = Date.now()): string {
  let when = '';
  try { when = new Date(entry.deletedAt).toLocaleString(currentUiLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { /* no time */ }
  return uiTemplate`${recycleWhat(entry, withName)} · 删除于 ${when} · 还能留 ${recycleDaysLeft(entry, now)} 天`;
}

/** What to say after a 「找回」. */
export function recycleRestoreNote(result: Pick<RecycleRestoreResult, 'failed' | 'replaced'>): string {
  const lines: string[] = [];
  if (result.failed) lines.push(uiText('有一部分没能找回，回收站里还留着，可以再试一次。'));
  if (result.replaced) lines.push(uiText('之后新记下的已经换进回收站，没有丢。'));
  return lines.join(' ');
}

export interface RecentlyDeletedOptions {
  api: RecycleApi;
  /** Which entries this place shows. */
  kinds: readonly RecycleEntryKind[];
  /** The character on stage now; entries of other characters are not listed here (the 角色页 bin lists all). */
  characterId(): string;
  /** After something came back (the place re-reads what it shows). */
  onRestored?(): void;
  onError(message: string): void;
  doc?: Pick<Document, 'createElement'>;
}

export class RecentlyDeleted {
  private view: RecycleBinView | null = null;
  private busy = false;
  private disposed = false;
  private note = '';
  private unsubscribe: (() => void) | null = null;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly options: RecentlyDeletedOptions) {
    const doc = options.doc ?? document;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
      const node = doc.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
    };
    root.className = `${root.className} recently-deleted`.trim();
    root.dataset.recycle = 'recently-deleted';
    this.list = el('ul', 'recently-deleted-list');
    this.status = el('output', 'hint'); this.status.setAttribute('role', 'status');
    root.replaceChildren(el('strong', '', uiText('最近删除的')), this.list, this.status);
    this.render();
  }

  async init(): Promise<void> {
    this.unsubscribe = this.options.api.onRecycleBin(view => { if (!this.disposed) { this.view = view; this.render(); } });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try { const view = await this.options.api.getRecycleBin(); if (!this.disposed) { this.view = view; this.render(); } }
    catch (error) { if (!this.disposed) this.options.onError(error instanceof Error ? error.message : String(error)); }
  }

  /** Days an entry stays in the bin (what the last view said; 7 until it has loaded). */
  days(): number { return this.view?.days ?? RECYCLE_DAYS_DEFAULT; }

  dispose(): void { this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null; this.root.replaceChildren(); }

  /** This place's entries, newest first. */
  entries(): RecycleSummary[] {
    const kinds = new Set<RecycleEntryKind>(this.options.kinds), id = this.options.characterId();
    return (this.view?.entries ?? []).filter(entry => kinds.has(entry.part) && entry.characterId === id).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  private async restore(id: string): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.render();
    try {
      const result = await this.options.api.restoreRecycleEntry(id);
      if (this.disposed) return;
      this.view = result.view;
      this.note = recycleRestoreNote(result);
      if (!result.failed) this.options.onRestored?.();
    } catch (error) { this.note = ''; this.options.onError(error instanceof Error ? error.message : String(error)); }
    finally { this.busy = false; if (!this.disposed) this.render(); }
  }

  private render(): void {
    const doc = this.options.doc ?? document, entries = this.entries();
    this.root.hidden = !entries.length && !this.note;
    this.list.replaceChildren(...entries.map(entry => {
      const item = doc.createElement('li'); item.dataset.recycleEntry = entry.id;
      const text = doc.createElement('span'); text.textContent = recycleEntryLine(entry, false);
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'subtle'; button.dataset.recycle = 'restore';
      button.textContent = uiText('找回'); button.disabled = this.busy;
      button.onclick = () => { void this.restore(entry.id); };
      item.append(text, button);
      return item;
    }));
    this.status.textContent = this.note;
  }
}
