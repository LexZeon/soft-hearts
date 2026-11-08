import {uiText,uiTemplate} from './ui-language';
import { TRANSIENT_SWITCH_DELAY_MS, TRANSIENT_SWITCH_RETRIES, isTransientSwitch } from './transient-switch';
import type {
  AmbientComment, AmbientDeleteResult, AmbientLanguage, AmbientTranscript,
  AmbientTranscriptPage, AmbientTranscriptQuery,
} from '../../shared/ambient-audio';

export interface AmbientTranscriptHistoryActions {
  list(query: AmbientTranscriptQuery): Promise<AmbientTranscriptPage>;
  read(id: string): Promise<AmbientTranscript>;
  comments(id: string): Promise<AmbientComment[]>;
  remove(id: string): Promise<AmbientDeleteResult>;
  onError(message: string): void;
}
export interface AmbientTranscriptHistoryOptions { pageSize?: number; }
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
function option(label: string, value: string): HTMLOptionElement {
  const node = make('option', label); node.value = value; return node;
}
function time(value: number): string { return new Date(value).toLocaleString(); }
const sourceName = (source: AmbientTranscript['source']) => source === 'microphone' ? uiText('麦克风') : uiText('系统声音');
const purposes = (record: Pick<AmbientTranscript, 'mode' | 'purposes'>) => (record.purposes ?? [record.mode]).map(p => p === 'music' ? uiText('音乐') : uiText('看剧')).join(' / ');
function language(value: AmbientLanguage): string {
  const labels = { zh: uiText('中文'), ja: uiText('日语'), en: uiText('英语') };
  const source = value.source === 'provider' ? uiText('转写服务返回') : value.source === 'verified-detector' ? uiText('已验证的语言检测') : uiText('未验证语言检测');
  const result = value.status === 'detected' ? labels[value.language]
    : value.status === 'mixed' ? uiTemplate`混合：${value.languages.map(code => labels[code]).join('、')}`
      : value.status === 'unsupported' ? uiTemplate`不支持的语言${value.language ? `：${value.language}` : ''}` : uiText('语言未知');
  return `${result} · ${source}`;
}

/** Scope-safe text archive viewer. It accepts no paths, URLs, audio or model instructions. */
export class AmbientTranscriptHistory {
  private generation = 0;
  private listRequest = 0;
  private detailRequest = 0;
  private disposed = false;
  private offset = 0;
  private selected = '';
  private readonly pageSize: number;
  private readonly query = make('input');
  private readonly tag = make('select');
  private readonly list = make('div');
  private readonly detail = make('div');
  private readonly status = make('output');
  private readonly previous = make('button', uiText('上一页'));
  private readonly next = make('button', uiText('下一页'));

  constructor(private readonly container: HTMLElement, private readonly actions: AmbientTranscriptHistoryActions, options: AmbientTranscriptHistoryOptions = {}) {
    this.pageSize = typeof options.pageSize === 'number' && Number.isFinite(options.pageSize)
      ? Math.max(1, Math.min(100, Math.floor(options.pageSize))) : 24;
    container.classList.add('memory-panel', 'ambient-transcript-history');
    const heading = make('h2', uiText('以前的转写（旧记录）'));
    const hint = make('p', uiText('「和她一起听」之前保存的歌词或对白原文，按当前角色与聊天连接区分，只能查看和删除，不再新增（现在她只记笔记，原文只留最近几段，见上面）。播放内容不代表你的立场。删除会停止本次一起听、清理相关评论与当前上下文，保留其它档案。')); hint.className = 'hint';
    this.query.id = 'ambient-transcript-query'; this.query.type = 'search'; this.query.maxLength = 200;
    this.query.placeholder = uiText('查找标题、tag 或原文'); this.query.setAttribute('aria-label', uiText('搜索播放声音文字记录'));
    this.tag.id = 'ambient-transcript-tag'; this.tag.setAttribute('aria-label', uiText('按 tag 筛选播放声音记录'));
    this.tag.append(option(uiText('全部 tag'), ''));
    const search = make('button', uiText('查找')); search.id = 'ambient-transcript-search'; search.type = 'button';
    search.onclick = () => { if (!this.disposed) { this.offset = 0; void this.refresh(); } };
    this.query.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); search.click(); }
    };
    this.tag.onchange = () => { this.offset = 0; void this.refresh(); };
    const tools = make('div'); tools.className = 'memory-tools'; tools.append(this.query, this.tag, search);
    this.list.id = 'ambient-transcript-list'; this.list.className = 'memory-messages';
    this.detail.id = 'ambient-transcript-detail'; this.detail.className = 'memory-detail';
    this.status.id = 'ambient-transcript-status'; this.status.setAttribute('aria-live', 'polite');
    this.previous.type = this.next.type = 'button'; this.previous.disabled = this.next.disabled = true;
    this.previous.id = 'ambient-transcript-previous'; this.next.id = 'ambient-transcript-next';
    this.previous.onclick = () => { if (!this.disposed) { this.offset = Math.max(0, this.offset - this.pageSize); void this.refresh(); } };
    this.next.onclick = () => { if (!this.disposed) { this.offset += this.pageSize; void this.refresh(); } };
    const paging = make('div'); paging.className = 'memory-tools'; paging.append(this.previous, this.status, this.next);
    container.replaceChildren(heading, hint, tools, this.list, paging, this.detail);
  }

  async init(): Promise<void> { await this.refresh(); }

  /** A new host scope has no labels, selections or pending reads from the previous one. */
  reset(): void {
    if (this.disposed) return;
    this.generation++; this.listRequest++; this.detailRequest++;
    this.offset = 0; this.selected = ''; this.query.value = '';
    this.tag.replaceChildren(option(uiText('全部 tag'), ''));
    this.list.replaceChildren(); this.detail.replaceChildren(); this.status.textContent = '';
    this.previous.disabled = this.next.disabled = true;
  }

  async refresh(attempt = 0): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation, request = ++this.listRequest;
    const query = this.query.value.trim().slice(0, 200), tag = this.tag.value;
    this.status.textContent = uiText('正在读取记录…'); this.previous.disabled = this.next.disabled = true;
    try {
      const page = await this.actions.list({ offset: this.offset, limit: this.pageSize, ...(query ? { query } : {}), ...(tag ? { tag } : {}) });
      if (!this.current(generation) || request !== this.listRequest) return;
      this.offset = page.offset;
      if (page.total > 0 && !page.records.length && page.offset >= page.total) {
        const lastPageOffset = Math.floor((page.total - 1) / this.pageSize) * this.pageSize;
        if (lastPageOffset < this.offset) { this.offset = lastPageOffset; await this.refresh(); return; }
      }
      this.tag.replaceChildren(option(uiText('全部 tag'), ''), ...page.tags.slice(0, 200).map(value => option(value, value)));
      this.tag.value = page.tags.includes(tag) ? tag : '';
      this.list.replaceChildren();
      for (const record of page.records.slice(0, 100)) {
        const button = make('button'); button.type = 'button'; button.className = 'memory-record'; button.dataset.recordId = record.id;
        const mode = `${sourceName(record.source)} · ${purposes(record)}`;
        button.append(make('strong', record.title), make('small', `${mode} · ${time(record.startedAt)} — ${time(record.endedAt)}`),
          make('small', `${language(record.language)} · ${record.tags.join(' / ')}`), make('span', record.excerpt));
        button.onclick = () => { if (this.current(generation)) void this.open(record.id); };
        this.list.append(button);
      }
      if (!page.records.length) this.list.append(make('p', uiText('还没有符合条件的文字记录。')));
      this.status.textContent = uiTemplate`共 ${page.total} 段 · 第 ${Math.floor(page.offset / this.pageSize) + 1} 页`;
      this.previous.disabled = page.offset <= 0;
      this.next.disabled = page.offset + page.records.length >= page.total;
      if (this.selected) await this.open(this.selected);
    } catch (error) {
      if (!this.current(generation) || request !== this.listRequest) return;
      // C2: mid-switch; read again in a moment rather than reporting a failure.
      if (isTransientSwitch(error) && attempt < TRANSIENT_SWITCH_RETRIES) {
        setTimeout(() => { if (this.current(generation) && request === this.listRequest) void this.refresh(attempt + 1); }, TRANSIENT_SWITCH_DELAY_MS);
        return;
      }
      this.status.textContent = uiText('记录读取失败，可重新查找。'); this.report(error);
    }
  }

  private async open(id: string): Promise<void> {
    if (this.disposed) return;
    const changed = this.selected !== id;
    this.selected = id;
    const generation = this.generation, request = ++this.detailRequest;
    if (changed) this.detail.replaceChildren(make('p', uiText('正在读取完整原文…')));
    try {
      const [record, comments] = await Promise.all([this.actions.read(id), this.actions.comments(id)]);
      if (!this.current(generation) || request !== this.detailRequest || this.selected !== id) return;
      if (record.id !== id) throw new Error(uiText('文字记录编号与请求不一致，请重新查找。'));
      const holder = make('div'); holder.className = 'memory-messages';
      const original = make('article');
      original.append(make('h3', record.title), make('small', `${sourceName(record.source)} · ${purposes(record)}`),
        make('p', `${time(record.startedAt)} — ${time(record.endedAt)}`), make('p', language(record.language)), make('p', record.tags.join(' / ')));
      const full = make('pre', record.text); full.id = 'ambient-transcript-original'; full.className = 'memory-original'; original.append(full);
      if (record.observations && record.observations.length > 1) {
        const sources = make('details'); sources.append(make('summary', uiText('同段声音的来源原文')));
        for (const observation of record.observations) {
          sources.append(make('small', `${sourceName(observation.source)} · ${observation.purposes.map(p => p === 'music' ? uiText('音乐') : uiText('看剧')).join(' / ')}`), make('pre', observation.text));
        }
        original.append(sources);
      }
      const remove = make('button', uiText('删除这段记录')); remove.id = 'ambient-transcript-delete'; remove.type = 'button';
      remove.onclick = () => {
        if (!this.current(generation) || request !== this.detailRequest || this.selected !== id) return;
        remove.textContent = uiText('确认删除原文及关联评论');
        remove.onclick = () => {
          if (!this.current(generation) || request !== this.detailRequest || this.selected !== id) return;
          void this.remove(id, generation);
        };
      };
      original.append(remove); holder.append(original);
      const spoken = make('article'); spoken.id = 'ambient-transcript-comments'; spoken.append(make('h3', uiText('角色已发出的评论')));
      const visible = comments.filter(comment => comment.source === 'ambient-assistant-comment' && comment.sessionId === record.sessionId && comment.recordIds.includes(id));
      for (const comment of visible) {
        const box = make('div'); box.dataset.commentId = comment.id;
        box.append(make('small', time(comment.createdAt)));
        const text = make('pre', comment.text); text.className = 'memory-original'; box.append(text); spoken.append(box);
      }
      if (!visible.length) spoken.append(make('p', uiText('这段记录没有已发出的角色评论。')));
      holder.append(spoken); this.detail.replaceChildren(holder);
    } catch (error) {
      if (!this.current(generation) || request !== this.detailRequest || this.selected !== id) return;
      this.selected = ''; this.detail.replaceChildren(); this.report(error);
    }
  }

  private async remove(id: string, generation: number): Promise<void> {
    this.detailRequest++; this.selected = ''; this.detail.replaceChildren();
    try {
      await this.actions.remove(id);
      if (!this.current(generation)) return;
      // Another selection may have opened while deletion was pending. Keep it,
      // except when it refers to the very record which has just been removed.
      if (this.selected === id) { this.detailRequest++; this.selected = ''; this.detail.replaceChildren(); }
      await this.refresh();
    } catch (error) { if (this.current(generation)) this.report(error); }
  }
  private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
  private report(error: unknown): void { this.actions.onError(error instanceof Error ? error.message : String(error)); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.listRequest++; this.detailRequest++;
    this.selected = ''; this.container.replaceChildren();
  }
}
