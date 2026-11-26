// 「边说边演（Claude 编排）」 in the control window's voice section (docs/claude/2026-11-20-speech-beats-2-4.md). Saved with the channel-dependent switches (shared/foundation/channel-defaults.ts `speechBeats`: on in
// development and source runs, off in stable until the user turns it on; a saved choice always wins). The host reads it at the start of
// each reply; this page only shows the switch and saves the user's click. Not open to the agent channel (it changes how much of the
// user's Claude usage a reply takes): only the user's own click here.
import { registerUiMessages } from '../../shared/foundation/ui-language';
import type { ChannelGateId, ChannelGatesView } from '../../shared/foundation/channel-defaults';
import { uiText } from '../foundation/ui-language';

registerUiMessages({
  en: {
    '边说边演（Claude 编排）': 'Acting while she talks (Claude choreography)',
    '她说话时，表情和小动作跟着每句话走；有时不说话，只用表情回你（聊天页显示一行灰色小字）。由你的 Claude 在同一条回复里一起编排，不多调用一次，每条回复的提示词多一段（多用一点 Claude 用量）。关掉就和原来一样。默认开着。':
      'While she talks, her face and small moves follow each sentence; sometimes she answers with an expression alone (a small grey line in the chat). Your Claude arranges it in the same reply: no extra call, a slightly longer prompt per reply (a little more Claude usage). Off: exactly as before. On by default.',
  },
  'zh-CN': {},
});

const TITLE = '边说边演（Claude 编排）';
const HINT = '她说话时，表情和小动作跟着每句话走；有时不说话，只用表情回你（聊天页显示一行灰色小字）。由你的 Claude 在同一条回复里一起编排，不多调用一次，每条回复的提示词多一段（多用一点 Claude 用量）。关掉就和原来一样。默认开着。';
const ID: ChannelGateId = 'speechBeats';

export interface SpeechBeatsSwitchPorts {
  get(): Promise<ChannelGatesView>;
  set(id: ChannelGateId, on: boolean): Promise<ChannelGatesView>;
  error?(message: string): void;
}

export class SpeechBeatsSwitch {
  private on: boolean | null = null;
  private busy = false;
  private readonly input: HTMLInputElement;

  constructor(root: HTMLElement, private readonly ports: SpeechBeatsSwitchPorts) {
    const doc = root.ownerDocument;
    const label = doc.createElement('label'); label.className = 'toggle-row';
    const copy = doc.createElement('span');
    const title = doc.createElement('strong'); title.textContent = uiText(TITLE);
    const hint = doc.createElement('small'); hint.textContent = uiText(HINT);
    copy.append(title, hint);
    this.input = doc.createElement('input');
    this.input.type = 'checkbox'; this.input.id = 'speech-beats'; this.input.setAttribute('role', 'switch'); this.input.disabled = true;
    this.input.onchange = () => { void this.set(this.input.checked); };
    label.append(copy, this.input);
    root.replaceChildren(label);
    void ports.get().then(view => { this.on = view[ID]?.on ?? null; this.render(); }, error => { this.ports.error?.(String(error)); this.render(); });
  }

  private async set(on: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.on = (await this.ports.set(ID, on))[ID]?.on ?? this.on; }
    catch (error) { this.ports.error?.(String(error)); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    this.input.checked = this.on === true;
    this.input.disabled = this.on === null || this.busy;
  }
}
