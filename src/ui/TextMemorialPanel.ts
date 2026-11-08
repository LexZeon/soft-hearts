import { uiText, uiTemplate } from './ui-language';
import type { TextMemorialView, TextMemorialEdit, TextMemorialDelete } from '../../shared/text-memorials';

export interface TextMemorialManagementApi {
  getTextMemorials(): Promise<TextMemorialView | null>;
  editTextMemorial(request: TextMemorialEdit): Promise<TextMemorialView>;
  deleteTextMemorial(request: TextMemorialDelete): Promise<TextMemorialView>;
  onTextMemorialsChanged(callback: (view: TextMemorialView | null) => void): () => void;
}
type Draft = { text: string; purpose: string; originalText: string; originalPurpose: string; generation: number; revision: number };

/** Independent saved-text section; opening it never grants recording or consent. */
export class TextMemorialPanel {
  private view: TextMemorialView | null = null;
  private floor = -1;
  private barrier = false;
  private sequence = 0;
  private epoch = 0;
  private operation = 0;
  private busy = false;
  private disposed = false;
  private started = false;
  private error = '';
  private confirm: string | null = null;
  private drafts = new Map<string, Map<string, Draft>>();
  private unsubscribe: () => void;

  constructor(private readonly api: TextMemorialManagementApi, private readonly changed: () => void) {
    this.unsubscribe = api.onTextMemorialsChanged(view => { this.sequence++; this.accept(view); });
  }
  open(): void { if (!this.started) { this.started = true; this.refresh(); } }
  refresh(): void {
    if (this.disposed) return;
    const sequence = this.sequence, epoch = this.epoch;
    this.error = ''; this.changed();
    void this.api.getTextMemorials().then(view => {
      if (!this.disposed && sequence === this.sequence && epoch === this.epoch) this.accept(view);
    }).catch(() => {
      if (!this.disposed && sequence === this.sequence && epoch === this.epoch) { this.error = uiText('读取没有完成，请重试。'); this.changed(); }
    });
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.epoch++; this.operation++; this.unsubscribe(); this.view = null; this.drafts.clear(); }
  private accept(next: TextMemorialView | null): void {
    if (this.disposed) return;
    if (!next) {
      this.floor = Math.max(this.floor, this.view?.generation ?? -1); this.barrier = true;
      this.view = null; this.epoch++; this.operation++; this.busy = false; this.confirm = null; this.changed(); return;
    }
    if (!Number.isSafeInteger(next.generation) || !Number.isSafeInteger(next.revision) || next.generation < this.floor || (this.barrier && next.generation <= this.floor)) return;
    const old = this.view;
    if (old && (next.generation < old.generation || (next.generation === old.generation && (next.scopeId !== old.scopeId || next.revision < old.revision)))) return;
    if (old && old.scopeId !== next.scopeId) { this.epoch++; this.operation++; this.busy = false; this.confirm = null; }
    this.floor = Math.max(this.floor, next.generation); this.barrier = false; this.view = next; this.error = ''; this.changed();
  }
  private async run(action: (view: TextMemorialView) => Promise<TextMemorialView>, success: (view: TextMemorialView) => void): Promise<void> {
    const view = this.view; if (!view || this.busy || this.disposed) return;
    const op = ++this.operation, epoch = this.epoch, scope = view.scopeId;
    this.busy = true; this.error = ''; this.changed();
    try {
      const result = await action(view);
      if (this.disposed || op !== this.operation || epoch !== this.epoch || this.view?.scopeId !== scope || result.scopeId !== scope) return;
      const current = this.view;
      if (result.generation < current.generation || (result.generation === current.generation && result.revision < current.revision)) return;
      success(result); this.accept(result);
    } catch {
      if (!this.disposed && op === this.operation && epoch === this.epoch) this.error = uiText('操作没有完成，内容可能已变化；请重新读取后核对。');
    } finally { if (!this.disposed && op === this.operation && epoch === this.epoch) { this.busy = false; this.changed(); } }
  }
  render(doc: Document): HTMLElement {
    const root = doc.createElement('section'); root.className = 'text-memorial-section';
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
    const button = (text: string, fn: () => void) => { const el = node('button', text); el.type = 'button'; el.disabled = this.busy; el.onclick = fn; return el; };
    root.append(node('strong', uiText('文字纪念')), node('p', uiText('这里只管理你同意留存的文字；查看不会开启画像记录。')));
    if (!this.view) root.append(node('p', uiText('当前纪念内容暂不可用。')));
    else {
      const view = this.view, group = this.drafts.get(view.scopeId) ?? new Map<string, Draft>(); this.drafts.set(view.scopeId, group);
      if (!view.entries.length) root.append(node('p', uiText('还没有保存的文字纪念。')));
      for (const entry of view.entries) {
        let draft = group.get(entry.id);
        if (!draft) { draft = { text: entry.text, purpose: entry.purpose, originalText: entry.text, originalPurpose: entry.purpose, generation: view.generation, revision: view.revision }; group.set(entry.id, draft); }
        else if (draft.text === draft.originalText && draft.purpose === draft.originalPurpose) { draft.text = draft.originalText = entry.text; draft.purpose = draft.originalPurpose = entry.purpose; draft.generation = view.generation; draft.revision = view.revision; }
        const d = draft, card = node('article'); card.className = 'user-profile-entry';
        const conflict = d.generation !== view.generation || d.revision !== view.revision;
        if (conflict) { card.append(node('p', uiText('内容已更新，未保存修改仍保留。请核对当前内容后再保存。')), node('p', uiTemplate`当前文字：${entry.text}`), node('p', uiTemplate`当前用途：${entry.purpose}`), button(uiText('核对后使用最新版本'), () => { d.originalText = entry.text; d.originalPurpose = entry.purpose; d.generation = view.generation; d.revision = view.revision; this.changed(); })); }
        const text = node('textarea'); text.value = d.text; text.maxLength = 240; text.setAttribute('aria-label', uiText('纪念文字')); text.oninput = () => { d.text = text.value; };
        const purpose = node('textarea'); purpose.value = d.purpose; purpose.maxLength = 80; purpose.setAttribute('aria-label', uiText('纪念用途')); purpose.oninput = () => { d.purpose = purpose.value; };
        card.append(text, purpose);
        const actions = node('div'); actions.className = 'user-profile-actions';
        actions.append(button(uiText('保存纪念修改'), () => {
          const submitted = { text: d.text, purpose: d.purpose }, expected = { scopeId: view.scopeId, generation: d.generation, revision: d.revision, id: entry.id };
          void this.run(() => this.api.editTextMemorial({ ...expected, ...submitted }), result => { const saved = result.entries.find(e => e.id === entry.id); if (saved?.text === submitted.text && saved.purpose === submitted.purpose && d.text === submitted.text && d.purpose === submitted.purpose) group.delete(entry.id); });
        }));
        if (this.confirm === entry.id) actions.append(button(uiText('确认删除纪念'), () => { const expected = { scopeId: view.scopeId, generation: view.generation, revision: view.revision, id: entry.id }; void this.run(() => this.api.deleteTextMemorial(expected), result => { if (!result.entries.some(e => e.id === entry.id)) { group.delete(entry.id); this.confirm = null; } }); }), button(uiText('取消删除'), () => { this.confirm = null; this.changed(); }));
        else actions.append(button(uiText('删除纪念'), () => { this.confirm = entry.id; this.changed(); }));
        card.append(actions); root.append(card);
      }
      for (const [id, d] of group) if (!view.entries.some(e => e.id === id) && (d.text !== d.originalText || d.purpose !== d.originalPurpose)) {
        const orphan = node('article'); orphan.className = 'user-profile-entry'; orphan.append(node('p', uiText('原纪念已删除，未保存修改仍保留，可复制或丢弃。')));
        const text = node('textarea'); text.value = d.text; text.setAttribute('aria-label', uiText('未保存纪念草稿')); text.oninput = () => { d.text = text.value; };
        const purpose = node('textarea'); purpose.value = d.purpose; purpose.setAttribute('aria-label', uiText('未保存纪念用途')); purpose.oninput = () => { d.purpose = purpose.value; };
        orphan.append(text, purpose, button(uiText('丢弃纪念草稿'), () => { group.delete(id); this.changed(); })); root.append(orphan);
      }
    }
    if (this.error) root.append(node('p', this.error)); root.append(button(uiText('重新读取纪念'), () => this.refresh()));
    return root;
  }
}
