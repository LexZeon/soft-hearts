import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import type { UserDiaryEntry, UserProfileEntry, UserProfileExpected, UserProfileKind, UserProfileView } from '../../shared/user-profile-ui';
import { ProfileViewGate } from './ProfileViewGate';
import type { TextMemorialPanel } from './TextMemorialPanel';
import './user-profile-panel.css';

type API = Pick<DesktopAPI, 'getUserProfile' | 'setUserProfileEnabled' | 'editUserProfile' | 'deleteUserProfile' | 'onUserProfileChanged'
  | 'editUserDiary' | 'deleteUserDiary' | 'clearUserDiary'>
  /** 熟悉度: the nickname she asked about and the user agreed to; the section only shows when the window offers these. */
  & Partial<Pick<DesktopAPI, 'getRelationshipNickname' | 'setRelationshipNickname'>>;
type Draft = { text: string; kind: UserProfileKind; originalText: string; originalKind: UserProfileKind; expected: UserProfileExpected };
const labels: Record<UserProfileKind, string> = { fact: '用户提供的事实', preference: '表达偏好', pending_inference: '待确认的推断' };

/** A local management surface; no operation is inferred from opening the panel. */
export class UserProfilePanel {
  private readonly gate = new ProfileViewGate();
  private readonly drafts = new Map<string, Map<string, Draft>>();
  private readonly unsubscribe: () => void;
  private busy = false;
  private operation = 0;
  private scopeEpoch = 0;
  private disposed = false;
  private confirmDelete: string | null = null;
  /** L3 diary: the day awaiting delete confirmation ('*' = clear all) and the one being edited. */
  private confirmDiary: string | null = null;
  private diaryDraft: { scopeId: string; date: string; text: string } | null = null;
  private status = '';
  /** 熟悉度 nickname: undefined while it is being read; the draft is what the text box holds. */
  private nickname: string | null | undefined;
  private nicknameDraft: string | null = null;
  private memorials: TextMemorialPanel | null = null;
  private readonly closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.close(); this.trigger.focus(); }
  };
  constructor(private readonly panel: HTMLElement, private readonly trigger: HTMLButtonElement,
    private readonly api: API, private readonly error: (message: string) => void,
    private readonly beforeOpen: () => void = () => {}) {
    this.panel.addEventListener('keydown', this.closeOnEscape);
    this.unsubscribe = api.onUserProfileChanged(view => this.onEvent(view));
    const sequence = this.gate.sequence;
    void api.getUserProfile().then(view => {
      if (!this.disposed && this.gate.snapshot(sequence, view)) this.render();
    }).catch(problem => { if (!this.disposed && sequence === this.gate.sequence) this.fail(problem); });
    this.render();
  }
  get opened(): boolean { return !this.panel.hidden; }
  /** Read only the currently enabled scope at the moment a message is sent. */
  messageExpectation(): UserProfileExpected | null {
    const view = this.gate.view;
    return !this.disposed && view?.enabled ? this.expected(view) : null;
  }
  toggle(): void { if (this.opened) this.close(); else this.open(); }
  open(): void {
    if (this.disposed) return; this.beforeOpen(); this.panel.hidden = false; this.trigger.setAttribute('aria-expanded', 'true'); this.memorials?.open(); this.render();
    void this.readNickname();
  }
  private async readNickname(): Promise<void> {
    if (!this.api.getRelationshipNickname) return;
    try { const value = await this.api.getRelationshipNickname(); if (!this.disposed) { this.nickname = value; this.render(); } }
    catch (problem) { if (!this.disposed) this.fail(problem); }
  }
  private async saveNickname(value: string | null): Promise<void> {
    if (!this.api.setRelationshipNickname || this.busy || this.disposed) return;
    this.busy = true; this.status = ''; this.render();
    try { this.nickname = await this.api.setRelationshipNickname(value); this.nicknameDraft = null; this.status = uiText('已保存。'); }
    catch (problem) { if (!this.disposed) this.fail(problem); }
    finally { if (!this.disposed) { this.busy = false; this.render(); } }
  }
  /** 熟悉度: what she calls the user. Asked once in chat, saved only after a plain yes; here it can be seen, changed and deleted. */
  private nicknameSection(): HTMLElement | null {
    if (!this.api.getRelationshipNickname || !this.api.setRelationshipNickname) return null;
    const section = this.node('section'); section.className = 'user-profile-nickname';
    section.append(this.node('strong', uiText('她对你的称呼')),
      this.node('p', uiText('她会在聊天里自然地问你一次，你明确说好才会记下；这里可以随时看、改、删。删除后她不会再问。')));
    if (this.nickname === undefined) { section.append(this.node('p', uiText('正在读取…'))); return section; }
    section.append(this.node('p', this.nickname ? this.nickname : uiText('还没有称呼。')));
    const input = this.node('input'); input.type = 'text'; input.maxLength = 8; input.disabled = this.busy;
    input.value = this.nicknameDraft ?? this.nickname ?? ''; input.setAttribute('aria-label', uiText('称呼（1 到 8 个字）'));
    input.oninput = () => { this.nicknameDraft = input.value; };
    const tools = this.node('div'); tools.className = 'user-profile-actions';
    tools.append(this.button(uiText('保存称呼'), () => { const text = (this.nicknameDraft ?? this.nickname ?? '').trim(); void this.saveNickname(text || null); }));
    if (this.nickname) tools.append(this.button(uiText('删除称呼'), () => void this.saveNickname(null)));
    section.append(input, tools); return section;
  }
  setMemorials(panel: TextMemorialPanel): void { if (this.disposed) { panel.dispose(); return; } this.memorials?.dispose(); this.memorials = panel; if (this.opened) panel.open(); this.render(); }
  refreshMemorials(): void { if (!this.disposed) this.render(); }
  close(): void { this.panel.hidden = true; this.trigger.setAttribute('aria-expanded', 'false'); this.confirmDelete = null; this.confirmDiary = null; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.operation++; this.scopeEpoch++;
    this.unsubscribe(); this.memorials?.dispose(); this.memorials = null; this.panel.removeEventListener('keydown', this.closeOnEscape);
    this.close(); this.panel.replaceChildren(); this.drafts.clear();
  }
  private onEvent(view: UserProfileView | null): void {
    if (this.disposed) return;
    const previous = this.gate.view?.scopeId;
    if (!this.gate.event(view)) return;
    if (!view || previous !== view.scopeId) { this.scopeEpoch++; this.operation++; this.busy = false; this.confirmDelete = null; this.confirmDiary = null; this.status = ''; }
    this.render();
  }
  private fail(problem: unknown): void {
    this.status = uiText('操作没有完成，请查看详情后重试。');
    this.error(problem instanceof Error ? problem.message : String(problem)); this.render();
  }
  private expected(view: UserProfileView) { return { scopeId: view.scopeId, generation: view.generation, revision: view.revision }; }
  private async run(action: (view: UserProfileView) => Promise<UserProfileView>, after?: (view: UserProfileView, scope: string) => void): Promise<void> {
    const current = this.gate.view;
    if (!current || this.busy || this.disposed) return;
    const id = ++this.operation, epoch = this.scopeEpoch, scope = current.scopeId;
    this.busy = true; this.status = ''; this.render();
    try {
      const result = await action(current);
      if (this.disposed || id !== this.operation || epoch !== this.scopeEpoch || this.gate.view?.scopeId !== scope) return;
      if (this.gate.response(scope, result)) { after?.(result, scope); this.status = uiText('已保存。'); }
    } catch (problem) { if (!this.disposed && id === this.operation && epoch === this.scopeEpoch) this.fail(problem); }
    finally { if (!this.disposed && id === this.operation && epoch === this.scopeEpoch) { this.busy = false; this.render(); } }
  }
  private draft(view: UserProfileView, entry: UserProfileEntry): Draft {
    const group = this.drafts.get(view.scopeId) ?? new Map<string, Draft>();
    if (!this.drafts.has(view.scopeId)) this.drafts.set(view.scopeId, group);
    let value = group.get(entry.id);
    if (!value) { value = { text: entry.text, kind: entry.kind, originalText: entry.text, originalKind: entry.kind, expected: this.expected(view) }; group.set(entry.id, value); }
    else if (value.text === value.originalText && value.kind === value.originalKind) {
      value.text = value.originalText = entry.text; value.kind = value.originalKind = entry.kind;
      value.expected = this.expected(view);
    }
    return value;
  }
  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.panel.ownerDocument.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private button(text: string, action: () => void): HTMLButtonElement {
    const button = this.node('button', text); button.type = 'button'; button.disabled = this.busy; button.onclick = action; return button;
  }
  private render(): void {
    if (this.disposed) return;
    const view = this.gate.view;
    const header = this.node('header'), title = this.node('strong', uiText('用户画像'));
    const close = this.button(uiText('关闭'), () => this.close()); close.disabled = false; header.append(title, close);
    const intro = this.node('p', uiText('查看不会开启记录。当前只从文字聊天中明确的自述记录；引用、角色扮演和含混内容会跳过。语音画像仍在开发。关闭后停止新的归纳与自动引用，已保存内容仍可管理。'));
    const content = this.node('div'); content.className = 'user-profile-content';
    const nickname = this.nicknameSection();
    if (!view) content.append(this.node('p', uiText('当前画像暂不可用。')));
    else {
      const label = this.node('label'); label.className = 'user-profile-toggle';
      const check = this.node('input'); check.type = 'checkbox'; check.checked = view.enabled; check.disabled = this.busy;
      check.onchange = () => { const enabled = check.checked; void this.run(v => this.api.setUserProfileEnabled({ ...this.expected(v), enabled })); };
      label.append(check, this.node('span', view.enabled ? uiText('允许记录：已开启') : uiText('允许记录：已关闭'))); content.append(label);
      if (!view.entries.length) content.append(this.node('p', uiText('这里还没有画像内容。')));
      for (const entry of view.entries) content.append(this.entry(view, entry));
      const ids = new Set(view.entries.map(entry => entry.id));
      for (const [id, draft] of this.drafts.get(view.scopeId) ?? []) {
        if (ids.has(id) || (draft.text === draft.originalText && draft.kind === draft.originalKind)) continue;
        const orphan = this.node('article'); orphan.className = 'user-profile-entry';
        orphan.append(this.node('strong', uiText('原条目已删除，未保存修改仍保留')));
        const copy = this.node('textarea'); copy.value = draft.text; copy.maxLength = 280; copy.rows = 2; copy.setAttribute('aria-label', uiText('未保存的画像草稿'));
        copy.oninput = () => { draft.text = copy.value; };
        orphan.append(copy, this.node('p', uiTemplate`草稿分类：${uiText(labels[draft.kind])}。此条不能直接保存，可复制后另作处理。`),
          this.button(uiText('丢弃草稿'), () => { this.drafts.get(view.scopeId)?.delete(id); this.render(); }));
        content.append(orphan);
      }
      content.append(this.diary(view));
    }
    if (nickname) content.append(nickname);
    if (this.memorials) content.append(this.memorials.render(this.panel.ownerDocument));
    const status = this.node('p', this.status); status.className = 'user-profile-status'; status.setAttribute('role', 'status');
    this.panel.replaceChildren(header, intro, content, status);
  }
  private entry(view: UserProfileView, entry: UserProfileEntry): HTMLElement {
    const card = this.node('article'); card.className = 'user-profile-entry';
    const heading = this.node('strong', uiText(labels[entry.kind])); card.append(heading);
    const draft = this.draft(view, entry);
    const changed = draft.expected.generation !== view.generation || draft.expected.revision !== view.revision;
    if (changed) {
      card.append(this.node('p', uiTemplate`画像已更新，未保存修改仍保留。当前内容：${entry.text}（${uiText(labels[entry.kind])}）。`));
      card.append(this.button(uiText('核对后使用最新版本'), () => {
        draft.originalText = entry.text; draft.originalKind = entry.kind; draft.expected = this.expected(view); this.render();
      }));
    }
    const text = this.node('textarea'); text.value = draft.text; text.maxLength = 280; text.rows = 2; text.disabled = this.busy;
    text.setAttribute('aria-label', uiText('画像内容')); text.oninput = () => { draft.text = text.value; };
    const select = this.node('select'); select.setAttribute('aria-label', uiText('画像内容分类')); select.disabled = this.busy;
    for (const kind of ['fact', 'preference', 'pending_inference'] as const) { const option = this.node('option', uiText(labels[kind])); option.value = kind; select.append(option); }
    select.value = draft.kind; select.onchange = () => { draft.kind = select.value as UserProfileKind; };
    card.append(text, select);
    if (entry.kind === 'pending_inference') card.append(this.node('p', uiText('待确认：选择事实或偏好并保存，才会明确确认。')));
    const source = this.node('details'), summary = this.node('summary', uiText('查看来源')), quote = this.node('p', entry.source.quote);
    source.append(summary, quote); card.append(source);
    const tools = this.node('div'); tools.className = 'user-profile-actions';
    tools.append(this.button(uiText('保存修改'), () => {
      const submitted = { text: draft.text, kind: draft.kind };
      const expected = { ...draft.expected };
      void this.run(() => this.api.editUserProfile({ ...expected, id: entry.id, edit: submitted }), (result, resultScope) => {
        const saved = result.entries.find(item => item.id === entry.id);
        if (saved?.text === submitted.text.trim() && saved.kind === submitted.kind && draft.text === submitted.text && draft.kind === submitted.kind)
          this.drafts.get(resultScope)?.delete(entry.id);
      });
    }));
    if (this.confirmDelete === entry.id) {
      tools.append(this.button(uiText('确认删除'), () => { void this.run(v => this.api.deleteUserProfile({ ...this.expected(v), id: entry.id }), (result, resultScope) => {
        if (!result.entries.some(item => item.id === entry.id)) { this.drafts.get(resultScope)?.delete(entry.id); this.confirmDelete = null; }
      }); }), this.button(uiText('取消'), () => { this.confirmDelete = null; this.render(); }));
    } else tools.append(this.button(uiText('删除'), () => { this.confirmDelete = entry.id; this.render(); }));
    card.append(tools); return card;
  }
  /** L3 diary: newest day first; text is shown with textContent / textarea values only. */
  private diary(view: UserProfileView): HTMLElement {
    const section = this.node('section'); section.className = 'user-profile-diary';
    section.append(this.node('strong', uiText('日记')),
      this.node('p', uiText('“允许记录”开着时，她每天用自己的口吻写一小段前一天的日记，新对话开头偶尔会自然提起一件。你改过的日子不会被自动改写，删除或清空的日子不会再写。')));
    const diary = view.diary ?? [];
    if (!diary.length) { section.append(this.node('p', uiText('还没有日记。'))); return section; }
    for (const entry of diary) section.append(this.diaryEntry(view, entry));
    const tools = this.node('div'); tools.className = 'user-profile-actions';
    if (this.confirmDiary === '*') tools.append(this.button(uiText('确认清空全部日记'), () => {
      void this.run(v => this.api.clearUserDiary(this.expected(v)), () => { this.confirmDiary = null; this.diaryDraft = null; });
    }), this.button(uiText('取消'), () => { this.confirmDiary = null; this.render(); }));
    else tools.append(this.button(uiText('清空全部日记'), () => { this.confirmDiary = '*'; this.render(); }));
    section.append(tools); return section;
  }
  private diaryEntry(view: UserProfileView, entry: UserDiaryEntry): HTMLElement {
    const card = this.node('article'); card.className = 'user-profile-entry';
    card.append(this.node('strong', entry.date + (entry.editedAt ? uiText('（已修改）') : '')));
    const tools = this.node('div'); tools.className = 'user-profile-actions';
    const draft = this.diaryDraft?.scopeId === view.scopeId && this.diaryDraft.date === entry.date ? this.diaryDraft : null;
    if (draft) {
      const text = this.node('textarea'); text.value = draft.text; text.maxLength = 500; text.rows = 4; text.disabled = this.busy;
      text.setAttribute('aria-label', uiText('日记内容')); text.oninput = () => { draft.text = text.value; };
      card.append(text);
      tools.append(this.button(uiText('保存日记修改'), () => {
        const submitted = draft.text;
        void this.run(v => this.api.editUserDiary({ ...this.expected(v), date: entry.date, text: submitted }), () => {
          if (this.diaryDraft === draft && draft.text === submitted) this.diaryDraft = null;
        });
      }), this.button(uiText('放弃修改'), () => { this.diaryDraft = null; this.render(); }));
    } else {
      card.append(this.node('p', entry.text));
      if (entry.meme) card.append(this.node('p', uiTemplate`只属于你们的小事：${entry.meme}`));
      if (this.confirmDiary === entry.date) tools.append(this.button(uiText('确认删除这天的日记'), () => {
        void this.run(v => this.api.deleteUserDiary({ ...this.expected(v), date: entry.date }), () => { this.confirmDiary = null; });
      }), this.button(uiText('取消'), () => { this.confirmDiary = null; this.render(); }));
      else tools.append(this.button(uiText('修改日记'), () => { this.diaryDraft = { scopeId: view.scopeId, date: entry.date, text: entry.text }; this.render(); }),
        this.button(uiText('删除这天的日记'), () => { this.confirmDiary = entry.date; this.render(); }));
    }
    card.append(tools); return card;
  }
}
