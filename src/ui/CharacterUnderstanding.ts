/**
 * I-018 理解讨论 on the 角色 page (docs/claude/2026-11-03-character-understanding.md): after a card is imported, created or
 * updated in place, Claude opens a short discussion about her; the user answers like a chat, or skips. The host keeps the
 * discussion (electron/character-understanding.ts); this panel only renders its view and sends the user's actions.
 * Everything Claude wrote is set with textContent; nothing here is saved without the user's "存进她的卡".
 */
import { uiText, uiTemplate } from './ui-language';
import { MAX_UNDERSTANDING_NOTES } from '../../shared/character-cards';
import { CARD_FIELD_LABELS } from '../../shared/character-card-update';
import {
  MAX_UNDERSTANDING_REPLY,
  type MoodPlanView, type UnderstandingFinalView, type UnderstandingMessage, type UnderstandingTrigger, type UnderstandingTurnView, type UnderstandingView,
} from '../../shared/character-understanding';
import type { CharacterCardState } from '../../shared/character-cards';
import type { DesktopAPI } from '../../shared/contracts';

export type CharacterUnderstandingApi = Pick<DesktopAPI, 'getCharacterUnderstanding' | 'startCharacterUnderstanding' | 'replyCharacterUnderstanding'
  | 'finishCharacterUnderstanding' | 'retryCharacterUnderstanding' | 'closeCharacterUnderstanding' | 'saveCharacterUnderstanding' | 'onCharacterUnderstanding'>
  & Partial<Pick<DesktopAPI, 'requestCharacterRealerEmotions'>>;

export interface CharacterUnderstandingOptions {
  api: CharacterUnderstandingApi;
  onError(message: string): void;
  /** The card state a save returned (the app applies it everywhere). */
  onState?(state: CharacterCardState): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const TRIGGER_LINES: Record<UnderstandingTrigger, string> = {
  imported: '刚导入了她。开始陪你之前，Claude 想先和你确认一下它怎么理解她。',
  created: '刚新建了她。开始陪你之前，Claude 想先和你确认一下它怎么理解她。',
  updated: '刚更新了她的人设。Claude 只看变动的部分，和你确认一下。',
  manual: 'Claude 会先说说它怎么理解她，你像聊天一样回答就好。',
};

export class CharacterUnderstandingPanel {
  private view: UnderstandingView | null = null;
  private disposed = false;
  private busy = false;
  private unsubscribe: (() => void) | null = null;
  private readonly root: HTMLElement;
  private readonly title = element('strong', 'understanding-title');
  private readonly lead = element('p', 'understanding-lead');
  private readonly messages = element('div', 'understanding-messages');
  private readonly status = element('output', 'understanding-status');
  private readonly compose = element('div', 'understanding-compose');
  private readonly input = element('textarea', 'understanding-input');
  private readonly send = element('button', 'primary', uiText('发送'));
  private readonly done = element('button', 'subtle', uiText('就这样'));
  private readonly retry = element('button', 'subtle', uiText('再试一次'));
  private readonly finalBox = element('div', 'understanding-final');
  private readonly close = element('button', 'subtle', uiText('跳过'));
  /** The wrap-up as drawn (its edits survive repaints of the same view). */
  private finalKey = '';
  private finalControls: { notes: HTMLTextAreaElement; save: HTMLButtonElement; applyMood: HTMLInputElement | null; extended: Map<string, HTMLInputElement>; warm: HTMLInputElement | null } | null = null;
  private messageCount = -1;
  private messageSession = '';
  private readonly closed = new Set<string>();

  constructor(private readonly container: HTMLElement, private readonly options: CharacterUnderstandingOptions) {
    this.root = element('section', 'settings-section character-understanding');
    this.root.setAttribute('aria-label', uiText('和 Claude 聊聊这个角色'));
    this.root.hidden = true;
    const header = element('div', 'understanding-header');
    this.close.type = 'button'; this.close.dataset.understandingAction = 'close'; this.close.onclick = () => void this.closeDiscussion();
    header.append(this.title, this.close);
    const privacy = element('p', 'hint understanding-privacy', uiText('只把这张卡和这段讨论交给你的 Claude，不带你们的聊天、日记和画像；讨论内容不会进她的聊天记忆。可以跳过，不挡着开始聊天。'));
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.input.rows = 3; this.input.maxLength = MAX_UNDERSTANDING_REPLY;
    this.input.placeholder = uiText('回答它，或者补充你想让它知道的');
    this.input.setAttribute('aria-label', uiText('回答 Claude'));
    for (const [button, action, run] of [[this.send, 'send', () => this.sendReply()], [this.done, 'finish', () => this.finish()], [this.retry, 'retry', () => this.retryStep()]] as const) {
      button.type = 'button'; button.dataset.understandingAction = action; button.onclick = () => void run();
    }
    const buttons = element('div', 'understanding-buttons');
    buttons.append(this.send, this.done, this.retry);
    this.compose.append(this.input, buttons);
    this.root.append(header, this.lead, privacy, this.messages, this.status, this.compose, this.finalBox);
    this.container.append(this.root);
  }

  async init(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe = this.options.api.onCharacterUnderstanding(view => this.setView(view));
    try { this.setView(await this.options.api.getCharacterUnderstanding()); } catch { /* No discussion to restore. */ }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.root.remove?.();
  }

  /** The discussion that is open now (tests read it). */
  get current(): UnderstandingView | null { return this.view ? structuredClone(this.view) : null; }

  /** Opens a discussion about this card; Claude speaks first. */
  async start(id: string, trigger: UnderstandingTrigger, changedFields: readonly string[] = []): Promise<void> {
    if (this.disposed) return;
    await this.run(async () => {
      this.setView(await this.options.api.startCharacterUnderstanding(id, trigger, [...changedFields]));
      this.root.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    });
  }

  setView(view: UnderstandingView | null): void {
    if (this.disposed) return;
    // A late copy never wins: not over a newer view of the same discussion, and not for a discussion closed here.
    if (view && (this.closed.has(view.sessionId) || (this.view?.sessionId === view.sessionId && view.version < this.view.version))) return;
    this.view = view;
    this.paint();
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.paintButtons();
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.textContent = message;
      this.options.onError(message);
    } finally { this.busy = false; if (!this.disposed) this.paintButtons(); }
  }

  private async sendReply(): Promise<void> {
    const view = this.view, text = this.input.value.trim();
    if (!view || !text) return;
    await this.run(async () => {
      const next = await this.options.api.replyCharacterUnderstanding(view.sessionId, text);
      this.input.value = '';
      this.setView(next);
    });
  }
  private async finish(): Promise<void> {
    const view = this.view; if (!view) return;
    await this.run(async () => { this.setView(await this.options.api.finishCharacterUnderstanding(view.sessionId)); });
  }
  private async retryStep(): Promise<void> {
    const view = this.view; if (!view) return;
    await this.run(async () => { this.setView(await this.options.api.retryCharacterUnderstanding(view.sessionId)); });
  }
  private async closeDiscussion(): Promise<void> {
    const view = this.view; if (!view) return;
    this.closed.add(view.sessionId);
    this.view = null; this.paint();
    try { await this.options.api.closeCharacterUnderstanding(view.sessionId); } catch { /* Already over. */ }
  }
  private async save(): Promise<void> {
    const view = this.view, controls = this.finalControls;
    if (!view?.final || !controls) return;
    const choices = {
      notes: controls.notes.value,
      applyMood: controls.applyMood ? controls.applyMood.checked : false,
      extended: [...controls.extended].filter(([, box]) => box.checked).map(([path]) => path),
      slowWarmUp: controls.warm && controls.warm.checked ? view.final.slowWarmUp.value : null,
    };
    await this.run(async () => {
      const state = await this.options.api.saveCharacterUnderstanding(view.sessionId, choices);
      this.options.onState?.(state);
    });
  }
  private async realer(): Promise<void> {
    const view = this.view, request = this.options.api.requestCharacterRealerEmotions;
    if (!view || !request) return;
    await this.run(async () => {
      // The host's own dialog explains it first; only its "打开" turns it on (F6). This panel never turns it on.
      const state = await request(view.cardId, true);
      this.options.onState?.(state);
    });
  }

  private paint(): void {
    const view = this.view;
    this.root.hidden = !view;
    if (!view) { this.messages.replaceChildren(); this.finalBox.replaceChildren(); this.finalKey = ''; this.finalControls = null; this.messageCount = -1; return; }
    this.title.textContent = uiTemplate`和 Claude 聊聊「${view.cardName}」`;
    this.lead.textContent = uiText(TRIGGER_LINES[view.trigger]);
    if (view.sessionId !== this.messageSession || view.messages.length !== this.messageCount) {
      this.messageSession = view.sessionId; this.messageCount = view.messages.length;
      this.messages.replaceChildren(...view.messages.map(message => this.message(message)));
    }
    const thinking = view.phase === 'thinking' ? uiText('Claude 正在想……') : view.phase === 'finishing' ? uiText('Claude 正在整理理解说明……')
      : view.phase === 'saving' ? uiText('正在存进她的卡……') : '';
    this.status.textContent = view.error ?? thinking;
    this.status.className = `understanding-status${view.error ? ' error' : ''}`;
    this.compose.hidden = !['thinking', 'waiting', 'failed'].includes(view.phase);
    this.close.textContent = view.phase === 'saved' ? uiText('关闭') : uiText('跳过');
    this.paintFinal(view);
    this.paintButtons();
  }

  private paintButtons(): void {
    const view = this.view;
    const waiting = view?.phase === 'waiting';
    const left = view ? view.maxRounds - view.rounds : 0;
    this.input.disabled = this.busy || !waiting || left <= 0;
    this.send.disabled = this.busy || !waiting || left <= 0;
    this.send.textContent = left === 1 ? uiText('发送（最后一次，发完就整理）') : uiText('发送');
    this.done.disabled = this.busy || !view || !(waiting || view.phase === 'failed') || !view.messages.some(message => message.from === 'claude');
    this.done.textContent = view?.retry === 'final' ? uiText('再整理一次') : uiText('就这样');
    this.retry.hidden = !view?.retry || view.retry === 'final';
    this.retry.disabled = this.busy;
    if (this.finalControls) for (const node of [this.finalControls.notes, this.finalControls.save]) node.disabled = this.busy || view?.phase !== 'final';
    this.close.disabled = this.busy && view?.phase === 'saving';
  }

  private message(message: UnderstandingMessage): HTMLElement {
    if (message.from === 'user') {
      const node = element('div', 'understanding-message from-user');
      node.append(element('span', 'understanding-who', uiText('你')), element('p', '', message.text));
      return node;
    }
    const node = element('div', 'understanding-message from-claude');
    node.append(element('span', 'understanding-who', 'Claude'));
    if (!message.turn) {
      node.append(element('p', 'understanding-raw-note', uiText('（这次没能按格式读懂，原文如下；什么都没存。）')), element('pre', 'understanding-raw', message.raw ?? ''));
      return node;
    }
    this.turn(node, message.turn);
    return node;
  }

  private heading(parent: HTMLElement, text: string): void { parent.append(element('h4', 'understanding-heading', text)); }

  private turn(node: HTMLElement, turn: UnderstandingTurnView): void {
    if (turn.reply) node.append(element('p', 'understanding-reply', turn.reply));
    if (turn.who) { this.heading(node, uiText('她是谁')); node.append(element('p', '', turn.who)); }
    if (turn.terms.length) {
      this.heading(node, turn.step === 'open' ? uiText('卡里的词') : uiText('更新后的理解'));
      const list = element('ul', 'understanding-terms');
      for (const term of turn.terms) {
        const item = element('li');
        item.append(element('strong', '', term.term), element('span', '', uiTemplate`：${term.meaning}`));
        if (term.misread) item.append(element('span', 'understanding-misread', uiTemplate` 容易误会：${term.misread}`));
        list.append(item);
      }
      node.append(list);
    }
    if (turn.voice.length) {
      this.heading(node, uiText('她说话大概这样'));
      const list = element('ul', 'understanding-voice');
      for (const line of turn.voice) list.append(element('li', '', `“${line}”`));
      node.append(list);
    }
    if (turn.mood) this.moodPlan(node, turn.mood, turn.moodSummary);
    if (turn.slowWarmUp) node.append(element('p', 'understanding-toggle', turn.slowWarmUp.value
      ? uiTemplate`建议打开「关系慢慢升温」。${turn.slowWarmUp.reason}` : uiTemplate`建议关掉「关系慢慢升温」。${turn.slowWarmUp.reason}`));
    if (turn.realerEmotions?.value) node.append(element('p', 'understanding-toggle', uiTemplate`建议「更真实的情绪」：打开。${turn.realerEmotions.reason}（要打开的话，最后会先弹出说明，由你决定。）`));
    this.cardEdits(node, turn.cardEdits);
    if (turn.questions.length) {
      this.heading(node, uiText('我想问你'));
      const list = element('ol', 'understanding-questions');
      for (const question of turn.questions) list.append(element('li', '', question));
      node.append(list);
    }
    if (turn.closing) node.append(element('p', 'understanding-closing', turn.closing));
  }

  private moodPlan(parent: HTMLElement, plan: MoodPlanView, summary: string): void {
    if (!plan.items.length && !plan.dropped && !plan.invalid && !summary) return;
    this.heading(parent, uiText('心情参数方案（没提到的保持现在的值）'));
    if (summary) parent.append(element('p', '', summary));
    if (plan.items.length) {
      const list = element('ul', 'understanding-mood');
      for (const item of plan.items) {
        const row = element('li', item.extended ? 'extended' : '');
        row.append(element('strong', '', item.label), element('span', '', uiTemplate`：${item.current} → ${item.proposed}（Gene ${item.gene}）`));
        if (item.extended) row.append(element('span', 'understanding-extended', uiTemplate` 超出常规范围（常规 ${item.typical}），要你同意才用`));
        if (item.effect) row.append(element('p', 'understanding-effect', uiTemplate`你会看到：${item.effect}`));
        if (item.reason) row.append(element('p', 'understanding-reason', uiTemplate`为什么：${item.reason}`));
        list.append(row);
      }
      parent.append(list);
    } else if (!plan.invalid && !plan.dropped) parent.append(element('p', 'hint', uiText('数值保持现在的，不用改。')));
    if (plan.invalid) parent.append(element('p', 'understanding-warning', uiText('这套数值合在一起不成立（比如门槛的先后顺序），没有采用。')));
    else if (plan.dropped) parent.append(element('p', 'understanding-warning', uiTemplate`另有 ${plan.dropped} 项不是应用支持的数值或超出了允许的范围，没有采用。`));
  }

  private cardEdits(parent: HTMLElement, edits: UnderstandingTurnView['cardEdits']): void {
    if (!edits.length) return;
    this.heading(parent, uiText('卡里这几句可能容易被误会（只是建议，改不改由你，在「编辑人设」里改）'));
    const list = element('ul', 'understanding-edits');
    for (const edit of edits) {
      const item = element('li');
      const where = edit.field ? uiTemplate`${uiText(CARD_FIELD_LABELS[edit.field])}：` : '';
      item.append(element('span', '', `${where}「${edit.quote}」 → 「${edit.suggestion}」`));
      if (edit.reason) item.append(element('p', 'understanding-reason', edit.reason));
      list.append(item);
    }
    parent.append(list);
  }

  private paintFinal(view: UnderstandingView): void {
    if (view.phase === 'saved') {
      if (this.finalKey === `${view.sessionId}:saved`) return;
      this.finalKey = `${view.sessionId}:saved`; this.finalControls = null;
      const parts: HTMLElement[] = [element('p', 'understanding-saved', uiTemplate`已存进「${view.cardName}」的卡；她的聊天、日记、画像和熟悉度都没动。以后每次聊天她都带着这份理解。`)];
      if (view.final?.realerEmotions.suggested && this.options.api.requestCharacterRealerEmotions) {
        const line = element('div', 'understanding-realer');
        line.append(element('p', '', uiText('你想给她打开「更真实的情绪」。它要你先看过说明，由你自己决定；这里不会替你打开。')));
        const open = element('button', 'subtle', uiText('看说明并决定…'));
        open.type = 'button'; open.dataset.understandingAction = 'realer'; open.onclick = () => void this.realer();
        line.append(open);
        parts.push(line);
      }
      this.finalBox.replaceChildren(...parts);
      return;
    }
    if (!view.final || !['final', 'saving'].includes(view.phase)) { if (this.finalKey) { this.finalBox.replaceChildren(); this.finalKey = ''; this.finalControls = null; } return; }
    const key = `${view.sessionId}:${JSON.stringify(view.final)}`;
    if (key === this.finalKey) return;
    this.finalKey = key;
    this.finalBox.replaceChildren(...this.finalSection(view, view.final));
  }

  private finalSection(view: UnderstandingView, final: UnderstandingFinalView): HTMLElement[] {
    const parts: HTMLElement[] = [];
    const box = element('div', 'understanding-final-body');
    this.heading(box, uiText('整理好的理解说明（存进卡以前可以改）'));
    if (final.summary) box.append(element('p', '', final.summary));
    const notes = element('textarea', 'understanding-notes');
    notes.rows = 8; notes.maxLength = MAX_UNDERSTANDING_NOTES; notes.value = final.notes;
    notes.setAttribute('aria-label', uiText('理解说明'));
    box.append(notes, element('small', 'hint', uiText('以后每次聊天，扮演她的 Claude 都会带着这份说明。清空再存就是不要理解说明。')));
    let applyMood: HTMLInputElement | null = null;
    const extended = new Map<string, HTMLInputElement>();
    if (final.mood.items.length) {
      this.heading(box, uiText('心情参数'));
      const apply = element('label', 'understanding-check');
      applyMood = element('input'); applyMood.type = 'checkbox'; applyMood.checked = true; applyMood.dataset.understandingChoice = 'apply-mood';
      apply.append(applyMood, element('span', '', uiText('采用这套心情参数（没提到的保持现在的值；她现在的心情不清零）')));
      box.append(apply);
      const list = element('ul', 'understanding-mood');
      for (const item of final.mood.items) {
        const row = element('li', item.extended ? 'extended' : '');
        row.append(element('strong', '', item.label), element('span', '', uiTemplate`：${item.current} → ${item.proposed}（Gene ${item.gene}）`));
        if (item.effect) row.append(element('p', 'understanding-effect', uiTemplate`你会看到：${item.effect}`));
        if (item.extended) {
          const label = element('label', 'understanding-check understanding-extended');
          const tick = element('input'); tick.type = 'checkbox'; tick.checked = item.agreed === true; tick.dataset.understandingChoice = `extended:${item.path}`;
          label.append(tick, element('span', '', uiTemplate`突破常规范围（常规 ${item.typical}），用 ${item.proposed}；不勾就用常规范围内最接近的 ${item.fallbackDisplay}`));
          row.append(label);
          extended.set(item.path, tick);
        }
        list.append(row);
      }
      box.append(list);
      const outside = final.mood.items.filter(item => item.extended);
      if (outside.length) {
        const alert = element('p', 'understanding-warning', uiTemplate`这几项超出了常规范围：${outside.map(item => item.label).join(uiText('、'))}。只有勾上的才会用扩展值。`);
        alert.setAttribute('role', 'alert');
        box.append(alert);
      }
    }
    if (final.mood.invalid) box.append(element('p', 'understanding-warning', uiText('这套数值合在一起不成立（比如门槛的先后顺序），没有采用。')));
    else if (final.mood.dropped) box.append(element('p', 'understanding-warning', uiTemplate`另有 ${final.mood.dropped} 项不是应用支持的数值或超出了允许的范围，没有采用。`));
    let warm: HTMLInputElement | null = null;
    if (final.slowWarmUp.value !== null && final.slowWarmUp.value !== final.slowWarmUp.current) {
      const label = element('label', 'understanding-check');
      warm = element('input'); warm.type = 'checkbox'; warm.checked = true; warm.dataset.understandingChoice = 'slow-warm-up';
      label.append(warm, element('span', '', final.slowWarmUp.value ? uiText('打开「关系慢慢升温」：一开始礼貌、好奇，相处久了才放开') : uiText('关掉「关系慢慢升温」：第一天起就很熟')));
      box.append(label);
    }
    // Asking for "更真实的情绪" changes the card, which would refuse this save; so its button comes after the save.
    if (final.realerEmotions.suggested && this.options.api.requestCharacterRealerEmotions)
      box.append(element('p', 'understanding-realer', uiText('你想给她打开「更真实的情绪」。存进卡以后，这里会出现它的说明按钮，由你自己决定；这里不会替你打开。')));
    this.cardEdits(box, final.cardEdits);
    const actions = element('div', 'understanding-buttons');
    const save = element('button', 'primary', uiText('存进她的卡'));
    save.type = 'button'; save.dataset.understandingAction = 'save'; save.onclick = () => void this.save();
    const discard = element('button', 'subtle', uiText('不存了'));
    discard.type = 'button'; discard.dataset.understandingAction = 'discard'; discard.onclick = () => void this.closeDiscussion();
    actions.append(save, discard);
    box.append(actions, element('small', 'hint', uiText('存的时候是原地更新同一个她：聊天、日记、画像和熟悉度都不动，存之前会先备份角色卡存档。')));
    parts.push(box);
    this.finalControls = { notes, save, applyMood, extended, warm };
    return parts;
  }
}
