import { uiText } from './ui-language';
export interface ScreenSharingOptionsState {
  screenSharing: boolean;
  cameraSharing: boolean;
  /** R09 自动截图, retired (识图第 1 步): kept so the host's state still spreads in; never shown, always false. */
  autoCapture: boolean;
  /** R09's interval, retired with it. */
  intervalSeconds: number;
  proactiveVision: boolean;
}

/** Only R10 根据画面主动聊天 is a choice here now. */
export type ScreenSharingOptionsPatch = Partial<Pick<ScreenSharingOptionsState, "proactiveVision">>;

export const DEFAULT_SCREEN_SHARING_OPTIONS: Readonly<ScreenSharingOptionsState> = {
  screenSharing: false,
  cameraSharing: false,
  autoCapture: false,
  intervalSeconds: 10,
  proactiveVision: true,
};

/** What sharing the screen means now (屏幕只读大概): the rough picture only, the whole screen when asked; nothing is saved. */
export const SCREEN_LOOK_HINT = "共享开着时，她平时只知道你大概在做什么（看前台是什么程序，不读窗口标题；认不出的程序，比如浏览器，会拍一张很小的图让小模型认一下，用完就丢）。你叫她看（说“你看看这个”，或点“给她看看屏幕”）时才看清整屏；她想看清时会先问你。不保存截图，关掉共享就全部清空。";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
};
let nextInstance = 0;

/** Runtime-only controls. Capturing and model requests are owned by the host. */
export class ScreenSharingOptions {
  private readonly root = element("section", "screen-sharing-options");
  private readonly screen = element("div", "screen-sharing-options-screen");
  private readonly proactive = element("input");
  private state: ScreenSharingOptionsState = { ...DEFAULT_SCREEN_SHARING_OPTIONS };
  /** I-028: closed with the pet's toolbar; shows again only when screen or camera sharing next starts. */
  private closed = false;
  private disposed = false;

  constructor(parent: HTMLElement, private readonly onChange: (patch: ScreenSharingOptionsPatch) => void) {
    const prefix = `screen-sharing-options-${++nextInstance}`;
    this.root.setAttribute("aria-label", uiText("画面共享选项"));

    const hint = element("p", "screen-sharing-options-hint", uiText(SCREEN_LOOK_HINT));
    hint.id = `${prefix}-hint`;
    hint.dataset.screenOption = "lookHint";
    this.screen.append(hint);

    this.proactive.type = "checkbox";
    this.proactive.id = `${prefix}-proactive`;
    this.proactive.dataset.screenOption = "proactiveVision";
    const proactiveLabel = element("label", "screen-sharing-options-toggle");
    proactiveLabel.append(this.proactive, element("span", "", uiText("根据画面主动聊天")));
    const proactiveHint = element("p", "screen-sharing-options-hint", uiText("只在角色想找你聊聊时使用已开启的画面，沿用主动发言间隔。"));
    proactiveHint.id = `${prefix}-proactive-hint`;
    this.proactive.setAttribute("aria-describedby", proactiveHint.id);
    this.root.append(this.screen, proactiveLabel, proactiveHint);
    parent.append(this.root);

    this.proactive.onchange = () => {
      if (this.disposed || (!this.state.screenSharing && !this.state.cameraSharing)) return;
      const proactiveVision = this.proactive.checked;
      if (proactiveVision === this.state.proactiveVision) return;
      this.state = { ...this.state, proactiveVision };
      this.onChange({ proactiveVision });
    };
    this.refresh();
  }

  update(state: ScreenSharingOptionsState): void {
    if (this.disposed) return;
    if ((state.screenSharing && !this.state.screenSharing) || (state.cameraSharing && !this.state.cameraSharing)) this.closed = false;
    this.state = { ...state };
    this.refresh();
  }

  get isOpen(): boolean { return !this.disposed && !this.root.hidden; }

  /** I-028: hides the options; sharing and every option stay as they are, and nothing is sent. */
  close(): void {
    if (this.disposed) return;
    this.closed = true;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proactive.onchange = null;
    this.root.remove();
  }

  private refresh(): void {
    this.root.hidden = this.closed || (!this.state.screenSharing && !this.state.cameraSharing);
    this.screen.hidden = !this.state.screenSharing;
    this.proactive.checked = this.state.proactiveVision;
    this.proactive.disabled = this.root.hidden;
  }
}
