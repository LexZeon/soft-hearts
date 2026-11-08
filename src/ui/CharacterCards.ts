import { uiText, uiTemplate } from './ui-language';
import {
  CHARACTER_TEXT_LIMITS,
  MAX_CHARACTER_CARDS,
  defaultCharacterMoodTemplate,
  effectiveCharacterMood,
  validateCharacterDraft,
  validateCharacterMoodTemplate,
  type CharacterMoodTemplate,
  type CharacterTextField,
  type CharacterDraft,
  type CharacterCardState,
} from "../../shared/character-cards";
import { MOOD_CHANNELS, type MoodParameters } from '../../shared/mood';
import { moodExtendedDifferences } from './MoodPanel';
import { CharacterResponseControls } from './CharacterResponseControls';
import { PersonalizeLanguageControls } from './PersonalizeLanguageControls';
import { PersonalizeVisualControls } from './PersonalizeVisualControls';
import { PersonalizeBodyControls } from './PersonalizeBodyControls';
import type { VisualPreview } from '../../shared/personalize-visual';
import type { ExpressionPreview } from '../../shared/expression-composition';
import type { BodyPosePreview } from '../../shared/personalize-body';
import type { ExpressionRecipe, ExpressionSupport } from '../../shared/expression-preview';
import { ExpressionPreviewButtons } from './ExpressionPreviewButtons';

interface CharacterCardsOptions {
  onError(message: string): void;
  onState?(state: CharacterCardState): void;
  onVisualPreview?(view:VisualPreview):Promise<boolean>;
  onExpressionPreview?(view:ExpressionPreview):Promise<boolean>;
  onBodyPreview?(view:BodyPosePreview):Promise<boolean>;
  /** E1: what this window's stage can show of 惊喜 / 害羞 on the loaded model (the 「预览」 buttons in 「心情和反应」). */
  expressionSupport?(recipe: ExpressionRecipe): ExpressionSupport | null;
  /** C2: deleting goes through the character page's confirmation (her memories stay unless ticked). */
  onDelete?(id: string): void;
  /** I-018: a card this editor just created from scratch or imported (not a copy): the page may talk it over with Claude. */
  onCreated?(card: CharacterCardState['cards'][number], how: 'created' | 'imported'): void;
}
type Field = CharacterTextField;
const draftFields: Field[] = ["name", "description", "personality", "scenario", "greeting", "examples", "systemPrompt"];
const emptyDraft = (): CharacterDraft => ({ name: uiText("新角色"), description: "", personality: "", scenario: "", greeting: "", examples: "", systemPrompt: "", mood: defaultCharacterMoodTemplate() });
const NEW = "__new_character__";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Text and parameter templates only; files, live state and permissions remain in the host. */
export class CharacterCards {
  private state: CharacterCardState = { cards: [], activeId: "" };
  private selectedId: string | null = null;
  private creating = false;
  private dirty = false;
  private busy = false;
  private disposed = false;
  private rendered = false;
  private stateRevision = 0;
  private lastNotice = "";
  private unsubscribe: (() => void) | null = null;
  private readonly fields = {} as Record<Field, HTMLInputElement | HTMLTextAreaElement>;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private select!: HTMLSelectElement;
  private active!: HTMLElement;
  private status!: HTMLOutputElement;
  private binding!: HTMLElement;
  private count!: HTMLElement;
  private warmUp!: HTMLInputElement;
  private realer!: HTMLInputElement;
  private moodEditor!: HTMLTextAreaElement;
  private moodSummary!: HTMLOutputElement;
  private blushEnabled!: HTMLInputElement;
  private blushIntensity!: HTMLInputElement;
  private blushValue!: HTMLOutputElement;
  private blushSize!: HTMLInputElement;
  private blushSizeValue!: HTMLOutputElement;
  private moodJsonValid = true;
  private moodControlError = false;
  private moodBaseline: MoodParameters = defaultCharacterMoodTemplate().parameters;
  private readonly importedRangeReview = new Set<string>();
  private readonly moodFields = new Map<string, HTMLInputElement>();
  private responseControls: CharacterResponseControls | null = null;
  private expressionPreview: ExpressionPreviewButtons | null = null;
  private personalizeControls: PersonalizeLanguageControls | null = null;
  private visualControls: PersonalizeVisualControls | null = null;
  private bodyControls: PersonalizeBodyControls | null = null;
  private responseCopySourceId: string | null = null;
  private readonly responseCopyRetries = new Map<string, string>();

  constructor(private readonly container: HTMLElement, private readonly options: CharacterCardsOptions) {}

  async init(): Promise<void> {
    if (this.disposed || this.unsubscribe) return;
    this.render();
    const revision = this.stateRevision;
    this.unsubscribe = window.desktop.onCharacterCards(state => this.applyState(state));
    try {
      const state = await window.desktop.getCharacterCards();
      if (this.disposed) return;
      if (revision === this.stateRevision) this.applyState(state);
      if (!this.dirty) this.setStatus(uiText("编辑后保存；切换角色会开始新对话"));
      this.options.onState?.(this.state);
    } catch (error) { this.error(error); }
  }

  /** Root may apply host broadcasts here; it never recursively calls onState. */
  applyState(state: CharacterCardState): void {
    if (this.disposed) return;
    if ((state.revision ?? 0) < (this.state.revision ?? 0)) return;
    this.render();
    const activeChanged = this.state.activeId !== state.activeId;
    this.state = structuredClone(state);
    this.stateRevision++;
    if (this.selectedId && !state.cards.some(card => card.id === this.selectedId)) {
      if (this.dirty) { this.selectedId = null; this.creating = true; }
      else this.selectedId = null;
    }
    if (!this.creating && (!this.selectedId || (activeChanged && !this.dirty))) this.selectedId = state.activeId || state.cards[0]?.id || null;
    this.renderOptions();
    if (!this.dirty && !this.creating) this.fillSelected();
    this.refresh();
    if (state.notice && state.notice !== this.lastNotice) {
      this.lastNotice = state.notice;
      this.options.onError(state.notice);
    } else if (!state.notice) this.lastNotice = "";
  }

  /** C2 角色页 "编辑人设" / "心情和反应": open this card in the editor (unsaved edits of another card are asked about first). */
  edit(id: string, part: 'persona' | 'tune' = 'persona'): void {
    if (this.disposed || this.busy || !this.state.cards.some(card => card.id === id)) return;
    if ((this.dirty || this.creating) && this.selectedId !== id && !window.confirm(uiText('编辑中的修改还没保存，要放弃这些修改吗？'))) return;
    if (this.selectedId !== id || this.creating) {
      this.selectedId = id; this.creating = this.dirty = false;
      this.renderOptions(); this.fillSelected(); this.refresh();
    }
    const target = part === 'tune' ? document.getElementById('character-response-controls') : this.fields.name.closest('section');
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    if (part === 'tune') this.expressionPreview?.refresh();
    if (part === 'persona') this.fields.name.focus({ preventScroll: true });
  }
  /** C2 新增角色 · 空白新建. */
  newBlank(): void {
    if ((this.dirty || this.creating) && !window.confirm(uiText('编辑中的修改还没保存，要放弃这些修改吗？'))) return;
    this.dirty = false;
    this.beginDraft(emptyDraft());
    this.fields.name.closest('section')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.responseControls?.dispose(); this.responseControls = null;
    this.personalizeControls?.dispose(); this.personalizeControls = null;
    this.visualControls?.dispose(); this.visualControls = null;
    this.bodyControls?.dispose(); this.bodyControls = null;
    this.responseCopyRetries.clear();
    this.container.replaceChildren();
    this.buttons.clear();
  }

  private render(): void {
    if (this.rendered) return;
    this.rendered = true;
    const section = element("section", "settings-section character-cards");
    section.setAttribute("aria-label", uiText("角色卡"));
    const heading = element("div", "character-heading");
    heading.append(element("h3", "", uiText("角色卡")));
    this.active = element("span", "character-active", uiText("正在读取…")); this.active.id = "character-active";
    heading.append(this.active);
    section.append(heading, element("p", "hint", uiText("保存伙伴的人设与心情参数模板。选择已有卡片即可启用，并开始新的对话。")));
    const chooser = element("div", "character-chooser");
    const label = element("label", "character-select-label");
    label.append(element("span", "", uiText("选择角色")));
    this.select = element("select"); this.select.id = "character-select";
    this.select.setAttribute("aria-label", uiText("选择并启用角色卡"));
    this.select.onchange = () => { if (this.select.value !== NEW) void this.activate(this.select.value); };
    label.append(this.select); chooser.append(label);
    const tools = element("div", "character-tools");
    tools.append(
      this.button("new", uiText("新建"), () => this.beginDraft(emptyDraft())),
      this.button("duplicate", uiText("复制"), () => {
        try {
          const sourceId = this.creating ? this.responseCopySourceId : this.selectedId;
          const draft = this.readDraft();
          draft.name = uiTemplate`${draft.name.trim() || uiText("新角色")} 副本`.slice(0, CHARACTER_TEXT_LIMITS.name);
          this.beginDraft(draft, this.moodBaseline);
          this.responseCopySourceId = sourceId;
        } catch (error) { this.error(error); }
      }),
      this.button("import", uiText("导入 JSON"), () => void this.importCard()),
      this.button("export", uiText("导出"), () => void this.exportCard()),
    );
    chooser.append(tools); section.append(chooser);
    const editor = element("div", "character-editor");
    editor.append(
      this.field("name", uiText("角色名称"), uiText("给伙伴起个名字"), 1),
      this.field("description", uiText("角色简介"), uiText("身份、背景与特点（可留空）"), 3),
      this.field("personality", uiText("性格与说话方式"), uiText("个性、表达习惯和相处方式（可留空）"), 3),
      this.field("greeting", uiText("开场白"), uiText("切换角色后显示的第一句话（可留空）"), 3),
      this.warmUpControl(),
      this.realerControl(),
    );
    const more = element("details", "character-more");
    more.append(element("summary", "", uiText("情境与对话示例")));
    const moreFields = element("div", "character-more-fields");
    moreFields.append(this.field("scenario", uiText("相处情境"), uiText("角色所在的环境、你们的关系（可留空）"), 3), this.field("examples", uiText("对话示例"), uiText("用户：……\n角色：……"), 5));
    more.append(moreFields);
    editor.append(more, this.field("systemPrompt", uiText("补充系统指令"), uiText("额外的角色指令（可留空）"), 5));
    section.append(editor, element("p", "hint character-prompt-hint", uiText("角色人设合计最多 12000 字；开场白不计入。角色卡不改变聊天连接、密钥或 Agent 权限。")));
    section.append(this.renderMoodEditor());
    const response = element('div'); section.append(response);
    // E1: the 「预览：惊喜 / 害羞」 buttons sit at the top of 「心情和反应」 (on the pet, any model; missing parts are skipped).
    this.expressionPreview = new ExpressionPreviewButtons({ support: recipe => this.options.expressionSupport?.(recipe) ?? null }, { className: 'character-expression-preview', label: uiText('在桌面上的她身上预览：') });
    this.responseControls = new CharacterResponseControls(response, { api: window.desktop, onError: message => this.options.onError(message), extra: this.expressionPreview.root });
    const personalize = element('div'); section.append(personalize);
    this.personalizeControls = new PersonalizeLanguageControls(personalize, { api: window.desktop, onError: message => this.options.onError(message) });
    const visual=element('div');section.append(visual);
    this.visualControls=new PersonalizeVisualControls(visual,{api:window.desktop,onError:message=>this.options.onError(message),preview:view=>this.options.onVisualPreview?.(view)??Promise.resolve(false),
      previewExpression:view=>this.options.onExpressionPreview?.(view)??Promise.resolve(false)});
    const body=element('div');section.append(body);
    this.bodyControls=new PersonalizeBodyControls(body,{api:window.desktop,onError:message=>this.options.onError(message),preview:view=>this.options.onBodyPreview?.(view)??Promise.resolve(false)});
    const model = element("div", "character-model");
    const modelText = element("div"); modelText.append(element("strong", "", uiText("MMD 模型关联")));
    this.binding = element("small", "", uiText("未关联模型")); this.binding.id = "character-model-name";
    modelText.append(this.binding); model.append(modelText);
    const modelActions = element("div", "character-model-actions");
    modelActions.append(this.button("bind-model", uiText("关联当前 MMD"), () => void this.bindModel(true)), this.button("unbind-model", uiText("解除关联"), () => void this.bindModel(false)));
    model.append(modelActions); section.append(model);
    section.append(element("p", "hint character-format-hint", uiText("导出 soft hearts v3 人设、心情数值与反应模板；兼容旧 v1 / v2 / Tavern 文字卡。模型关联仅保存在本机；不导出实时状态、聊天、本地路径或连接配置。")));
    const footer = element("div", "character-footer");
    const actions = element("div", "character-actions");
    actions.append(this.button("save", uiText("保存"), () => void this.save(false)), this.button("save-activate", uiText("保存并启用"), () => void this.save(true), "primary"), this.button("delete", uiText("删除"), () => void this.deleteCard(), "subtle"));
    actions.append(this.button('retry-response-copy', uiText('重试复制反应细调'), () => void this.retryResponseCopy(), 'subtle'));
    this.count = element("span", "character-count");
    footer.append(actions, this.count);
    this.status = element("output", "character-status", uiText("正在读取角色卡…")); this.status.id = "character-status";
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    section.append(footer, this.status); this.container.replaceChildren(section);
    this.refresh();
  }

  private renderMoodEditor(): HTMLElement {
    const section = element('section', 'character-mood'); section.setAttribute('aria-label', uiText('角色心情数值模板'));
    const heading = element('div', 'character-mood-heading');
    heading.append(element('strong', '', uiText('心情数值模板 · v1')), this.button('mood-gene', uiText('恢复 Gene 模板'), () => {
      this.setMoodTemplate(defaultCharacterMoodTemplate()); this.markDirty();
      this.setStatus(uiText('已填入 Gene 模板；保存后应用，不删除当前状态或聊天记录。'));
    }));
    section.append(heading, element('p', 'hint', uiText('这些数值随角色卡保存、复制和导出。只调整规则与表达偏好，不导入或复制当前通道值、B/M、互动进度或私人经历。半衰期控件单位为分钟；完整 JSON 的时间单位为毫秒。')));
    const table = element('table', 'character-mood-table'); const head = element('tr');
    for (const label of [uiText('通道'), uiText('静息基线'), uiText('事件敏感度'), uiText('恢复半衰期（分钟）')]) head.append(element('th', '', label));
    const thead = element('thead'); thead.append(head); table.append(thead); const body = element('tbody');
    const halfLifeBounds = { D: [1 / 6, 180], O: [0.5, 1440], E: [0.5, 720], N: [1 / 12, 60], C: [0.5, 1440] };
    for (const channel of MOOD_CHANNELS) {
      const row = element('tr'); const name = element('th', '', channel); name.scope = 'row'; row.append(name);
      for (const group of ['baseline', 'sensitivity', 'halfLifeMs'] as const) {
        const cell = element('td'), input = element('input'); input.type = 'number'; input.step = 'any';
        const suffix = group === 'halfLifeMs' ? 'half-life' : group;
        input.id = `character-mood-${suffix}-${channel}`;
        input.setAttribute('aria-label', `${channel} ${group === 'baseline' ? uiText('静息基线') : group === 'sensitivity' ? uiText('事件敏感度') : uiText('恢复半衰期，分钟')}`);
        const bounds = group === 'baseline' ? [5, 95] : group === 'sensitivity' ? [0, 4] : halfLifeBounds[channel];
        input.min = String(bounds[0]); input.max = String(bounds[1]);
        input.onchange = () => this.changeMood(template => { template.parameters[group][channel] = group === 'halfLifeMs' ? Math.round(Number(input.value) * 60_000) : Number(input.value); });
        this.moodFields.set(`${group}.${channel}`, input); cell.append(input); row.append(cell);
      }
      body.append(row);
    }
    table.append(body); section.append(table, element('p', 'hint', uiText('常规基线 40～60、敏感度 0.5～1.5 倍。有效的扩展配置会在保存或首次启用前说明影响并确认；未修改的既有配置不重复询问。')));
    const blush = element('div', 'character-blush-controls');
    const enable = element('label', 'character-blush-toggle'); this.blushEnabled = element('input'); this.blushEnabled.type = 'checkbox'; this.blushEnabled.id = 'character-blush-enabled';
    this.blushEnabled.onchange = () => this.changeMood(template => { template.parameters.blush.enabled = this.blushEnabled.checked; });
    enable.append(this.blushEnabled, element('span', '', uiText('自动脸红')));
    const intensity = element('label', 'character-blush-intensity'); intensity.append(element('span', '', uiText('脸红强度')));
    this.blushIntensity = element('input'); this.blushIntensity.type = 'range'; this.blushIntensity.min = '0'; this.blushIntensity.max = '100'; this.blushIntensity.step = '1'; this.blushIntensity.id = 'character-blush-intensity';
    this.blushIntensity.setAttribute('aria-label', uiText('角色脸红强度')); this.blushIntensity.oninput = () => this.changeMood(template => { template.parameters.blush.intensity = Number(this.blushIntensity.value); });
    this.blushValue = element('output'); intensity.append(this.blushIntensity, this.blushValue);
    const size = element('label', 'character-blush-intensity'); size.append(element('span', '', uiText('脸红大小')));
    this.blushSize = element('input'); this.blushSize.type = 'range'; this.blushSize.min = '0'; this.blushSize.max = '100'; this.blushSize.step = '1'; this.blushSize.id = 'character-blush-size';
    this.blushSize.setAttribute('aria-label', uiText('角色脸红大小')); this.blushSize.oninput = () => this.changeMood(template => { template.parameters.blush.size = Number(this.blushSize.value); });
    this.blushSizeValue = element('output'); size.append(this.blushSize, this.blushSizeValue);
    blush.append(enable, intensity, size); section.append(blush, element('p', 'hint', uiText('强度控制显色，大小单独控制双颊程序红晕的范围：50 为默认，100 约为默认的两倍，0 隐藏。关闭或强度为 0 不改变内在心情；实际表现还遵守模型与手选动作限制。')));
    const advanced = element('details', 'character-mood-advanced'); advanced.id = 'character-mood-advanced'; advanced.append(element('summary', '', uiText('完整心情模板 JSON：B/M、频率、倾向、强度与脸红时间')));
    this.moodEditor = element('textarea'); this.moodEditor.id = 'character-mood-template'; this.moodEditor.rows = 16; this.moodEditor.spellcheck = false; this.moodEditor.maxLength = 30000;
    this.moodEditor.dataset.schema = 'soft-hearts-mood-v1'; this.moodEditor.setAttribute('aria-label', uiText('完整角色心情模板 JSON'));
    this.moodEditor.oninput = () => {
      this.dirty = true;
      try { const template = validateCharacterMoodTemplate(JSON.parse(this.moodEditor.value)); this.updateMoodControls(template); this.setStatus(uiText('数值模板有尚未保存的修改。')); }
      catch { this.moodJsonValid = false; this.moodSummary.textContent = uiText('JSON 尚未完整或参数无效；请修正后保存。'); }
      this.refresh();
    };
    advanced.append(this.moodEditor); this.moodSummary = element('output', 'character-mood-summary'); this.moodSummary.id = 'character-mood-summary';
    section.append(advanced, this.moodSummary); this.setMoodTemplate(defaultCharacterMoodTemplate());
    return section;
  }

  private markDirty(): void { this.dirty = true; this.refresh(); }
  private setMoodTemplate(template: CharacterMoodTemplate): void {
    const validated = validateCharacterMoodTemplate(template);
    this.moodEditor.value = JSON.stringify(validated, null, 2); this.updateMoodControls(validated);
  }
  private updateMoodControls(template: CharacterMoodTemplate): void {
    this.moodJsonValid = true; this.moodControlError = false;
    for (const [key, input] of this.moodFields) {
      const [group, channel] = key.split('.') as ['baseline' | 'sensitivity' | 'halfLifeMs', typeof MOOD_CHANNELS[number]];
      const value = template.parameters[group][channel]; input.value = String(group === 'halfLifeMs' ? value / 60_000 : value);
    }
    this.blushEnabled.checked = template.parameters.blush.enabled; this.blushIntensity.value = String(template.parameters.blush.intensity); this.blushValue.textContent = `${template.parameters.blush.intensity} / 100`;
    this.blushSize.value = String(template.parameters.blush.size); this.blushSizeValue.textContent = `${template.parameters.blush.size} / 100`;
    this.moodSummary.textContent = uiTemplate`模板 v1 · D/O/E/N/C 敏感度 ${MOOD_CHANNELS.map(channel => template.parameters.sensitivity[channel]).join(' / ')} · 脸红 ${template.parameters.blush.enabled && template.parameters.blush.intensity > 0 && template.parameters.blush.size > 0 ? uiTemplate`${template.parameters.blush.intensity}，大小 ${template.parameters.blush.size}` : uiText('关闭')} · 保存后生效`;
  }
  private changeMood(update: (template: CharacterMoodTemplate) => void): void {
    try {
      const template = validateCharacterMoodTemplate(JSON.parse(this.moodEditor.value));
      update(template); this.setMoodTemplate(template); this.markDirty(); this.setStatus(uiText('数值模板有尚未保存的修改。'));
    } catch (error) { this.moodControlError = true; this.markDirty(); this.error(error); }
  }
  private confirmMood(template: CharacterMoodTemplate, baseline = this.moodBaseline, remember = true): boolean {
    const changes = moodExtendedDifferences(template.parameters, baseline);
    if (changes.length && !window.confirm(uiTemplate`这张角色卡包含新的扩展心情配置，可能改变敏感程度、恢复速度或主动频率：\n\n${changes.slice(0, 20).join('\n')}${changes.length > 20 ? uiTemplate`\n另有 ${changes.length - 20} 项。` : ''}\n\n是否采用本次配置？`)) {
      this.setStatus(uiText('扩展配置尚未应用；编辑内容与原有状态、记忆保留。')); return false;
    }
    if (remember) this.moodBaseline = structuredClone(template.parameters);
    return true;
  }

  private button(id: string, text: string, action: () => void, className = ""): HTMLButtonElement {
    const button = element("button", className, text);
    button.type = "button"; button.id = `character-${id}`; button.onclick = action;
    this.buttons.set(id, button);
    return button;
  }
  /** 熟悉度: "关系慢慢升温", off by default; a card setting that is exported with the card. */
  private warmUpControl(): HTMLElement {
    const wrap = element("div", "character-warm-up");
    const label = element("label", "character-warm-up-toggle");
    this.warmUp = element("input"); this.warmUp.type = "checkbox"; this.warmUp.id = "character-slow-warm-up";
    this.warmUp.onchange = () => {
      if (!this.dirty) this.setStatus(uiText("有尚未保存的修改"));
      this.markDirty();
    };
    label.append(this.warmUp, element("span", "", uiText("关系慢慢升温")));
    wrap.append(label, element("p", "hint", uiText("默认不勾：她从第一天起就和你很熟。勾上后，刚认识时她客气、好奇一点，不装熟，相处的天数多了才慢慢放开；慢热的角色放开得更慢。昵称和只属于你们的梗不受这个开关影响。")));
    return wrap;
  }
  /**
   * F6 "更真实的情绪": off by default. Not part of the draft: ticking it asks the host, which first shows what it does in a dialog
   * and saves only on "我知道了，打开"; unticking saves at once. The box always shows the saved value.
   */
  private realerControl(): HTMLElement {
    const wrap = element("div", "character-warm-up character-realer");
    const label = element("label", "character-warm-up-toggle");
    this.realer = element("input"); this.realer.type = "checkbox"; this.realer.id = "character-realer-emotions";
    this.realer.onchange = () => { void this.setRealer(this.realer.checked); };
    label.append(this.realer, element("span", "", uiText("更真实的情绪")));
    wrap.append(label, element("p", "hint", uiText("默认不勾。勾上时会先说明她会怎样：可以说更重的话、闹别扭更久、不一定先和好、吃醋更明显；你难过时她不加码，Claude 的安全规则不变。你点“我知道了，打开”才生效，取消勾选马上恢复。")));
    return wrap;
  }
  private async setRealer(on: boolean): Promise<void> {
    const id = this.selectedId;
    if (this.creating || !id) { this.realer.checked = false; this.setStatus(uiText("先保存这张角色卡，再打开“更真实的情绪”")); return; }
    await this.operation(async () => {
      const next = await window.desktop.requestCharacterRealerEmotions(id, on);
      if (this.disposed) return;
      this.accept(next);
      const now = next.cards.find(card => card.id === id)?.realerEmotions === true;
      this.setStatus(on ? (now ? uiText("已打开“更真实的情绪”") : uiText("没有打开“更真实的情绪”")) : uiText("已关闭“更真实的情绪”，她马上恢复原来的样子"));
    });
    if (!this.disposed) this.refresh();
  }
  private field(key: Field, title: string, placeholder: string, rows: number): HTMLLabelElement {
    const label = element("label", `field character-field character-field-${key}`);
    label.append(element("span", "", title));
    const input = key === "name" ? element("input") : element("textarea");
    input.id = key === "systemPrompt" ? "persona" : `character-${key}`;
    input.placeholder = placeholder; input.maxLength = CHARACTER_TEXT_LIMITS[key];
    if (input instanceof HTMLTextAreaElement) input.rows = rows;
    else { input.type = "text"; input.required = true; }
    input.oninput = () => {
      if (!this.dirty) this.setStatus(uiText("有尚未保存的修改"));
      this.dirty = true; this.refresh();
    };
    this.fields[key] = input; label.append(input);
    return label;
  }
  private readDraft(): CharacterDraft {
    if (this.moodControlError) throw new Error(uiText('请先修正快捷数值控件，或在完整 JSON 中恢复有效模板；尚未保存本次数值修改。'));
    return validateCharacterDraft({ ...Object.fromEntries(draftFields.map(key => [key, this.fields[key].value])), mood: JSON.parse(this.moodEditor.value), slowWarmUp: this.warmUp.checked });
  }
  private fillDraft(draft: CharacterDraft, baseline = effectiveCharacterMood(draft)): void {
    for (const key of draftFields) this.fields[key].value = draft[key];
    this.warmUp.checked = draft.slowWarmUp === true;
    this.setMoodTemplate({ version: 1, parameters: effectiveCharacterMood(draft) }); this.moodBaseline = structuredClone(baseline);
  }
  private fillSelected(): void {
    const card = this.state.cards.find(card => card.id === this.selectedId);
    if (card) this.fillDraft(card, this.importedRangeReview.has(card.id) ? defaultCharacterMoodTemplate().parameters : effectiveCharacterMood(card));
  }
  private renderOptions(): void {
    this.select.replaceChildren();
    for (const card of this.state.cards) {
      const option = element("option", "", `${card.name}${card.id === this.state.activeId ? uiText(" · 使用中") : ""}`);
      option.value = card.id; this.select.append(option);
    }
    if (this.creating) { const option = element("option", "", uiText("未保存的新角色")); option.value = NEW; this.select.append(option); }
    this.select.value = this.creating ? NEW : this.selectedId ?? "";
  }
  private refresh(): void {
    if (!this.rendered || this.disposed) return;
    const selected = this.state.cards.find(card => card.id === this.selectedId);
    const active = this.state.cards.find(card => card.id === this.state.activeId);
    const canAdd = this.state.cards.length < MAX_CHARACTER_CARDS;
    this.active.textContent = active ? uiTemplate`使用中：${active.name}` : uiText("尚无角色");
    this.binding.textContent = selected?.modelName ? uiTemplate`已关联：${selected.modelName}` : this.creating ? uiText("保存后可选择关联当前模型") : uiText("未关联模型，启用时保留当前 MMD");
    for (const button of this.buttons.values()) button.disabled = this.busy;
    for (const input of Object.values(this.fields)) input.disabled = this.busy;
    this.warmUp.disabled = this.busy;
    // F6: the saved value of the selected card, whatever the unsaved edits are (it is not part of the draft).
    this.realer.checked = !this.creating && selected?.realerEmotions === true;
    this.realer.disabled = this.busy || this.creating || !selected;
    this.moodEditor.disabled = this.busy;
    for (const input of [...this.moodFields.values(), this.blushEnabled, this.blushIntensity, this.blushSize]) input.disabled = this.busy || !this.moodJsonValid;
    this.select.disabled = this.busy || !this.state.cards.length;
    for (const id of ["new", "duplicate", "import"]) this.buttons.get(id)!.disabled = this.busy || !canAdd;
    this.buttons.get("duplicate")!.disabled ||= !selected && !this.creating;
    this.buttons.get('duplicate')!.title = uiText('人设与心情使用当前编辑内容；反应细调复制源卡已保存的模板，未保存的反应修改请先独立保存。');
    this.buttons.get("save")!.disabled = this.busy || !this.dirty;
    this.buttons.get("save-activate")!.disabled = this.busy || (!this.dirty && selected?.id === this.state.activeId);
    this.buttons.get("save-activate")!.textContent = !this.dirty && selected?.id === this.state.activeId ? uiText("正在使用") : !this.dirty && selected ? uiText("启用此角色") : uiText("保存并启用");
    for (const id of ["export", "bind-model", "delete"]) this.buttons.get(id)!.disabled ||= !selected;
    this.buttons.get("export")!.title = this.dirty ? uiText("导出上次保存的版本；当前修改请先保存") : uiText("导出这张角色卡");
    this.buttons.get("delete")!.disabled ||= this.state.cards.length <= 1;
    this.buttons.get("delete")!.title = this.state.cards.length <= 1 ? uiText("至少保留一张角色卡") : uiText("删除此角色卡");
    this.buttons.get("unbind-model")!.disabled ||= !selected?.modelName;
    const retry = this.buttons.get('retry-response-copy')!;
    retry.hidden = !selected || !this.responseCopyRetries.has(selected.id);
    this.count.textContent = uiTemplate`${this.state.cards.length} / ${MAX_CHARACTER_CARDS} 张`;
    let parameters = this.moodBaseline;
    try { parameters = validateCharacterMoodTemplate(JSON.parse(this.moodEditor.value)).parameters; } catch { /* Keep the last valid common values while JSON is incomplete. */ }
    this.responseControls?.select(this.creating ? null : this.selectedId, parameters, this.busy);
    this.personalizeControls?.select(!this.creating && selected ? { id: selected.id, name: selected.name } : null, this.busy);
    this.visualControls?.select(!this.creating&&selected?{id:selected.id,name:selected.name}:null,this.busy);
    this.bodyControls?.select(!this.creating&&selected?{id:selected.id,name:selected.name}:null,this.busy);
  }
  private beginDraft(draft: CharacterDraft, baseline = defaultCharacterMoodTemplate().parameters): void {
    if (this.busy || this.disposed || this.state.cards.length >= MAX_CHARACTER_CARDS) return;
    this.selectedId = null; this.creating = true; this.dirty = true;
    this.responseCopySourceId = null;
    this.fillDraft(draft, baseline); this.renderOptions(); this.refresh();
    this.setStatus(uiText("新角色尚未保存；保存后可启用")); this.fields.name.focus();
  }
  private setStatus(message: string, error = false): void {
    if (this.disposed) return;
    this.status.textContent = message; this.status.classList.toggle("character-error", error);
  }
  private error(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(message, true); this.options.onError(message);
  }
  private accept(state: CharacterCardState): void {
    if (this.disposed) return;
    this.applyState(state); this.options.onState?.(state);
  }
  private async operation(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.refresh();
    try { await action(); } catch (error) { this.error(error); }
    finally { if (!this.disposed) { this.busy = false; this.refresh(); } }
  }
  private async activate(id: string): Promise<void> {
    await this.operation(async () => {
      const target = this.state.cards.find(card => card.id === id);
      if (!target) throw new Error(uiText('角色卡不存在。'));
      const parameters = effectiveCharacterMood(target);
      if (!this.confirmMood({ version: 1, parameters }, this.importedRangeReview.has(id) ? defaultCharacterMoodTemplate().parameters : parameters, false)) return;
      this.setStatus(uiText("正在切换角色…"));
      // C2: the same switch as the character page (waits for her current line); older bridges only activate.
      const next = await (window.desktop.switchCharacter ?? window.desktop.activateCharacterCard)(id);
      if (this.disposed) return;
      this.importedRangeReview.delete(id);
      this.selectedId = id; this.creating = this.dirty = false; this.accept(next);
      this.setStatus(uiText("角色已启用，开始新的对话"));
    });
    if (!this.disposed) this.renderOptions();
  }
  private async save(enable: boolean): Promise<void> {
    if (!this.fields.name.value.trim()) { this.error(new Error(uiText("请填写角色名称。"))); this.fields.name.focus(); return; }
    await this.operation(async () => {
      const draft = this.readDraft();
      if (!this.confirmMood(draft.mood!)) return;
      let id = this.selectedId;
      if (this.dirty || this.creating || !id) {
        const fresh = this.creating && !this.responseCopySourceId; // I-018: a new card, not a copy
        const previous = new Set(this.state.cards.map(card => card.id));
        const next = await window.desktop.saveCharacterCard(draft, id ?? undefined);
        if (this.disposed) return;
        id ??= next.cards.filter(card => !previous.has(card.id)).at(-1)?.id ?? null;
        if (!id) throw new Error(uiText("未能确认保存后的角色，请重新读取角色卡。"));
        this.importedRangeReview.delete(id);
        if (this.creating && this.responseCopySourceId) this.responseCopyRetries.set(id, this.responseCopySourceId);
        this.responseCopySourceId = null;
        this.selectedId = id; this.creating = this.dirty = false; this.accept(next);
        const card = fresh && !previous.has(id) ? next.cards.find(value => value.id === id) : undefined;
        if (card) this.options.onCreated?.(card, 'created');
      }
      const sourceId = id ? this.responseCopyRetries.get(id) : undefined;
      if (id && sourceId && !await this.copyResponse(sourceId, id)) return;
      // An external character switch can arrive while the sidecar copy is in
      // flight. Keep its original target, but never re-activate or label the new
      // selection as the card whose save just completed.
      if (this.selectedId !== id || this.creating || this.disposed) return;
      if (enable) { const next = await window.desktop.activateCharacterCard(id!); this.importedRangeReview.delete(id!); this.accept(next); }
      this.setStatus(enable ? uiText("已保存并启用角色") : this.state.activeId === id ? uiText("已保存当前角色") : uiText("已保存；点击「启用此角色」开始使用"));
    });
  }
  private async copyResponse(sourceId: string, targetId: string): Promise<boolean> {
    try {
      const state = await window.desktop.copyCharacterResponse(sourceId, targetId);
      if (this.disposed) return false;
      if (state.characterId !== targetId) throw new Error(uiText('反应复制结果与已保存的新角色不匹配。'));
      if (state.storageError) throw new Error(state.storageError);
      this.responseControls?.acceptState(state); this.responseCopyRetries.delete(targetId);
      return true;
    } catch (error) {
      if (!this.disposed) {
        const message = uiTemplate`角色卡已保存，反应细调尚未复制：${error instanceof Error ? error.message : String(error)}。请点击“重试复制反应细调”；不会再次创建角色卡。`;
        if (this.selectedId === targetId && !this.creating) this.setStatus(message, true);
        this.options.onError(message);
      }
      return false;
    }
  }
  private async retryResponseCopy(): Promise<void> {
    const targetId = this.selectedId, sourceId = targetId ? this.responseCopyRetries.get(targetId) : undefined;
    if (!targetId || !sourceId) return;
    await this.operation(async () => {
      if (await this.copyResponse(sourceId, targetId) && this.selectedId === targetId && !this.creating) this.setStatus(uiText('已将源角色保存的反应细调复制到这张卡；角色ID与人设保留。'));
    });
  }
  private async deleteCard(): Promise<void> {
    const id = this.selectedId;
    if (!id || this.state.cards.length <= 1) return;
    if (this.options.onDelete) { this.options.onDelete(id); return; }
    await this.operation(async () => {
      const next = await window.desktop.deleteCharacterCard(id);
      if (this.disposed) return;
      this.selectedId = next.activeId; this.creating = this.dirty = false; this.accept(next);
      this.setStatus(uiText("角色卡已删除"));
    });
  }
  private async bindModel(enabled: boolean): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    await this.operation(async () => {
      this.accept(await window.desktop.bindCharacterModel(id, enabled));
      this.setStatus(enabled ? uiText("已关联当前 MMD；启用角色时应用") : uiText("已解除模型关联"));
    });
  }
  private async importCard(): Promise<void> {
    await this.operation(async () => {
      const previous = new Set(this.state.cards.map(card => card.id));
      const next = await window.desktop.importCharacterCard();
      if (!next || this.disposed) return;
      this.selectedId = next.cards.filter(card => !previous.has(card.id)).at(-1)?.id ?? next.activeId;
      this.importedRangeReview.add(this.selectedId);
      this.creating = this.dirty = false; this.accept(next);
      this.setStatus(uiText("角色卡已导入；点击「启用此角色」开始使用"));
      const created = next.cards.find(card => card.id === this.selectedId && !previous.has(card.id));
      if (created) this.options.onCreated?.(created, 'imported');
    });
  }
  private async exportCard(): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    await this.operation(async () => {
      if (await window.desktop.exportCharacterCard(id)) this.setStatus(this.dirty ? uiText("已导出保存的版本，未保存的编辑不在文件中") : uiText("角色卡已导出"));
    });
  }
}
