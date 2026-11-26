// Control-window section in 聊天记忆 for "recall old things by meaning" (I-111): one switch (off by default), the size the first download
// takes, progress, what has been computed so far, and deleting the model. Everything shown is host enums and numbers turned into
// fixed copy; no memory and no path ever reaches here.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { parseSemanticView, type SemanticNotice, type SemanticRecallView } from '../../shared/memory/memory-semantic/view';
import { poseMegabytes } from '../../shared/senses';

const NOTICE: Record<Exclude<SemanticNotice, ''>, string> = {
  'download-failed': '下载没完成，要重试吗？', 'verify-failed': '下载的文件没通过校验，已丢弃。要重试吗？',
  canceled: '已取消下载，这个功能关着。', failed: '本机模型刚才没能正常运行，下次用到时会重新启动；这期间想起旧事只按字面和关键词。',
  removed: '已删除本机模型和算出来的结果，这个功能关着。',
};

export function semanticLabelText(view: SemanticRecallView): string {
  return uiTemplate`按意思想起旧事（本机模型，约 ${poseMegabytes(view.downloadBytes || view.installedBytes)} MB，第一次要下载）`;
}

export function semanticStatusText(view: SemanticRecallView): string {
  if (view.phase === 'unsupported') return '';
  if (!view.enabled) return uiText('关着：不下载、不计算，她想起旧事只按字面和关键词。打开后会先下载一次模型，在你的电脑上运行，聊天内容不会离开这台电脑。');
  switch (view.phase) {
    case 'downloading': return uiTemplate`正在下载本机模型… ${Math.round((view.progress ?? 0) * 100)}%`;
    case 'installing': return uiText('正在校验和安装…');
    case 'not-installed': return uiText('已打开，但模型还没装好。');
    default: return view.total
      ? uiTemplate`已打开。已按意思整理 ${view.indexed} / ${view.total} 段旧聊天（后台在你不忙的时候慢慢补，没补到的段仍按字面想起）。`
      : uiText('已打开。还没有可整理的旧聊天。');
  }
}

export interface SemanticRecallPorts {
  get(): Promise<SemanticRecallView>;
  changed(callback: (view: SemanticRecallView) => void): () => void;
  set(on: boolean): Promise<SemanticRecallView>;
  retry(): Promise<SemanticRecallView>;
  cancel(): Promise<void>;
  remove(): Promise<SemanticRecallView>;
  error(message: string): void;
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};

export class SemanticRecallPanel {
  private readonly check = element('input');
  private readonly label = element('label', 'check-line');
  private readonly labelText = element('span');
  private readonly status = element('p', 'hint');
  private readonly notice = element('p', 'hint');
  private readonly cancelButton = element('button', 'subtle', uiText('取消'));
  private readonly retryButton = element('button', 'subtle', uiText('重试'));
  private readonly removeButton = element('button', 'subtle', uiText('删除本机模型'));
  private readonly details = element('p', 'hint');
  private readonly advanced = element('details');
  private readonly unsubscribe: () => void;

  constructor(private readonly root: HTMLElement, private readonly ports: SemanticRecallPorts) {
    this.check.type = 'checkbox'; this.check.id = 'semantic-recall-switch';
    this.label.append(this.check, this.labelText);
    for (const button of [this.cancelButton, this.retryButton, this.removeButton]) button.type = 'button';
    const line = element('div', 'action-line'); line.append(this.cancelButton, this.retryButton);
    const removeLine = element('div', 'action-line'); removeLine.append(this.removeButton);
    this.advanced.append(element('summary', '', uiText('高级')), this.details, removeLine);
    root.replaceChildren(this.label, this.status, line, this.notice, this.advanced);
    const run = (work: () => Promise<SemanticRecallView | void>) => () => void work().then(view => { if (view) this.render(view); }, error => this.ports.error(String(error)));
    this.check.onchange = () => { const on = this.check.checked; this.check.disabled = true; run(() => this.ports.set(on))(); };
    this.cancelButton.onclick = run(() => this.ports.cancel());
    this.retryButton.onclick = run(() => this.ports.retry());
    this.removeButton.onclick = run(() => this.ports.remove());
    this.unsubscribe = ports.changed(value => { const view = parseSemanticView(value); if (view) this.render(view); });
    void ports.get().then(view => this.render(view), () => { root.hidden = true; });
  }

  render(view: SemanticRecallView): void {
    this.root.hidden = view.phase === 'unsupported';
    if (view.phase === 'unsupported') return;
    this.labelText.textContent = semanticLabelText(view);
    this.check.checked = view.enabled;
    this.check.disabled = view.phase === 'downloading' || view.phase === 'installing';
    this.status.textContent = semanticStatusText(view);
    this.cancelButton.hidden = view.phase !== 'downloading';
    this.retryButton.hidden = !(view.enabled && view.phase === 'not-installed' && (view.notice === 'download-failed' || view.notice === 'verify-failed'));
    this.notice.textContent = view.notice ? uiText(NOTICE[view.notice]) : '';
    this.notice.hidden = !view.notice;
    this.details.textContent = view.installedBytes
      ? uiTemplate`已安装 ${poseMegabytes(view.installedBytes)} MB · BGE-small-zh-v1.5（智源 BAAI，MIT 许可；ONNX 转换：Xenova）· 只在你的电脑上算，处理器`
      : '';
    this.removeButton.hidden = !view.installedBytes;
    this.removeButton.disabled = view.phase === 'downloading' || view.phase === 'installing';
  }

  dispose(): void { this.unsubscribe(); }
}
