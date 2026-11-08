// 体验记录 (E2) in the control window's 「隐私与设置」: the switch "保留体验记录（只存本机）" (default off) and, while it is on,
// "刚才发生了什么": the newest 50 moments, one plain line each, filterable by character. Every line is set as textContent; the host
// sends only whitelisted journal entries (shared/journal.ts), and no part of them becomes markup.
import { describeJournalEntry, type JournalView } from '../../shared/journal';
import { uiText } from './ui-language';

export interface JournalPanelPorts {
  get(): Promise<JournalView>;
  setEnabled(enabled: boolean): Promise<JournalView>;
  changed(callback: (view: JournalView) => void): () => void;
  error(message: string): void;
}

/** '' = every character. */
export type JournalFilter = string;

/** The lines the panel shows, newest first. Pure, for tests. */
export function journalPanelLines(view: JournalView | null, filter: JournalFilter, tr: (source: string, ...values: readonly unknown[]) => string = uiText): string[] {
  if (!view?.enabled) return [];
  return view.entries.filter(entry => !filter || entry.characterId === filter).map(entry => describeJournalEntry(entry, tr)).reverse();
}

/** The filter's choices: every character that has a line, with its card name when the card still exists. */
export function journalFilterChoices(view: JournalView | null): Array<{ value: string; label: string }> {
  if (!view?.enabled) return [];
  const names = new Map(view.characters.map(card => [card.id, card.name]));
  const ids = [...new Set(view.entries.map(entry => entry.characterId).filter((id): id is string => !!id))];
  return ids.map(id => ({ value: id, label: names.get(id) ?? uiText('已删除的角色') }));
}

export function journalStatusText(view: JournalView | null): string {
  if (!view) return uiText('正在读取体验记录…');
  if (!view.enabled) return uiText('已关闭 · 不记录。打开后从现在起按天记在本机配置目录的 journal 文件夹里。');
  if (view.failure) return uiText('已开启 · 最近一次没能写进文件，下面是内存里的记录；陪伴不受影响。');
  if (view.truncatedToday) return uiText('已开启 · 今天的记录到上限了，明天接着记；之前的都在。');
  return view.entries.length ? uiText('已开启 · 最近 {0} 条', view.entries.length) : uiText('已开启 · 还没有记录');
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};

export class JournalPanel {
  private readonly toggle = element('input');
  private readonly status = element('p', 'hint journal-status');
  private readonly recent = element('div', 'journal-recent');
  private readonly filter = element('select');
  private readonly list = element('ol', 'journal-lines');
  private view: JournalView | null = null;
  private busy = false;
  private selected: JournalFilter = '';
  private readonly unsubscribe: () => void;

  constructor(root: HTMLElement, private readonly ports: JournalPanelPorts) {
    const heading = element('h3', '', uiText('体验记录'));
    const row = element('label', 'toggle-row');
    const copy = element('span');
    copy.append(element('strong', '', uiText('保留体验记录（只存本机）')),
      element('small', '', uiText('开启后，她的心情变化、原因和她自己做的事按天记在本机，方便以后回看和整理成周报。默认关闭；关掉后不再写，已有的记录不会删除。')));
    this.toggle.type = 'checkbox';
    this.toggle.setAttribute('role', 'switch');
    this.toggle.dataset.journal = 'enabled';
    this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.set(this.toggle.checked); };
    row.append(copy, this.toggle);
    this.status.setAttribute('role', 'status');
    this.status.dataset.journal = 'status';
    const filterLabel = element('label', 'field journal-filter');
    filterLabel.append(element('span', '', uiText('角色')), this.filter);
    this.filter.dataset.journal = 'filter';
    this.filter.onchange = () => { this.selected = this.filter.value; this.render(); };
    this.list.dataset.journal = 'lines';
    this.list.setAttribute('aria-label', uiText('刚才发生了什么'));
    this.recent.append(element('h4', '', uiText('刚才发生了什么')), filterLabel, this.list);
    const never = element('p', 'hint', uiText('只记时间、角色、类型、数值和固定的白话原因。从不记：你说的话、她的回复、日记、用户画像、称呼、文件路径和密钥。'));
    root.replaceChildren(heading, row, this.status, this.recent, never);
    this.render();
    this.unsubscribe = ports.changed(view => { this.view = view; this.render(); });
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error(String(error)); this.render(); });
  }

  dispose(): void { this.unsubscribe(); }

  private async set(enabled: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { this.view = await this.ports.setEnabled(enabled); }
    catch (error) { this.ports.error(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view;
    this.toggle.checked = !!view?.enabled;
    this.toggle.disabled = !view || this.busy;
    this.status.textContent = this.busy ? uiText('正在切换…') : journalStatusText(view);
    this.recent.hidden = !view?.enabled;
    const choices = journalFilterChoices(view);
    if (this.selected && !choices.some(choice => choice.value === this.selected)) this.selected = '';
    const options = [{ value: '', label: uiText('全部角色') }, ...choices].map(choice => {
      const option = element('option', '', choice.label);
      option.value = choice.value;
      return option;
    });
    this.filter.replaceChildren(...options);
    this.filter.value = this.selected;
    const lines = journalPanelLines(view, this.selected);
    this.list.replaceChildren(...(lines.length ? lines.map(line => element('li', '', line)) : [element('li', 'hint', uiText('还没有记录'))]));
  }
}
