// Control-window toggle and status line for the agent internal channel, plus the small
// renderer pieces the channel needs ("由 Claude 操作" notices and the two preview actions).
// Everything shown is host data set as textContent; nothing from the agent becomes markup.
import { uiText, uiTemplate } from './ui-language';
import type { AgentCallOutcome, AgentChannelNotice, AgentChannelRendererAction, AgentChannelView, AgentRecycleSummary } from '../../shared/agent-channel';

export interface AgentChannelPorts {
  get(): Promise<AgentChannelView>;
  setEnabled(enabled: boolean): Promise<AgentChannelView>;
  changed(callback: (view: AgentChannelView) => void): () => void;
  copy?(text: string): Promise<void>;
  error(message: string): void;
  /** I-014 "三方互通", 「重新接上」, 「撤回」 and the recycle bin (absent on older hosts: the controls are not shown). */
  setInterconnect?(enabled: boolean): Promise<AgentChannelView>;
  relink?(): Promise<AgentChannelView>;
  undo?(id: string): Promise<AgentChannelView>;
  restore?(id: string): Promise<AgentChannelView>;
  setRecycleDays?(days: number): Promise<AgentChannelView>;
}

const OUTCOME: Record<AgentCallOutcome, string> = { allowed: '已执行', denied: '已拒绝', failed: '没有成功', invalid: '参数不对' };

export function agentChannelStatusText(view: AgentChannelView | null, now = Date.now()): string {
  if (!view) return uiText('正在读取内部通道状态…');
  if (view.error) return view.error;
  if (!view.enabled) return uiText('已关闭 · 没有在监听，也没有口令文件。');
  if (!view.listening) return uiText('已开启，但没有在监听。请关闭再打开一次。');
  const clients = view.connections ? uiTemplate`${view.connections} 个 Claude 已连接` : uiText('还没有 Claude 连接');
  let text = uiTemplate`已开启 · 只接受本机当前用户 · ${clients}`;
  const last = view.lastAction;
  if (last) {
    const minutes = Math.max(0, Math.round((now - last.at) / 60_000));
    text += uiTemplate` · 最近：${last.title}（${uiText(OUTCOME[last.outcome] ?? '没有成功')}，${minutes ? uiTemplate`${minutes} 分钟前` : uiText('刚刚')}）`;
  }
  return text;
}

/** I-014: what the "三方互通" switch means right now, in one line. */
export function agentInterconnectText(view: AgentChannelView | null): string {
  const mutual = view?.interconnect;
  if (!mutual) return '';
  if (mutual.enabled) return uiText('已打开 · 你对自己的 Claude 说的、在设置里点的，直接做，不再弹窗确认；每次都会显示“由 Claude 操作”。要你同意的（隐私、花钱、删除等），Claude 要带上你在对话里说的原话才做。在桌宠聊天里对她说的，仍然先给你选项或弹窗确认。');
  return mutual.unreadable ? uiText('已关闭 · 这个开关的设置文件读不出来，先关着；打开一次就会重新记下。')
    : uiText('已关闭 · 你关掉的，会一直记着。需要确认的操作都会弹窗问你；内部通道照以前一样由下面的开关决定。');
}

export function agentNoticeText(notice: AgentChannelNotice): string {
  const title = typeof notice?.title === 'string' ? notice.title.slice(0, 40) : '';
  const detail = typeof notice?.detail === 'string' ? notice.detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80) : '';
  return uiTemplate`由 Claude 操作：${title || uiText('内部通道')}` + (detail ? `（${detail}）` : '');
}

export function recycleEntryText(entry: AgentRecycleSummary): string {
  const date = new Date(entry.expiresAt);
  return uiTemplate`「${entry.characterName}」的${entry.label} · ${date.getMonth() + 1} 月 ${date.getDate()} 日前可以找回`;
}

/** Maps the host's closed action set onto existing buttons; anything else is ignored. */
export function runAgentRendererAction(action: AgentChannelRendererAction, ports: { playPreview(recipe: 'surprise' | 'shy'): void; voicePreview(): void }): boolean {
  if (action?.kind === 'play-preview' && (action.recipe === 'surprise' || action.recipe === 'shy')) { ports.playPreview(action.recipe); return true; }
  if (action?.kind === 'voice-preview') { ports.voicePreview(); return true; }
  return false;
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};

export class AgentChannelPanel {
  private readonly mutualToggle = element('input');
  private readonly mutualStatus = element('p', 'hint agent-channel-status');
  private readonly mutualRow = element('label', 'toggle-row');
  private readonly link = element('p', 'hint agent-channel-link');
  private readonly relink = element('button', 'subtle', uiText('重新接上'));
  private readonly toggle = element('input');
  private readonly status = element('p', 'hint agent-channel-status');
  private readonly undoButton = element('button', 'subtle');
  private readonly setup = element('details', 'agent-channel-setup');
  private readonly claudeCode = element('pre', 'agent-channel-snippet');
  private readonly desktopConfig = element('pre', 'agent-channel-snippet');
  private readonly recycle = element('div', 'agent-channel-recycle');
  private readonly recycleList = element('ul', 'agent-channel-recycle-list');
  private readonly recycleDays = element('input');
  private view: AgentChannelView | null = null;
  private busy = false;
  private readonly unsubscribe: () => void;

  constructor(root: HTMLElement, private readonly ports: AgentChannelPorts) {
    const heading = element('h3', '', uiText('Claude 内部通道'));
    // I-014 "三方互通": on by default; off brings back the channel's own switch and every dialog.
    const mutualCopy = element('span');
    mutualCopy.append(element('strong', '', uiText('三方互通：你的 Claude、和她聊天、设置互相通着（默认打开）')),
      element('small', '', uiText('打开时，你本机的 Claude Code 自动接上；你对它说的事直接做，每次都会显示“由 Claude 操作”；要你同意的（隐私、花钱、删除等），它要带上你在对话里说的原话才做，没有就不做；改角色卡、换模型前先备份，能撤回的可以撤回，删除的记忆先进回收站。摄像头、麦克风、屏幕、电脑声音和付费语音仍然默认关，你说了才开。在桌宠聊天里对她说的，仍然先给你选项或弹窗确认。关掉后回到以前：内部通道关闭，需要确认的都弹窗。')));
    this.mutualToggle.type = 'checkbox';
    this.mutualToggle.setAttribute('role', 'switch');
    this.mutualToggle.dataset.agentChannel = 'interconnect';
    this.mutualToggle.disabled = true;
    this.mutualToggle.onchange = () => { const value = this.mutualToggle.checked; void this.run(() => this.ports.setInterconnect!(value)); };
    this.mutualRow.append(mutualCopy, this.mutualToggle);
    this.mutualStatus.setAttribute('role', 'status');
    this.mutualStatus.dataset.agentChannel = 'interconnect-status';
    this.link.dataset.agentChannel = 'claude-code';
    this.relink.type = 'button';
    this.relink.dataset.agentChannel = 'relink';
    this.relink.onclick = () => { void this.run(() => this.ports.relink!()); };
    const linkRow = element('div', 'agent-channel-link-row');
    linkRow.append(this.link, this.relink);

    const row = element('label', 'toggle-row');
    const copy = element('span');
    copy.append(element('strong', '', uiText('允许 Claude 通过内部通道操作 soft hearts')),
      element('small', '', uiText('“三方互通”打开时一直开着。关掉三方互通后由这里决定（默认关闭）：你本机的 Claude 可以读取状态、切换角色、调整少量设置；导入角色卡、载入模型、试听语音会先在这里弹窗问你。')));
    this.toggle.type = 'checkbox';
    this.toggle.setAttribute('role', 'switch');
    this.toggle.dataset.agentChannel = 'enabled';
    this.toggle.disabled = true;
    this.toggle.onchange = () => { const value = this.toggle.checked; void this.run(() => this.ports.setEnabled(value)); };
    row.append(copy, this.toggle);
    this.status.setAttribute('role', 'status');
    this.status.dataset.agentChannel = 'status';
    this.undoButton.type = 'button';
    this.undoButton.dataset.agentChannel = 'undo';
    this.undoButton.onclick = () => { const id = this.view?.lastAction?.undo?.id; if (id) void this.run(() => this.ports.undo!(id)); };
    this.setup.dataset.agentChannel = 'setup';
    this.setup.append(element('summary', '', uiText('怎么接上 Claude')),
      element('p', 'hint', uiText('Claude Code：三方互通打开时会自动接上；没接上时在终端运行一次下面这行。')), this.claudeCode, this.copyButton('copy-claude-code', () => this.claudeCode.textContent ?? ''),
      element('p', 'hint', uiText('Claude 桌面版：设置 → 开发者 → 编辑配置，把下面的 mcpServers 合并进 claude_desktop_config.json，保存后重启 Claude 桌面版。')),
      this.desktopConfig, this.copyButton('copy-desktop-config', () => this.desktopConfig.textContent ?? ''));
    // I-014 回收站: names and counts only; 「找回」 puts one entry back.
    this.recycle.dataset.agentChannel = 'recycle';
    const daysLabel = element('label', 'agent-channel-recycle-days');
    this.recycleDays.type = 'number';
    this.recycleDays.min = '1';
    this.recycleDays.max = '30';
    this.recycleDays.step = '1';
    this.recycleDays.dataset.agentChannel = 'recycle-days';
    this.recycleDays.onchange = () => {
      const days = Number(this.recycleDays.value);
      if (Number.isInteger(days) && days >= 1 && days <= 30) void this.run(() => this.ports.setRecycleDays!(days));
      else this.render();
    };
    daysLabel.append(element('span', '', uiText('删除的记忆在回收站里留')), this.recycleDays, element('span', '', uiText('天，到期才真正清理。')));
    this.recycle.append(element('h4', '', uiText('回收站')), daysLabel, this.recycleList);
    const never = element('p', 'hint', uiText('始终不开放：密钥、运行命令、任意读写文件、改“三方互通”以外的权限，以及永久删除记忆（只能先进回收站）。每次调用在配置目录 dev/agent-channel-audit.jsonl 记一行（工具、结果、耗时），不记参数和聊天内容。'));
    root.replaceChildren(heading, this.mutualRow, this.mutualStatus, linkRow, row, this.status, this.undoButton, this.setup, this.recycle, never);
    this.render();
    this.unsubscribe = ports.changed(view => { this.view = view; this.render(); });
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error(String(error)); this.render(); });
  }

  dispose(): void { this.unsubscribe(); }

  private copyButton(name: string, text: () => string): HTMLButtonElement {
    const button = element('button', 'subtle', uiText('复制'));
    button.type = 'button';
    button.dataset.agentChannel = name;
    button.onclick = () => {
      const value = text();
      if (!value || !this.ports.copy) return;
      void this.ports.copy(value).then(() => { button.textContent = uiText('已复制'); }, error => this.ports.error(String(error)));
    };
    return button;
  }

  private async run(action: () => Promise<AgentChannelView>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { this.view = await action(); }
    catch (error) { this.ports.error(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view, mutual = view?.interconnect, supported = !!mutual && !!this.ports.setInterconnect;
    this.mutualRow.hidden = !supported;
    this.mutualStatus.hidden = !supported;
    this.mutualToggle.checked = !!mutual?.enabled;
    this.mutualToggle.disabled = !view || this.busy || !supported;
    this.mutualStatus.textContent = agentInterconnectText(view);
    const link = mutual?.enabled ? mutual.claudeCode : null;
    this.link.textContent = link?.message ?? '';
    this.link.hidden = !link?.message;
    this.relink.hidden = !link || !this.ports.relink || !['removed', 'failed', 'missing', 'stale', 'unverified'].includes(link.state);
    this.relink.disabled = this.busy;
    this.toggle.checked = !!view?.enabled;
    // With 三方互通 on the channel is always open; its own switch matters again once that is off.
    this.toggle.disabled = !view || this.busy || !!mutual?.enabled;
    this.status.textContent = this.busy ? uiText('正在切换…') : agentChannelStatusText(view);
    const undo = view?.lastAction?.undo;
    this.undoButton.hidden = !undo || !this.ports.undo;
    this.undoButton.textContent = undo ? uiTemplate`撤回：${undo.label}` : '';
    this.undoButton.disabled = this.busy;
    this.setup.hidden = !view?.enabled || !view.setup;
    this.claudeCode.textContent = view?.enabled ? view.setup?.claudeCode ?? '' : '';
    this.desktopConfig.textContent = view?.enabled ? view.setup?.desktopConfig ?? '' : '';
    const entries = mutual?.recycleBin ?? [];
    this.recycle.hidden = !mutual || (!mutual.enabled && !entries.length);
    if (document.activeElement !== this.recycleDays) this.recycleDays.value = String(mutual?.recycleDays ?? 7);
    this.recycleDays.disabled = this.busy || !this.ports.setRecycleDays;
    this.recycleList.replaceChildren(...(entries.length ? entries.map(entry => this.recycleItem(entry)) : [element('li', 'hint', uiText('回收站是空的。'))]));
  }

  private recycleItem(entry: AgentRecycleSummary): HTMLLIElement {
    const item = element('li');
    item.dataset.recycleEntry = entry.id;
    const restore = element('button', 'subtle', uiText('找回'));
    restore.type = 'button';
    restore.disabled = this.busy || !this.ports.restore;
    restore.onclick = () => { void this.run(() => this.ports.restore!(entry.id)); };
    item.append(element('span', '', recycleEntryText(entry)), restore);
    return item;
  }
}
