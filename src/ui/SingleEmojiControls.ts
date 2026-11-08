import { uiText, uiTemplate } from './ui-language';
import { DEFAULT_EMOJI_SETTINGS, EMOJI_CATALOG, getEmoji, readEmojiSettings,
  type EmojiId, type EmojiSettings } from '../../shared/single-emoji';

export interface SingleEmojiControlPorts {
  get(): Promise<EmojiSettings>;
  save(input: EmojiSettings): Promise<EmojiSettings>;
  preview(id: EmojiId): Promise<boolean>;
  changed(callback: (settings: EmojiSettings) => void): () => void;
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const value = document.createElement(tag);
  value.className = className;
  if (text) value.textContent = text;
  return value;
};
let nextInstance = 0;

/** Controls edit only the strict local system catalog. Preview is an explicit
 * one-shot host request; editing or saving never emits an interaction reward. */
export class SingleEmojiControls {
  private readonly root = element('section', 'single-emoji-controls');
  private readonly enabled = element('input');
  private readonly catalog = new Map<EmojiId, HTMLInputElement>();
  private readonly previewChoice = element('select');
  private readonly saveButton = element('button', '', uiText('保存表情设置'));
  private readonly previewButton = element('button', '', uiText('在桌宠旁预览一次'));
  private readonly status = element('p', 'single-emoji-controls-status');
  private readonly unsubscribe: () => void;
  private draft = readEmojiSettings(DEFAULT_EMOJI_SETTINGS);
  private loaded = false;
  private dirty = false;
  private saving = false;
  private previewing = false;
  private disposed = false;
  private editRevision = 0;
  private hostRevision = 0;
  private previewId: EmojiId = EMOJI_CATALOG[0].id;
  private message = uiText('正在读取表情设置…');

  constructor(parent: HTMLElement, private readonly ports: SingleEmojiControlPorts) {
    const prefix = 'single-emoji-' + ++nextInstance;
    this.root.setAttribute('aria-label', uiText('独立表情'));
    this.root.append(element('h3', '', uiText('独立表情')),
      element('p', 'hint', uiText('偶尔单独显示一个表情，不遮角色或聊天；没有安全空位时会跳过。')),
      element('p', 'hint', uiText('没有当前角色贴图时，使用电脑系统 emoji')));
    this.enabled.type = 'checkbox'; this.enabled.id = prefix + '-enabled';
    this.enabled.dataset.emojiControl = 'enabled';
    const enabledLabel = element('label', 'single-emoji-controls-enabled');
    enabledLabel.append(this.enabled, element('span', '', uiText('允许独立显示表情')));
    this.root.append(enabledLabel);
    const fieldset = element('fieldset', 'single-emoji-controls-catalog');
    fieldset.append(element('legend', '', uiText('可用表情（至少保留一个）')));
    for (const entry of EMOJI_CATALOG) {
      const input = element('input'); input.type = 'checkbox'; input.id = prefix + '-' + entry.id;
      input.dataset.emojiId = entry.id;
      const label = element('label', 'single-emoji-controls-choice');
      label.append(input, element('span', 'single-emoji-controls-glyph', entry.glyph), element('span', '', uiText(entry.label)));
      input.onchange = () => this.select(entry.id, input.checked);
      this.catalog.set(entry.id, input); fieldset.append(label);
    }
    const previewLabel = element('label', 'single-emoji-controls-preview-choice');
    this.previewChoice.dataset.emojiControl = 'preview-choice';
    previewLabel.append(element('span', '', uiText('预览表情')), this.previewChoice);
    this.previewChoice.onchange = () => {
      const entry = getEmoji(this.previewChoice.value);
      if (entry && this.draft.selected.includes(entry.id)) this.previewId = entry.id;
    };
    this.saveButton.type = this.previewButton.type = 'button';
    this.saveButton.dataset.emojiControl = 'save'; this.previewButton.dataset.emojiControl = 'preview';
    this.saveButton.onclick = () => { void this.save(); };
    this.previewButton.onclick = () => { void this.preview(); };
    this.enabled.onchange = () => {
      if (!this.loaded || this.disposed) return;
      this.draft.enabled = this.enabled.checked; this.edited();
    };
    const actions = element('div', 'single-emoji-controls-actions');
    actions.append(this.saveButton, previewLabel, this.previewButton);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.status.dataset.emojiControl = 'status';
    this.root.append(fieldset, actions, this.status,
      element('p', 'hint', uiText('角色贴图与系统表情共用安全位置和显示开关。')));
    parent.append(this.root);
    // Subscribe before the initial asynchronous read. An event can make the
    // controls usable while a slow read is still pending.
    this.unsubscribe = ports.changed(settings => this.receive(settings));
    this.render();
    const hostRevision = this.hostRevision;
    void ports.get().then(settings => {
      if (this.disposed || hostRevision !== this.hostRevision || this.dirty || this.saving) return;
      this.receive(settings);
    }, () => {
      if (this.disposed || hostRevision !== this.hostRevision) return;
      this.loaded = true; this.message = uiText('设置暂时无法读取；修改后可重试保存。'); this.render();
    });
  }

  private receive(value: EmojiSettings): void {
    if (this.disposed) return;
    let settings: EmojiSettings;
    try { settings = readEmojiSettings(value); }
    catch { this.message = uiText('收到的表情设置无效，当前草稿已保留。'); this.render(); return; }
    this.hostRevision++; this.loaded = true;
    if (!this.dirty && !this.saving) {
      this.draft = settings;
      this.message = settings.enabled ? uiText('已开启 · 表情只在合适时机短暂出现。') : uiText('独立表情已关闭。');
    } else this.message = uiText('已收到本机设置更新；你尚未保存的修改已保留。');
    this.render();
  }

  private select(id: EmojiId, checked: boolean): void {
    if (!this.loaded || this.disposed) return;
    if (!checked && this.draft.selected.length === 1 && this.draft.selected.includes(id)) {
      this.message = uiText('至少保留一个表情；如不想显示，可关闭独立表情。'); this.render(); return;
    }
    const selected = new Set(this.draft.selected);
    if (checked) selected.add(id); else selected.delete(id);
    this.draft.selected = EMOJI_CATALOG.filter(entry => selected.has(entry.id)).map(entry => entry.id);
    this.edited();
  }

  private edited(): void {
    this.editRevision++; this.dirty = true;
    this.message = uiText('有未保存的修改；保存后再预览。'); this.render();
  }

  private async save(): Promise<void> {
    if (this.disposed || !this.loaded || !this.dirty || this.saving) return;
    const revision = this.editRevision, input = readEmojiSettings(this.draft);
    this.saving = true; this.message = uiText('正在保存表情设置…'); this.render();
    try {
      const returned = readEmojiSettings(await this.ports.save(input));
      if (this.disposed) return;
      if (this.editRevision === revision) {
        // Even the originating renderer uses the host's returned state.
        this.draft = returned; this.dirty = false;
        this.message = returned.enabled ? uiText('已保存 · 表情只在合适时机短暂出现。') : uiText('已保存 · 独立表情已关闭。');
      } else this.message = uiText('上一份修改已保存；较新的修改仍是草稿，请再次保存。');
    } catch {
      if (!this.disposed) this.message = uiText('表情设置未保存；当前修改已保留，请重试保存。');
    } finally {
      if (!this.disposed) { this.saving = false; this.render(); }
    }
  }

  private async preview(): Promise<void> {
    if (this.disposed || !this.loaded || this.dirty || this.saving || this.previewing || !this.draft.enabled) return;
    const id = this.previewId, revision = this.editRevision;
    this.previewing = true; this.message = uiText('正在尝试显示一次…'); this.render();
    try {
      const shown = await this.ports.preview(id);
      if (!this.disposed && this.editRevision === revision) this.message = shown
        ? uiText('已请求短暂预览；实际系统字形以桌宠旁显示为准。')
        : uiText('这次没有显示：请确认桌宠可见、已开启表情，并留出安全空位或稍后再试。');
    } catch {
      if (!this.disposed && this.editRevision === revision) this.message = uiText('这次预览未完成，请稍后重试。');
    } finally {
      if (!this.disposed) { this.previewing = false; this.render(); }
    }
  }

  private render(): void {
    if (this.disposed) return;
    this.enabled.checked = this.draft.enabled; this.enabled.disabled = !this.loaded;
    for (const [id, input] of this.catalog) {
      input.checked = this.draft.selected.includes(id); input.disabled = !this.loaded;
    }
    if (!this.draft.selected.includes(this.previewId)) this.previewId = this.draft.selected[0];
    this.previewChoice.replaceChildren(...this.draft.selected.map(id => {
      const entry = getEmoji(id)!;
      const option = element('option', '', entry.glyph + ' ' + uiText(entry.label)); option.value = id; return option;
    }));
    this.previewChoice.value = this.previewId;
    this.previewChoice.disabled = !this.loaded || this.previewing;
    this.saveButton.disabled = !this.loaded || !this.dirty || this.saving;
    this.saveButton.textContent = this.saving ? uiText('保存中…') : uiText('保存表情设置');
    this.previewButton.disabled = !this.loaded || !this.draft.enabled || this.dirty || this.saving || this.previewing;
    this.status.textContent = this.message;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.root.remove();
  }
}
