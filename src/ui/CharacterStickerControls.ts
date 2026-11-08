import { uiText, uiTemplate } from './ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../../shared/ui-copy.settings.en';
import type { CharacterStickerPorts, CharacterStickerView } from '../../shared/character-sticker';
import { EMOJI_CATALOG, getEmoji } from '../../shared/single-emoji';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text;
  return node;
};
const png = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 8_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
function view(value: CharacterStickerView): CharacterStickerView {
  if (!value || typeof value.connected !== 'boolean' || typeof value.reason !== 'string'
    || !['idle', 'reference', 'generating', 'result', 'saved', 'failed'].includes(value.phase)
    || !Array.isArray(value.saved) || value.saved.length > 128
    || value.saved.some(asset => !asset || !id(asset.id) || !getEmoji(asset.intent))
    || new Set(value.saved.map(asset => asset.id)).size !== value.saved.length
    || value.reference && (!id(value.reference.id) || !png(value.reference.png)
      || ![value.reference.width, value.reference.height].every(size => Number.isInteger(size) && size > 0 && size <= 4096))
    || value.result && (!id(value.result.id) || !png(value.result.png) || !getEmoji(value.result.intent)))
    throw new Error('Invalid character sticker view');
  return structuredClone(value);
}
type Operation = 'prepare' | 'generate' | 'save' | 'preview' | 'cancel';

/** No automatic capture/upload/generation. Host events replace context; local
 * operation epochs prevent their slower returned snapshots from reviving it. */
export class CharacterStickerControls {
  private readonly root = element('section', 'single-emoji-controls');
  private readonly connection = element('p', 'hint');
  private readonly connectionDetails = element('details');
  private readonly connectionDetailText = element('pre');
  private readonly prepare = element('button', '', uiText('准备当前角色参考图'));
  private readonly cancel = element('button', '', uiText('取消并清除当前预览'));
  private readonly intent = element('select');
  private readonly referenceBlock = element('div');
  private readonly referenceImage = element('img');
  private readonly resultBlock = element('div');
  private readonly resultImage = element('img');
  private readonly generateActions = element('div', 'single-emoji-controls-actions');
  private readonly saveActions = element('div', 'single-emoji-controls-actions');
  private readonly assets = element('div', 'single-emoji-controls-actions');
  private readonly status = element('p', 'single-emoji-controls-status');
  private readonly unsubscribe: () => void;
  private current: CharacterStickerView | null = null;
  private epoch = 0;
  private busy: Operation | null = null;
  private disposed = false;
  private binding: string | null = null;
  private blockOrphanResult = false;
  private readonly retiredReferences = new Set<string>();
  private readonly retiredResults = new Set<string>();
  private message = uiText('正在读取角色贴图状态…');

  constructor(parent: HTMLElement, private readonly ports: CharacterStickerPorts) {
    this.root.setAttribute('aria-label', uiText('角色专属表情包'));
    this.root.append(element('h3', '', uiText('角色专属表情包')),
      element('p', 'hint', uiText('依据当前 MMD 角色外形，确认的预览图会发给你自己的 Claude；不会上传 PMX、贴图目录或角色卡，也不会每句生成。')),
      this.connection);
    this.connectionDetails.append(element('summary', '', uiText('连接详情')), this.connectionDetailText);
    this.root.append(this.connectionDetails);
    this.prepare.type = this.cancel.type = 'button';
    this.prepare.dataset.stickerControl = 'prepare'; this.cancel.dataset.stickerControl = 'cancel';
    this.prepare.onclick = () => { void this.execute('prepare', () => ports.prepare()); };
    this.cancel.onclick = () => { void this.execute('cancel', () => ports.cancel()); };
    this.intent.dataset.stickerControl = 'intent';
    for (const entry of EMOJI_CATALOG) {
      const option = element('option', '', entry.glyph + ' ' + uiText(entry.label));
      option.value = entry.id; this.intent.append(option);
    }
    this.intent.value = EMOJI_CATALOG[0].id;
    const intentLabel = element('label', 'single-emoji-controls-preview-choice');
    intentLabel.append(element('span', '', uiText('表情意图')), this.intent);
    const actions = element('div', 'single-emoji-controls-actions');
    actions.append(this.prepare, intentLabel, this.cancel);
    this.referenceImage.alt = uiText('确认后将发送的当前角色参考图');
    this.referenceImage.dataset.stickerControl = 'reference-image';
    this.resultImage.alt = uiText('本次生成的角色表情图');
    this.resultImage.dataset.stickerControl = 'result-image';
    for (const image of [this.referenceImage, this.resultImage]) {
      image.width = 200; image.style.maxWidth = '100%'; image.style.height = 'auto';
      image.style.objectFit = 'contain';
    }
    this.referenceBlock.append(element('p', 'hint', uiText('当前参考图（准备不会发送）：')), this.referenceImage);
    this.resultBlock.append(element('p', 'hint', uiText('生成结果（保存后才使用）：')), this.resultImage);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.status.dataset.stickerControl = 'status'; this.connection.dataset.stickerControl = 'connection';
    this.root.append(actions, this.referenceBlock, this.generateActions, this.resultBlock,
      this.saveActions, element('p', 'hint', uiText('已保存的贴图可单次预览；不会因此再次调用 Claude。')), this.assets, this.status);
    parent.append(this.root);
    this.unsubscribe = ports.changed(value => this.receiveEvent(value));
    this.render();
    const epoch = this.epoch;
    void ports.get().then(value => {
      if (!this.disposed && epoch === this.epoch) this.accept(value);
    }, () => {
      if (!this.disposed && epoch === this.epoch) { this.message = uiText('状态暂时无法读取；可重新准备参考图。'); this.render(); }
    });
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value); if (set.size > 64) set.delete(set.values().next().value!);
  }
  private retire(): void {
    if (this.current?.reference) this.remember(this.retiredReferences, this.current.reference.id);
    if (this.current?.result) this.remember(this.retiredResults, this.current.result.id);
    this.binding = null; this.current = null; this.blockOrphanResult = true;
    this.clearImages();
  }
  private stale(value: CharacterStickerView): boolean {
    return !!(value.reference && this.retiredReferences.has(value.reference.id)
      || value.result && this.retiredResults.has(value.result.id)
      || value.result && !value.reference && !this.binding && this.blockOrphanResult);
  }
  private receiveEvent(input: CharacterStickerView): void {
    if (this.disposed) return;
    let next: CharacterStickerView;
    try { next = view(input); }
    catch { this.epoch++; this.busy = null; this.retire(); this.message = uiText('收到的贴图状态或图片无效，已清除临时预览。'); this.render(); return; }
    if (this.stale(next)) return;
    this.epoch++; this.busy = null; this.accept(next);
  }
  private accept(input: CharacterStickerView): void {
    let next: CharacterStickerView;
    try { next = view(input); }
    catch { this.retire(); this.message = uiText('收到的贴图状态或图片无效，已清除临时预览。'); this.render(); return; }
    if (this.stale(next)) return;
    if (next.reference) {
      if (this.current?.reference && this.current.reference.id !== next.reference.id)
        this.remember(this.retiredReferences, this.current.reference.id);
      this.binding = next.reference.id; this.blockOrphanResult = false;
    } else if (!next.result) {
      this.retire();
    }
    if (this.current?.result && this.current.result.id !== next.result?.id)
      this.remember(this.retiredResults, this.current.result.id);
    this.current = next;
    this.message = next.phase === 'generating' ? uiText('正在生成这一次确认的表情图…')
      : next.phase === 'reference' ? uiText('请检查这张参考图；只有明确确认后才会发送。')
        : next.phase === 'result' ? uiText('结果尚未使用；确认后再保存。')
          : next.phase === 'saved' ? uiText('已保存，可在下方单次预览。')
            : next.phase === 'failed' ? uiText('这次操作未完成；请按连接说明重试。') : uiText('准备参考图不会上传或生成。');
    this.render();
  }
  private async execute(operation: Exclude<Operation, 'preview'>,
    request: () => Promise<CharacterStickerView>): Promise<void> {
    if (this.disposed || this.busy === 'cancel' || this.busy && operation !== 'cancel') return;
    const epoch = ++this.epoch;
    this.busy = operation;
    if (operation === 'prepare' || operation === 'cancel') this.retire();
    this.message = operation === 'cancel' ? uiText('正在取消并清除临时预览…')
      : operation === 'prepare' ? uiText('正在准备当前角色的参考图；尚未发送。')
        : operation === 'generate' ? uiText('正在发送这张已确认的参考图并生成一次…') : uiText('正在保存这张结果…');
    this.render();
    try {
      const returned = await request();
      if (!this.disposed && this.epoch === epoch) { this.busy = null; this.accept(returned); }
    } catch {
      if (!this.disposed && this.epoch === epoch) {
        this.busy = null;
        this.message = operation === 'cancel' ? uiText('取消请求未完成；临时预览已在此清除，请重试。')
          : operation === 'prepare' ? uiText('参考图未准备完成；没有发送图片。')
            : operation === 'generate' ? uiText('这次生成未完成；没有可保存的新结果。')
              : uiText('结果未保存，请重试保存。');
        this.render();
      }
    }
  }
  private async preview(assetId: string): Promise<void> {
    if (this.disposed || this.busy || !this.current?.saved.some(asset => asset.id === assetId)) return;
    const epoch = ++this.epoch; this.busy = 'preview'; this.message = uiText('正在尝试单次预览…'); this.render();
    try {
      const shown = await this.ports.preview(assetId);
      if (!this.disposed && this.epoch === epoch) {
        this.busy = null; this.message = shown ? uiText('已请求单次预览。') : uiText('这次未显示；请确认角色可见并留出安全空位，或稍后再试。'); this.render();
      }
    } catch {
      if (!this.disposed && this.epoch === epoch) { this.busy = null; this.message = uiText('这次预览未完成，请稍后重试。'); this.render(); }
    }
  }
  private clearImages(): void {
    this.referenceImage.removeAttribute('src'); this.resultImage.removeAttribute('src');
    this.referenceBlock.hidden = this.resultBlock.hidden = true;
  }
  private render(): void {
    if (this.disposed) return;
    const current = this.current, generating = current?.phase === 'generating';
    const fixedReason = current?.reason && Object.hasOwn(ENGLISH_SETTINGS_UI_COPY, current.reason);
    this.connection.textContent = current ? current.connected ? uiText('已连接你自己的 Claude 角色贴图生成通道。')
      : uiText('当前未连接：') + (fixedReason ? uiText(current.reason) : uiText('生成通道暂不可用，请查看连接详情。')) : uiText('连接状态尚未确认。');
    this.connectionDetails.hidden = !current?.reason;
    this.connectionDetailText.textContent = current?.reason ?? '';
    this.prepare.disabled = !!this.busy || generating;
    this.intent.disabled = !!this.busy || generating;
    this.cancel.disabled = this.busy === 'cancel' || !this.busy && !current?.reference && !current?.result && !generating;
    this.clearImages();
    if (current?.reference) { this.referenceImage.src = current.reference.png; this.referenceBlock.hidden = false; }
    if (current?.result) { this.resultImage.src = current.result.png; this.resultBlock.hidden = false; }
    this.generateActions.replaceChildren(); this.saveActions.replaceChildren(); this.assets.replaceChildren();
    if (current?.connected && current.reference && current.phase === 'reference') {
      const referenceId = current.reference.id;
      const button = element('button', '', uiText('确认发送此图并生成一张'));
      button.type = 'button'; button.dataset.stickerControl = 'generate'; button.disabled = !!this.busy;
      button.onclick = () => {
        const intent = getEmoji(this.intent.value)?.id;
        if (this.current?.connected && this.current.phase === 'reference' && this.current.reference?.id === referenceId && intent)
          void this.execute('generate', () => this.ports.generate(referenceId, intent));
      };
      this.generateActions.append(button);
    }
    if (current?.result && current.phase === 'result') {
      const resultId = current.result.id;
      const button = element('button', '', uiText('保存并使用这张表情图'));
      button.type = 'button'; button.dataset.stickerControl = 'save'; button.disabled = !!this.busy;
      button.onclick = () => {
        if (this.current?.result?.id === resultId && this.current.phase === 'result')
          void this.execute('save', () => this.ports.save(resultId));
      };
      this.saveActions.append(button);
    }
    for (const asset of current?.saved ?? []) {
      const button = element('button', '', uiText('预览 ') + uiText(getEmoji(asset.intent)!.label));
      button.type = 'button'; button.dataset.stickerAsset = asset.id; button.disabled = !!this.busy || generating;
      button.onclick = () => { void this.preview(asset.id); }; this.assets.append(button);
    }
    this.status.textContent = this.message;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.epoch++; this.unsubscribe(); this.clearImages();
    this.current = null; this.binding = null; this.retiredReferences.clear(); this.retiredResults.clear();
    this.root.remove();
  }
}
