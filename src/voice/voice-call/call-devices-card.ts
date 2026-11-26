/**
 * I-177 batch 1: the call bar's second line, drawn in the call's button slot (src/voice/voice-call/call-controls.ts): one plain line
 * (the speakers hint with 「不再提醒」, or the headset-microphone note), or the suggestion card with 换 / 不换 / 以后再说.
 * Text only; the logic is src/voice/voice-call/call-mic.ts. The words come from the caller already translated.
 */
import { CALL_DEVICE_TEXT } from '../../../shared/voice/call-devices';
import { registerUiMessages } from '../../../shared/foundation/ui-language';
import { uiText } from '../../foundation/ui-language';
import type { CallBarPorts, CardAnswer } from './call-mic';

registerUiMessages({
  en: {
    [CALL_DEVICE_TEXT.speakersHint]: 'Headphones make this smoother: she will not hear her own echo, and it is easier to cut in.',
    [CALL_DEVICE_TEXT.headsetMicNote]: 'You are using the headset microphone, so her voice becomes phone quality. For a clearer call, plug in a USB microphone or use the one on a webcam.',
    '好，下一通电话起照这个顺序用麦克风。': 'Done: the next call (and every use of the microphone) follows this order.',
    [CALL_DEVICE_TEXT.hintOff]: 'Do not remind me', [CALL_DEVICE_TEXT.yes]: 'Switch', [CALL_DEVICE_TEXT.no]: 'Keep', [CALL_DEVICE_TEXT.later]: 'Later',
  },
  'zh-CN': {},
});

export class CallDeviceBar implements CallBarPorts {
  private readonly root: HTMLElement;
  constructor(slot: HTMLElement) {
    const doc = slot.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'voice-call-devices'; this.root.setAttribute('role', 'status'); this.root.hidden = true;
    slot.append(this.root);
  }
  line(text: string, action?: { label: string; run(): void }): void {
    const doc = this.root.ownerDocument;
    const row = doc.createElement('p'); row.className = 'voice-call-devices-line'; row.textContent = uiText(text);
    if (action) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = uiText(action.label);
      button.onclick = () => action.run();
      row.append(' ', button);
    }
    this.root.append(row); this.root.hidden = false;
  }
  card(text: string, answer: (value: CardAnswer) => void): void {
    const doc = this.root.ownerDocument;
    this.root.querySelector('.voice-call-devices-card')?.remove(); // one question at a time: Claude's reading replaces the keyword card
    const row = doc.createElement('p'); row.className = 'voice-call-devices-card'; row.textContent = uiText(text);
    const choices: Array<[CardAnswer, string]> = [['yes', CALL_DEVICE_TEXT.yes], ['no', CALL_DEVICE_TEXT.no], ['later', CALL_DEVICE_TEXT.later]];
    for (const [value, label] of choices) {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = uiText(label);
      button.onclick = () => answer(value);
      row.append(' ', button);
    }
    this.root.append(row); this.root.hidden = false;
  }
  clear(): void { this.root.replaceChildren(); this.root.hidden = true; }
}
