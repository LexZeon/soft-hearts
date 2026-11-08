import { uiText, uiTemplate, currentUiLanguage } from './ui-language';
import type { MemoryConfig, MemoryEdit, MemoryListQuery, MemoryPage, MemoryReadQuery, MemoryRecordPage } from '../../shared/memory';
import { MEMORY_CATEGORIES } from '../../shared/memory';
import type { MemoryNoteState } from '../../shared/memory-notes/interface';
import { TRANSIENT_SWITCH_DELAY_MS, TRANSIENT_SWITCH_RETRIES, isTransientSwitch } from './transient-switch';

interface MemoryPanelActions {
  list(query: MemoryListQuery): Promise<MemoryPage>;
  read(id: string, query?: MemoryReadQuery): Promise<MemoryRecordPage>;
  edit(id: string, patch: MemoryEdit): Promise<void>;
  remove(id: string): Promise<void>;
  /** I-021: this memory's note (read only) and deleting just the note. Without them the panel shows no note section. */
  note?(id: string): Promise<MemoryNoteState>;
  removeNote?(id: string): Promise<MemoryNoteState>;
  config(): Promise<MemoryConfig>;
  configure(value: unknown): Promise<void>;
  error(message: string): void;
}
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Bounded local archive viewer; all user content is rendered as text. */
export class MemoryPanel {
  private generation = 0;
  private listGeneration = 0;
  private offset = 0;
  private selected = '';
  private readonly query = make('input');
  private readonly tag = make('select');
  private readonly list = make('div');
  private readonly detail = make('div');
  private readonly status = make('output');
  private readonly previous = make('button', uiText('上一页'));
  private readonly next = make('button', uiText('下一页'));
  private readonly configEditor = make('textarea');
  /** I-021: the open memory's note section, and the status it shows (re-drawn only when that changes). */
  private noteBox: HTMLElement | null = null;
  constructor(private readonly container: HTMLElement, private readonly actions: MemoryPanelActions) {
    container.classList.add('memory-panel');
    const title = make('h2', uiText('聊天记忆'));
    const hint = make('p', uiText('保存双方文字与时间，主动话题另标来源。新对话保留记录；当前角色与聊天连接各自隔离。图片、声音和点心不存入记忆。'));
    hint.className = 'hint';
    this.query.id = 'memory-query'; this.query.placeholder = uiText('查找标题、标签或聊天文字'); this.query.setAttribute('aria-label', uiText('查找聊天记忆'));
    this.tag.id = 'memory-tag'; this.tag.setAttribute('aria-label', uiText('按标签筛选'));
    this.tag.append(new Option(uiText('全部标签'), ''));
    const refresh = make('button', uiText('查找')); refresh.id = 'memory-search'; refresh.type = 'button';
    refresh.onclick = () => { this.offset = 0; void this.refresh(); };
    this.query.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); refresh.click(); } };
    this.tag.onchange = () => { this.offset = 0; void this.refresh(); };
    const tools = make('div'); tools.className = 'memory-tools'; tools.append(this.query, this.tag, refresh);
    this.list.id = 'memory-list'; this.detail.id = 'memory-detail'; this.detail.className = 'memory-detail';
    this.previous.type = this.next.type = 'button';
    this.previous.onclick = () => { this.offset = Math.max(0, this.offset - 20); void this.refresh(); };
    this.next.onclick = () => { this.offset += 20; void this.refresh(); };
    const paging = make('div'); paging.className = 'memory-tools'; paging.append(this.previous, this.status, this.next);
    const tuning = make('details'); tuning.id = 'memory-tuning'; tuning.append(make('summary', uiText('记忆试验参数')));
    this.configEditor.id = 'memory-parameters'; this.configEditor.rows = 12; this.configEditor.setAttribute('aria-label', uiText('记忆试验参数 JSON'));
    const save = make('button', uiText('应用记忆参数')); save.type = 'button';
    save.onclick = () => void this.run(async () => { await this.actions.configure(JSON.parse(this.configEditor.value)); await this.loadConfig(); await this.refresh(); });
    tuning.append(make('p', uiText('仅调整整理、加权与召回额度，不删除原文。自动召回最多 3 段、3000 字符。')), this.configEditor, save);
    container.append(title, hint, tools, this.list, paging, this.detail, tuning);
  }
  private async run(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { this.actions.error(String(error)); } }
  async init(): Promise<void> { await this.loadConfig(); await this.refresh(); }
  private async loadConfig(): Promise<void> { this.configEditor.value = JSON.stringify(await this.actions.config(), null, 2); }
  reset(): void {
    this.generation++; this.listGeneration++; this.offset = 0; this.selected = ''; this.query.value = ''; this.noteBox = null;
    this.tag.replaceChildren(new Option(uiText('全部标签'), '')); this.status.textContent = '';
    this.detail.replaceChildren(); this.list.replaceChildren();
    void this.refresh();
  }
  async refresh(attempt = 0): Promise<void> {
    const generation = ++this.listGeneration;
    await this.run(async () => {
      let page;
      try { page = await this.actions.list({ offset: this.offset, limit: 20, query: this.query.value.trim(), tag: this.tag.value }); }
      catch (error) {
        // C2: mid-switch; read again in a moment rather than reporting a failure.
        if (isTransientSwitch(error) && attempt < TRANSIENT_SWITCH_RETRIES && generation === this.listGeneration) {
          setTimeout(() => { if (generation === this.listGeneration) void this.refresh(attempt + 1); }, TRANSIENT_SWITCH_DELAY_MS);
          return;
        }
        throw error;
      }
      if (generation !== this.listGeneration) return;
      this.list.replaceChildren();
      const selectedTag = this.tag.value;
      this.tag.replaceChildren(new Option(uiText('全部标签'), ''), ...page.tags.map(tag => new Option(tag, tag)));
      this.tag.value = selectedTag;
      for (const record of page.records) {
        const button = make('button'); button.type = 'button'; button.className = 'memory-record'; button.dataset.recordId = record.id;
        button.append(make('strong', record.title), make('small', uiTemplate`${new Date(record.createdAt).toLocaleString(currentUiLanguage())} · ${record.tags.join(' / ')} · 权重 ${record.weight.toFixed(1)}`));
        if (record.origin) button.append(make('small', uiTemplate`伙伴主动 · ${record.origin.labels.join('、')}`));
        button.onclick = () => void this.open(record.id);
        this.list.append(button);
      }
      if (!page.total) this.list.append(make('p', uiText('还没有符合条件的聊天记录。')));
      this.status.textContent = uiTemplate`共 ${page.total} 段 · ${Math.floor(page.offset / 20) + 1} 页${page.notice ? ` · ${page.notice}` : ''}`;
      this.previous.disabled = page.offset === 0; this.next.disabled = page.offset + page.records.length >= page.total;
    });
    // I-021: a note written (or deleted) meanwhile for the open memory shows up without reopening it.
    if (generation === this.listGeneration && this.selected && this.noteBox) void this.loadNote(this.selected, this.noteBox, this.generation);
  }
  private async open(id: string): Promise<void> {
    this.selected = id;
    const generation = ++this.generation;
    await this.run(async () => {
      const record = await this.actions.read(id);
      if (generation !== this.generation || this.selected !== id) return;
      this.detail.replaceChildren();
      const title = make('input'); title.id = 'memory-title'; title.value = record.title; title.maxLength = 100; title.setAttribute('aria-label', uiText('记忆标题'));
      const tags = make('input'); tags.id = 'memory-tags'; tags.value = record.tags.join('，'); tags.setAttribute('aria-label', uiText('记忆标签，逗号分隔'));
      const category = make('select'); category.setAttribute('aria-label', uiText('记忆分类'));
      for (const value of MEMORY_CATEGORIES) category.add(new Option(uiText(value), value)); category.value = record.category;
      const save = make('button', uiText('保存标题与标签')); save.type = 'button'; save.id = 'memory-save';
      save.onclick = () => void this.run(async () => { await this.actions.edit(id, { title: title.value, tags: tags.value.split(/[,，]/).map(v => v.trim()).filter(Boolean), category: category.value as MemoryEdit['category'] }); await this.refresh(); });
      const remove = make('button', uiText('删除这段记录')); remove.id = 'memory-delete'; remove.type = 'button';
      remove.onclick = () => {
        remove.textContent = uiText('确认删除这段原文');
        remove.onclick = () => void this.run(async () => { await this.actions.remove(id); this.detail.replaceChildren(); this.selected = ''; this.noteBox = null; await this.refresh(); });
      };
      this.detail.append(title, tags, category, save, remove);
      if (record.origin) this.detail.append(make('p', uiTemplate`伙伴主动发起 · ${record.origin.labels.join('、')} · 这是角色观察，不代表你作出的陈述或承诺。`));
      this.noteBox = null;
      if (this.actions.note && !record.origin) {
        const noteBox = make('section'); noteBox.id = 'memory-note'; noteBox.className = 'memory-note';
        this.detail.append(noteBox); this.noteBox = noteBox;
        void this.loadNote(id, noteBox, generation);
      }
      const messages = make('div'); messages.className = 'memory-messages'; this.detail.append(messages);
      this.renderMessages(id, record, messages, generation);
    });
  }
  /** I-021: her note for this memory, read only; only the note can be deleted here (the original stays). */
  private async loadNote(id: string, box: HTMLElement, generation: number): Promise<void> {
    const read = this.actions.note;
    if (!read) return;
    await this.run(async () => {
      const state = await read(id);
      if (generation !== this.generation || this.selected !== id || this.noteBox !== box) return;
      this.showNote(id, box, state, generation);
    });
  }
  private showNote(id: string, box: HTMLElement, state: MemoryNoteState, generation: number): void {
    const progress = state.progress.noted || state.progress.waiting
      ? uiTemplate`已经整理了 ${state.progress.noted} 段，还有 ${state.progress.waiting} 段等着整理。` : '';
    if (box.dataset.status === state.status && box.dataset.written === String(state.writtenAt ?? '')) {
      // Same note: only the count moves (a two-step delete in progress is left alone).
      const counter = box.children[box.children.length - 1];
      if (counter?.className === 'memory-note-progress') counter.textContent = progress;
      return;
    }
    box.dataset.status = state.status; box.dataset.written = String(state.writtenAt ?? '');
    box.replaceChildren(make('h3', uiText('她的笔记')));
    const note = state.note;
    if (state.status === 'written' && note) {
      box.append(make('strong', note.title), make('p', note.summary));
      const line = (label: string, values: readonly string[]) => { if (values.length) box.append(make('p', uiText(label) + values.join('、'))); };
      line('提到的人：', note.people);
      line('提到的事：', note.things);
      if (note.mood) box.append(make('p', uiText('你当时的心情：') + note.mood));
      line('说好要做的：', note.plans);
      line('方便想起来的词：', note.tags);
      const hint = make('p', uiText('笔记是她自己整理的，可能记错；想起来的时候以下面的原文为准。')); hint.className = 'hint';
      box.append(hint);
      const removeNote = this.actions.removeNote;
      if (removeNote) {
        const remove = make('button', uiText('删除这条笔记')); remove.type = 'button'; remove.id = 'memory-note-delete';
        remove.onclick = () => {
          remove.textContent = uiText('确认删除这条笔记（原文不删）');
          remove.onclick = () => void this.run(async () => {
            const next = await removeNote(id);
            if (generation !== this.generation || this.selected !== id || this.noteBox !== box) return;
            this.showNote(id, box, next, generation);
          });
        };
        box.append(remove);
      }
    } else {
      box.append(make('p', uiText(state.status === 'deleted' ? '这条笔记你删掉了，她不会再给这段写笔记；原文还在。'
        : state.status === 'waiting' ? '这段还没有笔记，她会在你不忙的时候慢慢整理。' : '这段不写笔记（太短，或者不是你们的聊天）。')));
    }
    const counter = make('small', progress); counter.className = 'memory-note-progress';
    box.append(counter);
  }
  private renderMessages(id: string, page: MemoryRecordPage, holder: HTMLElement, generation: number): void {
    for (const message of page.messages) {
      const box = make('article');
      box.append(make('small', `${message.role === 'user' ? uiText('你') : uiText('伙伴')} · ${new Date(message.createdAt).toLocaleString(currentUiLanguage())} · ${message.status}`));
      const content = make('pre', message.content); content.className = 'memory-original'; box.append(content);
      if (message.nextTextOffset !== undefined) {
        const more = make('button', uiText('继续读取这条长消息')); more.type = 'button';
        const load = (offset: number) => void this.run(async () => {
          const next = await this.actions.read(id, { messageOffset: page.messageOffset + page.messages.indexOf(message), messageLimit: 1, textOffset: offset });
          if (generation !== this.generation || this.selected !== id) return;
          const part = next.messages[0];
          if (part) content.textContent += part.content;
          if (part?.nextTextOffset !== undefined) more.onclick = () => load(part.nextTextOffset!); else more.remove();
        });
        more.onclick = () => load(message.nextTextOffset!); box.append(more);
      }
      holder.append(box);
    }
    if (page.nextMessageOffset !== undefined) {
      const more = make('button', uiText('读取后续原文')); more.type = 'button';
      more.onclick = () => void this.run(async () => {
        const next = await this.actions.read(id, { messageOffset: page.nextMessageOffset });
        if (generation !== this.generation || this.selected !== id) return;
        more.remove(); this.renderMessages(id, next, holder, generation);
      });
      holder.append(more);
    }
  }
  dispose(): void { this.generation++; this.listGeneration++; this.container.replaceChildren(); }
}
