import { uiText, uiTemplate } from './ui-language';
import type { InnerLoopDiagnostic, InnerLoopView } from '../../shared/inner-loop';
import type { OpeningWhy } from '../../shared/behaviors/opening-choice/interface';

export interface InnerLoopPanelSource {
  getInnerLoop(): Promise<InnerLoopView>;
  setInnerLoop(enabled: boolean): Promise<InnerLoopView>;
  onInnerLoop?(callback: (view: InnerLoopView) => void): () => void;
}

const actions: Record<InnerLoopDiagnostic['decision'], string> = { none: '不做', motion: '小动作', look: '看一眼', speak: '说一句', switch: '换件事做', invite: '邀请玩猜拳' };
const results: Record<InnerLoopDiagnostic['result'], string> = {
  ok: '完成', delivered: '已显示', undelivered: '未能显示', invalid: '回答不合格', timeout: '超时', cancelled: '被打断', error: '调用失败', asleep: '睡着了',
};

/** One read-only line per opportunity: categories, timings and counts only. */
export function formatInnerLoopDiagnostic(entry: InnerLoopDiagnostic): string {
  const time = new Date(entry.at).toLocaleTimeString();
  const parts = [time, entry.cue === 'speech' ? uiText('说话时机') : uiText('小动作时机'),
    entry.called ? uiText('问了模型') : uiText('未调用模型'), uiTemplate`决定：${uiText(actions[entry.decision])}`, uiText(results[entry.result])];
  if (entry.quiet) parts.push(uiText('安静时段'));
  if (entry.ms !== null) parts.push(`${(entry.ms / 1000).toFixed(1)}s`);
  if (entry.inputTokens !== null || entry.outputTokens !== null) parts.push(uiTemplate`token 入 ${entry.inputTokens ?? '—'} / 出 ${entry.outputTokens ?? '—'}`);
  if (entry.costUsd !== null) parts.push(`$${entry.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}

export function formatInnerLoopRecent(view: InnerLoopView): string {
  if (!view.developerMode) return uiText('开发者模式关闭时不记录内心循环。');
  if (!view.recent.length) return uiText('还没有记录。她空闲一段时间后出现小动作或说话时机时才会记录。');
  return view.recent.slice().reverse().map(formatInnerLoopDiagnostic).join('\n');
}

/** I-020 #10: one line per speech opportunity, "这次挑了什么、为什么" (labels and reasons only). */
export function formatOpeningWhy(entry: OpeningWhy): string {
  const time = new Date(entry.at).toLocaleTimeString();
  const from = entry.from === 'pause' ? uiText('一起听的停顿点') : uiText('说话时机');
  return [time, from, uiTemplate`这次：${entry.label}`, uiTemplate`为什么：${entry.why.join('；')}`, ...(entry.weights ? [uiTemplate`分量：${entry.weights}`] : [])].join(' · ');
}

export function formatOpeningRecent(view: InnerLoopView): string {
  if (!view.developerMode) return '';
  const lines = view.opening ?? [];
  return lines.length ? lines.map(formatOpeningWhy).join('\n') : uiText('还没有说话时机。');
}

/** The window's own desktop bridge, when it offers the inner-loop calls. */
export function defaultInnerLoopSource(): InnerLoopPanelSource | null {
  const desktop = (globalThis as { window?: { desktop?: Partial<InnerLoopPanelSource> } }).window?.desktop;
  return desktop && typeof desktop.getInnerLoop === 'function' && typeof desktop.setInnerLoop === 'function'
    ? desktop as InnerLoopPanelSource : null;
}

/** "主动发言" group of the developer mood panel: the master switch and the last 20 diagnostics (read only). */
export class InnerLoopSection {
  private readonly checkbox: HTMLInputElement;
  private readonly log: HTMLPreElement;
  private readonly opening: HTMLPreElement;
  private readonly notice: HTMLOutputElement;
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  constructor(parent: HTMLElement, private readonly source: InnerLoopPanelSource) {
    const doc = parent.ownerDocument;
    const group = doc.createElement('fieldset'); group.className = 'mood-inner-loop';
    const legend = doc.createElement('legend'); legend.textContent = uiText('主动发言');
    const label = doc.createElement('label');
    this.checkbox = doc.createElement('input'); this.checkbox.type = 'checkbox'; this.checkbox.id = 'mood-inner-loop-enabled';
    this.checkbox.disabled = true;
    const text = doc.createElement('span'); text.textContent = uiText('让她自己决定做什么（内心循环）');
    label.append(this.checkbox, text);
    const hint = doc.createElement('p'); hint.className = 'hint';
    hint.textContent = uiText('说话时机来了，她先按性格和心情挑这次说什么（屏幕、刚听完的、她的小情绪、邀你玩，或者这次不说；屏幕和声音只在你开着时才有），挑中自己的小情绪或邀你玩时，再用小模型想怎么说。频率和上限沿用角色卡，困了或深夜只做小动作。关掉后她不再说自己的小情绪、也不邀你玩，只剩固定的小动作；屏幕和一起听照常。');
    const details = doc.createElement('details'); details.className = 'mood-inner-loop-log';
    const summary = doc.createElement('summary'); summary.textContent = uiText('最近 20 次（只读诊断，不含原文）');
    this.log = doc.createElement('pre'); this.log.id = 'mood-inner-loop-log';
    const choiceTitle = doc.createElement('p'); choiceTitle.className = 'hint'; choiceTitle.textContent = uiText('这次挑了什么、为什么（只在内存，只有类别和理由）');
    this.opening = doc.createElement('pre'); this.opening.id = 'mood-opening-why';
    this.notice = doc.createElement('output');
    details.append(summary, this.log, choiceTitle, this.opening);
    group.append(legend, label, hint, details, this.notice);
    parent.append(group);
    this.checkbox.addEventListener('change', () => void this.set(this.checkbox.checked));
    // Developer mode may have changed since the last broadcast: opening the list reads it again.
    details.addEventListener('toggle', () => { if (details.open) void this.refresh(); });
    try { this.unsubscribe = source.onInnerLoop?.(view => this.render(view)) ?? null; } catch { this.unsubscribe = null; }
    void this.refresh();
  }
  async refresh(): Promise<void> {
    try { this.render(await this.source.getInnerLoop()); } catch (error) { this.notice.textContent = String(error); }
  }
  render(view: InnerLoopView): void {
    if (!this.busy) { this.checkbox.checked = view.enabled; this.checkbox.disabled = false; }
    this.log.textContent = formatInnerLoopRecent(view);
    this.opening.textContent = formatOpeningRecent(view);
  }
  private async set(enabled: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.checkbox.disabled = true; this.notice.textContent = '';
    try {
      const view = await this.source.setInnerLoop(enabled);
      this.busy = false; this.render(view);
    } catch (error) {
      this.busy = false; this.checkbox.checked = !enabled; this.checkbox.disabled = false; this.notice.textContent = String(error);
    }
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; }
}
