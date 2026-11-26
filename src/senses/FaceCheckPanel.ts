// I-135 认出"不是你": the control window's switch under 「摄像头共享」, with the plain-words explanation beside it, enrolment,
// one-click delete and an advanced box (offline import, delete the models). Everything shown is host enums and counts turned
// into fixed copy; nothing from elsewhere becomes markup.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { parseFaceCheckView, parseFaceEnrolPreviewMessage, type FaceCheckNotice, type FaceCheckView } from '../../shared/senses/face-check';
import { FaceEnrolPreviewView } from './FaceEnrolPreview';

registerUiMessages({ 'zh-CN': {}, en: {
  '认出是不是你（Beta）': 'Recognise whether it is you (Beta)',
  '打开后，摄像头开着时她会在这台电脑上看一眼是不是你。坐在电脑前的人明显不是你时，她会客气一点、疏远一点，偏爱只给你。拿不准时都当成是你。':
    'When this is on and the camera is on, she checks on this computer whether it is you. When the person at the computer is clearly not you, she is a little more polite and distant: her fondness is for you only. When unsure, it counts as you.',
  '只记你自己的脸，记的是一串数字，不是照片；只存在这台电脑上，加密保存，随时一键删除。它只判断"是不是你"，不认别人是谁，也不存别人。默认关闭；第一次打开要下载约 {0} MB 的识别组件。':
    'Only your own face is kept, as a list of numbers, not a photo; only on this computer, encrypted, deletable with one click. It only decides "is it you", never who anyone else is, and stores nobody else. Off by default; the first time it downloads a recognition component of about {0} MB.',
  '登记我的脸': 'Enrol my face', '重新登记': 'Enrol again', '取消': 'Cancel', '重试下载': 'Retry download', '删除我的脸部数据': 'Delete my face data',
  '高级': 'Advanced', '导入离线组件包…': 'Import offline package…', '删除识别组件': 'Delete recognition component',
  '正在下载识别组件… {0}%': 'Downloading the recognition component… {0}%', '正在校验和安装…': 'Verifying and installing…',
  '还没登记你的脸。打开摄像头（发图片或姿势识别），再点「登记我的脸」，看着摄像头几秒就好。': 'Your face is not enrolled yet. Turn the camera on (pictures or pose), then click “Enrol my face” and look at the camera for a few seconds.',
  '请看着摄像头… {0}%': 'Please look at the camera… {0}%',
  '已登记（{0} 组数字）。摄像头开着时，她会隔几秒看一眼是不是你。': 'Enrolled ({0} sets of numbers). While the camera is on she checks every few seconds whether it is you.',
  '已登记（{0} 组数字）。摄像头关着，现在不会看。': 'Enrolled ({0} sets of numbers). The camera is off, so nothing is checked now.',
  '已登记好了。': 'Enrolled.', '没登记成功：要正对摄像头、光线亮一点，再试一次。什么都没保存。': 'Enrolment did not work: face the camera in better light and try again. Nothing was saved.',
  '先打开摄像头（发图片或姿势识别），再登记。': 'Turn the camera on first (pictures or pose), then enrol.',
  '这台电脑没有可用的加密存储，所以不登记（不会明文保存）。': 'This computer has no secure storage available, so nothing is enrolled (it is never saved in the clear).',
  '已删除你的脸部数据，开关已关。': 'Your face data was deleted and the switch is off.',
  '下载没完成，要重试吗？': 'The download did not finish. Try again?', '下载的文件没通过校验，已丢弃。要重试吗？': 'A downloaded file failed verification and was discarded. Try again?',
  '已取消下载，开关已关。': 'Download canceled; the switch is off.', '已删除识别组件。': 'The recognition component was deleted.',
  '识别没能正常运行，先停了。关掉再打开开关可以重试。': 'Recognition could not run properly and stopped. Turn the switch off and on to retry.',
  '已安装 {0} MB': 'Installed {0} MB', '摄像头在用于认出是不是你': 'The camera is being used to recognise whether it is you',
} });

const NOTICE: Record<Exclude<FaceCheckNotice, ''>, string> = {
  'download-failed': '下载没完成，要重试吗？', 'verify-failed': '下载的文件没通过校验，已丢弃。要重试吗？', canceled: '已取消下载，开关已关。',
  removed: '已删除识别组件。', failed: '识别没能正常运行，先停了。关掉再打开开关可以重试。', enrolled: '已登记好了。',
  'enrol-failed': '没登记成功：要正对摄像头、光线亮一点，再试一次。什么都没保存。', 'enrol-needs-camera': '先打开摄像头（发图片或姿势识别），再登记。',
  'no-encryption': '这台电脑没有可用的加密存储，所以不登记（不会明文保存）。', deleted: '已删除你的脸部数据，开关已关。',
};

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

/** The explanation beside the switch (what is stored, where, deleting, off by default, only "is it you"). */
export function faceExplainText(view: FaceCheckView): string {
  return uiText('打开后，摄像头开着时她会在这台电脑上看一眼是不是你。坐在电脑前的人明显不是你时，她会客气一点、疏远一点，偏爱只给你。拿不准时都当成是你。') + ' '
    + uiTemplate`只记你自己的脸，记的是一串数字，不是照片；只存在这台电脑上，加密保存，随时一键删除。它只判断"是不是你"，不认别人是谁，也不存别人。默认关闭；第一次打开要下载约 ${megabytes(view.downloadBytes)} MB 的识别组件。`;
}

export function faceStatusText(view: FaceCheckView): string {
  if (view.phase === 'unsupported' || !view.enabled) return '';
  if (view.phase === 'downloading') return uiTemplate`正在下载识别组件… ${Math.round((view.progress ?? 0) * 100)}%`;
  if (view.phase === 'installing') return uiText('正在校验和安装…');
  if (view.phase === 'not-installed') return '';
  if (view.enrolling !== null) return uiTemplate`请看着摄像头… ${Math.round(view.enrolling * 100)}%`;
  if (!view.enrolled) return uiText('还没登记你的脸。打开摄像头（发图片或姿势识别），再点「登记我的脸」，看着摄像头几秒就好。');
  return view.camera ? uiTemplate`已登记（${view.enrolled} 组数字）。摄像头开着时，她会隔几秒看一眼是不是你。` : uiTemplate`已登记（${view.enrolled} 组数字）。摄像头关着，现在不会看。`;
}

export function faceNoticeText(notice: FaceCheckNotice): string { return notice ? uiText(NOTICE[notice]) : ''; }

export interface FaceCheckPorts {
  get(): Promise<FaceCheckView>;
  changed(callback: (view: FaceCheckView) => void): () => void;
  set(on: boolean): Promise<FaceCheckView>;
  download(): Promise<FaceCheckView>;
  cancelDownload(): Promise<void>;
  enrol(): Promise<FaceCheckView>;
  cancelEnrol(): Promise<FaceCheckView>;
  deleteData(): Promise<FaceCheckView>;
  importFiles(): Promise<FaceCheckView>;
  remove(): Promise<FaceCheckView>;
  error(message: string): void;
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};
const action = (label: string, cls = 'subtle') => { const b = element('button', cls, uiText(label)); b.type = 'button'; return b; };

export class FaceCheckPanel {
  private readonly toggle = element('input');
  private readonly explain = element('small', 'hint');
  private readonly status = element('p', 'hint pose-status');
  private readonly notice = element('p', 'hint pose-notice');
  private readonly enrolButton = action('登记我的脸', 'primary');
  private readonly cancelEnrolButton = action('取消');
  private readonly cancelDownloadButton = action('取消');
  private readonly retryButton = action('重试下载');
  private readonly deleteButton = action('删除我的脸部数据');
  private readonly advanced = element('details', 'pose-advanced');
  private readonly preview = new FaceEnrolPreviewView();
  private readonly details = element('p', 'hint');
  private readonly importButton = action('导入离线组件包…');
  private readonly removeButton = action('删除识别组件');
  private readonly unsubscribe: () => void;

  constructor(private readonly root: HTMLElement, private readonly ports: FaceCheckPorts) {
    this.toggle.type = 'checkbox'; this.toggle.id = 'face-check-toggle';
    const label = element('label', 'toggle');
    const words = element('span');
    words.append(element('strong', '', uiText('认出是不是你（Beta）')), this.explain);
    label.append(this.toggle, words);
    const actions = element('div', 'action-line');
    actions.append(this.enrolButton, this.cancelEnrolButton, this.cancelDownloadButton, this.retryButton, this.deleteButton);
    const advancedLine = element('div', 'action-line');
    advancedLine.append(this.importButton, this.removeButton);
    this.advanced.append(element('summary', '', uiText('高级')), this.details, advancedLine);
    root.replaceChildren(label, this.status, this.preview.element, actions, this.notice, this.advanced);
    const run = (work: () => Promise<FaceCheckView | void>) => () => void work().then(view => { if (view) this.render(view); }, error => this.ports.error(String(error)));
    this.toggle.onchange = run(() => this.ports.set(this.toggle.checked));
    this.enrolButton.onclick = run(() => this.ports.enrol());
    this.cancelEnrolButton.onclick = run(() => this.ports.cancelEnrol());
    this.cancelDownloadButton.onclick = run(() => this.ports.cancelDownload());
    this.retryButton.onclick = run(() => this.ports.download());
    this.deleteButton.onclick = run(() => this.ports.deleteData());
    this.importButton.onclick = run(() => this.ports.importFiles());
    this.removeButton.onclick = run(() => this.ports.remove());
    this.unsubscribe = ports.changed(value => {
      const shown = parseFaceEnrolPreviewMessage(value); // the live enrolment picture rides the same channel in its own wrapper
      if (shown) { this.preview.render(shown.enrolPreview); return; }
      const view = parseFaceCheckView(value); if (view) this.render(view);
    });
    void ports.get().then(view => { const parsed = parseFaceCheckView(view); if (parsed) this.render(parsed); else root.hidden = true; }, () => { root.hidden = true; });
  }

  render(view: FaceCheckView): void {
    this.root.hidden = view.phase === 'unsupported';
    if (view.phase === 'unsupported') return;
    this.toggle.checked = view.enabled;
    this.explain.textContent = faceExplainText(view);
    this.status.textContent = faceStatusText(view);
    this.status.hidden = !this.status.textContent;
    this.notice.textContent = faceNoticeText(view.notice);
    this.notice.hidden = !view.notice;
    const installed = !(view.phase === 'not-installed' || view.phase === 'downloading' || view.phase === 'installing');
    const enrolling = view.enrolling !== null;
    this.enrolButton.hidden = !view.enabled || !installed || enrolling;
    this.enrolButton.textContent = uiText(view.enrolled ? '重新登记' : '登记我的脸');
    this.enrolButton.disabled = !view.camera;
    this.cancelEnrolButton.hidden = !enrolling;
    if (!enrolling) this.preview.render(null); // the picture closes the moment enrolment ends
    this.cancelDownloadButton.hidden = view.phase !== 'downloading';
    this.retryButton.hidden = !(view.enabled && view.phase === 'not-installed');
    this.deleteButton.hidden = !view.enrolled && !view.enabled;
    this.details.textContent = view.installedBytes ? uiTemplate`已安装 ${megabytes(view.installedBytes)} MB` : '';
    this.removeButton.hidden = !view.installedBytes;
    const busy = view.phase === 'downloading' || view.phase === 'installing';
    for (const button of [this.importButton, this.removeButton]) button.disabled = busy;
  }

  dispose(): void { this.unsubscribe(); }
}

/**
 * The small light near her (companion window): on while the camera is being used for face checks. Only the view's `active`
 * boolean is read; the element is created here and has a fixed title.
 */
export function mountFaceCheckLight(host: HTMLElement, ports: { get(): Promise<FaceCheckView>; changed(callback: (view: FaceCheckView) => void): () => void }): () => void {
  const light = element('span', 'face-check-light');
  light.setAttribute('role', 'status');
  light.title = uiText('摄像头在用于认出是不是你');
  light.setAttribute('aria-label', light.title);
  light.hidden = true;
  host.append(light);
  const show = (value: unknown) => { const view = parseFaceCheckView(value); if (view) light.hidden = !view.active; }; // anything else on the channel (the enrolment picture) is ignored
  const unsubscribe = ports.changed(show);
  void ports.get().then(show, () => { light.hidden = true; });
  return () => { unsubscribe(); light.remove(); };
}
