// 「还在试用的功能」 in the control window's 「隐私与设置」: one switch each for what the stable channel keeps off until the user turns it on
// (shared/foundation/channel-defaults.ts; docs/claude/2026-11-19-stable-defaults.md). The host decides what each one does and what is on by
// default; this page only shows the switch and the words, and saves the user's click (a saved choice always wins over the channel's default).
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { ChannelGateId, ChannelGatesView } from '../../shared/foundation/channel-defaults';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: {
    '还在试用的功能': 'Features still on trial',
    '稳定版里这些先关着，你想试再打开；开发版里它们本来就开着。': 'The stable version keeps these off until you want to try them; the development version has them on already.',
    '让她出来（Unbound）': 'Let her come out (Unbound)',
    '打开后，托盘里的「让她出来」、控制窗口的按钮和 Ctrl+Alt+U 才会出现、才能用。进去前仍会先列出要打开的权限，你确认了才开；关掉它不影响已经开着的她。':
      'When on, the tray item 「Let her come out」, the control window button and Ctrl+Alt+U appear and work. A page listing the permissions still comes first and nothing opens until you confirm; turning this off does not send her back if she is already out.',
    '碰了才软': 'Soft only where touched',
    '打开后，你按住或拉她身体时，被碰的那一小块会轻轻陷下去、松手弹回来；不碰时她和现在一模一样。关着时拉她的动作照常，只是不陷下去。':
      'When on, the small spot you press or pull on her body dents softly and springs back on release; untouched, she looks exactly as now. Off, pulling her still works, without the dent.',
    '三人同框（Beta）': 'Three on stage (Beta)',
    '打开后，「让她出来」的全屏里可以请最多三位角色同时在场，每位都能说话、被点、被拉；默认还是只有和你说话的那位。还在试用（Beta）：三位都在时，你说一句最多会用三次 Claude 和三份朗读。关掉时，台上多出来的人会先走出屏幕再回去。':
      'When on, the full-screen can have up to three characters on stage at once; each can talk, be clicked and be pulled. By default it is still only the one you talk with. Still on trial (Beta): with all three out, one thing you say can use up to three Claude calls and three read-alouds. Turning it off sends the extra ones off the screen first.',
    '她们都能接话': 'They can answer each other',
    '三人同框时，台上每说完一句，另外几位各自用一次 haiku 判断要不要接，想接的先接，接话可以一直接下去，都由她们自己定。三位都在时，你说一句最多会用三次 Claude 和三份朗读。关掉时只有你点的那位回你，她们之间也不接话。':
      'With three on stage, after each line the others each ask a small model (haiku) once whether to answer; whoever wants to goes first, and it can go on as long as they choose. With all three out, one thing you say can use up to three Claude calls and three read-alouds. Off: only the one you clicked answers you, and they do not answer each other.',
    '已开启': 'On', '已关闭': 'Off', '正在读取…': 'Loading…', '正在切换…': 'Switching…',
  },
  'zh-CN': {},
});

export interface ChannelGatesPanelPorts {
  get(): Promise<ChannelGatesView>;
  set(id: ChannelGateId, on: boolean): Promise<ChannelGatesView>;
  error?(message: string): void;
}

interface Row { id: ChannelGateId; input: HTMLInputElement; status: HTMLElement }

const ROWS: readonly { id: ChannelGateId; inputId?: string; title: string; hint: string }[] = [
  { id: 'unboundEntry', title: '让她出来（Unbound）', hint: '打开后，托盘里的「让她出来」、控制窗口的按钮和 Ctrl+Alt+U 才会出现、才能用。进去前仍会先列出要打开的权限，你确认了才开；关掉它不影响已经开着的她。' },
  { id: 'threeOnStage', inputId: 'channel-gate-three-on-stage', title: '三人同框（Beta）', hint: '打开后，「让她出来」的全屏里可以请最多三位角色同时在场，每位都能说话、被点、被拉；默认还是只有和你说话的那位。还在试用（Beta）：三位都在时，你说一句最多会用三次 Claude 和三份朗读。关掉时，台上多出来的人会先走出屏幕再回去。' },
  { id: 'chimeIn', inputId: 'channel-gate-chime-in', title: '她们都能接话', hint: '三人同框时，台上每说完一句，另外几位各自用一次 haiku 判断要不要接，想接的先接，接话可以一直接下去，都由她们自己定。三位都在时，你说一句最多会用三次 Claude 和三份朗读。关掉时只有你点的那位回你，她们之间也不接话。' },
  { id: 'touchSoft', title: '碰了才软', hint: '打开后，你按住或拉她身体时，被碰的那一小块会轻轻陷下去、松手弹回来；不碰时她和现在一模一样。关着时拉她的动作照常，只是不陷下去。' },
];

export function channelGateStatus(view: ChannelGatesView | null, id: ChannelGateId, busy = false): string {
  if (busy) return uiText('正在切换…');
  if (!view) return uiText('正在读取…');
  return uiText(view[id].on ? '已开启' : '已关闭');
}

export class ChannelGatesPanel {
  private view: ChannelGatesView | null = null;
  private busy: ChannelGateId | null = null;
  private readonly rows: Row[] = [];

  constructor(root: HTMLElement, private readonly ports: ChannelGatesPanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('还在试用的功能');
    const intro = doc.createElement('p'); intro.className = 'hint'; intro.textContent = uiText('稳定版里这些先关着，你想试再打开；开发版里它们本来就开着。');
    root.replaceChildren(heading, intro);
    for (const row of ROWS) {
      const label = doc.createElement('label'); label.className = 'toggle-row';
      const copy = doc.createElement('span');
      const title = doc.createElement('strong'); title.textContent = uiText(row.title);
      const hint = doc.createElement('small'); hint.textContent = uiText(row.hint);
      copy.append(title, hint);
      const input = doc.createElement('input');
      input.type = 'checkbox'; input.id = row.inputId ?? (row.id === 'unboundEntry' ? 'channel-gate-unbound-entry' : 'channel-gate-touch-soft'); input.setAttribute('role', 'switch'); input.disabled = true;
      input.onchange = () => { void this.set(row.id, input.checked); };
      label.append(copy, input);
      const status = doc.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
      root.append(label, status);
      this.rows.push({ id: row.id, input, status });
    }
    this.render();
    void ports.get().then(view => { this.view = view; this.render(); }, error => { this.ports.error?.(String(error)); this.render(); });
  }

  private async set(id: ChannelGateId, on: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = id; this.render();
    try { this.view = await this.ports.set(id, on); }
    catch (error) { this.ports.error?.(String(error)); }
    finally { this.busy = null; this.render(); }
  }

  private render(): void {
    for (const row of this.rows) {
      row.input.checked = this.view?.[row.id].on ?? false;
      row.input.disabled = !this.view || this.busy !== null;
      row.status.textContent = channelGateStatus(this.view, row.id, this.busy === row.id);
    }
  }
}
