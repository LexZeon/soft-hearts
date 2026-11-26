/**
 * I-195 (docs/claude/2026-11-22-i195-her-alarms.md): 「让她自己留心（闹钟）」 in。
 * The switch (off by default; the user's own click only) and, below it, the small list of what she has left herself with a cancel button each (her own
 * words are shown here, on the user's own page: never in the chat, the journal or the repository). Off: she writes no marker, nothing is read, nothing
 * fires; what is already kept stays, dormant, and can still be cancelled here.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { uiText } from '../foundation/ui-language';

/** The one call's shape (the same as shared/behaviors/alarms/interface.ts HerAlarmsRequest / HerAlarmsView; kept here so this page does not reach into 主动's internals). */
export type HerAlarmsRequest = { readonly action: 'view' } | { readonly action: 'switch'; readonly on: boolean } | { readonly action: 'cancel'; readonly id: string };
export interface HerAlarmsView { readonly on: boolean; readonly items: readonly { readonly id: string; readonly when: string; readonly note: string }[] }

registerUiMessages({
  en: {
    '让她自己留心（闹钟）': 'Let her keep things in mind (alarms)',
    '打开后，她可以在回复里悄悄给自己留个心：到某个时间（或某一天），或某件事发生时（你回来了、今天第一次见、说要去睡……），或你说到某个词时，应用把这个备注告诉她，她自己决定说不说、怎么说。每次聊天的提示词会多一小段（多用一点 Claude 用量，首字可能慢一点点）。聊天里只会出现一行灰色小字，不显示她写了什么。默认关。':
      'When on, she can quietly leave herself a note in a reply: for a time (or a day), for something that happens (you are back, the first meeting of the day, you say you are going to sleep...), or for when you mention a word. The app hands her the note then, and she decides whether and how to say anything. Each chat prompt gets a short extra paragraph (a little more Claude usage; the first character may come a touch later). The chat shows only one small grey line, not what she wrote. Off by default.',
    '她现在留着的心：': 'What she is keeping in mind now:',
    '现在没有。': 'None right now.',
    '取消': 'Cancel',
    '全部取消': 'Cancel all',
    '（她记了件事）': '(she made a note for herself)',
    '开关关着：这些先放着，不会触发；你可以在这里取消。': 'The switch is off: these wait and do not fire; you can cancel them here.',
  },
  'zh-CN': {},
});

const TITLE = '让她自己留心（闹钟）';
const HINT = '打开后，她可以在回复里悄悄给自己留个心：到某个时间（或某一天），或某件事发生时（你回来了、今天第一次见、说要去睡……），或你说到某个词时，应用把这个备注告诉她，她自己决定说不说、怎么说。每次聊天的提示词会多一小段（多用一点 Claude 用量，首字可能慢一点点）。聊天里只会出现一行灰色小字，不显示她写了什么。默认关。';

export type HerAlarmsApi = (request: HerAlarmsRequest) => Promise<HerAlarmsView>;

export class HerAlarmsSection {
  readonly element: HTMLElement;
  private view: HerAlarmsView | null = null;
  private busy = false;
  private disposed = false;

  constructor(private readonly doc: Document, private readonly api: HerAlarmsApi, private readonly error: (message: string) => void) {
    this.element = doc.createElement('section');
    this.element.className = 'user-profile-nickname her-alarms';
    this.render();
  }

  /** Read the switch and the list (when the panel opens). */
  async read(): Promise<void> { await this.send({ action: 'view' }); }
  dispose(): void { this.disposed = true; }

  private async send(request: HerAlarmsRequest): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.render();
    try { const view = await this.api(request); if (!this.disposed) this.view = view; }
    catch (problem) { if (!this.disposed) this.error(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (!this.disposed) { this.busy = false; this.render(); } }
  }

  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }

  private render(): void {
    const section = this.element, view = this.view;
    const label = this.node('label'); label.className = 'user-profile-toggle';
    const check = this.node('input'); check.type = 'checkbox'; check.setAttribute('role', 'switch'); check.checked = view?.on === true; check.disabled = !view || this.busy;
    check.onchange = () => { void this.send({ action: 'switch', on: check.checked }); };
    label.append(check, this.node('span', uiText(TITLE)));
    section.replaceChildren(label, this.node('p', uiText(HINT)));
    if (!view) return;
    section.append(this.node('p', uiText('她现在留着的心：')));
    if (!view.items.length) section.append(this.node('p', uiText('现在没有。')));
    else {
      const list = this.node('ul'); list.className = 'nickname-table-list';
      for (const item of view.items) {
        const row = this.node('li'), cancel = this.node('button', uiText('取消')); cancel.type = 'button'; cancel.disabled = this.busy;
        cancel.onclick = () => { void this.send({ action: 'cancel', id: item.id }); };
        row.append(this.node('span', item.when ? `${item.when}：${item.note}` : item.note), cancel);
        list.append(row);
      }
      section.append(list);
      if (view.items.length > 1) {
        const all = this.node('button', uiText('全部取消')); all.type = 'button'; all.disabled = this.busy;
        all.onclick = () => { void this.send({ action: 'cancel', id: 'all' }); };
        section.append(all);
      }
      if (!view.on) section.append(this.node('p', uiText('开关关着：这些先放着，不会触发；你可以在这里取消。')));
    }
  }
}
