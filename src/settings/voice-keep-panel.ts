// 「保存她念出来的声音（用来比对）」: the control window's developer area for the dev-only keep-her-voice tool (docs/claude/2026-11-24-voice-keep.md).
// It shows nothing at all (the section stays hidden and empty) unless the host says the tool exists in this build: stable and packaged builds
// answer { available: false }. The window sends one small request and draws the answer; the host decides, asks before 清空, and opens the folder.
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { VOICE_KEEP_DAYS_RANGE, type VoiceKeepRequest, type VoiceKeepView } from '../../shared/voice';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: {
    '保存她念出来的声音（用来比对）': 'Keep the voice she reads aloud (for comparing)',
    '开发版里的内部测试工具，只在开发版和源码运行里有，稳定版和发布版没有。打开后，她每念一句话，云端声音（百炼、Drama 3）返回的音频就存在这台电脑上，每句一个文件，旁边有一个小文件写着时间、角色、声音、这句话和第几句。只存她自己的声音：不录麦克风，不录你的声音；系统语音录不下来，不保存。这些音频只给你自己听、做比对，不会发到任何地方，也不会交给任何模型。':
      'An internal test tool of the development build; it exists only in development builds and source runs, never in the stable or release build. When on, each sentence she reads aloud has the audio the cloud voice (Bailian, Drama 3) returned saved on this computer, one file per sentence with a small file beside it giving the time, character, voice, the sentence and its number. Only her own voice: the microphone and your voice are never recorded; the system voice cannot be captured and is not kept. The audio is only for your own ears, for comparing; it is sent nowhere and never handed to any model.',
    '保存': 'Keep',
    '保存天数': 'Days to keep',
    '过了这个天数的自动删除（今天算一天），1 到 30 天，默认 7 天。关掉开关只是不再保存，已经存的留到过期，或者你点「清空」。':
      'Anything older than this is deleted automatically (today counts as one day), 1 to 30 days, 7 by default. Turning the switch off only stops keeping; what is kept stays until it expires or you press Clear.',
    '打开文件夹': 'Open folder',
    '清空': 'Clear',
    '正在读取…': 'Loading…',
    '已保存 {0} 句，约 {1} MB。': '{0} sentences kept, about {1} MB.',
    '存满 {0} MB 了，先停止保存；过期的删掉或清空以后会接着存。': 'Reached {0} MB, so keeping has stopped; it resumes once old days expire or you clear.',
  },
  'zh-CN': {},
});

export interface VoiceKeepPanelPorts {
  call(request: VoiceKeepRequest): Promise<VoiceKeepView | null>;
  error?(message: string): void;
}

/** The status line in words (numbers only). */
export function voiceKeepStatus(view: VoiceKeepView | null): string {
  if (!view) return uiText('正在读取…');
  const megabytes = Math.round(view.bytes / (1024 * 1024));
  const kept = uiText('已保存 {0} 句，约 {1} MB。').replace('{0}', String(view.sentences)).replace('{1}', String(megabytes));
  return view.capped ? `${kept} ${uiText('存满 {0} MB 了，先停止保存；过期的删掉或清空以后会接着存。').replace('{0}', String(Math.round(view.capBytes / (1024 * 1024))))}` : kept;
}

export class VoiceKeepPanel {
  private view: VoiceKeepView | null = null;
  private busy = false;
  private toggle!: HTMLInputElement;
  private days!: HTMLInputElement;
  private clear!: HTMLButtonElement;
  private open!: HTMLButtonElement;
  private status!: HTMLElement;
  private built = false;

  constructor(private readonly root: HTMLElement, private readonly ports: VoiceKeepPanelPorts) {
    root.hidden = true; // shown (and its controls made) only once the host says the tool exists in this build
    void ports.call({ op: 'get' }).then(view => { this.view = view; this.render(); }, error => { ports.error?.(String(error)); });
  }

  /** The controls are made only where the tool exists: a stable window never has them. */
  private build(): void {
    const { root, ports } = this;
    const doc = root.ownerDocument;
    const heading = doc.createElement('h3'); heading.textContent = uiText('保存她念出来的声音（用来比对）');
    const intro = doc.createElement('p'); intro.className = 'hint';
    intro.textContent = uiText('开发版里的内部测试工具，只在开发版和源码运行里有，稳定版和发布版没有。打开后，她每念一句话，云端声音（百炼、Drama 3）返回的音频就存在这台电脑上，每句一个文件，旁边有一个小文件写着时间、角色、声音、这句话和第几句。只存她自己的声音：不录麦克风，不录你的声音；系统语音录不下来，不保存。这些音频只给你自己听、做比对，不会发到任何地方，也不会交给任何模型。');
    const row = doc.createElement('label'); row.className = 'toggle-row';
    const copy = doc.createElement('span'); const title = doc.createElement('strong'); title.textContent = uiText('保存'); copy.append(title);
    this.toggle = doc.createElement('input'); this.toggle.type = 'checkbox'; this.toggle.id = 'voice-keep-on'; this.toggle.setAttribute('role', 'switch'); this.toggle.disabled = true;
    this.toggle.onchange = () => { void this.send({ op: this.toggle.checked ? 'on' : 'off' }); };
    row.append(copy, this.toggle);
    const daysRow = doc.createElement('label'); daysRow.className = 'field';
    const daysLabel = doc.createElement('span'); daysLabel.textContent = uiText('保存天数');
    this.days = doc.createElement('input'); this.days.type = 'number'; this.days.id = 'voice-keep-days'; this.days.min = String(VOICE_KEEP_DAYS_RANGE.min); this.days.max = String(VOICE_KEEP_DAYS_RANGE.max);
    this.days.step = '1'; this.days.value = String(VOICE_KEEP_DAYS_RANGE.fallback); this.days.disabled = true;
    this.days.onchange = () => { void this.send({ op: 'days', days: Number(this.days.value) }); };
    daysRow.append(daysLabel, this.days);
    const daysHint = doc.createElement('p'); daysHint.className = 'hint';
    daysHint.textContent = uiText('过了这个天数的自动删除（今天算一天），1 到 30 天，默认 7 天。关掉开关只是不再保存，已经存的留到过期，或者你点「清空」。');
    const buttons = doc.createElement('div'); buttons.className = 'button-row';
    this.open = doc.createElement('button'); this.open.type = 'button'; this.open.id = 'voice-keep-open'; this.open.textContent = uiText('打开文件夹');
    this.open.onclick = () => { void this.send({ op: 'open' }); };
    this.clear = doc.createElement('button'); this.clear.type = 'button'; this.clear.id = 'voice-keep-clear'; this.clear.textContent = uiText('清空');
    this.clear.onclick = () => { void this.send({ op: 'clear' }); }; // the host asks "are you sure" itself
    buttons.append(this.open, this.clear);
    this.status = doc.createElement('p'); this.status.className = 'hint'; this.status.setAttribute('role', 'status');
    root.replaceChildren(heading, intro, row, daysRow, daysHint, buttons, this.status);
    void ports;
  }

  private async send(request: VoiceKeepRequest): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.view = await this.ports.call(request) ?? this.view; }
    catch (error) { this.ports.error?.(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    const view = this.view;
    this.root.hidden = !view?.available;
    if (!view?.available) return;
    if (!this.built) { this.built = true; this.build(); }
    this.toggle.checked = view.on; this.toggle.disabled = this.busy;
    if (this.root.ownerDocument.activeElement !== this.days) this.days.value = String(view.days);
    this.days.disabled = this.busy; this.clear.disabled = this.busy; this.open.disabled = this.busy;
    this.status.textContent = voiceKeepStatus(view);
  }
}
