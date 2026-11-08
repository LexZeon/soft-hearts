import { uiText, uiTemplate } from './ui-language';
import catalogData from "../../shared/motion-catalog.json";
import "../motion-library.css";
import { filterMotions, listTags, motionCategories, motionCategoryLabels } from "./motion-filters";
import type { MotionPreviewState } from "./motion-preview";
import { MotionWeightControls } from './MotionWeights';
import { MotionTrackCoverageControls } from './MotionTrackCoverage';
import type { AppSettings, AssetRef } from "../../shared/contracts";
import { getMotionLayerAssets, type MotionLayer } from "../../shared/motion-layers";
import type { MotionFitView } from "../stage/motion-retarget";
import type {
  CatalogMotion,
  MotionCatalog,
  MotionCategory,
  MotionDownloadProgress,
  MotionLibraryStatus,
  MotionPack,
  MotionPackId,
} from "../../shared/motion-library";

const catalog = catalogData as MotionCatalog;
const categoryNames = motionCategoryLabels;
const layerNames: Record<MotionLayer, string> = { pose: "身体姿态", gesture: "手势", expression: "面部表情" };
const layerHints: Record<MotionLayer, string> = {
  pose: "使用身体骨骼，保留独立表情；手势只覆盖与它重合的上身骨骼。",
  gesture: "只使用上身、手臂和手指骨骼，不替换腿部姿态或面部表情。",
  expression: "只使用表情和眼部等面部骨骼，身体姿态与手势继续播放。",
};

interface MotionLibraryOptions {
  getModel(): AssetRef | null;
  getSettings?(): AppSettings;
  beforeInstall?(): Promise<boolean>;
  onEnabled(asset: AssetRef, layer: MotionLayer): Promise<void>;
  onPreview(packId: MotionPackId, motion: CatalogMotion, layer: MotionLayer): Promise<boolean>;
  onClearLayer?(layer: MotionLayer): Promise<void>;
  onStopPreview(): Promise<void>;
  onError(message: string): void;
}

interface PackControls {
  card: HTMLElement;
  pack: MotionPack;
  search: HTMLInputElement;
  select: HTMLSelectElement;
  selectedId: string;
  description: HTMLElement;
  tags: HTMLElement;
  count: HTMLElement;
  install: HTMLButtonElement;
  preview: HTMLButtonElement;
  matched: number;
  cancel: HTMLButtonElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  weights: MotionWeightControls;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** Controls for the curated library; network and filesystem access stay in the host. */
export class MotionLibraryControls {
  private readonly trackCoverage: MotionTrackCoverageControls;
  private cards = new Map<MotionPackId, PackControls>();
  private status: MotionLibraryStatus | null = null;
  private statusRequest = 0;
  private statusError = false;
  private busyPack: MotionPackId | null = null;
  private cancelRequested = false;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private modelHint: HTMLElement | null = null;
  private directory: HTMLElement | null = null;
  private category: "all" | MotionCategory = "all";
  private selectedTags = new Set<string>();
  private tagSelect: HTMLSelectElement | null = null;
  private categorySelect: HTMLSelectElement | null = null;
  private selectedTagControls: HTMLElement | null = null;
  private filterResult: HTMLElement | null = null;
  private previewSummary: HTMLElement | null = null;
  private previewStop: HTMLButtonElement | null = null;
  private previewState: MotionPreviewState = { phase: "idle" };
  private targetLayer: MotionLayer = "pose";
  private targetSelect: HTMLSelectElement | null = null;
  private targetHint: HTMLElement | null = null;
  private busyLayer: MotionLayer | null = null;
  private layerControls = new Map<MotionLayer, { name: HTMLElement; clear: HTMLButtonElement }>();
  /** Adaptation layer step 2: per-motion fit on the loaded model (null until the stage reports). */
  private motionFit: MotionFitView | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: MotionLibraryOptions,
  ) {
    this.trackCoverage = new MotionTrackCoverageControls(catalog, () => {
      if (this.disposed) return;
      for (const controls of this.cards.values()) this.populateMotions(controls);
      this.updateFilterSummary();
    });
  }

  get selectedLayer(): MotionLayer { return this.targetLayer; }

  /** The stage's fit check for the current model: hidden motions are not offered. */
  setMotionFit(view: MotionFitView | null): void {
    if (this.disposed) return;
    this.motionFit = view;
    for (const controls of this.cards.values()) this.markMotionFit(controls);
    this.refresh();
  }

  private hiddenOnModel(packId: MotionPackId, motionId: string | undefined): boolean {
    return !!motionId && this.motionFit?.motions[`${packId}/${motionId}`] === "hidden";
  }

  private markMotionFit(controls: PackControls): void {
    for (const option of Array.from(controls.select.options ?? [])) {
      option.dataset.label ??= option.textContent ?? "";
      const hidden = this.hiddenOnModel(controls.pack.id, option.value);
      option.textContent = hidden ? `${option.dataset.label} · ${uiText("不适合当前模型")}` : option.dataset.label;
      option.dataset.motionFit = this.motionFit?.motions[`${controls.pack.id}/${option.value}`] ?? "";
    }
  }

  async init(): Promise<void> {
    if (this.disposed || this.unsubscribe) return;
    this.render();
    this.unsubscribe = window.desktop.onMotionDownload((progress) =>
      this.onProgress(progress),
    );
    await this.loadStatus();
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    this.trackCoverage.setModelKey(this.options.getModel()?.url ?? "");
    const fit = this.motionFit?.summary.model === "adapted" ? this.motionFit.summary : null;
    if (this.modelHint)
      this.modelHint.textContent = !this.options.getModel()
        ? uiText("点击「使用预装 Gene」载入模型，再选择配套动作。")
        : fit && fit.checked < fit.total && fit.scan === "running"
          ? uiTemplate`当前模型：正在检查动作是否适合（${fit.checked} / ${fit.total}）`
          : fit ? uiTemplate`当前模型：${fit.total} 个动作里 ${fit.usable} 个可用（已按模型自动适配）`
            : uiText("已为 Gene 适配；其它模型可能需要重新调整骨骼。短舞与手势由你选择启用。");
    const busy = this.busyPack !== null || this.busyLayer !== null;
    if (this.targetSelect) this.targetSelect.disabled = busy;
    if (this.targetHint) this.targetHint.textContent = uiText(layerHints[this.targetLayer]);
    const settings = this.options.getSettings?.();
    const layers = settings ? getMotionLayerAssets(settings) : null;
    for (const [layer, controls] of this.layerControls) {
      const asset = layers?.[layer];
      controls.name.textContent = layer === "expression" && settings && !settings.motionLayers && asset
        ? uiTemplate`随身体动作：${asset.name}` : asset?.name ?? uiText("未启用");
      controls.clear.disabled = busy || !asset || !this.options.onClearLayer;
      controls.clear.textContent = this.busyLayer === layer ? uiText("正在清除…") : uiText("清除");
    }
    for (const controls of this.cards.values()) {
      const installed = this.status?.packs.find(
        (pack) => pack.id === controls.pack.id,
      );
      const ready = !this.statusError && installed?.complete === true && installed.bundled === true;
      controls.count.textContent = `${installed?.installedMotionIds.length ?? 0} / ${controls.pack.motions.length} ${ready ? uiText("已预装") : uiText("已校验")}`;
      const selected = controls.pack.motions.find(
        (motion) => motion.id === controls.selectedId,
      );
      controls.weights.setAvailable(!busy && !this.statusError && !!selected &&
        installed?.installedMotionIds.includes(selected.id) === true);
      this.trackCoverage.setAvailable(controls.pack.id, !busy && !this.statusError && !!selected && installed?.installedMotionIds.includes(selected.id) === true);
      controls.install.textContent =
        this.busyPack === controls.pack.id
          ? uiText("正在准备…")
          : ready
            ? uiText("启用动作")
            : !this.status && !this.statusError ? uiText("正在校验…") : uiText("资源不可用");
      const unsuitable = this.hiddenOnModel(controls.pack.id, selected?.id);
      controls.install.disabled = busy || !selected || !ready || unsuitable;
      if (unsuitable && !busy) { controls.status.textContent = uiText("这个动作不适合当前模型"); controls.status.dataset.motionFit = "hidden"; }
      else if (controls.status.dataset.motionFit) { controls.status.textContent = ""; delete controls.status.dataset.motionFit; }
      const previewing = this.previewState.packId === controls.pack.id && this.previewState.motionId === selected?.id && this.previewState.layer === this.targetLayer;
      controls.preview.textContent = previewing && this.previewState.phase === "playing" ? uiText("重新预览") : uiText("预览动作");
      controls.preview.disabled = busy || this.previewState.phase === "loading" || !selected || !ready || !this.options.getModel() || unsuitable;
      controls.select.disabled = busy || !selected;
      controls.search.disabled = busy;
      controls.cancel.classList.toggle(
        "hidden",
        this.busyPack !== controls.pack.id,
      );
      if (this.busyPack !== controls.pack.id) controls.cancel.disabled = false;
      if (this.busyPack === null && (this.statusError || (this.status && !ready))) {
        controls.status.textContent = uiText("预装资源缺失、损坏或无法读取，请重新解压完整源码包或安装包。");
        controls.status.classList.add("motion-pack-error");
      }
    }
  }

  setPreviewState(state: MotionPreviewState): void {
    if (this.disposed) return;
    this.previewState = state;
    if (this.previewSummary) {
      this.previewSummary.dataset.phase = state.phase;
      this.previewSummary.textContent = state.phase === "idle"
        ? uiText("先选择目标通道，再选择动作试播；「启用动作」只保存该通道并同步桌宠。")
        : uiTemplate`${state.phase === "loading" ? uiText("正在准备预览") : uiText("预览中")}：${state.name ?? uiText("动作")} · ${uiText(layerNames[state.layer ?? "pose"])} · 仅控制窗口`;
    }
    if (this.previewStop) this.previewStop.disabled = state.phase === "idle";
    this.refresh();
  }

  private stopPreview(): void {
    void this.options.onStopPreview().catch(error => {
      if (!this.disposed) this.options.onError(String(error));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.busyPack)
      void window.desktop.cancelMotionDownload().catch(() => {});
    this.trackCoverage.dispose();
    this.container.replaceChildren();
    for (const controls of this.cards.values()) controls.weights.dispose();
    this.cards.clear();
    this.layerControls.clear();
  }

  private render(): void {
    const section = element("section", "settings-section motion-library-section");
    section.setAttribute("aria-label", uiText("预装动作库"));
    section.append(element("h3", "", uiText("预装动作库")));
    section.append(
      element(
        "p",
        "hint motion-library-intro",
        uiTemplate`Gene 模型与 ${catalog.packs.reduce((sum, pack) => sum + pack.motions.length, 0)} 个已审核动作已预装，按来源选择并离线启用。`,
      ),
    );
    this.modelHint = element("p", "hint motion-library-model-hint");
    this.modelHint.id = "motion-library-model-hint";
    section.append(this.modelHint);
    section.append(this.renderLayers());
    section.append(this.renderFilters(), this.trackCoverage.element);
    this.previewSummary = element("p", "motion-preview-summary");
    this.previewSummary.id = "motion-preview-summary";
    this.previewSummary.setAttribute("role", "status");
    this.previewSummary.setAttribute("aria-live", "polite");
    this.previewStop = element("button", "subtle", uiText("停止预览"));
    this.previewStop.id = "motion-preview-stop";
    this.previewStop.type = "button";
    this.previewStop.onclick = () => this.stopPreview();
    const previewActions = element("div", "motion-preview-actions");
    previewActions.append(this.previewSummary, this.previewStop);
    section.append(previewActions);
    const list = element("div", "motion-pack-list");
    for (const pack of catalog.packs) list.append(this.renderPack(pack));
    section.append(list);
    this.directory = element("p", "hint motion-library-directory");
    this.directory.id = "motion-library-directory";
    section.append(this.directory);
    this.container.replaceChildren(section);
    this.updateFilterSummary();
    this.setPreviewState(this.previewState);
  }

  private renderLayers(): HTMLElement {
    const panel = element("div", "motion-layers");
    panel.setAttribute("aria-label", uiText("独立动作通道"));
    const label = element("label", "motion-target-label", uiText("预览 / 启用到"));
    this.targetSelect = element("select", "motion-target-select");
    this.targetSelect.id = "motion-target-layer";
    for (const layer of ["pose", "gesture", "expression"] as const)
      this.targetSelect.append(new Option(uiText(layerNames[layer]), layer));
    this.targetSelect.value = this.targetLayer;
    this.targetSelect.onchange = () => {
      this.targetLayer = this.targetSelect!.value as MotionLayer;
      this.stopPreview();
      this.refresh();
    };
    label.append(this.targetSelect);
    this.targetHint = element("p", "hint motion-target-hint");
    this.targetHint.id = "motion-target-hint";
    panel.append(label, this.targetHint);
    for (const layer of ["pose", "gesture", "expression"] as const) {
      const row = element("div", "motion-layer-row");
      const value = element("div", "motion-layer-value");
      value.append(element("strong", "", uiText(layerNames[layer])));
      const name = element("span", "motion-layer-name");
      name.id = `motion-layer-${layer}-name`;
      value.append(name);
      const clear = element("button", "subtle motion-layer-clear", uiText("清除"));
      clear.type = "button";
      clear.id = `motion-layer-${layer}-clear`;
      clear.setAttribute("aria-label", uiTemplate`清除${uiText(layerNames[layer])}通道`);
      clear.onclick = () => void this.clearLayer(layer);
      this.layerControls.set(layer, { name, clear });
      row.append(value, clear);
      panel.append(row);
    }
    return panel;
  }

  private async clearLayer(layer: MotionLayer): Promise<void> {
    if (this.disposed || this.busyPack || this.busyLayer || !this.options.onClearLayer) return;
    this.busyLayer = layer;
    this.refresh();
    try {
      await this.options.onStopPreview();
      if (!this.disposed) await this.options.onClearLayer(layer);
    } catch (error) {
      if (!this.disposed) this.options.onError(String(error));
    } finally {
      this.busyLayer = null;
      this.refresh();
    }
  }

  private renderFilters(): HTMLElement {
    const filters = element("div", "motion-filters");
    this.categorySelect = element("select", "motion-filter-category");
    this.categorySelect.id = "motion-filter-category";
    this.categorySelect.setAttribute("aria-label", uiText("按动作类型筛选"));
    this.categorySelect.append(new Option(uiText("全部类型"), "all"));
    for (const category of motionCategories) this.categorySelect.append(new Option(uiText(categoryNames[category]), category));
    this.categorySelect.onchange = () => {
      this.category = this.categorySelect!.value as "all" | MotionCategory;
      this.applyFilters();
    };
    this.tagSelect = element("select");
    this.tagSelect.id = "motion-filter-tag";
    this.tagSelect.setAttribute("aria-label", uiText("添加 tag 筛选，多个标签同时匹配"));
    this.tagSelect.onchange = () => {
      if (this.tagSelect!.value) this.selectedTags.add(this.tagSelect!.value);
      this.applyFilters();
    };
    const typeLabel = element("label", "motion-pack-select-label", uiText("动作类型"));
    typeLabel.append(this.categorySelect);
    const tagLabel = element("label", "motion-pack-select-label", uiText("添加 tag · 多选组合"));
    tagLabel.append(this.tagSelect);
    const clear = element("button", "subtle motion-filter-clear", uiText("清除筛选"));
    clear.id = "motion-filter-clear";
    clear.type = "button";
    clear.onclick = () => {
      this.category = "all";
      this.categorySelect!.value = "all";
      this.selectedTags.clear();
      for (const controls of this.cards.values()) controls.search.value = "";
      this.applyFilters();
    };
    this.selectedTagControls = element("div", "motion-filter-tags");
    this.selectedTagControls.setAttribute("aria-label", uiText("已选 tags，点击移除"));
    this.filterResult = element("p", "motion-filter-result");
    this.filterResult.id = "motion-filter-result";
    this.filterResult.setAttribute("role", "status");
    filters.append(typeLabel, tagLabel, clear, this.selectedTagControls, this.filterResult);
    this.renderTagFilters();
    return filters;
  }

  private renderTagFilters(): void {
    this.tagSelect?.replaceChildren(new Option(uiText("选择 tag"), ""));
    const motions = catalog.packs.flatMap(pack => pack.motions);
    for (const { tag, count } of listTags(motions, { category: this.category })) {
      if (!this.selectedTags.has(tag)) this.tagSelect?.append(new Option(`${tag} (${count})`, tag));
    }
    this.selectedTagControls?.replaceChildren();
    for (const tag of this.selectedTags) {
      const chip = element("button", "motion-filter-chip", `${tag} ×`);
      chip.type = "button";
      chip.dataset.motionFilterTag = tag;
      chip.setAttribute("aria-pressed", "true");
      chip.setAttribute("aria-label", uiTemplate`移除 tag ${tag}`);
      chip.onclick = () => { this.selectedTags.delete(tag); this.applyFilters(); };
      this.selectedTagControls?.append(chip);
    }
  }

  private applyFilters(): void {
    this.stopPreview();
    this.renderTagFilters();
    for (const controls of this.cards.values()) this.populateMotions(controls);
    this.updateFilterSummary();
  }

  private updateFilterSummary(): void {
    const count = [...this.cards.values()].reduce((sum, controls) => sum + controls.matched, 0);
    const total = catalog.packs.reduce((sum, pack) => sum + pack.motions.length, 0);
    if (this.filterResult) this.filterResult.textContent = count
      ? uiTemplate`${count} / ${total} 个动作 · 已选 tags 同时匹配`
      : uiTemplate`0 / ${total} 个动作 · 没有匹配项，可移除 tag 或清除筛选。`;
  }

  private renderPack(pack: MotionPack): HTMLElement {
    const card = element("article", "motion-pack-card");
    card.id = `motion-pack-${pack.id}`;
    const header = element("div", "motion-pack-heading");
    const heading = element("div");
    heading.append(element("h4", "", pack.name));
    const bytes = [...pack.motions, ...pack.documents].reduce(
      (total, file) => total + file.bytes,
      0,
    );
    heading.append(
      element("small", "", `${pack.motions.length} VMD · ${formatBytes(bytes)}`),
    );
    const count = element("span", "motion-pack-count", uiText("正在检查…"));
    count.id = `motion-count-${pack.id}`;
    header.append(heading, count);
    card.append(header);

    const search = element("input", "motion-pack-search");
    search.type = "search";
    search.id = `motion-search-${pack.id}`;
    search.placeholder = uiText("搜索英文名称或 tag，例如 happy / thinking");
    search.setAttribute("aria-label", uiTemplate`${pack.name} 搜索动作或标签`);
    card.append(search);
    const label = element("label", "motion-pack-select-label");
    label.htmlFor = `motion-select-${pack.id}`;
    label.append(element("span", "", uiText("选择动作")));
    const select = element("select", "motion-pack-select");
    select.id = `motion-select-${pack.id}`;
    label.append(select);
    card.append(label);
    const description = element("p", "motion-pack-description");
    description.id = `motion-description-${pack.id}`;
    const tags = element("div", "motion-pack-tags");
    tags.id = `motion-tags-${pack.id}`;
    card.append(description, tags);
    const weights = new MotionWeightControls(pack.id, () => {
      const current = this.cards.get(pack.id);
      if (current) this.populateMotions(current);
    });
    card.append(weights.element, this.trackCoverage.createPack(pack.id));

    const actions = element("div", "motion-pack-actions");
    const preview = element("button", "subtle", uiText("预览动作"));
    preview.type = "button";
    preview.id = `motion-preview-${pack.id}`;
    const install = element("button", "primary", uiText("启用动作"));
    install.type = "button";
    install.id = `motion-install-${pack.id}`;
    const cancel = element("button", "subtle hidden", uiText("取消启用"));
    cancel.type = "button";
    cancel.id = `motion-cancel-${pack.id}`;
    actions.append(preview, install, cancel);
    card.append(actions);
    const progress = element("progress", "motion-pack-progress hidden");
    progress.id = `motion-progress-${pack.id}`;
    progress.value = 0;
    progress.max = pack.motions.length + pack.documents.length;
    progress.setAttribute("aria-label", uiTemplate`${pack.name} 资源校验进度`);
    const status = element("p", "motion-pack-status");
    status.id = `motion-status-${pack.id}`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    card.append(progress, status, this.renderLicense(pack));

    const selectedId =
      pack.motions.find((motion) => motion.id === "happy")?.id ??
      pack.motions.find((motion) => motion.id === "stand")?.id ??
      pack.motions[0]?.id ??
      "";
    const controls: PackControls = {
      card, pack, search, select, selectedId, description, tags, count,
      install, preview, matched: pack.motions.length, cancel, progress, status, weights,
    };
    this.cards.set(pack.id, controls);
    this.populateMotions(controls);
    search.oninput = () => { this.stopPreview(); this.populateMotions(controls); };
    select.onchange = () => {
      this.stopPreview();
      controls.selectedId = select.value;
      this.describeMotion(controls);
      this.refresh();
    };
    install.onclick = () => void this.install(controls);
    preview.onclick = () => void this.preview(controls);
    cancel.onclick = () => {
      this.cancelRequested = true;
      cancel.disabled = true;
      status.textContent = uiText("正在取消启用…");
      void window.desktop.cancelMotionDownload().catch((error) => {
        if (this.disposed) return;
        cancel.disabled = false;
        this.options.onError(String(error));
      });
    };
    return card;
  }

  private renderLicense(pack: MotionPack): HTMLElement {
    const details = element("details", "motion-pack-license");
    details.append(element("summary", "", uiText("作者署名与授权说明")));
    details.append(element("p", "motion-pack-credit", pack.license.attribution));
    details.append(
      element(
        "p",
        "",
        `${pack.license.id} · ${pack.modifications ?? uiText("文件按英文名称归档，VMD 内容未改写。")}`,
      ),
    );
    details.append(element("code", "motion-pack-url", pack.license.url));
    details.append(element("p", "", `Source: ${pack.source}`));
    details.append(element("code", "motion-pack-url", pack.sourceUrl));
    details.append(element("code", "motion-pack-revision", `Revision: ${pack.revision}`));
    if (pack.compatibilityNote) details.append(element("p", "", pack.compatibilityNote));
    details.append(
      element("p", "", uiText("预装资源保留上游 Readme、许可全文及每个文件的原始名称、来源、校验值和 tags。请一并遵守作者使用指南。")),
    );
    if (pack.id === "gene")
      details.append(
        element("p", "", uiText("Gene 角色形象另外保留商标与设计权，其他商业角色用途需联系作者。预装模型、贴图和动作保留各自来源与许可说明。")),
      );
    const copy = element("button", "subtle motion-pack-copy", uiText("复制来源与授权"));
    copy.type = "button";
    copy.onclick = async () => {
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard?.writeText) {
          copy.textContent = uiText("请选中上方文字复制");
          return;
        }
        await clipboard.writeText(
          `${pack.license.attribution}\n${pack.license.id}: ${pack.license.url}\nSource: ${pack.sourceUrl}\nRevision: ${pack.revision}\n${pack.modifications ?? "VMD contents unchanged; English filenames."}`,
        );
        if (!this.disposed) copy.textContent = uiText("已复制");
      } catch {
        if (!this.disposed) copy.textContent = uiText("请选中上方文字复制");
      }
    };
    details.append(copy);
    return details;
  }

  private populateMotions(controls: PackControls): void {
    let matches = filterMotions(controls.pack.motions, {
      query: controls.search.value, category: this.category, selectedTags: [...this.selectedTags],
    });
    matches = matches.filter(motion => this.trackCoverage.matches(controls.pack.id, motion));
    const ranking = controls.weights.ranking;
    if (ranking) {
      const matching = new Map(matches.map(motion => [motion.id, motion]));
      matches = ranking.rows.flatMap(row => matching.has(row.asset.motionId) ? [matching.get(row.asset.motionId)!] : []);
    }
    controls.matched = matches.length;
    controls.card.classList.toggle("hidden", matches.length === 0 && (this.category !== "all" || this.selectedTags.size > 0 || this.trackCoverage.filtering));
    controls.select.replaceChildren();
    if (ranking) {
      for (const motion of matches) {
        const row = ranking.rows.find(row => row.asset.motionId === motion.id)!;
        controls.select.append(new Option(`${motion.name} · ${row.knownCoverage === 0 ? uiText('未评估') : row.rankingValue.toFixed(3)}`, motion.id));
      }
    } else for (const category of ["pose", "expression", "reaction", "idle", "gesture", "dance"] as const) {
      const motions = matches.filter((motion) => motion.category === category);
      if (!motions.length) continue;
      const group = element("optgroup");
      group.label = uiText(categoryNames[category]);
      for (const motion of motions) group.append(new Option(motion.name, motion.id));
      controls.select.append(group);
    }
    if (!matches.some((motion) => motion.id === controls.selectedId))
      controls.selectedId = matches[0]?.id ?? "";
    controls.select.value = controls.selectedId;
    this.markMotionFit(controls);
    this.describeMotion(controls);
    this.refresh();
    this.updateFilterSummary();
  }

  private describeMotion(controls: PackControls): void {
    const motion: CatalogMotion | undefined = controls.pack.motions.find(
      (candidate) => candidate.id === controls.selectedId,
    );
    controls.weights.select(motion ?? null);
    this.trackCoverage.selectMotion(controls.pack.id, motion ?? null);
    controls.tags.replaceChildren();
    if (!motion) {
      controls.description.textContent = uiText("没有匹配的动作，请换一个英文关键词或 tag。");
      return;
    }
    const kind = motion.boneFrames === 0 ? uiText("表情预设") : uiText("含骨骼动作");
    controls.description.textContent = `${motion.relativePath} · ${kind}`;
    for (const tag of motion.tags) {
      const chip = element("button", "motion-filter-chip motion-tag", tag);
      chip.type = "button";
      chip.setAttribute("aria-label", uiTemplate`按 tag ${tag} 筛选`);
      chip.setAttribute("aria-pressed", String(this.selectedTags.has(tag)));
      chip.onclick = () => {
        if (this.selectedTags.has(tag)) this.selectedTags.delete(tag); else this.selectedTags.add(tag);
        this.applyFilters();
      };
      controls.tags.append(chip);
    }
  }

  private async preview(controls: PackControls): Promise<void> {
    const motion = controls.pack.motions.find(motion => motion.id === controls.selectedId);
    if (!motion || this.disposed || this.busyPack || this.busyLayer || !this.options.getModel()) return;
    controls.status.classList.remove("motion-pack-error");
    try {
      await this.options.onPreview(controls.pack.id, motion, this.targetLayer);
    } catch (error) {
      if (this.disposed) return;
      controls.status.textContent = uiTemplate`预览失败：${String(error)}`;
      controls.status.classList.add("motion-pack-error");
      this.options.onError(String(error));
    }
  }

  private async loadStatus(): Promise<void> {
    const request = ++this.statusRequest;
    try {
      const status = await window.desktop.getMotionLibrary();
      if (this.disposed || request !== this.statusRequest) return;
      this.status = status;
      this.statusError = false;
      if (this.directory) this.directory.textContent = uiTemplate`素材目录：${status.directory}`;
      this.refresh();
    } catch (error) {
      if (!this.disposed && request === this.statusRequest) {
        this.statusError = true;
        this.refresh();
        this.options.onError(uiTemplate`动作库状态读取失败：${String(error)}`);
      }
    }
  }

  private onProgress(progress: MotionDownloadProgress): void {
    if (this.disposed || this.busyPack !== progress.packId) return;
    const controls = this.cards.get(progress.packId);
    if (!controls) return;
    controls.progress.classList.remove("hidden");
    controls.progress.max = Math.max(1, progress.total);
    controls.progress.value = progress.completed;
    controls.status.textContent = `${progress.completed} / ${progress.total} · ${progress.fileName}`;
  }

  private async install(controls: PackControls): Promise<void> {
    if (this.disposed || this.busyPack || this.busyLayer || !controls.selectedId) return;
    const motionId = controls.selectedId;
    const layer = this.targetLayer;
    const motionName = controls.pack.motions.find((motion) => motion.id === motionId)?.name ?? motionId;
    this.busyPack = controls.pack.id;
    this.cancelRequested = false;
    controls.status.classList.remove("motion-pack-error");
    controls.status.textContent = uiText("正在检查本地文件并准备动作…");
    controls.progress.value = 0;
    controls.progress.classList.remove("hidden");
    this.refresh();
    try {
      await this.options.onStopPreview();
      if (this.options.beforeInstall && !(await this.options.beforeInstall())) {
        if (!this.disposed)
          controls.status.textContent = uiText("设置尚未保存，未启用动作，请重试。");
        return;
      }
      if (this.disposed) return;
      if (this.cancelRequested) {
        controls.status.textContent = uiText("已取消，未启用动作。");
        return;
      }
      const asset = await window.desktop.installMotionPack(controls.pack.id, motionId, layer);
      if (this.disposed) return;
      await this.options.onEnabled(asset, layer);
      if (this.disposed) return;
      controls.status.textContent = this.options.getModel()
        ? uiTemplate`已启用 ${motionName} · ${uiText(layerNames[layer])}`
        : uiTemplate`已选用 ${motionName}；载入预装 Gene 后可再次启用`;
    } catch (error) {
      if (this.disposed) return;
      const message = String(error);
      if (/abort|cancel|取消|停止/i.test(message))
        controls.status.textContent = uiText("启用已取消；原动作保持不变。");
      else {
        controls.status.textContent = uiTemplate`未能启用，可重试：${message}`;
        controls.status.classList.add("motion-pack-error");
        this.options.onError(message);
      }
    } finally {
      if (!this.disposed) {
        controls.progress.classList.add("hidden");
        await this.loadStatus();
        this.busyPack = null;
        this.refresh();
      }
    }
  }
}
