// I-006 第 1 步 in the control window's 「隐私与设置」: the switch 「知道你是不是在忙」 (default ON). It says plainly what is read: only how many
// seconds since the keyboard or mouse was last touched (plus screen lock, sleep and whether her own window has the focus), never which
// key, which window or where the pointer went. Off: nothing is read, not even once.
import { registerUiMessages } from '../../shared/ui-language';
import type { UserActivitySwitchView } from '../../shared/behaviors/user-activity/interface';
import { uiText } from './ui-language';

registerUiMessages({
  en: {
    '知道你是不是在忙': 'Know whether you are busy',
    '你专心做事时，她安静下来做自己的事': 'When you are absorbed in something, she goes quiet and does her own things',
    '只读“距你上次动键盘鼠标过了多少秒”，再加上有没有锁屏、电脑有没有睡眠、她的窗口有没有拿到焦点。不知道你按了什么键、在哪个窗口、鼠标去了哪里；什么都不记录，也不发给任何人。你专心做事时她更安静，更常发呆、想事情。关掉以后一次都不读，她和以前一样。':
      'It reads only how many seconds it has been since you last touched the keyboard or mouse, plus whether the screen is locked, the computer is asleep and one of her windows has the focus. It does not know which key you pressed, which window you are in or where the pointer went; nothing is recorded or sent anywhere. While you are absorbed she is quieter and daydreams and thinks more. Turned off, nothing is read, not even once, and she is as before.',
    '正在读取…': 'Loading…', '正在切换…': 'Switching…',
    '已开启 · 只读多少秒没动键盘鼠标': 'On · reads only the seconds since the last key or mouse touch', '已关闭 · 一次都不读': 'Off · nothing is read',
  },
  'zh-CN': {},
});

export interface UserActivityPanelPorts {
  get(): Promise<UserActivitySwitchView>;
  set(enabled: boolean): Promise<UserActivitySwitchView>;
  changed?(callback: (view: UserActivitySwitchView) => void): () => void;
  error?(message: string): void;
}

export function userActivityStatus(view: UserActivitySwitchView | null, busy = false): string {
  if (busy) return uiText('正在切换…');
  if (!view) return uiText('正在读取…');
  return view.enabled ? uiText('已开启 · 只读多少秒没动键盘鼠标') : uiText('已关闭 · 一次都不读');
}

export class UserActivityPanel {
  private readonly toggle: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private view: UserActivitySwitchView | null = null;
  private busy = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(root: HTMLElement, private readonly ports: UserActivityPanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('知道你是不是在忙');
    const row = doc.createElement('label'); row.className = 'toggle-row';
    const copy = doc.createElement('span');
    const title = doc.createElement('strong'); title.textContent = uiText('你专心做事时，她安静下来做自己的事');
    const hint = doc.createElement('small');
    hint.textContent = uiText('只读“距你上次动键盘鼠标过了多少秒”，再加上有没有锁屏、电脑有没有睡眠、她的窗口有没有拿到焦点。不知道你按了什么键、在哪个窗口、鼠标去了哪里；什么都不记录，也不发给任何人。你专心做事时她更安静，更常发呆、想事情。关掉以后一次都不读，她和以前一样。');
    copy.append(title, hint);
    this.toggle = doc.createElement('input');
    this.toggle.type = 'checkbox'; this.toggle.id = 'user-activity-enabled'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.set(this.toggle.checked); };
    row.append(copy, this.toggle);
    this.status = doc.createElement('p'); this.status.className = 'hint'; this.status.setAttribute('role', 'status');
    root.replaceChildren(heading, row, this.status);
    let off: (() => void) | null = null;
    try { off = ports.changed?.(view => { this.view = view; this.render(); }) ?? null; } catch { off = null; }
    this.unsubscribe = off;
    this.render();
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error?.(String(error)); this.render(); });
  }

  dispose(): void { this.unsubscribe?.(); }

  private async set(enabled: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await this.ports.set(enabled); }
    catch (error) { this.ports.error?.(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    this.toggle.checked = !!this.view?.enabled;
    this.toggle.disabled = !this.view || this.busy;
    this.status.textContent = userActivityStatus(this.view, this.busy);
  }
}
