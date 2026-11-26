// I-162 step 2: 「她的声音」 on the character page.
// The provider, that provider's voice (gender marked where known), pace and pitch where the provider can change them, and the 声音描述
// (the compatible prompt). Saving writes her card's voice through the host (saveCharacterVoice → the card store the resolver reads).
// Paid providers: choosing one only stores the choice; a preview keeps its own paid notice and consent (the port), and the page never holds a key.
import { uiText, uiTemplate } from '../foundation/ui-language';
import { attachUnsavedSign, type UnsavedSign } from '../foundation/unsaved-sign';
import type { CardsDesktopAPI } from '../../shared/cards/desktop-api';
import type { CharacterVoice } from '../../shared/foundation/character-voice';
import type { TtsProvider } from '../../shared/foundation/tts-config';
import {
  VOICE_DESCRIPTION_EXAMPLE, VOICE_DESCRIPTION_MAX, VOICE_PROVIDER_FORM, VOICE_PROVIDER_ORDER, bailianVoiceChoices, providerNote, systemVoiceChoices, voiceFormOf,
  voiceFormUnchanged, voiceFromForm, type VoiceChoice, type VoiceForm,
} from '../../shared/voice';
import { CharacterVoiceReading } from './CharacterVoiceReading';

export type CharacterVoiceBridge = Pick<CardsDesktopAPI, 'saveCharacterVoice'>;
/** What the page needs from the window around it (the settings, the system voices, the preview); the wiring gives these. */
export interface CharacterVoicePorts {
  /** The default voice for new characters (the old global choice): what a card with no voice of her own shows. */
  newDefault(): CharacterVoice | undefined;
  systemVoices(): readonly { voiceURI: string; name?: string; lang?: string }[];
  /** Whether the provider's connection and key are saved (never the key itself). */
  providerReady(provider: TtsProvider): boolean;
  /** The active character is the one on stage: only she can be previewed. */
  isActive(id: string): boolean;
  /** Plays her saved voice (a paid one asks the user first, through the existing preview notices). */
  preview?(): Promise<void>;
  /** I-164: plays this text with her saved voice (the 读法 list's 试听; the same notices and consent as `preview`). */
  previewText?(text: string): Promise<void>;
  /** Opens the voice page where the connection and key are filled in (「百炼语音」 / 「Drama 3 语音」). */
  openSetup?(provider: 'bailian' | 'fish'): void;
}
interface Options { api: CharacterVoiceBridge; ports: CharacterVoicePorts; onError(message: string): void }
export interface VoiceSubject { id: string; name: string; voice?: CharacterVoice }

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text;
  return node;
};
const field = (label: string, input: HTMLElement): HTMLLabelElement => { const row = make('label', '', 'character-voice-field'); row.append(make('span', label), input); return row; };

export class CharacterVoiceControls {
  readonly root = make('section', '', 'character-voice settings-section');
  private subject: VoiceSubject | null = null;
  private form: VoiceForm = voiceFormOf(undefined, undefined);
  private busy = false;
  private dirty = false;
  private sign: UnsavedSign | null = null; // the unsaved sign (2026-11-24)
  private generation = 0;
  private readonly provider = make('select');
  private readonly note = make('p', '', 'hint character-voice-note');
  private readonly ready = make('p', '', 'hint character-voice-ready');
  private readonly voice = make('select');
  private readonly voiceId = make('input');
  private readonly voiceRow: HTMLLabelElement;
  private readonly idRow: HTMLLabelElement;
  private readonly rate = make('input');
  private readonly rateOut = make('output');
  private readonly rateRow: HTMLLabelElement;
  private readonly pitch = make('input');
  private readonly pitchOut = make('output');
  private readonly pitchRow: HTMLLabelElement;
  private readonly description = make('textarea');
  private readonly count = make('span', '', 'hint');
  private readonly save = make('button', uiText('保存她的声音'), 'primary');
  private readonly reset = make('button', uiText('恢复成新角色的默认声音'), 'subtle');
  private readonly preview = make('button', uiText('试听她现在的声音'), 'subtle');
  private readonly setup = make('button', '', 'subtle');
  private readonly status = make('output', '', 'character-voice-status');
  /** I-164 读法: the list of shown -> spoken texts (src/cards/CharacterVoiceReading.ts); saved with the rest of her voice. */
  private readonly reading: CharacterVoiceReading;

  constructor(container: HTMLElement, private readonly options: Options) {
    const previewText = options.ports.previewText;
    this.reading = new CharacterVoiceReading({ onChange: entries => { this.form.reading = entries; this.touch(); },
      preview: previewText ? text => previewText.call(options.ports, text) : null, onError: message => options.onError(message) });
    this.root.id = 'character-voice-controls';
    this.root.setAttribute('aria-label', uiText('她的声音'));
    this.root.append(make('h3', uiText('她的声音')),
      make('p', uiText('这张卡自己的声音：服务商、那家的声音、语速和音调，还有一段「声音描述」。换了人，她的声音不会跟着变；没有自己声音的卡，用「新角色的默认声音」。'), 'hint'));
    for (const key of VOICE_PROVIDER_ORDER) { const option = make('option', uiText(VOICE_PROVIDER_FORM[key].label)); option.value = key; this.provider.append(option); }
    this.provider.id = 'character-voice-provider'; this.provider.onchange = () => { this.read(); this.form.voiceId = ''; this.paint(); this.touch(); };
    this.voice.id = 'character-voice-voice'; this.voice.onchange = () => { this.form.voiceId = this.voice.value; this.touch(); };
    this.voiceId.id = 'character-voice-id'; this.voiceId.type = 'text'; this.voiceId.maxLength = 128; this.voiceId.autocomplete = 'off'; this.voiceId.spellcheck = false;
    this.voiceId.placeholder = uiText('Drama 3 的声音编号（reference_id）；不填就不用 Drama 3');
    this.voiceId.oninput = () => { this.form.voiceId = this.voiceId.value.trim(); this.touch(); };
    for (const [input, out, min, max] of [[this.rate, this.rateOut, '0.5', '2'], [this.pitch, this.pitchOut, '0.5', '2']] as const) {
      input.type = 'range'; input.min = min; input.max = max; input.step = '0.05';
      input.oninput = () => { this.read(); out.value = `${Number(input.value).toFixed(2)}×`; this.touch(); };
    }
    this.rate.id = 'character-voice-rate'; this.pitch.id = 'character-voice-pitch';
    this.description.id = 'character-voice-description'; this.description.rows = 3; this.description.maxLength = VOICE_DESCRIPTION_MAX;
    this.description.placeholder = uiTemplate`例如：${VOICE_DESCRIPTION_EXAMPLE}`;
    this.description.oninput = () => { this.form.description = this.description.value; this.count.textContent = `${Array.from(this.description.value).length} / ${VOICE_DESCRIPTION_MAX}`; this.touch(); };
    this.voiceRow = field(uiText('声音'), this.voice); this.idRow = field(uiText('声音编号'), this.voiceId);
    const rateLine = make('span', '', 'character-voice-slider'); rateLine.append(this.rate, this.rateOut);
    const pitchLine = make('span', '', 'character-voice-slider'); pitchLine.append(this.pitch, this.pitchOut);
    this.rateRow = field(uiText('语速'), rateLine); this.pitchRow = field(uiText('音调（只有系统声音能调）'), pitchLine);
    const describe = field(uiText('声音描述（兼容提示词）'), this.description);
    const help = make('p', uiText('写她的性别、年纪感、音色、语速、笑起来的样子。她用的服务商没有现成的声音时，会按这段话挑最接近的；百炼会把它当作说话风格。Drama 3 不用这段话（它会把长段描述念出来），Drama 3 的表演提示在朗读设置里另写一句短的。字怎么念写在下面的「读法」里。已知是另一个性别的声音不会被用上。'), 'hint');
    this.save.type = this.reset.type = this.preview.type = this.setup.type = 'button';
    this.save.id = 'character-voice-save'; this.reset.id = 'character-voice-reset'; this.preview.id = 'character-voice-preview'; this.setup.id = 'character-voice-setup';
    this.save.onclick = () => void this.saveNow(false); this.reset.onclick = () => void this.saveNow(true);
    this.preview.onclick = () => void this.previewNow();
    this.setup.onclick = () => { if (this.form.provider !== 'system') this.options.ports.openSetup?.(this.form.provider); };
    const actions = make('div', '', 'character-voice-actions'); actions.append(this.save, this.reset, this.preview);
    this.sign = attachUnsavedSign({ saveButton: this.save, page: '她的声音', title: () => this.root.querySelector?.('h3') as HTMLElement | null });
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.count.textContent = `0 / ${VOICE_DESCRIPTION_MAX}`;
    this.root.append(field(uiText('服务商'), this.provider), this.note, this.ready, this.setup, this.voiceRow, this.idRow, this.rateRow, this.pitchRow, describe, this.count, help, this.reading.root, actions, this.status,
      make('p', uiText('这里只存选择，不会读出任何声音，也不会花钱；Key 在「百炼语音」「Drama 3 语音」里填，不在角色卡里，也不会导出。'), 'hint'));
    container.replaceChildren(this.root);
    this.paint();
  }

  /** The card the editor shows now (null: a new, unsaved one). Unsaved edits of the same card stay while she is selected. */
  select(subject: VoiceSubject | null, busy: boolean): void {
    const changed = subject?.id !== this.subject?.id;
    this.busy = busy;
    this.subject = subject ? { id: subject.id, name: subject.name, ...(subject.voice ? { voice: subject.voice } : {}) } : null;
    if (changed || !this.dirty) { this.form = voiceFormOf(subject?.voice, this.options.ports.newDefault()); this.dirty = false; this.status.textContent = ''; this.reading.set(this.form.reading ?? []); }
    this.paint();
  }

  private read(): void {
    const provider = this.provider.value as TtsProvider;
    this.form = { ...this.form, provider: VOICE_PROVIDER_FORM[provider] ? provider : 'system', rate: Number(this.rate.value) || 1, pitch: Number(this.pitch.value) || 1 };
  }
  private touch(): void { this.dirty = true; this.paint(); }

  private choices(): VoiceChoice[] {
    return this.form.provider === 'system' ? systemVoiceChoices(this.options.ports.systemVoices()) : this.form.provider === 'bailian' ? bailianVoiceChoices() : [];
  }
  private paint(): void {
    const form = this.form, caps = VOICE_PROVIDER_FORM[form.provider], subject = this.subject;
    this.provider.value = form.provider;
    this.note.textContent = uiText(providerNote(form.provider));
    const paid = caps.paid, ready = !paid || this.options.ports.providerReady(form.provider);
    this.ready.hidden = ready;
    this.ready.textContent = ready ? '' : form.provider === 'fish' ? uiText('Drama 3 的 Key 还没有填：先用别的声音读（你可以在「Drama 3 语音」里填）。')
      : uiText('百炼的连接和 Key 还没有填：先用别的声音读（你可以在「百炼语音」里填）。');
    this.setup.hidden = ready; this.setup.textContent = form.provider === 'fish' ? uiText('去填 Drama 3 的 Key') : uiText('去填百炼的 Key');
    this.voiceRow.hidden = caps.pick !== 'list'; this.idRow.hidden = caps.pick !== 'id';
    if (caps.pick === 'list') {
      const list = this.choices();
      this.voice.replaceChildren(new Option(uiText('按声音描述自动挑'), ''));
      for (const choice of list) this.voice.add(new Option(`${choice.label}${choice.gender ? ` · ${uiText(choice.gender === 'female' ? '女声' : '男声')}` : ''}`, choice.id));
      if (form.voiceId && !list.some(choice => choice.id === form.voiceId)) this.voice.add(new Option(uiText('她现在的声音（列表里没有）'), form.voiceId));
      this.voice.value = form.voiceId;
    } else this.voiceId.value = form.voiceId;
    this.rateRow.hidden = !caps.rate; this.pitchRow.hidden = !caps.pitch;
    this.rate.value = String(form.rate); this.rateOut.value = `${Number(form.rate).toFixed(2)}×`;
    this.pitch.value = String(form.pitch); this.pitchOut.value = `${Number(form.pitch).toFixed(2)}×`;
    if (this.description.value !== form.description) this.description.value = form.description;
    this.count.textContent = `${Array.from(form.description).length} / ${VOICE_DESCRIPTION_MAX}`;
    const off = this.busy || !subject;
    for (const control of [this.provider, this.voice, this.voiceId, this.rate, this.pitch, this.description, this.reset, this.setup]) control.disabled = off;
    this.save.disabled = off || !this.dirty || voiceFormUnchanged(subject?.voice, form);
    this.sign?.update(this.dirty && !voiceFormUnchanged(subject?.voice, form), []);
    this.reset.disabled = off || !subject?.voice;
    this.preview.disabled = off || !this.options.ports.preview || !subject || !this.options.ports.isActive(subject.id) || this.dirty;
    this.preview.title = !subject ? '' : !this.options.ports.isActive(subject.id) ? uiText('只能试听正在使用的角色；先换成她') : this.dirty ? uiText('先保存，再试听') : '';
    this.reading.setState(off, !!subject && this.options.ports.isActive(subject.id) && !this.dirty, this.preview.title);
  }

  private async saveNow(clear: boolean): Promise<void> {
    const subject = this.subject;
    if (!subject || this.busy) return;
    const generation = ++this.generation;
    this.busy = true; this.paint();
    try {
      this.read();
      await this.options.api.saveCharacterVoice(subject.id, clear ? null : voiceFromForm(this.form));
      if (generation !== this.generation || this.subject?.id !== subject.id) return;
      this.dirty = false; this.busy = false;
      this.status.textContent = clear ? uiText('她现在用「新角色的默认声音」。') : uiText('她的声音已保存。');
      // The card state that follows (desk:characters) refills the form; until then this shows what was saved.
      if (clear) { this.form = voiceFormOf(undefined, this.options.ports.newDefault()); this.reading.set(this.form.reading ?? []); }
      this.paint();
    } catch (error) {
      this.busy = false; this.paint();
      this.options.onError(error instanceof Error ? error.message : String(error));
    }
  }
  private async previewNow(): Promise<void> {
    if (!this.options.ports.preview || this.busy) return;
    try { await this.options.ports.preview(); } catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
  /** The form as it would be saved (for tests and the page's own checks). */
  currentVoice(): CharacterVoice { return voiceFromForm(this.form); }
}
