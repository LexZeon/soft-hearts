import { uiText, uiTemplate } from './ui-language';
import { MODEL_CAPABILITY_IDS, type CapabilitySource, type ModelCapabilityEntry, type ModelCapabilityId } from '../../shared/model-capability';
import { CAPABILITY_LABELS, type CapabilityPreviewResult } from '../../shared/model-capability-check';
import { HER_ACTIONS } from '../../shared/her-actions';
import { approximateActions, fingerReasonWords, fingerWords, missingActionGroups, partWords, type ModelAdaptation } from '../../shared/model-adaptation';
import type { ModelCapabilitySyncState } from './model-capability-sync';

/**
 * I-024 角色页「这个模型能做什么」: one row per capability, straight from MODEL_CAPABILITY_IDS (the same table the host stores;
 * registered for I-025 in shared/capabilities.ts as model_capability_switch / model_capability_try): whether this model has it
 * and how it was recognised, 「试一下」 on the pet, and an on/off stored per model that takes effect at once in both windows.
 * "On" cannot turn on what the model does not have.
 */
const row = (id: ModelCapabilityId, hint: string, slug: string) => ({ title: CAPABILITY_LABELS[id], hint, slug });
export const CAPABILITY_ROWS: Readonly<Record<ModelCapabilityId, { title: string; hint: string; slug: string }>> = Object.freeze({
  closeEyes: row('closeEyes', '困了、睡着时眼睛慢慢闭上', 'close-eyes'),
  blush: row('blush', '害羞时用模型自己的红晕', 'blush'),
  mouth: row('mouth', '说话、吃东西时嘴会动', 'mouth'),
  sleepPose: row('sleepPose', '睡着时慢慢低头、头微歪', 'sleep-pose'),
  gesture: row('gesture', '聊天时抬手比划、挥挥手', 'gesture'),
  drowsyFace: row('drowsyFace', '困的时候眉眼耷拉下来', 'drowsy-face'),
  tears: row('tears', '很难过时眼角有泪', 'tears'),
});
const SOURCE_WORDS: Readonly<Record<CapabilitySource, string>> = Object.freeze({ name: '有 · 名字认出', haiku: '有 · haiku 认出', none: '没找到' });

export interface ModelCapabilityPanelOptions {
  /** 试一下: shows this capability once on the pet (host → pet stage.previewCapability). */
  preview(id: ModelCapabilityId): Promise<CapabilityPreviewResult>;
  setChoice(modelKey: string, id: ModelCapabilityId, choice: 'on' | 'off'): Promise<unknown>;
  onError(message: string): void;
}
interface Row { root: HTMLElement; detail: HTMLElement; toggle: HTMLInputElement; tryButton: HTMLButtonElement }

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const timeText = (at: number) => { const date = new Date(at); return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };

/** A part in the user's words; "右手腕（有重名骨骼）" translates its two halves. */
export function partText(part: string): string {
  const shared = /^(.+)（有重名骨骼）$/u.exec(part);
  return shared ? uiTemplate`${uiText(shared[1])}（有重名骨骼）` : uiText(part);
}
const partsText = (list: readonly string[]) => list.map(partText).join(uiText('、'));

/**
 * T-213 她的动作 on this model, in the user's words: how many of the actions it has what they need for, which ones it cannot
 * do and exactly what each lacks, fingers left out, and body parts hanging elsewhere than in the standard skeleton. The same
 * rule the stage applies before playing one (shared/model-adaptation.ts); the stage still checks the bound tracks and the fit.
 */
export function adaptationLines(adaptation: ModelAdaptation | null | undefined): string[] {
  if (!adaptation) return [];
  const total = HER_ACTIONS.length, ok = HER_ACTIONS.filter(id => adaptation.actions[id]?.ok).length;
  const lines = [ok === total ? uiTemplate`她的动作：${total} 个都有需要的部位。` : uiTemplate`她的动作：${total} 个里能做 ${ok} 个。`];
  for (const group of missingActionGroups(adaptation)) lines.push(uiTemplate`做不了${partsText(group.actions)}：缺${partsText(group.missing)}`);
  // Skeleton step 2: a face action this model plays with its own near shapes (the stage's own rule, so it says the same).
  for (const row of approximateActions(adaptation)) lines.push(row.lighter
    ? uiTemplate`${uiText(row.action)}是近似的：没有${uiText(row.part)}，用${partsText(row.using)}拼的，会轻一点。`
    : uiTemplate`${uiText(row.action)}是近似的：没有${uiText(row.part)}，用${partsText(row.using)}代替。`);
  for (const issue of adaptation.fingerIssues) lines.push(uiTemplate`${uiText(fingerWords(issue.finger))}没用上（${uiText(fingerReasonWords(issue.reason))}），不会猜着对应。`);
  for (const row of adaptation.structure)
    lines.push(uiTemplate`${uiText(partWords(row.bone))}接在${uiText(partWords(row.actual))}下（标准是${uiText(partWords(row.expected))}下）：会把它和身体扯开的动作会跳过。`);
  return lines;
}

export class ModelCapabilityPanel {
  private readonly section = make('section', 'model-capabilities');
  private readonly status = make('output', 'model-capabilities-status');
  /** T-213: her actions on this model (adaptationLines). */
  private readonly actions = make('div', 'model-capability-actions');
  private readonly rows = new Map<ModelCapabilityId, Row>();
  private state: ModelCapabilitySyncState | null = null;
  private readonly pending = new Set<ModelCapabilityId>();
  private notice = '';
  private disposed = false;

  constructor(container: HTMLElement, private readonly options: ModelCapabilityPanelOptions) {
    this.section.id = 'model-capabilities';
    this.section.setAttribute('aria-label', uiText('这个模型能做什么'));
    const heading = make('h3', '', uiText('这个模型能做什么'));
    const hint = make('p', 'model-capabilities-hint', uiText('载入模型时先按骨骼和表情的名字认；认不出的，只把部位名字交给 haiku 对照一次，再看那个部位是不是真的会动。开关按模型存在本机，不改模型文件。'));
    const list = make('div', 'model-capability-list');
    for (const id of MODEL_CAPABILITY_IDS) {
      const row = CAPABILITY_ROWS[id];
      const root = make('div', 'model-capability-row'); root.dataset.capability = id;
      const label = make('label', 'toggle-row');
      const text = make('span');
      const detail = make('small', 'model-capability-detail');
      text.append(make('strong', '', uiText(row.title)), detail);
      const toggle = make('input'); toggle.type = 'checkbox'; toggle.id = `model-capability-${row.slug}`; toggle.dataset.modelCapability = 'switch';
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', uiText(row.title));
      toggle.onchange = () => { void this.choose(id, toggle.checked); };
      label.append(text, toggle);
      const tryButton = make('button', 'subtle model-capability-try', uiText('试一下'));
      tryButton.type = 'button'; tryButton.id = `model-capability-try-${row.slug}`; tryButton.dataset.modelCapability = 'try';
      tryButton.setAttribute('aria-label', uiTemplate`试一下：${uiText(row.title)}`);
      tryButton.onclick = () => { void this.tryOnce(id); };
      root.append(label, tryButton);
      list.append(root);
      this.rows.set(id, { root, detail, toggle, tryButton });
    }
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.actions.id = 'model-capability-actions';
    this.section.append(heading, hint, list, this.actions, this.status);
    container.append(this.section);
    this.paint();
  }

  /** The control window's ModelCapabilitySync state (its preview stage's model). */
  update(state: ModelCapabilitySyncState): void {
    if (this.disposed) return;
    const modelChanged = this.state?.targetKey !== state.targetKey || this.state?.loaded !== state.loaded;
    this.state = state;
    if (modelChanged) { this.notice = ''; this.pending.clear(); }
    this.paint();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const row of this.rows.values()) { row.toggle.onchange = null; row.tryButton.onclick = null; }
    this.section.remove();
  }

  private entry(id: ModelCapabilityId): ModelCapabilityEntry | null { return this.state?.card?.[id] ?? null; }

  private paint(): void {
    const state = this.state, card = state?.card ?? null;
    for (const id of MODEL_CAPABILITY_IDS) {
      const row = this.rows.get(id)!, entry = card?.[id] ?? null, words = CAPABILITY_ROWS[id];
      // T-213: what is missing, exactly (a part, or a part a clip cannot reach because its name is shared), not just "not found".
      const found = !entry ? '' : !entry.detected && entry.missing?.length ? uiTemplate`缺${partsText(entry.missing)}` : uiText(SOURCE_WORDS[entry.source]);
      row.detail.textContent = entry ? `${found} · ${uiText(words.hint)}` : uiText(words.hint);
      row.root.dataset.source = entry?.source ?? '';
      row.toggle.checked = entry?.enabled === true;
      row.toggle.disabled = !entry?.detected || !state?.targetKey || this.pending.has(id);
      row.tryButton.disabled = !card;
    }
    const checked = state?.record?.checkedAt;
    const base = !state?.loaded ? uiText('载入模型后，这里会列出这个模型能做什么。')
      : state.checking ? uiText('正在体检这个模型……（只把部位名字交给 haiku 对照）')
        : !card ? uiText('正在读取这个模型的体检……')
          : checked ? uiTemplate`体检于 ${timeText(checked)}` : uiText('已按名字认出；体检完成后会写上时间。');
    const waiting = state?.waitingForReload ? uiText('haiku 认出的部位，下次载入这个模型时开始用。') : '';
    this.status.textContent = [this.notice, base, waiting].filter(Boolean).join('\n');
    const lines = state?.loaded ? adaptationLines(state.adaptation) : [];
    for (const child of [...this.actions.children]) child.remove();
    this.actions.append(...lines.map((line, index) => make(index ? 'p' : 'strong', index ? 'model-capability-action-missing' : '', line)));
    this.actions.hidden = !lines.length;
  }

  private async choose(id: ModelCapabilityId, on: boolean): Promise<void> {
    const modelKey = this.state?.targetKey, entry = this.entry(id);
    if (this.disposed || !modelKey || !entry?.detected || this.pending.has(id)) { this.paint(); return; }
    this.pending.add(id); this.paint();
    const title = uiText(CAPABILITY_ROWS[id].title);
    try {
      await this.options.setChoice(modelKey, id, on ? 'on' : 'off');
      this.notice = on ? uiTemplate`已打开「${title}」` : uiTemplate`已关闭「${title}」`;
    } catch (error) {
      this.notice = uiText('开关没有保存，请再试一次。');
      this.options.onError(error instanceof Error ? error.message : String(error));
    } finally { this.pending.delete(id); if (!this.disposed) this.paint(); }
  }

  private async tryOnce(id: ModelCapabilityId): Promise<void> {
    if (this.disposed) return;
    const title = uiText(CAPABILITY_ROWS[id].title), entry = this.entry(id);
    if (!entry?.detected) { this.notice = uiTemplate`这个模型做不了：${title}`; this.paint(); return; }
    let result: CapabilityPreviewResult;
    try { result = await this.options.preview(id); }
    catch (error) { this.options.onError(error instanceof Error ? error.message : String(error)); result = 'not-ready'; }
    if (this.disposed) return;
    this.notice = result === 'shown' ? uiTemplate`已在桌宠上试了一下：${title}`
      : result === 'pet-hidden' ? uiText('桌宠没在显示，显示桌宠后再试。')
        : !entry.enabled ? uiTemplate`「${title}」关着，打开后再试。`
          : uiTemplate`还没准备好：${title}（她正忙着别的，或模型还没画出来）`;
    this.paint();
  }
}
