import {uiText,uiTemplate} from './ui-language';
import type { AmbientAudioPurpose } from './ambient-audio-segments';

export interface AmbientAudioControlState {
  active: boolean;
  mode: AmbientAudioPurpose | null;
  /** Host capability check, not an assumption from an omitted language hint. */
  available: boolean;
  unavailableReason: string;
  destination: string;
  status: string;
  localDanceActive: boolean;
}

export interface AmbientAudioControlActions {
  /** Root owns host consent and the one existing system-audio capture. */
  onStart(mode: AmbientAudioPurpose): Promise<void>;
  onStop(): Promise<void>;
  onDanceOnly?(): Promise<void>;
  onError?(message: string): void;
  onExpanded?(expanded: boolean): void;
}

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};

/** Explicit purpose/consent UI. Opening this panel never starts a capture or upload. */
export class AmbientAudioControls {
  private readonly panel = node('section');
  private readonly music = node('button', uiText('听音乐'));
  private readonly movie = node('button', uiText('陪看电影'));
  private readonly start = node('button', uiText('开始理解'));
  private readonly stop = node('button', uiText('停止理解'));
  private readonly dance = node('button', uiText('仅本机律动'));
  private readonly status = node('output');
  private readonly destination = node('p');
  private readonly description = node('p');
  private readonly close = node('button', uiText('收起'));
  private selected: AmbientAudioPurpose = 'music';
  private expanded = false;
  private disposed = false;
  private busy = false;
  private pendingAction: 'start' | 'stop' | 'dance' | null = null;
  private operation = 0;
  private state: AmbientAudioControlState = {
    active: false, mode: null, available: false, unavailableReason: uiText('尚未验证转写连接的中、日、英检测能力。'),
    destination: uiText('尚未配置已验证的转写连接'), status: '', localDanceActive: false,
  };

  constructor(container: HTMLElement, private readonly actions: AmbientAudioControlActions) {
    this.panel.className = 'ambient-audio-panel'; this.panel.hidden = true;
    this.panel.setAttribute('data-mood-ui', 'true');
    this.panel.setAttribute('aria-label', uiText('读取本机音频用途'));
    const header = node('div'); header.className = 'ambient-audio-heading';
    header.append(node('strong', '读取本机音频'), this.close);
    const choices = node('div'); choices.className = 'ambient-audio-choices'; choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', uiText('音频用途'));
    choices.append(this.music, this.movie);
    this.description.className = 'ambient-audio-description';
    this.destination.className = 'ambient-audio-destination';
    const notice = node('p', uiText('开始理解后，系统声音片段发送到上方转写连接，识别文字会交给当前聊天连接用于低频评论，并保存在当前角色的本机记录中。原始音频不保存。停止不会删除已保存文字。'));
    notice.className = 'ambient-audio-notice';
    const tools = node('div'); tools.className = 'ambient-audio-actions'; tools.append(this.start, this.stop, this.dance);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    for (const button of [this.music, this.movie, this.start, this.stop, this.dance, this.close]) button.type = 'button';
    this.music.onclick = () => this.choose('music'); this.movie.onclick = () => this.choose('movie');
    this.start.onclick = () => void this.begin(); this.stop.onclick = () => void this.end();
    this.dance.onclick = () => void this.localDance(); this.close.onclick = () => this.setExpanded(false);
    this.panel.onkeydown = event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); this.setExpanded(false); } };
    this.panel.append(header, choices, this.description, this.destination, notice, tools, this.status);
    container.append(this.panel); this.render();
  }

  get isExpanded(): boolean { return this.expanded; }
  toggleExpanded(): void { this.setExpanded(!this.expanded); }
  setExpanded(value: boolean): void {
    if (this.disposed || value === this.expanded) return;
    this.expanded = value; this.panel.hidden = !value;
    this.actions.onExpanded?.(value);
    if (value) this.music.focus({ preventScroll: true });
  }

  setState(patch: Partial<AmbientAudioControlState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    if (this.state.active && this.state.mode) this.selected = this.state.mode;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.operation++;
    if (this.expanded) { this.expanded = false; this.actions.onExpanded?.(false); }
    this.panel.remove();
    // The integrating owner stops capture/session during its own teardown.
  }

  private choose(mode: AmbientAudioPurpose): void {
    if (this.busy || this.state.active || this.disposed) return;
    this.selected = mode; this.render();
  }

  private async begin(): Promise<void> {
    if (this.disposed || this.busy || this.state.active || !this.state.available) return;
    const operation = ++this.operation; this.busy = true; this.pendingAction = 'start'; this.render();
    try { await this.actions.onStart(this.selected); }
    catch { if (!this.disposed && operation === this.operation) this.fail(uiText('系统声音理解未能开启，请检查转写连接。')); }
    finally { if (!this.disposed && operation === this.operation) { this.busy = false; this.pendingAction = null; this.render(); } }
  }

  private async end(): Promise<void> {
    if (this.disposed || this.pendingAction === 'stop' || (!this.state.active && this.pendingAction !== 'start')) return;
    // A stop may supersede a pending start. The host must also invalidate it.
    const operation = ++this.operation; this.busy = true; this.pendingAction = 'stop'; this.render();
    try { await this.actions.onStop(); }
    catch { if (!this.disposed && operation === this.operation) this.fail(uiText('系统声音理解停止未确认，请再次停止。')); }
    finally { if (!this.disposed && operation === this.operation) { this.busy = false; this.pendingAction = null; this.render(); } }
  }

  private async localDance(): Promise<void> {
    if (this.disposed || this.busy || this.state.active || this.selected !== 'music' || !this.actions.onDanceOnly) return;
    const operation = ++this.operation; this.busy = true; this.pendingAction = 'dance'; this.render();
    try { await this.actions.onDanceOnly(); }
    catch { if (!this.disposed && operation === this.operation) this.fail(uiText('本机律动未能切换，请重试。')); }
    finally { if (!this.disposed && operation === this.operation) { this.busy = false; this.pendingAction = null; this.render(); } }
  }

  private fail(message: string): void { this.state.status = message; this.actions.onError?.(message); }

  private render(): void {
    const locked = this.busy || this.state.active;
    this.music.disabled = this.movie.disabled = locked;
    this.music.setAttribute('aria-pressed', String(this.selected === 'music'));
    this.movie.setAttribute('aria-pressed', String(this.selected === 'movie'));
    this.description.textContent = this.selected === 'music'
      ? uiText('理解歌词，按角色性格与当前心情偶尔聊一两句；也可只开启本机律动。')
      : uiText('理解电影或视频中的对白，保留原文，不把台词当作你说的话。');
    this.destination.textContent = uiTemplate`转写连接：${this.state.destination.slice(0, 500)}`;
    this.start.disabled = locked || !this.state.available;
    this.start.textContent = this.pendingAction === 'start' ? uiText('正在连接…') : uiText('开始理解');
    this.stop.disabled = this.pendingAction === 'stop' || (!this.state.active && this.pendingAction !== 'start');
    this.dance.hidden = this.selected !== 'music' || !this.actions.onDanceOnly;
    this.dance.disabled = locked;
    this.dance.textContent = this.state.localDanceActive ? uiText('停止本机律动') : uiText('仅本机律动');
    const text = this.state.status || (!this.state.available ? this.state.unavailableReason
      : this.state.active ? uiText('正在理解系统声音') : uiText('尚未开启声音理解'));
    this.status.textContent = text.slice(0, 600);
    this.panel.dataset.active = String(this.state.active);
  }
}
