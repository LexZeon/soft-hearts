import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import { PersonalizeAuthoringControls, type AuthoringBridge } from './PersonalizeAuthoringControls';
import { LANGUAGE_FIELDS, LANGUAGE_LABELS, LANGUAGE_TEXT_LIMIT, emptyLanguageRules, hasLanguageRules,
  validateLanguageProfile, validateLanguageRevision, validateLanguageRules,
  type LanguageField, type LanguageRules, type LanguageState } from '../../shared/personalize-language';

type Bridge = Pick<DesktopAPI, 'getPersonalizeLanguage' | 'savePersonalizeLanguage' | 'undoPersonalizeLanguage' | 'onPersonalizeLanguage'> & AuthoringBridge;
interface Options { api: Bridge; onError(message: string): void; confirm?(message: string): boolean }
interface Entry {
  saved: LanguageState | null; draft: LanguageRules; baseRevision: number; dirty: boolean;
  loading: boolean; saving: boolean; readGeneration: number; editGeneration: number; error: string;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.textContent = text; return result;
}
/** Localized headings only; the saved rules and the provider context stay untouched. */
function languageRulesPreview(rules: LanguageRules): string {
  const checked = validateLanguageRules(rules);
  return LANGUAGE_FIELDS.filter(field => checked[field]).map(field =>
    uiTemplate`${uiText(LANGUAGE_LABELS[field])}：\n${checked[field]}`).join('\n\n')
    || uiText('尚未填写规则；保存空规则将恢复原有文字表达。');
}

/** Local drafts and a truthful rule preview. Only explicit host saves can activate anything. */
export class PersonalizeLanguageControls {
  private readonly entries = new Map<string, Entry>();
  private card: { id: string; name: string } | null = null;
  private parentBusy = false;
  private disposed = false;
  private readonly target = node('p');
  private readonly status = node('output');
  private readonly preview = node('pre');
  private readonly fields = {} as Record<LanguageField, HTMLTextAreaElement>;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly unsubscribe: () => void;
  private readonly authoring: PersonalizeAuthoringControls;

  constructor(container: HTMLElement, private readonly options: Options) {
    const details = node('details'); details.className = 'personalize-language';
    details.append(node('summary', uiText('personalize · 文字语言习惯')), this.target,
      node('p', uiText('可以先研究台词再编辑，也可手工填写。草稿与预览不生效；保存后只补充这张卡的 Claude 文字表达，不改人设、声音或权限。')));
    this.authoring = new PersonalizeAuthoringControls(details, { api: options.api, onError: message => this.options.onError(message),
      rules: () => structuredClone(this.entry()?.draft ?? emptyLanguageRules()),
      apply: rules => { const entry = this.entry(); if (!entry) return;
        entry.draft = validateLanguageRules(rules); entry.editGeneration++;
        entry.dirty = JSON.stringify(entry.draft) !== JSON.stringify(entry.saved?.profile.rules ?? emptyLanguageRules()); this.render(true); },
    });
    details.ontoggle = () => { if (!details.open) this.authoring.close(); };
    for (const field of LANGUAGE_FIELDS) {
      const label = node('label', uiText(LANGUAGE_LABELS[field])), input = node('textarea');
      input.rows = 3; input.maxLength = LANGUAGE_TEXT_LIMIT; input.dataset.languageField = field;
      input.setAttribute('aria-label', uiText(LANGUAGE_LABELS[field])); this.fields[field] = input;
      input.oninput = () => {
        const entry = this.entry(); if (!entry) return;
        entry.draft[field] = input.value; entry.editGeneration++; entry.error = ''; this.authoring.edited();
        entry.dirty = JSON.stringify(entry.draft) !== JSON.stringify(entry.saved?.profile.rules ?? emptyLanguageRules());
        this.render();
      };
      label.append(input); details.append(label);
    }
    this.preview.dataset.languagePreview = 'rules';
    details.append(node('h4', uiText('规则预览（纯文本，未运行模型）')), this.preview);
    const actions = node('div'); actions.className = 'personalize-actions';
    for (const [id, text] of [['save', uiText('保存并启用')], ['disable', uiText('停用已保存规则')], ['undo', uiText('恢复上次确认版本')], ['reload', uiText('读取已保存规则')]] as const) {
      const button = node('button', text); button.type = 'button'; button.dataset.languageAction = id;
      button.onclick = () => { if (id === 'reload') void this.load(true); else void this.change(id); };
      this.buttons.set(id, button); actions.append(button);
    }
    this.status.setAttribute('role', 'status'); details.append(actions, this.status); container.append(details);
    this.unsubscribe = options.api.onPersonalizeLanguage(state => this.receive(state));
    this.render(true);
  }
  select(card: { id: string; name: string } | null, busy = false): void {
    if (this.disposed) return;
    this.card = card ? { id: card.id, name: card.name } : null; this.parentBusy = busy;
    if (card && !this.entries.has(card.id)) this.entries.set(card.id, {
      saved: null, draft: emptyLanguageRules(), baseRevision: 0, dirty: false,
      loading: false, saving: false, readGeneration: 0, editGeneration: 0, error: '',
    });
    this.render(true);
    const entry = this.entry(); if (entry && !entry.saved && !entry.loading) void this.load(false);
  }
  private entry(): Entry | undefined { return this.card ? this.entries.get(this.card.id) : undefined; }
  private confirm(text: string): boolean { return (this.options.confirm ?? (value => window.confirm(value)))(text); }
  private checked(state: LanguageState, id: string): LanguageState {
    if (state.characterId !== id) throw Error(uiText('语言习惯返回了另一张角色卡，已忽略。'));
    validateLanguageRevision(state.revision); validateLanguageProfile(state.profile);
    if (state.previous) { validateLanguageRevision(state.previous.revision); validateLanguageProfile(state.previous.profile); }
    return structuredClone(state);
  }
  private receive(state: LanguageState): void {
    if (this.disposed) return;
    const entry = this.entries.get(state.characterId); if (!entry) return;
    const checked = this.checked(state, state.characterId);
    if (checked.revision < (entry.saved?.revision ?? -1)) return;
    entry.saved = checked;
    if (!entry.dirty && !entry.saving && !entry.loading) {
      entry.draft = structuredClone(checked.profile.rules); entry.baseRevision = checked.revision;
    }
    if (this.card?.id === state.characterId) this.render(!entry.dirty && !entry.saving && !entry.loading);
  }
  private async load(discard: boolean): Promise<void> {
    const card = this.card, entry = this.entry();
    if (!card || !entry || entry.loading || entry.saving || this.disposed || this.parentBusy) return;
    if (discard && entry.dirty && !this.confirm(uiTemplate`读取「${card.name}」(${card.id})已保存的规则？未保存草稿将被替换。`)) return;
    const generation = ++entry.readGeneration, edits = entry.editGeneration;
    entry.loading = true; entry.error = ''; this.render();
    try {
      const read = this.checked(await this.options.api.getPersonalizeLanguage(card.id), card.id);
      if (this.disposed || entry.readGeneration !== generation) return;
      // A newer host event can arrive while this read is pending. Reconcile to
      // that confirmed version without replacing any edits made during the read.
      const state = read.revision < (entry.saved?.revision ?? -1) ? entry.saved! : read;
      entry.saved = state;
      if (entry.editGeneration === edits && (discard || !entry.dirty)) {
        entry.draft = structuredClone(state.profile.rules); entry.baseRevision = state.revision; entry.dirty = false;
      }
    } catch (error) {
      if (!this.disposed && entry.readGeneration === generation) entry.error = String(error);
    } finally {
      if (!this.disposed && entry.readGeneration === generation) {
        entry.loading = false; if (this.card?.id === card.id) this.render(true);
      }
    }
  }
  private async change(kind: 'save' | 'disable' | 'undo'): Promise<void> {
    const card = this.card, entry = this.entry();
    if (!card || !entry?.saved || entry.loading || entry.saving || entry.saved.storageError || this.parentBusy || this.disposed) return;
    try {
      const rules = kind === 'save' ? validateLanguageRules(entry.draft) : structuredClone(entry.saved.profile.rules);
      const previous = entry.saved.previous;
      if (kind === 'undo' && !previous) return;
      const title = kind === 'undo' ? uiText('恢复上次确认版本') : kind === 'disable' ? uiText('停用已保存规则') : hasLanguageRules(rules) ? uiText('保存并启用规则') : uiText('保存空规则并恢复原有表达');
      const preview = languageRulesPreview(kind === 'undo' ? previous!.profile.rules : rules);
      if (!this.confirm(uiTemplate`${title}：${card.name}\n角色ID：${card.id}\n\n${preview}\n\n仅影响该卡后续 Claude 文字表达，不修改声音、人设或历史。`)) return;
      const edits = entry.editGeneration, revision = entry.baseRevision;
      entry.saving = true; entry.error = ''; this.render();
      try {
        const result = this.checked(await (kind === 'undo'
          ? this.options.api.undoPersonalizeLanguage(card.id, revision)
          : this.options.api.savePersonalizeLanguage(card.id, { enabled: kind === 'save' && hasLanguageRules(rules), rules }, revision)), card.id);
        if (this.disposed || result.revision < (entry.saved?.revision ?? -1)) return;
        entry.saved = result; entry.baseRevision = result.revision;
        // A disable never silently saves or discards an unsaved draft.
        if (entry.editGeneration === edits && (kind !== 'disable' || !entry.dirty)) {
          entry.draft = structuredClone(result.profile.rules); entry.dirty = false;
        } else entry.dirty = true;
      } catch (error) {
        if (!this.disposed) { entry.error = String(error); this.options.onError(entry.error); }
      } finally {
        if (!this.disposed) { entry.saving = false; if (this.card?.id === card.id) this.render(true); }
      }
    } catch (error) { if (!this.disposed) { entry.error = String(error); this.render(); } }
  }
  private render(fields = false): void {
    if (this.disposed) return;
    const entry = this.entry(), locked = !entry || this.parentBusy || !!entry.loading || !!entry.saving || !!entry.saved?.storageError;
    this.authoring.select(this.card && entry?.saved ? { id: this.card.id, revision: entry.baseRevision } : null, locked);
    this.target.textContent = this.card ? uiTemplate`目标卡：${this.card.name} · ${this.card.id}` : uiText('请先保存并选择一张角色卡。');
    let valid = true;
    try { this.preview.textContent = languageRulesPreview(entry?.draft ?? emptyLanguageRules()); }
    catch (error) { valid = false; this.preview.textContent = String(error); }
    for (const field of LANGUAGE_FIELDS) {
      if (fields) this.fields[field].value = entry?.draft[field] ?? '';
      this.fields[field].disabled = !entry || this.parentBusy || !!entry.saved?.storageError;
    }
    this.buttons.get('save')!.disabled = locked || !entry?.saved || !valid;
    this.buttons.get('save')!.textContent = entry && hasLanguageRules(entry.draft) ? uiText('保存并启用') : uiText('保存空规则');
    this.buttons.get('disable')!.disabled = locked || !entry?.saved?.profile.enabled;
    this.buttons.get('undo')!.disabled = locked || !entry?.saved?.previous;
    this.buttons.get('reload')!.disabled = !entry || this.parentBusy || !!entry.loading || !!entry.saving;
    const conflict = entry?.saved && entry.dirty && entry.saved.revision !== entry.baseRevision;
    this.status.textContent = !entry ? '' : entry.error || entry.saved?.storageError || (entry.saving ? uiText('正在保存；新编辑会保留为草稿。') : entry.loading ? uiText('正在读取；草稿不会被迟到结果覆盖。') : conflict ? uiText('已保存规则有新修订，当前草稿保留；读取后再确认。') : entry.dirty ? uiText('未保存草稿，尚未生效。') : uiTemplate`${entry.saved?.profile.enabled ? uiText('已启用') : uiText('未启用')} · 已确认修订 ${entry.saved?.revision ?? 0}；预览不是模型回复。`);
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.authoring.dispose(); this.unsubscribe(); this.entries.clear(); }
}
