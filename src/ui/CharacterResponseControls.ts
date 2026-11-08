import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import type { MoodContext, MoodLabel, MoodParameters, MoodTendency } from '../../shared/mood';
import { MOOD_LABELS } from '../../shared/mood-runtime';
import {
  CHARACTER_RESPONSE_CONTEXTS, CHARACTER_RESPONSE_INTENSITIES, CHARACTER_RESPONSE_MOODS,
  CHARACTER_RESPONSE_PHASES, CHARACTER_RESPONSE_TENDENCIES, MAX_CHARACTER_RESPONSE_RULES,
  characterResponseRuleKey, defaultCharacterResponseProfile, defaultCharacterResponseRule,
  validateCharacterResponseProfile,
  type CharacterResponseIntensity, type CharacterResponsePhase, type CharacterResponseProfile,
  type CharacterResponseRule, type CharacterResponseState, type CharacterResponseWhen,
} from '../../shared/character-response';

type CommonResponse = Pick<MoodParameters, 'weights' | 'intensity'>;
export type CharacterResponseBridge = Pick<DesktopAPI, 'getCharacterResponse' | 'saveCharacterResponse' | 'onCharacterResponse'>;
interface Options { api: CharacterResponseBridge; onError(message: string): void; confirm?(message: string): boolean;
  /** E1: shown right under the heading (the 「预览：惊喜 / 害羞」 buttons), so 「心情和反应」 lands on them. */
  extra?: HTMLElement }
interface Entry {
  saved: CharacterResponseState | null;
  draft: CharacterResponseProfile;
  baseProfile: CharacterResponseProfile;
  baseRevision: number;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  readGeneration: number;
  editGeneration: number;
  when: CharacterResponseWhen;
  message: string;
  pendingKey: string;
}
interface Slider { input: HTMLInputElement; value: HTMLOutputElement; estimate: HTMLElement }
const PHASE_LABELS: Record<CharacterResponsePhase, string> = {
  idle: '空闲', rua: '摸头', 'food-wait': '点心等待', 'food-ready': '点心准备', 'food-eating': '接受点心', cheek: '捏脸持握',
};
const CONTEXT_LABELS: Record<MoodContext, string> = {
  neutral: '一般', positive: '正面', support: '关心与支持', concern: '担心', disappointment: '失落', offense: '冒犯',
};
const TENDENCY_LABELS: Record<MoodTendency, string> = { playful: '玩闹', close: '亲近', comfortable: '享受与放松', cautious: '谨慎' };
const INTENSITY_LABELS: Record<CharacterResponseIntensity, string> = {
  expression: '情绪表情', gaze: '情绪眼神', posture: '亲近姿态', playful: '玩闹动作', text: '文字语气',
};
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const sameProfile = (a: CharacterResponseProfile, b: CharacterResponseProfile) => JSON.stringify(a) === JSON.stringify(b);
const number = (value: number) => Number(value.toFixed(2)).toString();
const description = (when: CharacterResponseWhen) => `${uiText(MOOD_LABELS[when.mood])} · ${when.phase ? uiText(PHASE_LABELS[when.phase]) : uiText('全部阶段')} · ${when.context ? uiText(CONTEXT_LABELS[when.context]) : uiText('全部情境')}`;
function inheritedRule(profile: CharacterResponseProfile, when: CharacterResponseWhen): CharacterResponseRule | null {
  let selected: CharacterResponseRule | null = null, rank = -1;
  for (const rule of profile.rules) {
    if (rule.when.mood !== when.mood || (rule.when.phase !== undefined && rule.when.phase !== when.phase)
      || (rule.when.context !== undefined && rule.when.context !== when.context)) continue;
    const next = (Number(rule.when.phase !== undefined) + Number(rule.when.context !== undefined)) * 2 + Number(rule.when.context !== undefined);
    if (next > rank) { selected = rule; rank = next; }
  }
  return selected;
}

/** A separate, per-character template editor. Drafts never become mood events. */
export class CharacterResponseControls {
  private readonly entries = new Map<string, Entry>();
  private selectedId: string | null = null;
  private common: CommonResponse | null = null;
  private externalBusy = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly mood = make('select');
  private readonly phase = make('select');
  private readonly context = make('select');
  private readonly ruleList = make('select');
  private readonly summary = make('p', '', 'hint response-rule-summary');
  private readonly status = make('output', '', 'response-status');
  private readonly tendency = new Map<MoodTendency, Slider>();
  private readonly intensity = new Map<CharacterResponseIntensity, Slider>();
  private readonly add = make('button', uiText('新增此条件细调'));
  private readonly remove = make('button', uiText('删除此条件，恢复继承'));
  private readonly inherit = make('button', uiText('全部恢复继承'));
  private readonly save = make('button', uiText('保存反应细调'));
  private readonly revert = make('button', uiText('撤销修改'));
  private readonly reload = make('button', uiText('重新读取'));

  constructor(private readonly container: HTMLElement, private readonly options: Options) {
    this.render();
    this.unsubscribe = options.api.onCharacterResponse(state => this.acceptState(state));
    this.update();
  }

  /** Repeated card broadcasts update the common estimate, never reload a dirty draft. */
  select(characterId: string | null, common: CommonResponse, busy = false): void {
    if (this.disposed) return;
    this.selectedId = characterId; this.common = { weights: { ...common.weights }, intensity: { ...common.intensity } }; this.externalBusy = busy;
    if (characterId) {
      const entry = this.entry(characterId);
      if (!entry.saved && !entry.loading && !entry.message) void this.load(characterId, entry);
    }
    this.update();
  }

  /** Host events may precede selection of a just-imported card. */
  acceptState(state: CharacterResponseState): void {
    if (this.disposed) return;
    try {
      if (!state.characterId || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error(uiText('反应细调状态无效。'));
      const profile = validateCharacterResponseProfile(state.profile);
      const entry = this.entry(state.characterId);
      if (entry.saved && state.revision < entry.saved.revision) return;
      const consistent = !entry.saved || state.revision !== entry.saved.revision || sameProfile(profile, entry.saved.profile);
      if (consistent) {
        entry.saved = { characterId: state.characterId, revision: state.revision, profile, ...(state.storageError ? { storageError: state.storageError } : {}) };
        if (!entry.dirty) {
          entry.draft = structuredClone(profile); entry.baseProfile = structuredClone(profile); entry.baseRevision = state.revision;
        } else if (sameProfile(profile, entry.baseProfile)) {
          // A global sidecar revision can advance for a different character.
          entry.baseRevision = state.revision;
        }
      }
      if (state.pendingProfile) {
        const pending = validateCharacterResponseProfile(state.pendingProfile);
        const key = `${state.revision}:${JSON.stringify(pending)}`;
        if (key !== entry.pendingKey) {
          entry.pendingKey = key;
          if (!entry.dirty) { entry.draft = pending; entry.dirty = true; entry.editGeneration++; }
          entry.message = state.notice || uiText('卡已导入，反应细调待重试保存；当前只是草稿。');
        }
      } else if (state.notice && !entry.dirty) entry.message = state.notice;
      this.update();
    } catch (error) { this.report(error); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.entries.clear(); this.container.replaceChildren();
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        saved: null, draft: defaultCharacterResponseProfile(), baseProfile: defaultCharacterResponseProfile(), baseRevision: 0,
        dirty: false, loading: false, saving: false, readGeneration: 0, editGeneration: 0,
        when: { mood: 'calm' }, message: '', pendingKey: '',
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private async load(id: string, entry: Entry): Promise<void> {
    entry.loading = true; if (!entry.dirty) entry.message = '';
    const generation = ++entry.readGeneration; this.update();
    try {
      const state = await this.options.api.getCharacterResponse(id);
      if (this.disposed || entry.readGeneration !== generation) return;
      if (state.characterId !== id) throw new Error(uiText('读取的反应细调不属于所选角色。'));
      this.acceptState(state);
    } catch (error) {
      if (!this.disposed && entry.readGeneration === generation) { entry.message = this.errorText(error); this.report(error); }
    } finally {
      if (!this.disposed && entry.readGeneration === generation) { entry.loading = false; this.update(); }
    }
  }

  private currentEntry(): Entry | null { return this.selectedId ? this.entries.get(this.selectedId) ?? null : null; }
  private exact(entry: Entry): CharacterResponseRule | undefined {
    const key = characterResponseRuleKey(entry.when);
    return entry.draft.rules.find(rule => characterResponseRuleKey(rule.when) === key);
  }
  private inherited(entry: Entry): CharacterResponseRule | null {
    return inheritedRule(entry.draft, entry.when);
  }
  private change(update: (profile: CharacterResponseProfile, entry: Entry) => void): void {
    const entry = this.currentEntry();
    if (!entry?.saved || entry.saving || entry.loading || this.externalBusy || entry.saved.storageError || this.disposed) return;
    try {
      const draft = structuredClone(entry.draft); update(draft, entry);
      entry.draft = validateCharacterResponseProfile(draft); entry.dirty = !sameProfile(entry.draft, entry.saved.profile);
      entry.editGeneration++; entry.message = entry.dirty ? uiText('反应细调有尚未保存的修改；只影响这张卡的表达模板。') : '';
      this.update();
    } catch (error) { entry.message = this.errorText(error); this.report(error); this.update(); }
  }
  private async saveDraft(): Promise<void> {
    const id = this.selectedId, entry = this.currentEntry();
    if (!id || !entry?.saved || !entry.dirty || entry.loading || entry.saving || entry.saved.storageError || this.externalBusy || this.disposed) return;
    const submitted = structuredClone(entry.draft), edited = entry.editGeneration;
    if (!this.confirmChanges(entry, submitted)) { entry.message = uiText('扩展反应细调尚未采用，草稿保留；没有保存或更改当前状态。'); this.update(); return; }
    entry.saving = true; entry.readGeneration++; entry.message = uiText('正在保存这张卡的反应细调…'); this.update();
    try {
      const result = await this.options.api.saveCharacterResponse(id, submitted, entry.baseRevision);
      if (this.disposed) return;
      if (result.characterId !== id) throw new Error(uiText('保存结果不属于原角色，未更新当前草稿。'));
      this.acceptState(result);
      if (result.storageError) throw new Error(result.storageError);
      if (entry.editGeneration === edited && entry.saved?.revision === result.revision && sameProfile(entry.saved.profile, submitted)) {
        entry.draft = structuredClone(entry.saved.profile); entry.baseProfile = structuredClone(entry.saved.profile);
        entry.baseRevision = result.revision; entry.dirty = false; entry.pendingKey = ''; entry.message = uiText('已保存反应细调；当前数值、互动进度与记忆保留。');
      } else entry.message = uiText('保存期间收到更新，本地草稿已保留；请核对后再保存或撤销修改。');
    } catch (error) {
      if (!this.disposed) {
        entry.message = uiTemplate`未保存，草稿已保留：${this.errorText(error)}`; this.report(error);
        // Refresh the revision without replacing local changes. A true same-card
        // conflict stays visible until the user explicitly reverts/re-edits.
        try { const latest = await this.options.api.getCharacterResponse(id); if (!this.disposed && latest.characterId === id) this.acceptState(latest); }
        catch { /* The original error remains the useful recovery message. */ }
      }
    } finally { if (!this.disposed) { entry.saving = false; this.update(); } }
  }
  private revertDraft(): void {
    const entry = this.currentEntry();
    if (!entry?.saved || entry.saving || this.externalBusy || this.disposed) return;
    entry.draft = structuredClone(entry.saved.profile); entry.baseProfile = structuredClone(entry.saved.profile);
    entry.baseRevision = entry.saved.revision; entry.dirty = false; entry.pendingKey = ''; entry.editGeneration++;
    entry.message = uiText('已撤销本地反应修改，使用最近读回的已保存模板。'); this.update();
  }
  private confirmChanges(entry: Entry, profile: CharacterResponseProfile): boolean {
    const changes: string[] = [];
    const extended = (value: number) => value !== 0 && (value < 0.5 || value > 1.5);
    for (const rule of profile.rules) {
      const before = inheritedRule(entry.saved!.profile, rule.when) ?? defaultCharacterResponseRule(rule.when);
      for (const key of CHARACTER_RESPONSE_TENDENCIES) {
        const value = rule.tendencyScale[key];
        if (value !== before.tendencyScale[key] && extended(value)) changes.push(uiTemplate`${description(rule.when)}：${uiText(TENDENCY_LABELS[key])} ${number(before.tendencyScale[key] * 100)}% → ${number(value * 100)}%，选择权重参考 ${number((this.common?.weights[key] ?? 1) * value)}`);
      }
      for (const key of CHARACTER_RESPONSE_INTENSITIES) {
        const value = rule.intensityScale[key];
        if (value !== before.intensityScale[key] && extended(value)) changes.push(uiTemplate`${description(rule.when)}：${uiText(INTENSITY_LABELS[key])} ${number(before.intensityScale[key] * 100)}% → ${number(value * 100)}%，预计强度 ${number(Math.min(100, (this.common?.intensity[key] ?? 50) * value))} / 100`);
      }
    }
    if (!changes.length) return true;
    return (this.options.confirm ?? (message => window.confirm(message)))(uiTemplate`本次有新的非常规反应比例（常规参考 50%～150%，0% 为关闭）：\n\n${changes.slice(0, 12).join('\n')}${changes.length > 12 ? uiTemplate`\n另有 ${changes.length - 12} 项。` : ''}\n\n这些比例改变表达倾向或强度，不增加互动奖励。是否保存本次配置？`);
  }

  private render(): void {
    const section = make('section', undefined, 'character-response'); section.id = 'character-response-controls';
    section.setAttribute('aria-label', uiText('逐心情反应细调'));
    section.append(make('h3', uiText('逐心情反应细调')), make('p', uiText('按心情和已实现的互动条件调整表达。九项独立；100% 为中性，不表示发生概率。此处只编辑模板，保存后生效。'), 'hint'));
    if (this.options.extra) section.append(this.options.extra);
    const selectors = make('div', undefined, 'response-selectors');
    const select = (input: HTMLSelectElement, id: string, label: string, choices: readonly (readonly [string, string])[]) => {
      input.id = id; input.setAttribute('aria-label', label);
      for (const [value, text] of choices) { const option = make('option', text); option.value = value; input.append(option); }
      const field = make('label', undefined, 'field'); field.append(make('span', label), input); selectors.append(field);
    };
    select(this.mood, 'response-mood', uiText('心情'), CHARACTER_RESPONSE_MOODS.map(mood => [mood, uiText(MOOD_LABELS[mood])]));
    select(this.phase, 'response-phase', uiText('互动阶段'), [['', uiText('全部阶段')], ...CHARACTER_RESPONSE_PHASES.map(phase => [phase, uiText(PHASE_LABELS[phase])] as const)]);
    select(this.context, 'response-context', uiText('语义情境'), [['', uiText('全部情境')], ...CHARACTER_RESPONSE_CONTEXTS.map(context => [context, uiText(CONTEXT_LABELS[context])] as const)]);
    const selectWhen = () => {
      const entry = this.currentEntry(); if (!entry || this.disposed) return;
      entry.when = { mood: this.mood.value as MoodLabel, ...(this.phase.value ? { phase: this.phase.value as CharacterResponsePhase } : {}), ...(this.context.value ? { context: this.context.value as MoodContext } : {}) };
      this.update();
    };
    this.mood.onchange = this.phase.onchange = this.context.onchange = selectWhen;
    this.ruleList.id = 'response-rule-list'; this.ruleList.setAttribute('aria-label', uiText('已有反应条件'));
    this.ruleList.onchange = () => {
      const entry = this.currentEntry(); const rule = entry?.draft.rules.find(rule => characterResponseRuleKey(rule.when) === this.ruleList.value);
      if (entry && rule) { entry.when = structuredClone(rule.when); this.update(); }
    };
    section.append(selectors, this.ruleList, this.summary);
    const actions = make('div', undefined, 'response-rule-actions');
    this.add.id = 'response-add-rule'; this.remove.id = 'response-remove-rule'; this.inherit.id = 'response-inherit';
    for (const button of [this.add, this.remove, this.inherit, this.save, this.revert, this.reload]) button.type = 'button';
    this.add.onclick = () => this.change((profile, entry) => {
      if (this.exact(entry)) return;
      if (profile.rules.length >= MAX_CHARACTER_RESPONSE_RULES) throw new Error(uiTemplate`最多保存 ${MAX_CHARACTER_RESPONSE_RULES} 个条件；请先删除不需要的条件。`);
      const inherited = this.inherited(entry);
      profile.rules.push(inherited ? { ...structuredClone(inherited), when: structuredClone(entry.when) } : defaultCharacterResponseRule(entry.when));
    });
    this.remove.onclick = () => this.change((profile, entry) => { const key = characterResponseRuleKey(entry.when); profile.rules = profile.rules.filter(rule => characterResponseRuleKey(rule.when) !== key); });
    this.inherit.onclick = () => this.change(profile => { profile.rules = []; });
    actions.append(this.add, this.remove, this.inherit); section.append(actions);
    const sliders = make('div', undefined, 'response-sliders');
    const slider = (group: 'tendency' | 'intensity', key: string, label: string, maximum: number, host = sliders): Slider => {
      const row = make('label', undefined, 'response-slider'); const heading = make('span', undefined, 'response-slider-heading');
      const output = make('output'); heading.append(make('span', label), output);
      const input = make('input'); input.id = `response-${group}-${key}`; input.type = 'range'; input.min = '0'; input.max = String(maximum); input.step = '1'; input.value = '100'; input.setAttribute('aria-label', uiTemplate`${label}细调百分比`);
      const estimate = make('small', '', 'response-estimate'); row.append(heading, input, estimate); host.append(row);
      return { input, value: output, estimate };
    };
    section.append(make('h4', uiText('倾向选择权重')), make('p', uiText('玩闹、亲近、享受和谨慎互不排斥。共同权重为 0 时，细调不会重新开启该倾向。'), 'hint'));
    for (const key of CHARACTER_RESPONSE_TENDENCIES) {
      const controls = slider('tendency', key, uiText(TENDENCY_LABELS[key]), 400); this.tendency.set(key, controls);
      controls.input.oninput = () => this.change((profile, entry) => {
        const rule = profile.rules.find(rule => characterResponseRuleKey(rule.when) === characterResponseRuleKey(entry.when));
        if (rule) rule.tendencyScale[key] = Number(controls.input.value) / 100;
      });
    }
    section.append(sliders); const intensitySliders = make('div', undefined, 'response-sliders');
    section.append(make('h4', uiText('表现强度')), make('p', uiText('下列预计值按编辑区的共同强度与细调倍率计算，上限 100。共同设置仍需用角色卡“保存”提交；反应细调在下方单独保存。实际表现受模型、手选动作与整体限幅约束。'), 'hint'));
    for (const key of CHARACTER_RESPONSE_INTENSITIES) {
      const controls = slider('intensity', key, uiText(INTENSITY_LABELS[key]), 200, intensitySliders); this.intensity.set(key, controls);
      controls.input.oninput = () => this.change((profile, entry) => {
        const rule = profile.rules.find(rule => characterResponseRuleKey(rule.when) === characterResponseRuleKey(entry.when));
        if (rule) rule.intensityScale[key] = Number(controls.input.value) / 100;
      });
    }
    section.append(intensitySliders, make('p', uiText('条件更具体时优先采用该条；同样具体的“语义情境”优先于“互动阶段”。只选择一条规则，倍率不逐层相乘。删除当前条件会恢复继承；全部恢复继承只清空本地草稿，仍需保存。'), 'hint'));
    const footer = make('div', undefined, 'response-save-actions'); this.save.id = 'response-save'; this.revert.id = 'response-revert';
    this.save.onclick = () => void this.saveDraft(); this.revert.onclick = () => this.revertDraft();
    this.reload.id = 'response-reload'; this.reload.onclick = () => { const id = this.selectedId, entry = this.currentEntry(); if (id && entry && !entry.loading && !entry.saving && !this.externalBusy && !this.disposed) void this.load(id, entry); };
    footer.append(this.save, this.revert, this.reload); this.status.id = 'response-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    section.append(footer, this.status); this.container.append(section);
  }

  private update(): void {
    if (this.disposed) return;
    const entry = this.currentEntry();
    const disabled = !entry?.saved || entry.loading || entry.saving || this.externalBusy || Boolean(entry.saved.storageError);
    const exact = entry ? this.exact(entry) : undefined;
    const rule = entry ? exact ?? this.inherited(entry) ?? defaultCharacterResponseRule(entry.when) : defaultCharacterResponseRule({ mood: 'calm' });
    if (entry) { this.mood.value = entry.when.mood; this.phase.value = entry.when.phase ?? ''; this.context.value = entry.when.context ?? ''; }
    for (const select of [this.mood, this.phase, this.context, this.ruleList]) select.disabled = disabled;
    this.ruleList.replaceChildren(); const first = make('option', uiTemplate`已有条件 ${entry?.draft.rules.length ?? 0} / ${MAX_CHARACTER_RESPONSE_RULES}`); first.value = ''; this.ruleList.append(first);
    for (const item of entry?.draft.rules ?? []) { const option = make('option', description(item.when)); option.value = characterResponseRuleKey(item.when); this.ruleList.append(option); }
    this.ruleList.value = exact ? characterResponseRuleKey(exact.when) : '';
    this.summary.textContent = !entry ? uiText('请先保存角色卡，再编辑属于这张卡的反应细调。')
      : `${description(entry.when)}：${exact ? uiText('此条件有独立细调') : this.inherited(entry) ? uiText('继承更宽条件，新增后可单独调整') : uiText('继承共同设置，新增后可单独调整')}。`;
    this.add.disabled = disabled || Boolean(exact) || (entry?.draft.rules.length ?? 0) >= MAX_CHARACTER_RESPONSE_RULES;
    this.remove.disabled = disabled || !exact; this.inherit.disabled = disabled || !entry?.draft.rules.length;
    for (const [key, slider] of this.tendency) {
      const scale = rule.tendencyScale[key], common = this.common?.weights[key] ?? 1;
      slider.input.value = String(scale * 100); slider.input.disabled = disabled || !exact; slider.value.textContent = `${number(scale * 100)}%`;
      slider.estimate.textContent = uiTemplate`共同权重 ${number(common)} × ${number(scale * 100)}% ≈ ${number(common * scale)}；实际选择还受心情证据影响`;
    }
    for (const [key, slider] of this.intensity) {
      const scale = rule.intensityScale[key], common = this.common?.intensity[key] ?? 50;
      slider.input.value = String(scale * 100); slider.input.disabled = disabled || !exact; slider.value.textContent = `${number(scale * 100)}%`;
      slider.estimate.textContent = uiTemplate`共同强度 ${number(common)} / 100 × ${number(scale * 100)}% → 预计 ${number(Math.min(100, common * scale))} / 100`;
    }
    const conflict = Boolean(entry?.dirty && entry.saved && entry.baseRevision !== entry.saved.revision && !sameProfile(entry.baseProfile, entry.saved.profile));
    this.save.disabled = disabled || !entry?.dirty || conflict;
    this.revert.disabled = !entry?.saved || entry.saving || this.externalBusy || !entry.dirty;
    this.reload.disabled = !entry || entry.loading || entry.saving || this.externalBusy;
    this.status.textContent = !entry ? uiText('新角色先保存，再保存反应细调。') : entry.saved?.storageError ? uiTemplate`原反应文件暂不可写：${entry.saved.storageError}`
      : conflict ? uiText('这张卡已有较新的反应设置。本地草稿保留；撤销修改会采用最新版，再按需要调整。')
      : entry.loading ? uiText('正在读取这张卡的反应细调…') : entry.message || (entry.dirty ? uiText('有尚未保存的反应细调。') : uiTemplate`已保存模板 · 修订 ${entry.saved?.revision ?? 0} · 当前数值与经历独立保留`);
    this.status.classList.toggle('response-unsaved', Boolean(entry?.dirty));
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private report(error: unknown): void { if (!this.disposed) this.options.onError(this.errorText(error)); }
}
