// Control-window panel for local pose sensing (I-001 stage 1): the one-line download question with the size,
// progress, status, and an "advanced" box with size / version / GPU-or-CPU, delete, offline import and re-detect.
// Everything shown is host enums and numbers turned into fixed copy; nothing from elsewhere becomes markup.
import { uiText, uiTemplate } from './ui-language';
import { registerUiMessages } from '../../shared/ui-language';
import { parsePoseView, poseMegabytes, type PoseNotice, type PoseSensingView } from '../../shared/pose-signals';

registerUiMessages({ 'zh-CN': {}, en: {
  '想让我看见你，需要先下载约 {0} MB 的本地识别组件。它只在你的电脑上运行，画面不会离开这台电脑，也不会被保存。现在下载吗？':
    'To see you I first need a local recognition component of about {0} MB. It runs only on your computer; the camera picture never leaves it and is never saved. Download it now?',
  '下载': 'Download', '以后再说': 'Not now', '取消': 'Cancel', '重试': 'Try again',
  '已有离线组件包？导入…': 'Have an offline package? Import…', '导入离线组件包…': 'Import offline package…',
  '删除感知组件': 'Delete sensing component', '重新检测硬件': 'Re-detect hardware', '高级': 'Advanced',
  '本地识别组件还没下载（约 {0} MB）。打开摄像头时会先问你。': 'The local recognition component is not downloaded yet (about {0} MB). You will be asked when you turn the camera on.',
  '正在下载本地识别组件… {0}%': 'Downloading the local recognition component… {0}%',
  '小包下载不了，改从官方地址下载（共约 {0} MB）… {1}%': 'The small package could not be downloaded, so this comes from the official sources instead (about {0} MB)… {1}%',
  '正在校验和安装…': 'Verifying and installing…',
  '本地识别组件已就绪。打开摄像头，她就能在这台电脑上看见你。': 'The local recognition component is ready. Turn the camera on and she can see you, on this computer only.',
  '正在准备本地识别（第一次会先测一下这台电脑）…': 'Getting local recognition ready (the first time it tests this computer)…',
  '摄像头感知开启中 · 画面只在本机处理，不保存、不上传': 'Camera sensing is on · the picture stays on this computer, never saved or uploaded',
  '本地识别刚才停了一下，马上重新开始…': 'Local recognition stopped for a moment and will restart shortly…',
  '下载没完成，要重试吗？': 'The download did not finish. Try again?',
  '下载的文件没通过校验，已丢弃。要重试吗？': 'A downloaded file failed verification and was discarded. Try again?',
  '选的文件里缺少一部分，或者不是需要的文件。': 'Some files are missing, or the chosen files are not the ones needed.',
  '已导入，组件已就绪。': 'Imported. The component is ready.', '已删除本地识别组件。': 'The local recognition component was deleted.',
  '打不开摄像头（可能被系统隐私设置关掉了，或者正被别的程序使用）。': 'The camera could not be opened (it may be blocked in system privacy settings or used by another app).',
  '这台电脑跑本地识别有点吃力，先暂停了。': 'Local recognition is too heavy for this computer right now, so it paused.',
  '本地识别没能正常运行，已经关掉摄像头。': 'Local recognition could not run properly, so the camera was turned off.',
  '已取消下载。': 'Download canceled.',
  '已安装 {0} MB · 组件版本 {1} · 加速：{2}': 'Installed {0} MB · component version {1} · acceleration: {2}',
  '显卡': 'GPU', '处理器': 'CPU', '自动': 'automatic',
  '摄像头感知': 'Camera sensing', '拍一张给她看': 'Snap one for her',
  '只在本机识别你在不在、朝向和动作，画面不发给 Claude；想让她看画面，点聊天框里的「拍一张给她看」': 'Recognises on this computer only whether you are there, which way you face and how you move; the picture is not sent to Claude. To show her, use “Snap one for her” in the chat box',
  '诊断（只记类别和次数）：{0}': 'Diagnostics (categories and counts only): {0}',
} });

const NOTICE: Record<Exclude<PoseNotice, ''>, string> = {
  'download-failed': '下载没完成，要重试吗？', 'verify-failed': '下载的文件没通过校验，已丢弃。要重试吗？',
  'import-incomplete': '选的文件里缺少一部分，或者不是需要的文件。', 'import-done': '已导入，组件已就绪。',
  removed: '已删除本地识别组件。', 'camera-unavailable': '打不开摄像头（可能被系统隐私设置关掉了，或者正被别的程序使用）。',
  'too-slow': '这台电脑跑本地识别有点吃力，先暂停了。', crashed: '本地识别没能正常运行，已经关掉摄像头。', canceled: '已取消下载。',
};

/** The question, exactly as the user reads it (size from the host's manifest). */
export function posePromptText(view: PoseSensingView): string {
  return uiTemplate`想让我看见你，需要先下载约 ${poseMegabytes(view.downloadBytes)} MB 的本地识别组件。它只在你的电脑上运行，画面不会离开这台电脑，也不会被保存。现在下载吗？`;
}

export function poseStatusText(view: PoseSensingView): string {
  switch (view.phase) {
    case 'unsupported': return '';
    case 'not-installed': return uiTemplate`本地识别组件还没下载（约 ${poseMegabytes(view.downloadBytes)} MB）。打开摄像头时会先问你。`;
    case 'downloading': return view.fallback
      ? uiTemplate`小包下载不了，改从官方地址下载（共约 ${poseMegabytes(view.downloadBytes)} MB）… ${Math.round((view.progress ?? 0) * 100)}%`
      : uiTemplate`正在下载本地识别组件… ${Math.round((view.progress ?? 0) * 100)}%`;
    case 'installing': return uiText('正在校验和安装…');
    case 'idle': return uiText('本地识别组件已就绪。打开摄像头，她就能在这台电脑上看见你。');
    case 'starting': return uiText('正在准备本地识别（第一次会先测一下这台电脑）…');
    case 'running': return uiText('摄像头感知开启中 · 画面只在本机处理，不保存、不上传');
    case 'restarting': return uiText('本地识别刚才停了一下，马上重新开始…');
  }
}

export function poseNoticeText(notice: PoseNotice): string { return notice ? uiText(NOTICE[notice]) : ''; }

export function poseDetailsText(view: PoseSensingView): string {
  if (!view.installedBytes) return '';
  const route = view.route === 'gpu' ? uiText('显卡') : view.route === 'cpu' ? uiText('处理器') : uiText('自动');
  return uiTemplate`已安装 ${poseMegabytes(view.installedBytes)} MB · 组件版本 ${view.componentVersion} · 加速：${route}`;
}

export interface PoseSensingPorts {
  get(): Promise<PoseSensingView>;
  changed(callback: (view: PoseSensingView) => void): () => void;
  download(): Promise<PoseSensingView>;
  cancel(): Promise<void>;
  dismiss(): Promise<PoseSensingView>;
  importFiles(): Promise<PoseSensingView>;
  remove(): Promise<PoseSensingView>;
  redetect(): Promise<PoseSensingView>;
  diagnostics(): Promise<Partial<Record<string, number>>>;
  /** Bring the privacy page into view (the question can be raised from the pet window). */
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

export class PoseSensingPanel {
  private view: PoseSensingView | null = null;
  private readonly question = element('div', 'pose-question');
  private readonly questionText = element('p');
  private readonly status = element('p', 'hint pose-status');
  private readonly notice = element('p', 'hint pose-notice');
  private readonly advanced = element('details', 'pose-advanced');
  private readonly details = element('p', 'hint');
  private readonly diagnostics = element('p', 'hint pose-diagnostics');
  private readonly downloadButton = action('下载', 'primary');
  private readonly laterButton = action('以后再说');
  private readonly cancelButton = action('取消');
  private readonly retryButton = action('重试');
  private readonly importLink = action('已有离线组件包？导入…');
  private readonly importButton = action('导入离线组件包…');
  private readonly removeButton = action('删除感知组件');
  private readonly redetectButton = action('重新检测硬件');
  private readonly unsubscribe: () => void;

  constructor(private readonly root: HTMLElement, private readonly ports: PoseSensingPorts, private readonly cameraLabel?: HTMLElement | null) {
    const buttons = element('div', 'action-line');
    buttons.append(this.downloadButton, this.laterButton);
    this.question.append(this.questionText, buttons, this.importLink);
    const summary = element('summary', '', uiText('高级'));
    const line = element('div', 'action-line');
    line.append(this.importButton, this.removeButton, this.redetectButton);
    this.advanced.append(summary, this.details, line, this.diagnostics);
    const statusLine = element('div', 'action-line');
    statusLine.append(this.status, this.cancelButton, this.retryButton);
    root.replaceChildren(this.question, statusLine, this.notice, this.advanced);
    const run = (work: () => Promise<PoseSensingView | void>) => () => void work().then(view => { if (view) this.render(view); }, error => this.ports.error(String(error)));
    this.downloadButton.onclick = run(() => this.ports.download());
    this.retryButton.onclick = run(() => this.ports.download());
    this.laterButton.onclick = run(() => this.ports.dismiss());
    this.cancelButton.onclick = run(() => this.ports.cancel());
    this.importLink.onclick = this.importButton.onclick = run(() => this.ports.importFiles());
    this.removeButton.onclick = run(() => this.ports.remove());
    this.redetectButton.onclick = run(() => this.ports.redetect());
    this.advanced.addEventListener('toggle', () => { if (this.advanced.open) void this.refreshDiagnostics(); });
    this.unsubscribe = ports.changed(value => { const view = parsePoseView(value); if (view) this.render(view); });
    void ports.get().then(view => this.render(view), () => { root.hidden = true; });
  }

  private async refreshDiagnostics(): Promise<void> {
    const counts = await this.ports.diagnostics().catch(() => ({}));
    const text = Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(' · ');
    this.diagnostics.textContent = text ? uiTemplate`诊断（只记类别和次数）：${text}` : '';
    this.diagnostics.hidden = !text;
  }

  render(view: PoseSensingView): void {
    const previousPrompt = this.view?.prompt;
    // A new refused camera request (from either window) brings the panel into view again, not only the first one.
    const askedAgain = !!this.view && (view.asked ?? 0) > (this.view.asked ?? 0);
    this.view = view;
    this.root.hidden = view.phase === 'unsupported';
    // I-036: the 「姿势识别」 row (its words are src/ui/layout.ts's); where there is no component package it cannot be turned on.
    if (this.cameraLabel) this.cameraLabel.hidden = view.phase === 'unsupported';
    if (view.phase === 'unsupported') return;
    const asking = view.prompt && view.phase === 'not-installed';
    this.question.hidden = !asking;
    this.questionText.textContent = asking ? posePromptText(view) : '';
    this.status.textContent = poseStatusText(view);
    this.cancelButton.hidden = view.phase !== 'downloading';
    this.retryButton.hidden = !(view.phase === 'not-installed' && (view.notice === 'download-failed' || view.notice === 'verify-failed'));
    this.notice.textContent = poseNoticeText(view.notice);
    this.notice.hidden = !view.notice;
    this.details.textContent = poseDetailsText(view);
    const busy = view.phase === 'downloading' || view.phase === 'installing';
    this.removeButton.hidden = !view.installedBytes;
    this.redetectButton.hidden = !view.installedBytes;
    for (const button of [this.downloadButton, this.importButton, this.importLink, this.removeButton, this.redetectButton]) button.disabled = busy;
    // (While it is still downloading, this shows the progress line instead of the question.)
    if ((asking && !previousPrompt) || askedAgain) { this.ports.reveal?.(); this.root.scrollIntoView?.({ block: 'nearest' }); }
  }

  dispose(): void { this.unsubscribe(); }
}
