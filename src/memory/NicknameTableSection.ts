/**
 * Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md): the nickname table in 用户画像, beside what she calls you. Shows her real
 * name, every name you call her (added from the chat only when you really said it, or by hand here) and lets you add and remove them.
 * Removing goes into the recycle bin first (the panel's 「最近删除的」 brings it back). In Unbound these are the names that start a call.
 */
import { uiText } from '../foundation/ui-language';
import type { MemoryDesktopAPI } from '../../shared/memory/desktop-api';
import type { NicknameTableView } from '../../shared/memory/nickname-table';

export type NicknameTableApi = Pick<MemoryDesktopAPI, 'getNicknameTable' | 'addHerNickname' | 'removeHerNickname'>;

export class NicknameTableSection {
  readonly element: HTMLElement;
  private view: NicknameTableView | null = null;
  private draft = '';
  private busy = false;
  private disposed = false;
  constructor(private readonly doc: Document, private readonly api: NicknameTableApi, private readonly error: (message: string) => void) {
    this.element = doc.createElement('section');
    this.element.className = 'user-profile-nickname nickname-table';
    this.render();
  }

  async read(): Promise<void> {
    try { const view = await this.api.getNicknameTable(); if (!this.disposed) { this.view = view; this.render(); } }
    catch (problem) { if (!this.disposed) this.error(problem instanceof Error ? problem.message : String(problem)); }
  }
  dispose(): void { this.disposed = true; }

  private async change(run: () => Promise<string[]>, clear = false): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.render();
    try { const list = await run(); if (!this.disposed && this.view) { this.view = { ...this.view, herNicknames: list }; if (clear) this.draft = ''; } }
    catch (problem) { if (!this.disposed) this.error(problem instanceof Error ? problem.message : String(problem)); }
    finally { if (!this.disposed) { this.busy = false; this.render(); } }
  }

  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  }
  private button(text: string, action: () => void): HTMLButtonElement {
    const button = this.node('button', text); button.type = 'button'; button.disabled = this.busy; button.onclick = action; return button;
  }

  private render(): void {
    const section = this.element;
    section.replaceChildren(this.node('strong', uiText('你对她的称呼')),
      this.node('p', uiText('你在聊天里给她起的名字会自动记在这里（只记你真说过的）；也可以自己加、删。她出来（Unbound）时，叫她的本名或这些名字就能开始通话。')));
    const view = this.view;
    if (!view) { section.append(this.node('p', uiText('正在读取…'))); return; }
    if (view.herName) section.append(this.node('p', `${uiText('她的本名：')}${view.herName}`));
    const list = this.node('ul'); list.className = 'nickname-table-list';
    if (!view.herNicknames.length) list.append(this.node('li', uiText('还没有。')));
    for (const name of view.herNicknames) {
      const item = this.node('li'); item.append(this.node('span', name), this.button(uiText('删除'), () => void this.change(() => this.api.removeHerNickname(name))));
      list.append(item);
    }
    const input = this.node('input'); input.type = 'text'; input.maxLength = 8; input.disabled = this.busy; input.value = this.draft;
    input.setAttribute('aria-label', uiText('加一个称呼（1 到 8 个字）'));
    input.oninput = () => { this.draft = input.value; };
    const tools = this.node('div'); tools.className = 'user-profile-actions';
    tools.append(this.button(uiText('加上'), () => { const text = this.draft.trim(); if (text) void this.change(() => this.api.addHerNickname(text), true); }));
    section.append(list, input, tools);
  }
}
