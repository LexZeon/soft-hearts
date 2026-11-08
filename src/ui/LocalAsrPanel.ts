// Control-window panel for the local speech recognizer (voice input): the one-line download
// question with the size, progress, status, and an "advanced" box with size / version, delete and offline import.
// Everything shown is host enums and numbers turned into fixed copy; nothing from elsewhere becomes markup.
import { uiText, uiTemplate } from './ui-language';
import { registerUiMessages } from '../../shared/ui-language';
import { parseLocalAsrView, type LocalAsrNotice, type LocalAsrView } from '../../shared/local-asr';
import { poseMegabytes } from '../../shared/pose-signals';

registerUiMessages({ 'zh-CN': {}, en: {
  '想让我听见你说话，需要先下载约 {0} MB 的本机识别组件（SenseVoice 中文语音识别）。它只在你的电脑上运行，声音不会离开这台电脑，也不会被保存。现在下载吗？':
    'To hear you I first need a local speech recognizer of about {0} MB (SenseVoice). It runs only on your computer; your voice never leaves it and is never saved. Download it now?',
  '本机识别组件还没下载（约 {0} MB）。打开语音输入时会先问你。': 'The local speech recognizer is not downloaded yet (about {0} MB). You will be asked when you turn voice input on.',
  '正在下载本机识别组件… {0}%': 'Downloading the local speech recognizer… {0}%',
  '小包下载不了，改从官方地址下载（共约 {0} MB）… {1}%': 'The small package could not be downloaded, so this comes from the official sources instead (about {0} MB)… {1}%',
  '本机识别已就绪。打开语音输入，我就能听见你；声音只在这台电脑上识别。': 'Local recognition is ready. Turn voice input on and I can hear you; your voice is recognised on this computer only.',
  '正在准备本机识别（加载模型，几秒钟）…': 'Getting local recognition ready (loading the model, a few seconds)…',
  '本机识别正在听 · 声音只在这台电脑上识别，不保存、不上传': 'Local recognition is listening · your voice stays on this computer, never saved or uploaded',
  '本机识别刚才没能正常运行，下次说话时会重新启动。': 'Local recognition did not run properly; it restarts the next time you speak.',
  '删除识别组件': 'Delete recognizer', '已删除本机识别组件。': 'The local speech recognizer was deleted.',
  '已安装 {0} MB · 组件版本 {1} · SenseVoiceSmall（阿里巴巴通义实验室，FunASR 模型许可）· 处理器': 'Installed {0} MB · component version {1} · SenseVoiceSmall (Alibaba Tongyi Lab, FunASR model licence) · CPU',
} });

const NOTICE: Record<Exclude<LocalAsrNotice, ''>, string> = {
  'download-failed': '下载没完成，要重试吗？', 'verify-failed': '下载的文件没通过校验，已丢弃。要重试吗？',
  'import-incomplete': '选的文件里缺少一部分，或者不是需要的文件。', 'import-done': '已导入，组件已就绪。',
  removed: '已删除本机识别组件。', canceled: '已取消下载。', failed: '本机识别刚才没能正常运行，下次说话时会重新启动。',
};

export function localAsrPromptText(view: LocalAsrView): string {
  return uiTemplate`想让我听见你说话，需要先下载约 ${poseMegabytes(view.downloadBytes)} MB 的本机识别组件（SenseVoice 中文语音识别）。它只在你的电脑上运行，声音不会离开这台电脑，也不会被保存。现在下载吗？`;
}

export function localAsrStatusText(view: LocalAsrView): string {
  switch (view.phase) {
    case 'unsupported': return '';
    case 'not-installed': return uiTemplate`本机识别组件还没下载（约 ${poseMegabytes(view.downloadBytes)} MB）。打开语音输入时会先问你。`;
    case 'downloading': return view.fallback
      ? uiTemplate`小包下载不了，改从官方地址下载（共约 ${poseMegabytes(view.downloadBytes)} MB）… ${Math.round((view.progress ?? 0) * 100)}%`
      : uiTemplate`正在下载本机识别组件… ${Math.round((view.progress ?? 0) * 100)}%`;
    case 'installing': return uiText('正在校验和安装…');
    case 'idle': return uiText('本机识别已就绪。打开语音输入，我就能听见你；声音只在这台电脑上识别。');
    case 'starting': return uiText('正在准备本机识别（加载模型，几秒钟）…');
    case 'ready': return uiText('本机识别正在听 · 声音只在这台电脑上识别，不保存、不上传');
  }
}

export function localAsrNoticeText(notice: LocalAsrNotice): string { return notice ? uiText(NOTICE[notice]) : ''; }

export function localAsrDetailsText(view: LocalAsrView): string {
  if (!view.installedBytes) return '';
  return uiTemplate`已安装 ${poseMegabytes(view.installedBytes)} MB · 组件版本 ${view.componentVersion} · SenseVoiceSmall（阿里巴巴通义实验室，FunASR 模型许可）· 处理器`;
}

export interface LocalAsrPorts {
  get(): Promise<LocalAsrView>;
  changed(callback: (view: LocalAsrView) => void): () => void;
  download(): Promise<LocalAsrView>;
  cancel(): Promise<void>;
  dismiss(): Promise<LocalAsrView>;
  importFiles(): Promise<LocalAsrView>;
  remove(): Promise<LocalAsrView>;
  /** Bring the voice-input settings into view (the question can be raised from the pet window). */
  reveal?(): void;
  error(message: string): void;
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};
const action = (label: string, cls = 'subtle') => { const b = element('button', cls, uiText(label)); b.type = 'button'; return b; };

export class LocalAsrPanel {
  private view: LocalAsrView | null = null;
  private readonly question = element('div', 'pose-question');
  private readonly questionText = element('p');
  private readonly status = element('p', 'hint pose-status');
  private readonly notice = element('p', 'hint pose-notice');
  private readonly advanced = element('details', 'pose-advanced');
  private readonly details = element('p', 'hint');
  private readonly downloadButton = action('下载', 'primary');
  private readonly laterButton = action('以后再说');
  private readonly cancelButton = action('取消');
  private readonly retryButton = action('重试');
  private readonly importLink = action('已有离线组件包？导入…');
  private readonly importButton = action('导入离线组件包…');
  private readonly removeButton = action('删除识别组件');
  private readonly unsubscribe: () => void;

  constructor(private readonly root: HTMLElement, private readonly ports: LocalAsrPorts) {
    const buttons = element('div', 'action-line');
    buttons.append(this.downloadButton, this.laterButton);
    this.question.append(this.questionText, buttons, this.importLink);
    const line = element('div', 'action-line');
    line.append(this.importButton, this.removeButton);
    this.advanced.append(element('summary', '', uiText('高级')), this.details, line);
    const statusLine = element('div', 'action-line');
    statusLine.append(this.status, this.cancelButton, this.retryButton);
    root.replaceChildren(this.question, statusLine, this.notice, this.advanced);
    const run = (work: () => Promise<LocalAsrView | void>) => () => void work().then(view => { if (view) this.render(view); }, error => this.ports.error(String(error)));
    this.downloadButton.onclick = run(() => this.ports.download());
    this.retryButton.onclick = run(() => this.ports.download());
    this.laterButton.onclick = run(() => this.ports.dismiss());
    this.cancelButton.onclick = run(() => this.ports.cancel());
    this.importLink.onclick = this.importButton.onclick = run(() => this.ports.importFiles());
    this.removeButton.onclick = run(() => this.ports.remove());
    this.unsubscribe = ports.changed(value => { const view = parseLocalAsrView(value); if (view) this.render(view); });
    void ports.get().then(view => this.render(view), () => { root.hidden = true; });
  }

  render(view: LocalAsrView): void {
    const previousPrompt = this.view?.prompt;
    const askedAgain = !!this.view && (view.asked ?? 0) > (this.view.asked ?? 0);
    this.view = view;
    this.root.hidden = view.phase === 'unsupported';
    if (view.phase === 'unsupported') return;
    const asking = view.prompt && view.phase === 'not-installed';
    this.question.hidden = !asking;
    this.questionText.textContent = asking ? localAsrPromptText(view) : '';
    this.status.textContent = localAsrStatusText(view);
    this.cancelButton.hidden = view.phase !== 'downloading';
    this.retryButton.hidden = !(view.phase === 'not-installed' && (view.notice === 'download-failed' || view.notice === 'verify-failed'));
    this.notice.textContent = localAsrNoticeText(view.notice);
    this.notice.hidden = !view.notice;
    this.details.textContent = localAsrDetailsText(view);
    const busy = view.phase === 'downloading' || view.phase === 'installing';
    this.removeButton.hidden = !view.installedBytes;
    for (const button of [this.downloadButton, this.importButton, this.importLink, this.removeButton]) button.disabled = busy;
    if ((asking && !previousPrompt) || askedAgain) { this.ports.reveal?.(); this.root.scrollIntoView?.({ block: 'nearest' }); }
  }

  dispose(): void { this.unsubscribe(); }
}
