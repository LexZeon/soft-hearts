// I-071 v2 第二步 「Claude 助手」 page: the user's own Claude for using and adjusting soft hearts, separate from
// her chat. Model and thinking-effort pickers like Claude's own UI, the reply streaming in, buttons where a choice is asked,
// one host-written line per action with 「撤回」 where it applies, and the popup for anything that needs the user's yes.
// Everything shown is set as textContent: nothing from the model or the host becomes markup.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { RecentlyDeleted, type RecycleApi } from '../foundation/recently-deleted';
import { stripEmphasis } from '../../shared/voice';
import { RECYCLE_ASSISTANT_OWNER } from '../../shared/foundation/recycle-bin';
import {
  ASSISTANT_EFFORTS, ASSISTANT_MODELS,
  type AssistantAction, type AssistantConfirmView, type AssistantEvent, type AssistantMessage, type AssistantPart, type AssistantPrefs, type AssistantView,
} from '../../shared/safety/assistant';
import { CONVERSION_LEFT_OUT_REASON_LABELS, CONVERSION_STEP_LABELS, CONVERSION_TARGET_LABELS, leftOutAllFailures, type ConversionJobView } from '../../shared/cards';

export interface AssistantPorts {
  get(): Promise<AssistantView>;
  send(text: string, choiceId?: string): Promise<AssistantView>;
  cancel(): Promise<AssistantView>;
  clear(): Promise<AssistantView>;
  setPrefs(prefs: Partial<AssistantPrefs>): Promise<AssistantView>;
  answer(id: string, allow: boolean): Promise<void>;
  undo(id: string): Promise<AssistantView>;
  /** I-071 v2 第三步: 「取消」 on a conversion line. */
  cancelConversion?(id: string): Promise<unknown>;
  events(callback: (event: AssistantEvent) => void): () => void;
  error(message: string): void;
  /** I-144b 回收站: 「最近删除的」 under the conversation (「清空」 puts it into the bin, filed under the assistant's own owner). Without it, no such list. */
  recycle?: RecycleApi;
}

/** The action line in the interface language (the host keeps a Chinese copy for the transcript). */
export function assistantActionText(action: AssistantAction): string {
  const what = `${uiText(action.title)}${action.detail ? `${uiText('：')}${action.detail}` : ''}`;
  switch (action.outcome) {
    case 'read': return uiTemplate`查看了：${what}`;
    case 'done': return action.undone ? uiTemplate`${what} · 已撤回` : action.undoId ? uiTemplate`${what} · 可以撤回` : uiTemplate`${what} · 不能撤回`;
    case 'declined': return uiTemplate`没有执行：${what}（你没有允许）`;
    case 'timeout': return uiTemplate`没有执行：${what}（没有确认，算作不允许）`;
    case 'stopped': return uiTemplate`没有执行：${what}（已停止）`;
    case 'busy': return uiTemplate`没有执行：${what}（另一个确认还开着）`;
    default: return uiTemplate`没做成：${what}` + (action.message ? `（${action.message}）` : '');
  }
}

const SUGGESTIONS = ['怎么让她更常主动说话？', '声音能换成什么？', '帮我把朗读关掉'];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class AssistantPanel {
  private view: AssistantView | null = null;
  private thinking = false;
  private confirm: AssistantConfirmView | null = null;
  private confirmTimer: ReturnType<typeof setInterval> | null = null;
  private readonly list = element('div', 'messages assistant-messages');
  private readonly model = element('select', 'assistant-select');
  private readonly effort = element('select', 'assistant-select');
  private readonly clearButton = element('button', 'subtle', uiText('清空'));
  private readonly input = element('textarea');
  private readonly sendButton = element('button', 'primary assistant-send', uiText('发送'));
  private readonly overlay = element('div', 'assistant-confirm');
  private readonly unsubscribe: () => void;
  private recentlyDeleted: RecentlyDeleted | null = null;

  /** `overlayHost`: where the popup lives (document.body in the app, so it shows over any page). */
  constructor(private readonly root: HTMLElement, private readonly ports: AssistantPorts, overlayHost?: HTMLElement) {
    const heading = element('div', 'panel-heading assistant-heading');
    const title = element('div');
    title.append(element('h2', '', uiText('Claude 助手')),
      element('p', '', uiText('你自己的 Claude，帮你用和调整 soft hearts。它不是她；这里的对话只存在这一页。')));
    const pickers = element('div', 'assistant-pickers');
    const label = (text: string, select: HTMLSelectElement) => { const wrap = element('label', 'assistant-picker'); wrap.append(element('span', '', text), select); return wrap; };
    for (const item of ASSISTANT_MODELS) this.model.append(new Option(item.value === 'sonnet' ? uiTemplate`${item.label}（推荐）` : item.label, item.value));
    for (const item of ASSISTANT_EFFORTS) this.effort.append(new Option(uiText(item.label), item.value));
    this.model.setAttribute('aria-label', uiText('模型'));
    this.effort.setAttribute('aria-label', uiText('思考强度'));
    this.model.onchange = () => this.savePrefs({ model: this.model.value as AssistantPrefs['model'] });
    this.effort.onchange = () => this.savePrefs({ effort: this.effort.value as AssistantPrefs['effort'] });
    this.clearButton.type = 'button';
    this.clearButton.onclick = () => this.run(() => this.ports.clear());
    pickers.append(label(uiText('模型'), this.model), label(uiText('思考强度'), this.effort), this.clearButton);
    heading.append(title, pickers);
    this.list.setAttribute('role', 'log');
    this.list.setAttribute('aria-live', 'polite');
    const composer = element('div', 'composer-wrap');
    const form = element('form');
    this.input.rows = 3;
    this.input.id = 'assistant-input';
    this.input.placeholder = uiText('问 soft hearts 的事，或者让它帮你改设置…（Enter 发送，Shift+Enter 换行）');
    this.input.setAttribute('aria-label', uiText('给 Claude 助手的消息'));
    this.input.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submit(); }
    };
    const tools = element('div', 'composer-tools');
    tools.append(element('small', 'assistant-hint', uiText('要你同意的操作会先弹窗问你。')), this.sendButton);
    this.sendButton.type = 'submit';
    form.onsubmit = event => { event.preventDefault(); this.submit(); };
    form.append(this.input, tools);
    composer.append(form);
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    const recycleBox = element('div');
    root.replaceChildren(heading, this.list, recycleBox, composer);
    if (ports.recycle) {
      this.recentlyDeleted = new RecentlyDeleted(recycleBox, { api: ports.recycle, kinds: ['assistant-chat'], characterId: () => RECYCLE_ASSISTANT_OWNER,
        onRestored: () => this.run(() => this.ports.get()), onError: message => ports.error(message) });
      void this.recentlyDeleted.init();
    } else recycleBox.hidden = true;
    (overlayHost ?? root).append(this.overlay);
    this.unsubscribe = ports.events(event => this.onEvent(event));
    void ports.get().then(view => this.show(view), error => ports.error(String(error)));
  }

  dispose(): void { this.unsubscribe(); this.recentlyDeleted?.dispose(); if (this.confirmTimer) clearInterval(this.confirmTimer); }

  private run(work: () => Promise<AssistantView>): void {
    void work().then(view => this.show(view), error => this.ports.error(error instanceof Error ? error.message : String(error)));
  }

  private savePrefs(prefs: Partial<AssistantPrefs>): void { this.run(() => this.ports.setPrefs(prefs)); }

  private submit(): void {
    if (this.view?.busy) { this.run(() => this.ports.cancel()); return; }
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.run(() => this.ports.send(text));
  }

  private onEvent(event: AssistantEvent): void {
    if (event.type === 'state') { this.show(event.view); return; }
    if (event.type === 'confirm') { this.openConfirm(event.request); return; }
    if (event.type === 'confirm-closed') { if (this.confirm?.id === event.id) this.closeConfirm(); return; }
    if (event.type === 'conversion') {
      for (const message of this.view?.messages ?? []) for (const part of message.parts) if (part.kind === 'conversion' && part.job.id === event.job.id) part.job = event.job;
      this.renderMessages();
      return;
    }
    const message = this.view?.messages.find(item => item.id === event.messageId);
    if (!message) return;
    if (event.type === 'thinking') this.thinking = event.on;
    else if (event.type === 'part') { message.parts.push(event.part); if (event.part.kind === 'text') this.thinking = false; }
    else if (event.type === 'text') {
      const last = message.parts.at(-1);
      if (last?.kind === 'text') last.text += event.text; else message.parts.push({ kind: 'text', text: event.text });
      this.thinking = false;
    }
    this.renderMessages();
  }

  private show(view: AssistantView): void {
    this.view = structuredClone(view);
    if (!view.busy) this.thinking = false;
    this.model.value = view.prefs.model;
    this.effort.value = view.prefs.effort;
    this.clearButton.disabled = view.busy || !view.messages.length;
    this.sendButton.textContent = view.busy ? uiText('停止') : uiText('发送');
    this.sendButton.classList.toggle('assistant-stop', view.busy);
    this.renderMessages();
  }

  private renderMessages(): void {
    const view = this.view;
    if (!view) return;
    if (!view.messages.length) {
      const welcome = element('div', 'welcome assistant-welcome');
      welcome.append(element('h3', '', uiText('想调整什么？')),
        element('p', '', uiText('问它软件怎么用，它会查手册再答；让它改设置，它会直接动手。要你同意的，会先弹窗问你。')));
      const suggestions = element('div', 'suggestions');
      for (const text of SUGGESTIONS) {
        const button = element('button', '', uiText(text));
        button.type = 'button';
        button.onclick = () => { this.input.value = uiText(text); this.submit(); };
        suggestions.append(button);
      }
      welcome.append(suggestions);
      this.list.replaceChildren(welcome);
      return;
    }
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    this.list.replaceChildren(...view.messages.map((message, index) => this.renderMessage(message, index === view.messages.length - 1)));
    if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  private renderMessage(message: AssistantMessage, last: boolean): HTMLElement {
    const node = element('div', `message ${message.role === 'user' ? 'user' : 'assistant-reply'}`);
    node.append(element('div', 'message-label', message.role === 'user' ? uiText('你') : uiText('Claude 助手')));
    // Buttons come last, under the words that explain them (the model often writes its answer after offering them).
    for (const part of [...message.parts.filter(item => item.kind !== 'choices'), ...message.parts.filter(item => item.kind === 'choices')]) node.append(this.renderPart(part, last, message.role));
    if (message.status === 'streaming' && (this.thinking || !message.parts.length)) node.append(element('div', 'assistant-thinking', uiText('思考中…')));
    if (message.status === 'stopped') node.append(element('div', 'assistant-note', uiText('（已停止）')));
    if (message.status === 'failed') node.append(element('div', 'message-error', message.error || uiText('这次没能回完。')));
    return node;
  }

  private renderPart(part: AssistantPart, last: boolean, role: AssistantMessage['role']): HTMLElement {
    // The panel shows text, not markup: the model's doubled emphasis markers ("**摸头**") are dropped, the words stay (T-252); the user's own words are shown as typed.
    if (part.kind === 'text') return element('div', 'message-body', role === 'user' ? part.text : stripEmphasis(part.text));
    if (part.kind === 'conversion') return this.renderConversion(part.job);
    // I-071 fix 5: a line the software itself wrote (the conversion intro), set as text.
    if (part.kind === 'notice') return element('div', 'assistant-notice', part.text);
    if (part.kind === 'action') {
      const line = element('div', `assistant-action assistant-action-${part.action.outcome}`);
      line.append(element('span', '', assistantActionText(part.action)));
      const undoId = part.action.undoId;
      if (part.action.outcome === 'done' && undoId && !part.action.undone) {
        const undo = element('button', 'subtle assistant-undo', uiText('撤回'));
        undo.type = 'button';
        undo.onclick = () => { undo.disabled = true; this.run(() => this.ports.undo(undoId)); };
        line.append(undo);
      }
      return line;
    }
    const box = element('div', 'assistant-choices');
    if (part.choices.question) box.append(element('div', 'assistant-choices-question', part.choices.question));
    const row = element('div', 'assistant-choices-row');
    for (const option of part.choices.options) {
      const button = element('button', part.choices.answered === option ? 'assistant-choice chosen' : 'assistant-choice', option);
      button.type = 'button';
      button.disabled = !!part.choices.answered || !!this.view?.busy || !last;
      button.onclick = () => { button.disabled = true; this.run(() => this.ports.send(option, part.choices.id)); };
      row.append(button);
    }
    box.append(row);
    return box;
  }

  /** A conversion's line: what, each step, then the result or 「取消」 (host-written values, set as text). */
  private renderConversion(job: ConversionJobView): HTMLElement {
    const box = element('div', `assistant-conversion assistant-conversion-${job.state}`);
    box.append(element('strong', '', uiTemplate`把「${job.sourceName}」转成${uiText(CONVERSION_TARGET_LABELS[job.target])}`));
    const list = element('ul', 'assistant-conversion-steps');
    for (const step of job.steps) {
      const mark = step.status === 'done' ? '✓' : step.status === 'running' ? '…' : step.status === 'skipped' ? '–' : '·';
      const count = step.total ? ` ${step.done ?? 0}/${step.total}` : '';
      list.append(element('li', `assistant-conversion-step ${step.status}`, `${mark} ${uiText(CONVERSION_STEP_LABELS[step.id])}${count}`));
    }
    box.append(list);
    if (job.state === 'done') {
      box.append(element('div', 'assistant-conversion-result', uiTemplate`转好了：新角色「${job.newName ?? ''}」在角色页（还不是当前角色）。原来的「${job.sourceName}」没有任何改动。`));
      // I-071 fix 5: the memory items that were left out, by title, each with why (never their text).
      if (job.leftOut?.length) {
        const count = job.leftOutCount ?? job.leftOut.length;
        // I-071 fix 8: the list also says what came back missing or cut, a cap, a voice binding with no room (not only re-ask failures).
        box.append(element('div', 'assistant-conversion-left-out', leftOutAllFailures(job)
          ? uiTemplate`有 ${String(count)} 条记忆重问一次还是翻得不合格，没有带过去（新卡里没有它们，原角色里都还在）：`
          : uiTemplate`有 ${String(count)} 项没有完整带过去（原角色里都还在）：`));
        const list = element('ul', 'assistant-conversion-left-out-list');
        for (const item of job.leftOut) list.append(element('li', '', `「${item.title}」：${item.reasons.map(reason => uiText(CONVERSION_LEFT_OUT_REASON_LABELS[reason])).join('、')}`));
        if (count > job.leftOut.length) list.append(element('li', '', uiTemplate`还有 ${String(count - job.leftOut.length)} 条`));
        box.append(list);
      }
      for (const note of job.lint ?? []) box.append(element('div', 'assistant-note', note));
    } else if (job.state === 'cancelled') box.append(element('div', 'assistant-note', uiText('已取消：没有留下任何新东西，原角色没有任何改动。')));
    else if (job.state === 'failed') box.append(element('div', 'message-error', job.error || uiText('没有转成，原角色没有任何改动。')));
    else if (job.cancellable && this.ports.cancelConversion) {
      const cancel = element('button', 'subtle assistant-undo', uiText('取消转换'));
      cancel.type = 'button';
      cancel.onclick = () => { cancel.disabled = true; void this.ports.cancelConversion!(job.id).catch(error => this.ports.error(error instanceof Error ? error.message : String(error))); };
      box.append(cancel);
    }
    return box;
  }

  private openConfirm(request: AssistantConfirmView): void {
    this.confirm = request;
    const card = element('div', 'assistant-confirm-card');
    const seconds = element('small', 'assistant-confirm-time');
    const deadline = Date.now() + request.timeoutMs;
    const tick = () => { seconds.textContent = uiTemplate`来自 Claude 助手（${uiText(request.toolTitle)}）。${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒内不回应就算不允许。`; };
    tick();
    if (this.confirmTimer) clearInterval(this.confirmTimer);
    this.confirmTimer = setInterval(tick, 1000);
    const buttons = element('div', 'assistant-confirm-buttons');
    const deny = element('button', '', uiText(request.buttons[0]));
    const allow = element('button', 'primary', uiText(request.buttons[1]));
    deny.type = allow.type = 'button';
    const answer = (value: boolean) => { deny.disabled = allow.disabled = true; void this.ports.answer(request.id, value).catch(() => {}); };
    deny.onclick = () => answer(false);
    allow.onclick = () => answer(true);
    buttons.append(deny, allow);
    card.append(element('strong', '', request.title), element('p', 'assistant-confirm-detail', request.detail), seconds, buttons);
    this.overlay.replaceChildren(card);
    this.overlay.hidden = false;
    deny.focus?.();
  }

  private closeConfirm(): void {
    this.confirm = null;
    if (this.confirmTimer) { clearInterval(this.confirmTimer); this.confirmTimer = null; }
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
  }
}

/** The page's ports over the preload API (src/main.ts mounts it once). */
export function mountAssistantPanel(root: HTMLElement | null, notify: (message: string) => void): AssistantPanel | null {
  if (!root) return null;
  const desktop = window.desktop;
  return new AssistantPanel(root, {
    get: () => desktop.assistantGet(), send: (text, choiceId) => desktop.assistantSend(text, choiceId), cancel: () => desktop.assistantCancel(),
    clear: () => desktop.assistantClear(), setPrefs: prefs => desktop.assistantSetPrefs(prefs), answer: (id, allow) => desktop.assistantAnswer(id, allow),
    undo: id => desktop.assistantUndo(id), events: callback => desktop.onAssistant(callback), error: notify,
    cancelConversion: id => desktop.assistantCancelConversion(id), recycle: desktop,
  }, document.body);
}
