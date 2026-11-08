import { uiText, uiTemplate } from './ui-language';
import {
  DEFAULT_BLUSH_CALIBRATION,
  validateBlushCalibration,
  type BlushCalibration,
  type BlushCalibrationView,
} from '../../shared/blush';

export interface BlushCalibrationControlsOptions {
  onApply(modelKey: string, value: BlushCalibration): void | Promise<void>;
  onPreview?(value: BlushCalibration): void | Promise<void>;
  onError(message: string): void;
}
type Field = keyof BlushCalibration;
const fields: { key: Field; label: string; min: number; max: number; unit: string }[] = [
  { key: 'eyeOffsetX', label: '双眼参考水平偏移', min: -0.5, max: 0.5, unit: '原眼距' },
  { key: 'eyeOffsetY', label: '双眼参考垂直偏移', min: -0.5, max: 0.5, unit: '原眼距' },
  { key: 'eyeSpacingScale', label: '双眼参考间距', min: 0.5, max: 1.5, unit: '倍' },
  { key: 'mouthOffsetX', label: '嘴部参考水平偏移', min: -0.5, max: 0.5, unit: '原眼距' },
  { key: 'mouthOffsetY', label: '嘴部参考垂直偏移', min: -0.5, max: 0.5, unit: '原眼距' },
];
function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Model-local calibration drafts. No role, emotion, file or provider access. */
export class BlushCalibrationControls {
  private readonly section = make('section');
  private readonly support = make('p');
  private readonly status = make('output');
  private readonly details = make('details');
  private readonly detailText = make('pre');
  private readonly apply = make('button', uiText('保存当前模型校准'));
  private readonly reset = make('button', uiText('恢复默认（待保存）'));
  private readonly preview = make('button', uiText('预览红晕'));
  private readonly inputs = new Map<Field, { input: HTMLInputElement; value: HTMLOutputElement; unit: string }>();
  private view: BlushCalibrationView | null = null;
  private draft: BlushCalibration = { ...DEFAULT_BLUSH_CALIBRATION };
  private dirty = false;
  private valid = true;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private notice = uiText('尚未读取当前模型的校准。');
  private storageError = '';
  private detailError = '';

  constructor(container: HTMLElement, private readonly options: BlushCalibrationControlsOptions) {
    this.section.id = 'blush-calibration';
    this.section.className = 'blush-calibration';
    this.section.setAttribute('aria-label', uiText('当前模型的本机脸部定位校准'));
    const heading = make('h3', uiText('本机模型：眼睛与嘴部定位'));
    const hint = make('p', uiText('眼骨只是定位参考，嘴点可能由头部估算；下方能力说明来自当前舞台。偏移按校准前的原眼距计，0.10 表示原眼距的 10%；间距 1 倍保留自动参考距离。'));
    hint.className = 'blush-calibration-hint';
    const boundary = make('p', uiText('这里只调整定位参考，不移动模型原始眼骨，不调整脸红强度或大小，也不写入角色卡。修改保留在当前草稿；预览仅在控制窗口临时显示，不产生互动奖励，保存后才写入本机模型校准。'));
    boundary.className = 'blush-calibration-hint';
    this.support.className = 'blush-calibration-support';
    this.support.textContent = uiText('定位能力尚未就绪；眼睛和嘴的参考点不等于精确皮肤位置。');
    this.section.append(heading, hint, boundary, this.support);
    for (const field of fields) {
      const row = make('label'); row.className = 'blush-calibration-field';
      const label = make('span', uiTemplate`${uiText(field.label)}（${uiText(field.unit)}）`);
      const input = make('input'); input.type = 'range'; input.id = `blush-calibration-${field.key}`;
      input.min = String(field.min); input.max = String(field.max); input.step = '0.01';
      input.setAttribute('aria-label', uiTemplate`${uiText(field.label)}，单位${uiText(field.unit)}`);
      const value = make('output');
      input.oninput = () => {
        if (this.disposed || this.busy || !this.view?.modelKey) return;
        this.draft[field.key] = Number(input.value);
        this.dirty = true;
        try { validateBlushCalibration(this.draft); this.valid = true; this.detailError = ''; this.notice = uiText('定位草稿已修改；预览不保存，保存校准后才生效。'); }
        catch (error) { this.valid = false; this.detailError = error instanceof Error ? error.message : String(error); this.notice = uiText('校准参数无效，请检查数值并查看详情。'); }
        this.refresh();
      };
      this.inputs.set(field.key, { input, value, unit: field.unit });
      row.append(label, input, value); this.section.append(row);
    }
    const actions = make('div'); actions.className = 'blush-calibration-actions';
    this.apply.id = 'blush-calibration-apply'; this.apply.type = 'button';
    this.reset.id = 'blush-calibration-reset'; this.reset.type = 'button';
    this.preview.id = 'blush-calibration-preview'; this.preview.type = 'button'; this.preview.hidden = !options.onPreview;
    this.apply.onclick = () => { void this.save(); };
    this.preview.onclick = () => { void this.showPreview(); };
    this.reset.onclick = () => {
      if (this.disposed || this.busy || !this.view?.modelKey) return;
      this.draft = { ...DEFAULT_BLUSH_CALIBRATION }; this.dirty = true; this.valid = true;
      this.detailError = '';
      this.notice = uiText('已填入默认定位草稿；仍需保存，不会自动覆盖当前模型配置。');
      this.refresh();
    };
    actions.append(this.preview, this.apply, this.reset);
    this.status.id = 'blush-calibration-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.details.append(make('summary', uiText('查看校准问题详情')), this.detailText);
    this.section.append(actions, this.status, this.details); container.append(this.section); this.refresh();
  }

  update(view: BlushCalibrationView, support?: string): void {
    if (this.disposed) return;
    const modelChanged = !this.view || this.view.modelKey !== view.modelKey;
    if (!modelChanged && this.view && view.revision < this.view.revision) return;
    const newer = modelChanged || !this.view || view.revision > this.view.revision;
    if (modelChanged) {
      this.generation++; this.busy = false; this.dirty = false;
      this.detailError = '';
      this.notice = view.modelKey ? uiText('当前模型校准已读取；修改后可预览并保存。') : uiText('请先加载模型，再校准眼睛和嘴部参考位置。');
    }
    const previous = this.view;
    this.view = { ...view, calibration: { ...view.calibration } };
    this.storageError = view.storageError ?? '';
    if (support !== undefined) this.support.textContent = support;
    else if (modelChanged) this.support.textContent = uiText('定位能力尚未就绪；眼睛和嘴的参考点不等于精确皮肤位置。');
    try {
      const incoming = validateBlushCalibration(view.calibration);
      if (!this.dirty && newer) { this.draft = incoming; this.valid = true; }
      // Equal revisions may refresh a storage error, never roll back a just-saved draft.
      if (!newer && previous) this.view.calibration = { ...previous.calibration };
    } catch (error) {
      if (modelChanged) this.draft = { ...DEFAULT_BLUSH_CALIBRATION };
      this.valid = false; this.detailError = error instanceof Error ? error.message : String(error); this.notice = uiText('校准参数无效，请检查数值并查看详情。');
    }
    this.refresh();
  }

  private refresh(): void {
    const unavailable = this.disposed || this.busy || !this.view?.modelKey;
    for (const field of fields) {
      const controls = this.inputs.get(field.key)!;
      controls.input.value = String(this.draft[field.key]);
      controls.input.disabled = unavailable;
      controls.value.textContent = Number.isFinite(this.draft[field.key]) ? `${this.draft[field.key].toFixed(2)} ${uiText(controls.unit)}` : uiText('无效数值');
    }
    this.apply.disabled = unavailable || !this.dirty || !this.valid;
    this.reset.disabled = unavailable;
    this.preview.disabled = unavailable || !this.valid || !this.options.onPreview;
    this.status.textContent = [this.storageError ? uiText('校准保存失败，请查看详情。') : '', this.notice].filter(Boolean).join('\n');
    this.details.hidden = !this.storageError && !this.detailError;
    this.detailText.textContent = [this.storageError, this.detailError].filter(Boolean).join('\n');
    this.status.dataset.error = String(!!this.storageError || !this.valid);
  }

  private async save(): Promise<void> {
    if (this.disposed || this.busy || !this.dirty || !this.view?.modelKey) return;
    const modelKey = this.view.modelKey, generation = this.generation, revision = this.view.revision;
    try {
      const submitted = validateBlushCalibration(this.draft);
      this.busy = true; this.detailError = ''; this.notice = uiText('正在保存当前模型校准…'); this.refresh();
      await this.options.onApply(modelKey, { ...submitted });
      if (this.disposed || generation !== this.generation || this.view?.modelKey !== modelKey) return;
      this.dirty = false; this.valid = true;
      if (this.view.revision > revision) this.draft = validateBlushCalibration(this.view.calibration);
      else { this.draft = submitted; this.view.calibration = { ...submitted }; }
      this.notice = this.storageError ? uiText('保存请求已结束，请按上方存储错误处理。') : uiText('当前模型校准已保存；角色心情与记忆保持不变。');
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.detailError = error instanceof Error ? error.message : String(error);
      this.notice = uiText('校准操作未完成，请查看详情后重试。');
      this.options.onError(this.detailError);
    } finally {
      if (!this.disposed && generation === this.generation) { this.busy = false; this.refresh(); }
    }
  }

  private async showPreview(): Promise<void> {
    if (this.disposed || this.busy || !this.view?.modelKey || !this.options.onPreview) return;
    const generation = this.generation;
    try {
      const preview = validateBlushCalibration(this.draft);
      await this.options.onPreview({ ...preview });
      if (!this.disposed && generation === this.generation) { this.notice = uiText('已请求控制窗口临时预览；草稿尚未保存，也不计互动奖励。'); this.refresh(); }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.detailError = error instanceof Error ? error.message : String(error); this.notice = uiText('校准操作未完成，请查看详情后重试。'); this.options.onError(this.detailError); this.refresh();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.apply.onclick = this.reset.onclick = this.preview.onclick = null;
    for (const { input } of this.inputs.values()) input.oninput = null;
    this.section.remove();
  }
}
