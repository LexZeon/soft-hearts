/**
 * I-207 (docs/claude/2026-11-23-card-milestone.md): a card's milestone in 用户画像 (Gene: 这一单：还没签收 / 已签收（11月23日）). Shown only when the card declares one.
 * Read only until the user clears it: the first click on 「清除」 asks, the second does it (it goes into 「最近删除的」 first, so it can come back). She is
 * the one who marks it reached, in her own reply; nothing here marks it.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { uiText, uiTemplate } from '../foundation/ui-language';

/** The two calls' shapes (the same as shared/cards/card-milestone.ts; kept here so this page does not reach into the cards part's internals). */
export type CardMilestoneRequest = { readonly action: 'milestone-clear' };
export interface CardMilestoneView { readonly name: string; readonly notYet: string; readonly reached: string; readonly done: boolean; readonly date: string | null }
/** The one write (the herAlarms channel; the page confirms first) ... */
export type CardMilestoneClear = (request: CardMilestoneRequest) => Promise<{ milestone?: CardMilestoneView | null }>;
/** ... and the read, which is the archive's own read-only call (I-208: `getCharacterArchive` for the current character). */
export interface CardMilestoneApi { read(): Promise<CardMilestoneView | null>; clear: CardMilestoneClear }

registerUiMessages({
  en: {
    '她的里程碑': 'Her milestone',
    '这是角色卡里声明的一件事。她觉得发生了，会在自己的回复里悄悄记下（不显示），应用只记下是哪一天。你可以清掉它，清掉的会先进「最近删除的」。':
      'A thing her card declares. When she feels it has happened she quietly marks it in her own reply (never shown); the app only keeps the day. You can clear it; a cleared one goes into “recently deleted” first.',
    '清除': 'Clear',
    '确定清除？': 'Clear it?',
    '确定': 'Yes, clear',
  }, // 「取消」 is registered by HerAlarmsSection (the same page)
  'zh-CN': {},
});

export class CardMilestoneSection {
  readonly element: HTMLElement;
  private view: CardMilestoneView | null = null;
  private asking = false;
  private busy = false;
  private disposed = false;

  constructor(private readonly doc: Document, private readonly api: CardMilestoneApi, private readonly error: (message: string) => void) {
    this.element = doc.createElement('section');
    this.element.className = 'user-profile-nickname card-milestone';
    this.element.hidden = true;
  }

  /** Read it (when the panel opens). */
  async read(): Promise<void> { await this.send(null); }
  dispose(): void { this.disposed = true; }

  private async send(request: CardMilestoneRequest | null): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.asking = false; this.render();
    try { const view = request ? (await this.api.clear(request)).milestone ?? null : await this.api.read(); if (!this.disposed) this.view = view; }
    catch (problem) { if (!this.disposed) this.error(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (!this.disposed) { this.busy = false; this.render(); } }
  }

  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private button(text: string, action: () => void): HTMLButtonElement {
    const button = this.node('button', text); button.type = 'button'; button.disabled = this.busy; button.onclick = action; return button;
  }

  /** The card's own words, in the card's own language: "这一单：已签收（11月23日）" is the card's line, so the date reads in the page's language. */
  private state(view: CardMilestoneView): string {
    if (!view.done) return `${view.name}：${view.notYet}`;
    const match = view.date ? /^\d{4}-(\d{2})-(\d{2})$/u.exec(view.date) : null;
    const when = match ? uiTemplate`${Number(match[1])}月${Number(match[2])}日` : '';
    return `${view.name}：${view.reached}${when ? `（${when}）` : ''}`;
  }

  private render(): void {
    const view = this.view;
    this.element.hidden = !view;
    if (!view) { this.element.replaceChildren(); return; }
    const row = this.node('p', this.state(view));
    this.element.replaceChildren(this.node('strong', uiText('她的里程碑')), this.node('p', uiText('这是角色卡里声明的一件事。她觉得发生了，会在自己的回复里悄悄记下（不显示），应用只记下是哪一天。你可以清掉它，清掉的会先进「最近删除的」。')), row);
    if (!view.done) return;
    if (!this.asking) { row.append(' ', this.button(uiText('清除'), () => { this.asking = true; this.render(); })); return; }
    row.append(' ', this.node('span', uiText('确定清除？')), ' ', this.button(uiText('确定'), () => { void this.send({ action: 'milestone-clear' }); }),
      ' ', this.button(uiText('取消'), () => { this.asking = false; this.render(); }));
  }
}
