import { uiText, uiTemplate } from './ui-language';
import {
  DIMENSIONS, MOTION_WEIGHT_LIMIT, motionDimensionLabels, parseWeightTags,
  type Dimension, type MotionWeightQuery, type MotionWeightResults, type MotionWeightView,
} from '../../shared/motion-weights';
import type { CatalogMotion, MotionPackId } from '../../shared/motion-library';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); value.textContent = text; return value;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const value = node('button', text); value.type = 'button'; value.className = 'subtle'; value.onclick = action; return value;
}
interface Row { root: HTMLElement; dimension: HTMLSelectElement; tag: HTMLInputElement; weight: HTMLInputElement }

/** Existing library metadata editing. No preview, playback, settings or model API is exposed here. */
export class MotionWeightControls {
  readonly element = node('div');
  private readonly editor = node('details');
  private readonly editorBody = node('fieldset');
  private readonly rows = node('div');
  private readonly status = node('p');
  private readonly mode = node('select');
  private readonly searchPanel = node('fieldset');
  private readonly queryRows = node('div');
  private readonly rankingReason = node('p');
  private readonly searchStatus = node('p');
  private rowInputs: Row[] = [];
  private queryInputs: Row[] = [];
  private motion: CatalogMotion | null = null;
  private available = false;
  private view: MotionWeightView | null = null;
  private generation = 0;
  private queryGeneration = 0;
  private editGeneration = 0;
  private disposed = false;
  private saving = false;
  private result: MotionWeightResults | null = null;

  constructor(private readonly packId: MotionPackId, private readonly changed: () => void) {
    this.element.className = 'motion-weight-controls';
    this.editor.append(node('summary', uiText('当前动作的个人 tag 权重')));
    this.editorBody.append(node('p', uiText('0～1 表示标签适配；留空是未评估，0 是明确不适配。用于查找，不改变播放强度。')), this.rows);
    this.editorBody.append(button(uiText('添加标签'), () => {
      if (this.rowInputs.length < MOTION_WEIGHT_LIMIT) this.addTag();
    }), button(uiText('保存权重'), () => void this.save()));
    this.editor.append(this.editorBody, button(uiText('放弃草稿并重读'), () => void this.load()), this.status);
    this.status.setAttribute('role', 'status');
    this.editor.ontoggle = () => { if (this.editor.open && !this.view) void this.load(); };
    const label = node('label', uiText('当前动作列表排序 '));
    this.mode.setAttribute('aria-label', uiText('动作列表排序模式'));
    this.mode.append(new Option(uiText('原顺序 · 精确 AND 筛选'), 'and'), new Option(uiText('加权检索 · 已保存的个人标签'), 'weighted'));
    this.mode.onchange = () => {
      this.queryGeneration++; this.result = null; this.rankingReason.textContent = '';
      this.searchPanel.hidden = this.mode.value !== 'weighted';
      this.searchStatus.textContent = this.mode.value === 'weighted' ? uiText('填写查询标签，再点击加权检索。') : '';
      this.changed();
    };
    label.append(this.mode);
    this.searchPanel.hidden = true;
    this.searchPanel.append(node('p', uiText('在当前类型、文字和精确 tag 筛选内排序。查询重要度 0～1；未评估项以 0.5 排序并单列，标签数量不额外加分。')), this.queryRows);
    this.searchPanel.append(button(uiText('添加查询标签'), () => {
      if (this.queryInputs.length < MOTION_WEIGHT_LIMIT) this.addQuery();
    }), button(uiText('加权检索'), () => void this.search()), this.searchStatus, this.rankingReason);
    this.searchStatus.setAttribute('role', 'status');
    this.element.append(this.editor, label, this.searchPanel);
    this.addQuery(false); this.editorBody.disabled = true;
  }
  get ranking(): MotionWeightResults | null { return this.mode.value === 'weighted' ? this.result : null; }
  select(motion: CatalogMotion | null): void {
    if (this.motion?.id === motion?.id && this.motion?.sha256 === motion?.sha256) return;
    this.motion = motion; this.generation++; this.editGeneration++; this.view = null;
    this.revokeSelection();
    this.rows.replaceChildren(); this.rowInputs = []; this.editorBody.disabled = true;
    this.status.textContent = motion ? uiText('展开后读取当前动作的个人权重。') : uiText('请先选择动作。');
    if (this.editor.open) void this.load();
    this.describeRanking();
  }
  setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    if (!available) {
      this.generation++; this.view = null; this.editorBody.disabled = true;
      this.revokeSelection();
      this.status.textContent = uiText('当前动作未安装或校验未通过，暂不能标注。');
    } else if (this.editor.open) void this.load();
  }
  describeRanking(): void {
    const row = this.ranking?.rows.find(row => row.asset.motionId === this.motion?.id);
    this.rankingReason.textContent = row ? [
      uiTemplate`当前动作：排序值 ${row.rankingValue.toFixed(3)}；已评估覆盖 ${(row.knownCoverage * 100).toFixed(0)}%。`,
      ...row.dimensions.map(d => `${uiText(motionDimensionLabels[d.dimension])}：${d.families.map(f =>
        `${f.tag}=${f.fit === null ? uiText('未评估') : f.fit}${f.conflict ? uiText('（保守取小值）') : ''}`).join('、')}`),
    ].join(' ') : '';
  }
  dispose(): void { this.disposed = true; this.generation++; this.queryGeneration++; this.revokeSelection(); }

  private revokeSelection(): void {
    const generation = this.generation;
    void window.desktop.invalidateMotionWeightSelection(this.packId).catch(() => {
      if (!this.disposed && generation === this.generation) {
        this.view = null; this.editorBody.disabled = true;
        this.status.textContent = uiText('动作标注选择失效未确认，请重新读取后编辑。');
      }
    });
  }

  private row(parent: HTMLElement, changed: () => void, remove: (row: Row) => void): Row {
    const root = node('div'), dimension = node('select'), tag = node('input'), weight = node('input');
    root.className = 'motion-weight-row';
    dimension.setAttribute('aria-label', uiText('标签维度'));
    for (const id of DIMENSIONS) dimension.append(new Option(uiText(motionDimensionLabels[id]), id));
    tag.maxLength = 64; tag.placeholder = uiText('标签'); tag.setAttribute('aria-label', uiText('标签'));
    weight.type = 'number'; weight.min = '0'; weight.max = '1'; weight.step = '0.05';
    weight.placeholder = uiText('未评估'); weight.setAttribute('aria-label', uiText('权重，留空为未评估'));
    const row = { root, dimension, tag, weight };
    for (const input of [dimension, tag, weight]) input.oninput = changed;
    root.append(dimension, tag, weight, button(uiText('移除'), () => { remove(row); changed(); root.remove(); }));
    parent.append(root); return row;
  }
  private addTag(value?: { dimension: Dimension; tag: string; weight: number | null }): void {
    const row = this.row(this.rows, () => { this.editGeneration++; },
      value => { this.rowInputs = this.rowInputs.filter(row => row !== value); });
    row.dimension.value = value?.dimension ?? 'content'; row.tag.value = value?.tag ?? '';
    row.weight.value = value?.weight == null ? '' : String(value.weight);
    this.rowInputs.push(row); this.editGeneration++;
  }
  private addQuery(notify = true): void {
    const row = this.row(this.queryRows, () => this.invalidateQuery(),
      value => { this.queryInputs = this.queryInputs.filter(row => row !== value); });
    row.weight.value = '1'; row.weight.placeholder = uiText('重要度');
    row.weight.setAttribute('aria-label', uiText('查询重要度'));
    this.queryInputs.push(row); if (notify) this.invalidateQuery();
  }
  private invalidateQuery(): void {
    this.queryGeneration++; this.result = null; this.rankingReason.textContent = '';
    if (this.mode.value === 'weighted') this.searchStatus.textContent = uiText('查询已修改，请重新点击加权检索。');
    this.changed();
  }
  private async load(): Promise<void> {
    if (this.disposed || !this.motion || !this.available || this.saving) return;
    const generation = ++this.generation, edit = this.editGeneration, motion = this.motion;
    this.view = null; this.editorBody.disabled = true; this.status.textContent = uiText('正在读取…');
    try {
      const view = await window.desktop.readMotionWeights(this.packId, motion.id);
      if (this.disposed || generation !== this.generation || edit !== this.editGeneration) return;
      if (view.asset.packId !== this.packId || view.asset.motionId !== motion.id || view.asset.sha256 !== motion.sha256)
        throw Error(uiText('动作内容已变化，请重新载入动作库。'));
      this.view = view; this.rows.replaceChildren(); this.rowInputs = [];
      const defaults = [...new Set(motion.tags.map(tag => tag.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-')))]
        .slice(0, MOTION_WEIGHT_LIMIT).map(tag => ({ dimension: 'content' as const, tag, weight: null }));
      for (const tag of view.revision === 0 ? defaults : view.tags) this.addTag(tag);
      this.editorBody.disabled = false;
      this.status.textContent = view.revision === 0 ? uiText('来源标签尚未评估；修改后点击保存。') : uiText('已读取保存的个人权重。');
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.status.textContent = String(error);
    }
  }
  private async save(): Promise<void> {
    if (this.disposed || !this.view || this.saving) return;
    const generation = this.generation, edit = this.editGeneration;
    try {
      const tags = parseWeightTags(this.rowInputs.map(row => ({ dimension: row.dimension.value, tag: row.tag.value,
        weight: row.weight.value.trim() === '' ? null : Number(row.weight.value) })));
      this.saving = true; this.editorBody.disabled = true; this.status.textContent = uiText('正在保存…');
      const view = await window.desktop.saveMotionWeights({ token: this.view.token, revision: this.view.revision, tags });
      if (this.disposed || generation !== this.generation || edit !== this.editGeneration) return;
      this.view = view; this.status.textContent = uiText('已保存，可放弃草稿并重读核对。');
      if (this.mode.value === 'weighted' && this.result) void this.search();
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.status.textContent = uiTemplate`${String(error)} 草稿已保留。`;
    } finally {
      this.saving = false;
      if (!this.disposed) this.editorBody.disabled = !this.view;
      if (!this.disposed && !this.view && this.editor.open && this.available) void this.load();
    }
  }
  private async search(): Promise<void> {
    if (this.disposed || this.mode.value !== 'weighted') return;
    const generation = ++this.queryGeneration;
    const request: MotionWeightQuery = { packId: this.packId, preferred: this.queryInputs.map(row => ({
      dimension: row.dimension.value as Dimension, tag: row.tag.value, importance: Number(row.weight.value),
    })) };
    this.searchStatus.textContent = uiText('正在检索已保存的权重…');
    try {
      const result = await window.desktop.searchMotionWeights(request);
      if (this.disposed || generation !== this.queryGeneration || this.mode.value !== 'weighted') return;
      this.result = result; this.searchStatus.textContent = uiTemplate`已按个人权重排序 ${result.rows.length} 个已安装动作。`;
      this.changed(); this.describeRanking();
    } catch (error) {
      if (!this.disposed && generation === this.queryGeneration) this.searchStatus.textContent = String(error);
    }
  }
}
