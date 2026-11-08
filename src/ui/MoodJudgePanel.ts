// I-027 in the control window's 「隐私与设置」: the switch "心情调整员" (default OFF: it spends the user's Claude quota). Off: her mood
// follows the app's own rules exactly as before and nothing is ever asked.
import { registerUiMessages } from '../../shared/ui-language';
import type { MoodJudgeSwitchView } from '../../shared/behaviors/mood-judge/interface';
import { uiText } from './ui-language';

registerUiMessages({
  en: {
    '心情调整员': 'Mood adjuster',
    '让 haiku 帮她再想一想心情': 'Let haiku think her mood over',
    '她身上发生的事（你说的话、摸头、喂食、睡醒、很久没人理……）照常马上起作用；过一两分钟，你 Claude 里的 haiku 会按她的性格和此刻的心情，把她的心情数再微调一下。会用你的 Claude 用量：普通的一天约 80 次；上限每天 {0} 次打底，你每和她聊一句多 {1} 次，最多 {2} 次，超了当天只用本机规则。不发图片、听到的原文、记忆和日记。默认开启，可以在这里关掉。':
      'What happens to her (what you say, a pat, a snack, waking up, being left alone…) still takes effect at once; a minute or two later, haiku in your Claude adjusts her mood numbers a little, by her personality and how she feels now. It uses your Claude quota: about 80 calls on a normal day; the daily limit starts at {0}, grows by {1} for each message you send her, and never goes above {2}; past it, only the app’s own rules for the rest of the day. No pictures, heard audio text, memories or diary are sent. On by default; you can turn it off here.',
    '正在读取…': 'Loading…', '正在切换…': 'Switching…',
    '已开启 · 今天最多 {0} 次': 'On · at most {0} today', '已关闭 · 只用本机规则': 'Off · the app’s own rules only',
  },
  'zh-CN': {},
});

export interface MoodJudgePanelPorts {
  get(): Promise<MoodJudgeSwitchView>;
  set(enabled: boolean): Promise<MoodJudgeSwitchView>;
  changed?(callback: (view: MoodJudgeSwitchView) => void): () => void;
  error?(message: string): void;
}

export function moodJudgeStatus(view: MoodJudgeSwitchView | null, busy = false): string {
  if (busy) return uiText('正在切换…');
  if (!view) return uiText('正在读取…');
  return view.enabled ? uiText('已开启 · 今天最多 {0} 次', view.cap) : uiText('已关闭 · 只用本机规则');
}

export class MoodJudgePanel {
  private readonly toggle: HTMLInputElement;
  private readonly status: HTMLParagraphElement;
  private readonly hint: HTMLElement;
  private view: MoodJudgeSwitchView | null = null;
  private busy = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(root: HTMLElement, private readonly ports: MoodJudgePanelPorts) {
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('心情调整员');
    const row = doc.createElement('label'); row.className = 'toggle-row';
    const copy = doc.createElement('span');
    const title = doc.createElement('strong'); title.textContent = uiText('让 haiku 帮她再想一想心情');
    this.hint = doc.createElement('small');
    copy.append(title, this.hint);
    this.toggle = doc.createElement('input');
    this.toggle.type = 'checkbox'; this.toggle.id = 'mood-judge-enabled'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
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
    this.hint.textContent = uiText('她身上发生的事（你说的话、摸头、喂食、睡醒、很久没人理……）照常马上起作用；过一两分钟，你 Claude 里的 haiku 会按她的性格和此刻的心情，把她的心情数再微调一下。会用你的 Claude 用量：普通的一天约 80 次；上限每天 {0} 次打底，你每和她聊一句多 {1} 次，最多 {2} 次，超了当天只用本机规则。不发图片、听到的原文、记忆和日记。默认开启，可以在这里关掉。',
      this.view?.base ?? 120, this.view?.perChat ?? 2, this.view?.max ?? 800);
    this.status.textContent = moodJudgeStatus(this.view, this.busy);
  }
}
