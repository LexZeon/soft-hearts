/**
 * I-088 你生活里的人和事 (control window, 记忆页, next to 我们的小东西): the people and things her notes name, one row each with every name
 * she knows them by, how many chats, and the last time. Rename, merge, split a name off, delete; and a 待确认 list of merges she is
 * unsure of ("小明" and "明哥"), each with 是同一个 / 不是. All text is textContent; the host sends names, counts and times only.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { PeopleThingsOp, PeopleThingsPending, PeopleThingsRow, PeopleThingsView } from '../../shared/memory/people-things/view';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: {
    '你生活里的人和事': 'The people and things in your life', '叫法归并、改名、待确认': 'Names, renaming, to confirm',
    '她从聊天笔记里记下的人和事，同一个人的不同叫法放在一起。你说其中任何一种叫法，她都会想起和这个人有关的那几次聊天。只存在这台电脑上，只存叫法，不存聊天原文，也不会跟着角色卡导出。':
      'The people and things she wrote down from her chat notes, with the different names of one person kept together. Say any one of the names and she remembers the chats about them. Stored only on this computer, only the names (no chat text), and never exported with a character card.',
    '正在读取…': 'Reading…', '还没有记下人和事。她写了聊天笔记以后，这里会慢慢出现。': 'Nothing yet. They appear here as she writes her chat notes.',
    '共 {0} 个': '{0} in all', '共 {0} 个，只显示最近的 {1} 个': '{0} in all, showing the latest {1}',
    '待确认': 'To confirm', '她拿不准这两个是不是同一个，你说了算：': 'She is not sure these are the same one; you decide:',
    '是同一个': 'Same one', '不是': 'Not the same', '「{0}」和「{1}」是同一个吗？': 'Are “{0}” and “{1}” the same one?',
    '人': 'person', '事': 'thing', '叫法：': 'Also called: ', '{0} 次聊天 · 最近 {1}': 'in {0} chats · last {1}',
    '改名': 'Rename', '合并…': 'Merge…', '删掉': 'Delete', '确定删掉？': 'Really delete?', '确定': 'OK', '取消': 'Cancel',
    '拆出': 'Split off', '合并到这个': 'Merge into this one', '选一个要和「{0}」合并的：': 'Pick the one to merge with “{0}”:',
    '新名字（最多 24 个字）': 'New name (up to 24 characters)',
  },
  'zh-CN': {},
});

type Tr = (source: string, ...values: readonly unknown[]) => string;

const two = (n: number) => String(n).padStart(2, '0');
export const peopleThingsDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

/** One row's words. Pure, for tests. */
export function peopleThingsRowWords(row: PeopleThingsRow, tr: Tr = uiText): { title: string; kind: string; aliases: string[]; meta: string } {
  return { title: row.name, kind: tr(row.kind === 'person' ? '人' : '事'), aliases: row.names.map(name => name.text).filter(text => text !== row.name),
    meta: tr('{0} 次聊天 · 最近 {1}', String(row.chats), peopleThingsDay(row.lastAt)) };
}
/** One suggestion's question. */
export function peopleThingsPendingWords(item: PeopleThingsPending, tr: Tr = uiText): string { return tr('「{0}」和「{1}」是同一个吗？', item.a.name, item.b.name); }

export interface PeopleThingsPorts {
  get(): Promise<PeopleThingsView>;
  change(op: PeopleThingsOp): Promise<PeopleThingsView>;
  changed(callback: () => void): () => void;
  error(message: string): void;
}

export class PeopleThingsPanel {
  private readonly status: HTMLElement;
  private readonly pending: HTMLElement;
  private readonly list: HTMLElement;
  private view: PeopleThingsView | null = null;
  private mergeFrom: PeopleThingsRow | null = null;
  private renaming: string | null = null;
  private confirming: string | null = null;
  constructor(private readonly root: HTMLElement, private readonly ports: PeopleThingsPorts) {
    const title = this.el('h3', '', uiText('你生活里的人和事'));
    const note = this.el('p', 'hint', uiText('她从聊天笔记里记下的人和事，同一个人的不同叫法放在一起。你说其中任何一种叫法，她都会想起和这个人有关的那几次聊天。只存在这台电脑上，只存叫法，不存聊天原文，也不会跟着角色卡导出。'));
    this.status = this.el('p', 'hint', uiText('正在读取…'));
    this.pending = this.el('div', 'people-things-pending');
    this.list = this.el('div', 'people-things-list');
    root.replaceChildren(title, note, this.status, this.pending, this.list);
    ports.changed(() => void this.refresh());
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try { this.render(await this.ports.get()); } catch (error) { this.ports.error(String(error)); }
  }

  private el(tag: string, className = '', text?: string, part?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (part) node.dataset.peopleThings = part;
    return node;
  }
  private button(text: string, part: string, action: () => void): HTMLButtonElement {
    const node = this.el('button', '', text, part) as HTMLButtonElement;
    node.type = 'button';
    node.onclick = action;
    return node;
  }
  private async send(op: PeopleThingsOp): Promise<void> {
    try { this.mergeFrom = null; this.renaming = null; this.confirming = null; this.render(await this.ports.change(op)); }
    catch (error) { this.ports.error(error instanceof Error ? error.message : String(error)); }
  }

  private render(view: PeopleThingsView): void {
    this.view = view;
    this.status.textContent = !view.total ? uiText('还没有记下人和事。她写了聊天笔记以后，这里会慢慢出现。')
      : view.rows.length < view.total ? uiText('共 {0} 个，只显示最近的 {1} 个', String(view.total), String(view.rows.length)) : uiText('共 {0} 个', String(view.total));
    const nodes: HTMLElement[] = [];
    if (view.pending.length) {
      nodes.push(this.el('h4', 'people-things-heading', uiText('待确认'), 'pending-heading'), this.el('p', 'hint', uiText('她拿不准这两个是不是同一个，你说了算：')));
      for (const item of view.pending) {
        const box = this.el('div', 'people-things-suggestion', undefined, 'pending');
        box.append(this.el('div', 'people-things-question', peopleThingsPendingWords(item), 'question'));
        const actions = this.el('div', 'people-things-actions');
        actions.append(
          this.button(uiText('是同一个'), 'confirm', () => void this.send({ kind: 'confirm', key: item.a.key, other: item.b.key })),
          this.button(uiText('不是'), 'refuse', () => void this.send({ kind: 'refuse', key: item.a.key, other: item.b.key })));
        box.append(actions);
        nodes.push(box);
      }
    }
    this.pending.replaceChildren(...nodes);
    const rows: HTMLElement[] = [];
    if (this.mergeFrom) {
      const from = this.mergeFrom;
      const bar = this.el('div', 'people-things-merge-bar', undefined, 'merge-bar');
      bar.append(this.el('span', '', uiText('选一个要和「{0}」合并的：', from.name)), this.button(uiText('取消'), 'merge-cancel', () => { this.mergeFrom = null; if (this.view) this.render(this.view); }));
      rows.push(bar);
    }
    for (const row of view.rows) rows.push(this.row(row));
    this.list.replaceChildren(...rows);
  }

  private row(row: PeopleThingsRow): HTMLElement {
    const words = peopleThingsRowWords(row);
    const box = this.el('div', `people-things-row people-things-${row.kind}`, undefined, 'row');
    box.dataset.key = row.key;
    const text = this.el('div', 'people-things-text');
    const head = this.el('div', 'people-things-name');
    head.append(this.el('span', '', words.title, 'name'), this.el('span', 'people-things-kind', ` · ${words.kind}`, 'kind'));
    text.append(head);
    if (row.names.length > 1) {
      const names = this.el('div', 'people-things-aliases', undefined, 'aliases');
      names.append(this.el('span', 'hint', uiText('叫法：')));
      for (const name of row.names) {
        const chip = this.el('span', 'people-things-alias', name.text, 'alias');
        const split = this.button(uiText('拆出'), 'split', () => void this.send({ kind: 'split', key: name.key }));
        split.title = `${uiText('拆出')} ${name.text}`;
        names.append(chip, split);
      }
      text.append(names);
    }
    text.append(this.el('div', 'people-things-meta', words.meta, 'meta'));
    box.append(text);
    const actions = this.el('div', 'people-things-actions');
    if (this.mergeFrom && this.mergeFrom.key !== row.key) {
      const from = this.mergeFrom;
      actions.append(this.button(uiText('合并到这个'), 'merge-into', () => void this.send({ kind: 'merge', key: from.key, other: row.key })));
    } else if (!this.mergeFrom) {
      if (this.renaming === row.key) {
        const input = this.el('input', '', undefined, 'rename-input') as HTMLInputElement;
        input.type = 'text'; input.maxLength = 24; input.value = row.name; input.placeholder = uiText('新名字（最多 24 个字）');
        actions.append(input, this.button(uiText('确定'), 'rename-ok', () => void this.send({ kind: 'rename', key: row.key, text: input.value })),
          this.button(uiText('取消'), 'rename-cancel', () => { this.renaming = null; if (this.view) this.render(this.view); }));
      } else {
        actions.append(this.button(uiText('改名'), 'rename', () => { this.renaming = row.key; this.confirming = null; if (this.view) this.render(this.view); }),
          this.button(uiText('合并…'), 'merge', () => { this.mergeFrom = row; this.renaming = null; this.confirming = null; if (this.view) this.render(this.view); }));
        actions.append(this.confirming === row.key
          ? this.button(uiText('确定删掉？'), 'delete-confirm', () => void this.send({ kind: 'delete', key: row.key }))
          : this.button(uiText('删掉'), 'delete', () => { this.confirming = row.key; if (this.view) this.render(this.view); }));
      }
    }
    box.append(actions);
    return box;
  }
}
