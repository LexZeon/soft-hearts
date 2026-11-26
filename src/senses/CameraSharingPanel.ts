import { uiText } from '../foundation/ui-language';
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { RuntimePatch, RuntimeState } from '../../shared/foundation/runtime-state';

/**
 * I-036: the companion's camera button expands this panel with the two independent camera switches. The control window's
 * privacy page shows the same two switches as rows (src/settings/layout.ts) with the same words.
 *
 * Only the user's own click changes a switch here; the host decides (electron/senses/media-runtime.ts) and a refused 「姿势识别」 (component not
 * downloaded) says why in the window, as before. Nothing in this panel touches the camera itself.
 */
export const CAMERA_GROUP_TITLE = '摄像头共享';
export const CAMERA_GROUP_HINT = '两个开关各管各的：可以都开、只开一个，或都不开。';
export const CAMERA_IMAGES_TITLE = '发图片';
export const CAMERA_IMAGES_HINT = '开着时她能看你：平时发消息不附图，她用的是自己看你一眼时记下的一句话（十分钟内）；叫她“看看我”、问她你的样子或点「拍一张给她看」时，发清楚的一张。不用下载，不保存。';
export const CAMERA_POSE_TITLE = '姿势识别（本机）';
/** I-081: lists everything pose sensing recognises (shared/senses/pose-signals.ts POSE_RECOGNISES), and that turning it on is consent. */
export const CAMERA_POSE_HINT = '识别你在不在、朝向、坐着还是站着、动作幅度、挥手，以及你在画面里的位置、离屏幕大概多远和身体各个点的坐标；只在这台电脑上算，不保存、不上传，画面不离开电脑。打开就算你同意她用这些；第一次要下载本地识别组件。';
export const CAMERA_BOTH_HINT = '两个都开时，她平时知道识别出的姿势和她自己看你一眼时记下的话；叫她看时才附图。';
export const CAMERA_HELD_HINT = '你说了先别看：小图暂停，叫她“看看我”就恢复。';

// The English of the words shared with the control window's rows is in shared/foundation/ui-copy.settings.en.ts.
registerUiMessages({ 'zh-CN': {}, en: {
  [CAMERA_HELD_HINT]: 'You asked her not to look: small pictures are paused until you ask her to look at you.',
} });

/** The camera button's tooltip words after "摄像头共享：" (what is on; the button only expands the panel). */
export function cameraWords(state: Pick<RuntimeState, 'cameraImages' | 'cameraLocal'>): string {
  const on = [state.cameraImages === true ? uiText(CAMERA_IMAGES_TITLE) : '', state.cameraLocal === true ? uiText('姿势识别') : ''].filter(Boolean);
  return on.length ? `${on.join(' + ')}${uiText('已开，点击展开')}` : uiText('已关闭，点击展开');
}
registerUiMessages({ 'zh-CN': {}, en: { '姿势识别': 'posture sensing', '已开，点击展开': ' on · click to expand', '已关闭，点击展开': 'off · click to expand',
  '这个窗口还不能开关摄像头。': 'This window cannot switch the camera yet.',
  // The control window's privacy line (src/main.ts applyRuntime).
  '摄像头发图片 + 姿势识别': 'Camera pictures + posture sensing', '摄像头发图片': 'Camera pictures',
  '摄像头发图片已开启 · 平时发消息不附图，叫她看时发清楚的一张': 'Camera pictures on · ordinary messages carry no picture; a clear one when you ask her to look' } });

export interface CameraSharingPorts {
  /** Ask the host to change the switches (window.desktop.setRuntimeState); the reply may say why 「姿势识别」 stayed off. */
  set(patch: RuntimePatch): Promise<RuntimeState>;
  explain(reply: RuntimeState): void;
  error(message: string): void;
  /** I-190: fills the panel's 「用哪个摄像头」 section (src/stage/toolbar-sources.ts mountCamera); a pick there never turns a switch. */
  sources?(host: HTMLElement): void;
}

export class CameraSharingPanel {
  /** Built the first time the panel opens (the companion window's markup has only the empty section until then). */
  private parts: { images: HTMLInputElement; pose: HTMLInputElement; both: HTMLElement; held: HTMLElement } | null = null;
  private state: RuntimeState | null = null;
  private disposed = false;

  /** `root`: the panel (#pet-camera-panel, hidden until the button opens it); `trigger`: the companion's camera button. */
  constructor(private readonly root: HTMLElement, private readonly trigger: HTMLElement, private readonly ports: CameraSharingPorts) {
    root.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', root.id);
  }

  get isOpen(): boolean { return !this.disposed && !this.root.hidden; }

  /** The camera button: open or close the panel (never a switch by itself). */
  toggle(): void { if (this.isOpen) this.close(); else this.open(); }
  open(): void {
    if (this.disposed) return;
    this.build();
    this.root.hidden = false; this.trigger.setAttribute('aria-expanded', 'true'); this.refresh();
  }
  /** Hides the panel only; both switches stay as they are. */
  close(): void { if (this.disposed) return; this.root.hidden = true; this.trigger.setAttribute('aria-expanded', 'false'); }

  update(state: RuntimeState): void {
    if (this.disposed) return;
    this.state = { ...state };
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parts) this.parts.images.onchange = this.parts.pose.onchange = null;
  }

  private build(): void {
    if (this.parts) return;
    const doc = this.root.ownerDocument ?? document;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const row = (title: string, hint: string, key: 'cameraImages' | 'cameraLocal') => {
      const label = make('label', 'camera-sharing-toggle');
      const input = make('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.dataset.cameraSwitch = key;
      const text = make('span', 'camera-sharing-text');
      text.append(make('strong', '', uiText(title)), make('small', '', uiText(hint)));
      label.append(input, text);
      input.onchange = () => this.change(key, input);
      return { label, input };
    };
    const imagesRow = row(CAMERA_IMAGES_TITLE, CAMERA_IMAGES_HINT, 'cameraImages');
    const poseRow = row(CAMERA_POSE_TITLE, CAMERA_POSE_HINT, 'cameraLocal');
    const both = make('p', 'camera-sharing-hint', uiText(CAMERA_BOTH_HINT));
    const held = make('p', 'camera-sharing-hint', uiText(CAMERA_HELD_HINT));
    this.root.classList.add('camera-sharing-panel');
    this.root.append(make('strong', 'camera-sharing-title', uiText(CAMERA_GROUP_TITLE)), make('p', 'camera-sharing-hint', uiText(CAMERA_GROUP_HINT)),
      imagesRow.label, poseRow.label, both, held);
    if (this.ports.sources) { const section = make('div', 'camera-sharing-sources'); this.root.append(section); this.ports.sources(section); }
    this.parts = { images: imagesRow.input, pose: poseRow.input, both, held };
  }

  private change(key: 'cameraImages' | 'cameraLocal', input: HTMLInputElement): void {
    if (this.disposed) return;
    const wanted = input.checked;
    void this.ports.set({ [key]: wanted }).then(reply => {
      // A refused switch flips back (no state change is broadcast for it) and says why.
      input.checked = reply[key] === true;
      this.ports.explain(reply);
    }, error => { input.checked = this.state?.[key] === true; this.ports.error(String(error)); });
  }

  private refresh(): void {
    const parts = this.parts, state = this.state;
    if (!parts) return;
    parts.images.checked = state?.cameraImages === true;
    parts.pose.checked = state?.cameraLocal === true;
    parts.both.hidden = !(state?.cameraImages === true && state.cameraLocal === true);
    parts.held.hidden = !(state?.cameraImages === true && state.cameraHeld === true);
  }
}
