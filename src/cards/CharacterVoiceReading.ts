// I-164 读法: the small list inside 「她的声音」. Each row is { shown text -> spoken text }, optionally for one provider, and
// "只在单独出现时" for a tic. It only edits the list the voice form holds (saving is 「保存她的声音」, one place); the 试听 button plays the shown texts
// through the existing preview (a paid voice keeps its own notice and consent: the port), so nothing here starts a voice or spends by itself.
import { uiText } from '../foundation/ui-language';
import { READING_ENTRIES_MAX, READING_FROM_MAX, READING_TO_MAX, normalizeReadingEntries, type ReadingEntry } from '../../shared/foundation/character-voice-reading';
import type { TtsProvider } from '../../shared/foundation/tts-config';
import { readingSample } from '../../shared/voice';

interface Row { from: string; to: string; provider: TtsProvider | ''; alone: boolean }
interface Options {
  /** The list as it would be saved (unusable rows already left out). */
  onChange(entries: ReadingEntry[]): void;
  /** Plays the text with her saved voice (null: no preview here). */
  preview: ((text: string) => Promise<void>) | null;
  onError(message: string): void;
}
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text;
  return node;
};
const PROVIDER_CHOICES: readonly (readonly [TtsProvider | '', string])[] = [['', '所有声音'], ['system', '系统声音'], ['bailian', '百炼'], ['fish', 'Drama 3']];

export class CharacterVoiceReading {
  readonly root = make('div', '', 'character-voice-reading');
  private rows: Row[] = [];
  private off = false;
  private canPreview = false;
  private previewTip = '';
  private readonly list = make('div', '', 'character-voice-reading-list');
  private readonly add = make('button', uiText('加一条读法'), 'subtle');
  private readonly preview = make('button', uiText('试听读法'), 'subtle');

  constructor(private readonly options: Options) {
    this.root.id = 'character-voice-reading';
    this.add.type = this.preview.type = 'button';
    this.add.id = 'character-voice-reading-add'; this.preview.id = 'character-voice-reading-preview';
    this.add.onclick = () => { if (this.rows.length < READING_ENTRIES_MAX) { this.rows.push({ from: '', to: '', provider: '', alone: false }); this.paint(); } };
    this.preview.onclick = () => void this.previewNow();
    const actions = make('div', '', 'character-voice-actions'); actions.append(this.add, this.preview);
    this.root.append(make('h4', uiText('读法')),
      make('p', uiText('她说的字不变，只改声音读的字：名字怎么读、口癖（切、啧）怎么出声。左边是显示的字，右边是读的字；留空的一行不会保存。只有一个字的会在单独出现时才读，所以「关切」里的切不受影响。'), 'hint'),
      this.list, actions);
    this.paint();
  }

  /** The list the card has now (called when she is selected or her voice is reset; typing never calls it, so the cursor stays). */
  set(entries: readonly ReadingEntry[]): void {
    this.rows = entries.map(entry => ({ from: entry.from, to: entry.to, provider: entry.provider ?? '', alone: entry.alone === true }));
    this.paint();
  }
  /** Whether the list can be edited, whether she can be previewed now, and why not. The rows are rebuilt only when `off` changes (typing keeps its cursor). */
  setState(off: boolean, canPreview: boolean, previewTip: string): void {
    const rebuild = off !== this.off;
    this.off = off; this.canPreview = canPreview; this.previewTip = previewTip;
    if (rebuild) this.paint(); else this.paintState();
  }
  /** The rows as they would be saved. */
  entries(): ReadingEntry[] {
    return normalizeReadingEntries(this.rows.map(row => ({ from: row.from, to: row.to, ...(row.provider ? { provider: row.provider } : {}), ...(row.alone ? { alone: true } : {}) })));
  }

  private changed(): void { this.options.onChange(this.entries()); this.paintState(); }
  private paint(): void {
    this.list.replaceChildren(...this.rows.map(row => this.rowNode(row)));
    this.paintState();
  }
  private paintState(): void {
    this.add.disabled = this.off || this.rows.length >= READING_ENTRIES_MAX;
    this.preview.disabled = this.off || !this.canPreview || !this.options.preview || this.entries().length === 0;
    this.preview.title = this.previewTip;
  }
  private rowNode(row: Row): HTMLElement {
    const line = make('div', '', 'character-voice-reading-row');
    const from = make('input'), to = make('input'), provider = make('select'), alone = make('input'), box = make('label', '', 'character-voice-reading-alone'), remove = make('button', uiText('删掉'), 'subtle');
    from.type = to.type = 'text'; from.maxLength = READING_FROM_MAX; to.maxLength = READING_TO_MAX; from.autocomplete = to.autocomplete = 'off'; from.spellcheck = to.spellcheck = false;
    from.value = row.from; to.value = row.to; from.placeholder = uiText('显示的字'); to.placeholder = uiText('读的字');
    from.setAttribute('aria-label', uiText('显示的字')); to.setAttribute('aria-label', uiText('读的字'));
    from.oninput = () => { row.from = from.value; this.changed(); };
    to.oninput = () => { row.to = to.value; this.changed(); };
    for (const [value, label] of PROVIDER_CHOICES) { const option = make('option', uiText(label)); option.value = value; provider.append(option); }
    provider.value = row.provider; provider.setAttribute('aria-label', uiText('用在哪个声音'));
    provider.onchange = () => { row.provider = (provider.value || '') as Row['provider']; this.changed(); };
    alone.type = 'checkbox'; alone.checked = row.alone; alone.onchange = () => { row.alone = alone.checked; this.changed(); };
    box.append(alone, make('span', uiText('只在单独出现时读')));
    remove.type = 'button'; remove.onclick = () => { this.rows.splice(this.rows.indexOf(row), 1); this.paint(); this.options.onChange(this.entries()); };
    from.disabled = to.disabled = provider.disabled = alone.disabled = remove.disabled = this.off;
    line.append(from, make('span', '→'), to, provider, box, remove);
    return line;
  }
  private async previewNow(): Promise<void> {
    if (!this.options.preview || this.off) return;
    const text = readingSample(this.entries());
    if (!text) return;
    try { await this.options.preview(text); } catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); }
  }
}
