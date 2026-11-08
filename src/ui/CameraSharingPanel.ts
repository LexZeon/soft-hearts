import { uiText } from './ui-language';
import { registerUiMessages } from '../../shared/ui-language';
import type { RuntimePatch, RuntimeState } from '../../shared/contracts';

/**
 * I-036: the pet's camera button expands this panel with the two independent camera switches. The control window's
 * privacy page shows the same two switches as rows (src/ui/layout.ts) with the same words.
 *
 * Only the user's own click changes a switch here; the host decides (electron/runtime.ts) and a refused 「姿势识别」 (component not
 * downloaded) says why in the window, as before. Nothing in this panel touches the camera itself.
 */
export const CAMERA_GROUP_TITLE = '摄像头共享';
export const CAMERA_GROUP_HINT = '两个开关各管各的：可以都开、只开一个，或都不开。';
export const CAMERA_IMAGES_TITLE = '发图片';
export const CAMERA_IMAGES_HINT = '你发消息时附一张很小的画面（约 320×240），她能看出你在不在、表情和大概姿势；叫她“看看我”或点「拍一张给她看」时发清楚的一张。不用下载，不保存。';
export const CAMERA_POSE_TITLE = '姿势识别（本机）';
export const CAMERA_POSE_HINT = '只在这台电脑上识别你在不在、朝向和动作，画面不离开电脑；第一次要下载本地识别组件。';
export const CAMERA_BOTH_HINT = '两个都开时，姿势有明显变化（或十分钟没发过）才附小图，其余时候她只知道识别出的姿势。';
export const CAMERA_HELD_HINT = '你说了先别看：小图暂停，叫她“看看我”就恢复。';

// The English of the words shared with the control window's rows is in shared/ui-copy.settings.en.ts.
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
  '摄像头发图片已开启 · 你发消息时附一张小图，叫她看时发清楚的一张': 'Camera pictures on · each message carries a small picture; a clear one when you ask her to look' } });

export interface CameraSharingPorts {
  /** Ask the host to change the switches (window.desktop.setRuntimeState); the reply may say why 「姿势识别」 stayed off. */
  set(patch: RuntimePatch): Promise<RuntimeState>;
  explain(reply: RuntimeState): void;
  error(message: string): void;
}

export class CameraSharingPanel {
  /** Built the first time the panel opens (the pet window's markup has only the empty section until then). */
  private parts: { images: HTMLInputElement; pose: HTMLInputElement; both: HTMLElement; held: HTMLElement } | null = null;
  private state: RuntimeState | null = null;
  private disposed = false;

  /** `root`: the panel (#pet-camera-panel, hidden until the button opens it); `trigger`: the pet's camera button. */
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
