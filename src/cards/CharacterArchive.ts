/**
 * I-208 角色档案 (docs/claude/2026-11-24-i208-archive-step1.md): one character's archive inside the character page. A read-only view of what her memory already
 * holds (diary, chat notes, her portrait of the user, dates the user told her, plans she remembers, familiarity, a card's milestone), by kind, newest first,
 * with one search box over all of them. It holds no copy and has no delete of its own: editing and deleting stay on the memory pages and the recycle bin, which it points to.
 * The one exception (I-208 step 3): her margin notes in the card's object (Gene's handbook) can be edited here, and deleted after a confirm (they go into the recycle bin first).
 * Text is set with textContent only. The host answers pages (`more`); nothing is asked for until the panel is opened.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { uiText, uiTemplate } from '../foundation/ui-language';
import type { ArchiveItem, ArchiveKind, ArchiveSection, CharacterArchiveRequest, CharacterArchiveView } from '../../shared/memory';

export type CharacterArchiveApi = (request: CharacterArchiveRequest) => Promise<CharacterArchiveView>;

registerUiMessages({
  en: {
    '档案': 'Archive', '关闭': 'Close', '搜索档案': 'Search the archive', '搜日记、笔记、画像、计划……': 'Search diary, notes, portrait, plans…', '显示更多': 'Show more',
    '这里只看：要改或删某一条，去「用户画像」页和各记忆页；删掉的东西先在回收站，能找回。': 'Read only: to edit or delete one, use the profile and memory pages; whatever is deleted waits in the recycle bin first and can come back.',
    '打开回收站': 'Open the recycle bin', '正在读档案……': 'Reading the archive…', '没有找到包含「{0}」的内容。': 'Nothing here contains “{0}”.',
    '日记': 'Diary', '聊天笔记': 'Chat notes', '她眼里的你': 'Her portrait of you', '特别的日子': 'Special days', '她记得的计划': 'Plans she remembers', '熟悉度': 'Familiarity', '她的里程碑': 'Her milestone',
    '还没有日记。她会在你们聊过之后、在你不忙的时候写。': 'No diary yet. She writes it after you have talked, when you are not busy.',
    '还没有聊天笔记。': 'No chat notes yet.', '还没有记下关于你的事。': 'Nothing noted about you yet.',
    '你还没告诉她生日或纪念日。': 'You have not told her a birthday or an anniversary yet.', '她还没有记下你说过的计划。': 'She has not noted any plan you mentioned yet.',
    '还没有聊过。': 'No chats yet.', '用户提供的事实': 'Facts you gave', '表达偏好': 'How you like things said', '待确认的推断': 'To be confirmed',
    '等着': 'Waiting', '问过了': 'Asked', '你自己说了': 'You said it first', '过期了': 'Expired', '生日': 'Birthday', '纪念日': 'Anniversary',
    '小梗：{0}': 'Private joke: {0}', '{0}月{1}日': '{0}/{1}', '第一次聊天，到今天是第 {0} 天': 'First chat; today is day {0}', '一起聊过的天数：{0}': 'Days you chatted: {0}',
    '算上特别瞬间的有效天数：{0}': 'Counting special moments: {0} days', '有特别瞬间的天数：{0}': 'Days with a special moment: {0}', '她叫你：{0}': 'She calls you: {0}', '你叫她：{0}': 'You call her: {0}',
    '这是角色卡里声明的一件事，清除在「用户画像」页。': 'A thing her card declares; clear it on the profile page.',
    '档案页面暂时不可用。': 'The archive is unavailable right now.',
    '她的物件': 'Her object', '她的物件 · 《{0}》': 'Her object · “{0}”', '第 {0} 页': 'Page {0}', '批注': 'Margin note', '她添的': 'Added by her', '编辑': 'Edit', '删除': 'Delete', '保存': 'Save', '取消': 'Cancel', '确定': 'Confirm', '确定删除？': 'Delete it?',
    '批注是她自己写的：你可以改，也可以删；删掉的先放进回收站，能找回。': 'The margin notes are hers: you can edit them or delete them; a deleted one waits in the recycle bin first and can come back.',
  },
  'zh-CN': {},
});

const SECTION_ORDER: readonly { kind: ArchiveKind; title: string; empty: string }[] = [
  { kind: 'diary', title: '日记', empty: '还没有日记。她会在你们聊过之后、在你不忙的时候写。' },
  { kind: 'notes', title: '聊天笔记', empty: '还没有聊天笔记。' },
  { kind: 'portrait', title: '她眼里的你', empty: '还没有记下关于你的事。' },
  { kind: 'anniversaries', title: '特别的日子', empty: '你还没告诉她生日或纪念日。' },
  { kind: 'plans', title: '她记得的计划', empty: '她还没有记下你说过的计划。' },
  { kind: 'familiarity', title: '熟悉度', empty: '还没有聊过。' },
  { kind: 'milestone', title: '她的里程碑', empty: '' },
  { kind: 'object', title: '她的物件', empty: '' },
];
const PORTRAIT_TAGS: Readonly<Record<string, string>> = { fact: '用户提供的事实', preference: '表达偏好', pending_inference: '待确认的推断' };
const PLAN_TAGS: Readonly<Record<string, string>> = { waiting: '等着', asked: '问过了', 'user-said': '你自己说了', expired: '过期了' };
const SPECIAL_TAGS: Readonly<Record<string, string>> = { birthday: '生日', anniversary: '纪念日' };

/** "2026-11-23" as the line says it: 11月23日 (the year only when it is not this year). */
function dateText(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return '';
  const when = uiTemplate`${Number(match[2])}月${Number(match[3])}日`;
  return Number(match[1]) === new Date().getFullYear() ? when : `${match[1]} ${when}`;
}

/** What one line says in its own words (the host sends a closed tag and the value; the labels are this window's). */
function familiarityText(item: ArchiveItem): string {
  switch (item.tag) {
    case 'met': return uiTemplate`第一次聊天，到今天是第 ${item.text} 天`;
    case 'days': return uiTemplate`一起聊过的天数：${item.text}`;
    case 'effective': return uiTemplate`算上特别瞬间的有效天数：${item.text}`;
    case 'quality': return uiTemplate`有特别瞬间的天数：${item.text}`;
    case 'nickname': return uiTemplate`她叫你：${item.text}`;
    case 'herNickname': return uiTemplate`你叫她：${item.text}`;
    default: return item.text;
  }
}
function specialText(item: ArchiveItem): string {
  const [month, day] = item.text.split('-');
  return `${uiText(SPECIAL_TAGS[item.tag] ?? item.tag)} · ${uiTemplate`${month}月${day}日`}`;
}

/** Her margin notes: edit one's words, delete one (the page confirms first). Both resolve to whether something changed. Absent: the notes are shown without these buttons. */
export interface ArchiveNoteApi { edit(characterId: string, id: string, text: string): Promise<boolean>; remove(characterId: string, id: string): Promise<boolean> }

/** The two writes on the host's existing `herAlarms` call (the preload may not grow; electron/wiring/card-objects-call-wiring.ts answers them). */
export function archiveNoteApi(alarms: (request: { action: 'object-note-edit'; characterId: string; id: string; text: string } | { action: 'object-note-delete'; characterId: string; id: string }) => Promise<{ objectNote?: { changed: boolean } }>): ArchiveNoteApi {
  return { edit: async (characterId, id, text) => (await alarms({ action: 'object-note-edit', characterId, id, text })).objectNote?.changed === true,
    remove: async (characterId, id) => (await alarms({ action: 'object-note-delete', characterId, id })).objectNote?.changed === true };
}

export interface CharacterArchiveOptions {
  api: CharacterArchiveApi;
  notes?: ArchiveNoteApi;
  onError(message: string): void;
  /** Where deleted things wait (the character page's recycle bin); the page points to it, it never deletes. */
  openBin?(): void;
  /** Milliseconds a typed search waits for the next key (default 300). */
  searchDelayMs?: number;
}

export class CharacterArchivePanel {
  readonly element: HTMLElement;
  private characterId = '';
  private query = '';
  private view: CharacterArchiveView | null = null;
  /** What is shown per kind: the first page plus the pages asked for since. */
  private readonly shown = new Map<ArchiveKind, ArchiveItem[]>();
  private readonly more = new Map<ArchiveKind, boolean>();
  private readonly totals = new Map<ArchiveKind, number>();
  private sequence = 0;
  private loading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** The margin note being edited, and the one waiting for its delete confirm (item ids). */
  private editing: string | null = null;
  private confirming: string | null = null;
  private readonly body: HTMLElement;
  private readonly box: HTMLInputElement;
  private readonly title: HTMLElement;

  constructor(private readonly doc: Document, private readonly options: CharacterArchiveOptions) {
    this.element = this.node('section', 'character-archive'); this.element.hidden = true; this.element.id = 'character-archive-panel';
    this.element.setAttribute('aria-label', uiText('档案'));
    this.title = this.node('strong', 'character-archive-title');
    const close = this.node('button', 'subtle', uiText('关闭')); close.type = 'button'; close.dataset.archiveAction = 'close'; close.onclick = () => this.close();
    const head = this.node('div', 'character-archive-head'); head.append(this.title, close);
    this.box = this.node('input', 'character-archive-search'); this.box.type = 'search'; this.box.dataset.archiveField = 'query';
    this.box.placeholder = uiText('搜日记、笔记、画像、计划……'); this.box.setAttribute('aria-label', uiText('搜索档案'));
    this.box.oninput = () => this.typed();
    this.box.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.search(); } };
    const note = this.node('p', 'character-archive-note', uiText('这里只看：要改或删某一条，去「用户画像」页和各记忆页；删掉的东西先在回收站，能找回。'));
    if (options.openBin) {
      const bin = this.node('button', 'link', uiText('打开回收站')); bin.type = 'button'; bin.dataset.archiveAction = 'open-bin'; bin.onclick = () => options.openBin?.();
      note.append(' ', bin);
    }
    this.body = this.node('div', 'character-archive-body');
    this.element.append(head, this.box, note, this.body);
  }

  private node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); node.className = className; if (text) node.textContent = text; return node;
  }

  /** Show her archive (the page asks the host for it now; nothing is read while it is closed). */
  async open(characterId: string, name: string): Promise<void> {
    if (this.disposed) return;
    this.characterId = characterId; this.query = ''; this.box.value = '';
    this.title.textContent = `${uiText('档案')} · ${name}`;
    this.element.hidden = false;
    await this.load();
  }
  close(): void { this.element.hidden = true; this.sequence++; this.cancelTimer(); this.view = null; this.shown.clear(); this.editing = null; this.confirming = null; this.body.replaceChildren(); }
  dispose(): void { this.disposed = true; this.cancelTimer(); this.sequence++; }
  get isOpen(): boolean { return !this.element.hidden; }
  get currentId(): string { return this.characterId; }

  private cancelTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private typed(): void { this.cancelTimer(); this.timer = setTimeout(() => { this.timer = null; this.search(); }, this.options.searchDelayMs ?? 300); }
  private search(): void { this.cancelTimer(); const query = this.box.value.trim(); if (query === this.query && this.view) return; this.query = query; void this.load(); }

  /** The first page of every section for the current search. A later answer never lands on an earlier question's page. */
  private async load(): Promise<void> {
    const turn = ++this.sequence; this.loading = true; this.render();
    try {
      const view = await this.options.api({ characterId: this.characterId, ...(this.query ? { query: this.query } : {}) });
      if (turn !== this.sequence || this.disposed) return;
      this.view = view; this.shown.clear();
      for (const section of view.sections) this.take(section, false);
    } catch (problem) { if (turn === this.sequence && !this.disposed) this.options.onError(problem instanceof Error ? problem.message : uiText('档案页面暂时不可用。')); }
    finally { if (turn === this.sequence && !this.disposed) { this.loading = false; this.render(); } }
  }

  private take(section: ArchiveSection, append: boolean): void {
    this.shown.set(section.kind, [...(append ? this.shown.get(section.kind) ?? [] : []), ...section.items]);
    this.more.set(section.kind, section.more); this.totals.set(section.kind, section.total);
  }

  private async nextPage(kind: ArchiveKind): Promise<void> {
    const turn = this.sequence, offset = this.shown.get(kind)?.length ?? 0;
    try {
      const view = await this.options.api({ characterId: this.characterId, kind, offset, ...(this.query ? { query: this.query } : {}) });
      if (turn !== this.sequence || this.disposed) return;
      const section = view.sections.find(item => item.kind === kind);
      if (section) this.take(section, true);
      this.render();
    } catch (problem) { if (turn === this.sequence && !this.disposed) this.options.onError(problem instanceof Error ? problem.message : uiText('档案页面暂时不可用。')); }
  }

  private line(kind: ArchiveKind, item: ArchiveItem): HTMLElement {
    const row = this.node('li', 'character-archive-item'); row.dataset.archiveItem = item.id;
    const meta: string[] = [];
    const when = dateText(item.date);
    if (when) meta.push(when);
    if (kind === 'object') { if (item.title) meta.push(uiTemplate`第 ${item.title} 页`); if (item.tag === 'note') meta.push(uiText('批注')); if (item.tag === 'own') meta.push(uiText('她添的')); }
    if (kind === 'portrait' && item.tag) meta.push(uiText(PORTRAIT_TAGS[item.tag] ?? item.tag));
    if (kind === 'plans' && item.tag) meta.push(uiText(PLAN_TAGS[item.tag] ?? item.tag));
    if (meta.length) row.append(this.node('span', 'character-archive-meta', meta.join(' · ')), ' ');
    if (kind === 'notes' && item.title) row.append(this.node('strong', '', item.title), this.node('br'));
    if (kind === 'diary' && item.title) row.append(this.node('em', '', uiTemplate`小梗：${item.title}`), this.node('br'));
    if (kind === 'object') this.objectLine(row, item);
    else if (kind === 'milestone') row.append(this.node('strong', '', item.title), ' ', this.node('span', '', item.text));
    else row.append(this.node('span', 'character-archive-text', kind === 'familiarity' ? familiarityText(item) : kind === 'anniversaries' ? specialText(item) : item.text));
    return row;
  }

  /** One line of her object: an entry of the book (fixed) or one of her margin notes (editable here, deletable after a confirm). */
  private objectLine(row: HTMLElement, item: ArchiveItem): void {
    const notes = this.options.notes, mine = (item.tag === 'note' || item.tag === 'own') && !!notes && item.id.startsWith('object-note:');
    const id = item.id.slice('object-note:'.length);
    if (mine && this.editing === item.id) {
      const field = this.node('textarea', 'character-archive-edit'); field.value = item.text; field.maxLength = 160; field.rows = 2; field.dataset.archiveField = 'note-text';
      const save = this.button(uiText('保存'), 'note-save', () => { void this.writeNote(() => notes!.edit(this.characterId, id, field.value)); });
      const cancel = this.button(uiText('取消'), 'note-cancel', () => { this.editing = null; this.render(); });
      row.append(field, ' ', save, ' ', cancel);
      return;
    }
    row.append(this.node('span', 'character-archive-text', item.text));
    if (!mine) return;
    if (this.confirming === item.id) {
      row.append(' ', this.node('span', '', uiText('确定删除？')), ' ', this.button(uiText('确定'), 'note-delete-confirm', () => { void this.writeNote(() => notes!.remove(this.characterId, id)); }),
        ' ', this.button(uiText('取消'), 'note-delete-cancel', () => { this.confirming = null; this.render(); }));
      return;
    }
    row.append(' ', this.button(uiText('编辑'), 'note-edit', () => { this.editing = item.id; this.confirming = null; this.render(); }),
      ' ', this.button(uiText('删除'), 'note-delete', () => { this.confirming = item.id; this.editing = null; this.render(); }));
  }

  private button(label: string, action: string, onClick: () => void): HTMLButtonElement {
    const button = this.node('button', 'subtle', label); button.type = 'button'; button.dataset.archiveAction = action; button.onclick = onClick; return button;
  }

  /** A write of one note; then the page is read again from the top (the search is cleared: a search made before the write could show an older reading). */
  private async writeNote(write: () => Promise<boolean>): Promise<void> {
    this.editing = null; this.confirming = null;
    try { await write(); } catch (problem) { if (!this.disposed) this.options.onError(problem instanceof Error ? problem.message : uiText('档案页面暂时不可用。')); }
    if (this.disposed) return;
    this.query = ''; this.box.value = '';
    await this.load();
  }

  private render(): void {
    if (this.element.hidden) return;
    if (this.loading && !this.view) { this.body.replaceChildren(this.node('p', 'character-archive-empty', uiText('正在读档案……'))); return; }
    const view = this.view;
    if (!view) { this.body.replaceChildren(); return; }
    const parts: HTMLElement[] = [];
    for (const { kind, title, empty } of SECTION_ORDER) {
      if (kind === 'milestone' && !view.milestone) continue; // only a card that declares one has this section
      if (kind === 'object' && !view.object) continue; // likewise a card that declares an object
      const items = this.shown.get(kind) ?? [], total = this.totals.get(kind) ?? 0;
      const section = this.node('section', 'character-archive-section'); section.dataset.archiveKind = kind;
      section.append(this.node('h4', '', `${kind === 'object' && view.object ? uiTemplate`她的物件 · 《${view.object.name}》` : uiText(title)}${total ? ` (${total})` : ''}`));
      if (!items.length) section.append(this.node('p', 'character-archive-empty', this.query ? uiTemplate`没有找到包含「${this.query}」的内容。` : uiText(empty)));
      else {
        const list = this.node('ul', 'character-archive-list');
        for (const item of items) list.append(this.line(kind, item));
        section.append(list);
        if (kind === 'milestone') section.append(this.node('p', 'character-archive-note', uiText('这是角色卡里声明的一件事，清除在「用户画像」页。')));
        if (kind === 'object' && this.options.notes) section.append(this.node('p', 'character-archive-note', uiText('批注是她自己写的：你可以改，也可以删；删掉的先放进回收站，能找回。')));
        if (this.more.get(kind)) {
          const next = this.node('button', 'subtle', uiText('显示更多')); next.type = 'button'; next.dataset.archiveAction = 'more'; next.dataset.archiveKind = kind;
          next.onclick = () => { next.disabled = true; void this.nextPage(kind); };
          section.append(next);
        }
      }
      parts.push(section);
    }
    this.body.replaceChildren(...parts);
  }
}
