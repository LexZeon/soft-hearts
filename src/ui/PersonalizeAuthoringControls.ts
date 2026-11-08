import { uiText, uiTemplate } from './ui-language';
import type { DesktopAPI } from '../../shared/contracts';
import { AUTHORING_MATERIAL_LIMIT, AUTHORING_FEEDBACK_LIMIT,
  type LanguageAuthoringSession, type LanguageStudy } from '../../shared/personalize-authoring';
import type { LanguageRules } from '../../shared/personalize-language';

export type AuthoringBridge = Pick<DesktopAPI, 'openLanguageAuthoring' | 'researchLanguage' | 'cancelLanguageAuthoring' | 'closeLanguageAuthoring'>;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const result = document.createElement(tag); result.textContent = text; return result;
};
interface Draft { materials: string; feedback: string; study?: LanguageStudy; status: string }
export class PersonalizeAuthoringControls {
  private readonly drafts = new Map<string, Draft>();
  private card: { id: string; revision: number } | null = null;
  private locked = true;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private session: LanguageAuthoringSession | null = null;
  private readonly materials = node('textarea');
  private readonly feedback = node('textarea');
  private readonly report = node('pre');
  private readonly status = node('output');
  private readonly research = node('button', uiText('用当前 Claude 研究'));
  private readonly cancel = node('button', uiText('取消研究'));
  constructor(container: HTMLElement, private readonly options: {
    api: AuthoringBridge; rules(): LanguageRules; apply(rules: LanguageRules): void; onError?(message:string): void;
  }) {
    const section = node('fieldset'); section.className = 'personalize-authoring';
    section.append(node('legend', uiText('台词研究与打磨')), node('p', uiText('主动提交后使用当前 Claude 文字连接。材料只在本次制作草稿中暂存；不会进入普通聊天、记忆或角色卡导出。结果是候选，需在下方确认保存。')));
    const materialLabel = node('label', uiText('待研究的台词／文本')), feedbackLabel = node('label', uiText('回答澄清问题／希望如何调整'));
    this.materials.rows = 5; this.materials.maxLength = AUTHORING_MATERIAL_LIMIT; this.materials.dataset.authoringField = 'materials';
    this.feedback.rows = 3; this.feedback.maxLength = AUTHORING_FEEDBACK_LIMIT; this.feedback.dataset.authoringField = 'feedback';
    this.materials.setAttribute('aria-label', uiText('待研究的台词或文本')); this.feedback.setAttribute('aria-label', uiText('澄清回答与打磨要求'));
    materialLabel.append(this.materials); feedbackLabel.append(this.feedback);
    for (const [input, field] of [[this.materials, 'materials'], [this.feedback, 'feedback']] as const) input.oninput = () => {
      const draft = this.draft(); if (!draft) return; draft[field] = input.value; this.edited(); this.render();
    };
    this.research.type = this.cancel.type = 'button'; this.research.dataset.authoringAction = 'research'; this.cancel.dataset.authoringAction = 'cancel';
    this.research.onclick = () => { void this.run(); }; this.cancel.onclick = () => { this.stop(uiText('已取消；材料和规则草稿已保留。')); this.render(); };
    this.status.setAttribute('role', 'status'); this.report.setAttribute('aria-label', uiText('研究依据、候选推断与澄清问题'));
    section.append(materialLabel, this.research, this.cancel, this.status, this.report, feedbackLabel); container.append(section); this.render();
  }
  select(card: { id: string; revision: number } | null, locked: boolean): void {
    if (this.disposed) return;
    const changed = this.card?.id !== card?.id || this.card?.revision !== card?.revision;
    if (changed || (locked && !this.locked)) this.stop();
    this.card = card; this.locked = locked;
    if (card && !this.drafts.has(card.id)) this.drafts.set(card.id, { materials: '', feedback: '', status: '' });
    if (changed) { const draft = this.draft(); if (draft) { draft.study = undefined; draft.status = ''; } }
    this.render(changed);
  }
  private draft(): Draft | undefined { return this.card ? this.drafts.get(this.card.id) : undefined; }
  /** Any newer local edit revokes an in-flight snapshot before it can replace rules. */
  edited(): void {
    if (this.disposed) return;
    if (this.busy) this.stop(uiText('编辑已保留；旧研究已取消，请明确重新研究。'));
    else this.generation++;
  }
  close(): void { this.stop(uiText('制作界面已关闭；未保存规则不生效。')); this.render(); }
  private stop(message?: string): void {
    this.generation++; this.busy = false;
    const session = this.session; this.session = null;
    if (session) void this.options.api.cancelLanguageAuthoring(session.id).catch(() => {});
    if (message && this.draft()) this.draft()!.status = message;
  }
  private async run(): Promise<void> {
    const card = this.card, draft = this.draft(); if (!card || !draft || this.locked || this.busy || this.disposed || !draft.materials.trim()) return;
    const generation = ++this.generation, rules = structuredClone(this.options.rules());
    const materials = draft.materials, refinement = draft.feedback;
    this.busy = true; draft.status = uiText('正在研究；编辑、切卡或关闭制作界面会取消旧结果。'); this.render();
    const current = () => !this.disposed && generation === this.generation && this.card?.id === card.id && this.card.revision === card.revision;
    try {
      let session = this.session;
      if (!session) {
        session = await this.options.api.openLanguageAuthoring(card.id, card.revision);
        if (!current()) { void this.options.api.closeLanguageAuthoring(session.id).catch(() => {}); return; }
        if (session.characterId !== card.id || session.savedRevision !== card.revision) throw Error(uiText('制作草稿返回了其他角色或版本，已忽略。'));
        this.session = session;
      }
      const result = await this.options.api.researchLanguage({ sessionId: session.id, revision: session.revision, materials, refinement, rules });
      if (!current()) return;
      if (result.session.id !== session.id || result.session.characterId !== card.id || result.session.savedRevision !== card.revision
        || result.session.revision !== session.revision + 1) throw Error(uiText('迟到或不匹配的研究结果已忽略。'));
      this.session = result.session; draft.study = result.study;
      this.options.apply(structuredClone(result.study.rules));
      draft.status = uiText('候选已放入下方可编辑草稿，尚未生效。可回答问题后继续打磨，或修改并明确保存。');
    } catch (error) {
      if (current()) { const detail=String(error); draft.status = detail;
        if(this.options.onError){this.options.onError(detail);draft.status=uiText('研究未完成，材料与草稿保留，可查看问题详情。');}
        const session = this.session; this.session = null;
        if (session) void this.options.api.closeLanguageAuthoring(session.id).catch(() => {}); }
    } finally { if (current()) { this.busy = false; this.render(); } }
  }
  private render(fields = false): void {
    if (this.disposed) return;
    const draft = this.draft();
    if (fields) { this.materials.value = draft?.materials ?? ''; this.feedback.value = draft?.feedback ?? ''; }
    this.materials.disabled = this.feedback.disabled = !this.card || this.locked;
    this.research.disabled = !draft || this.locked || this.busy || !draft.materials.trim(); this.cancel.disabled = !this.busy;
    this.research.textContent = draft?.study ? uiText('按回答继续用 Claude 打磨') : uiText('用当前 Claude 研究');
    this.status.textContent = draft?.status ?? '';
    const study = draft?.study;
    this.report.textContent = !study ? '' : [
      uiText('原文观察（引用来自所提交材料）'), ...study.observations.map(item => `「${item.quote}」：${item.finding}`),
      uiText('候选推断（待你确认）'), ...study.inferences,
      uiText('需要你解释的问题'), ...study.questions.map((text, i) => `${i + 1}. ${text}`),
      study.insufficient ? uiTemplate`证据不足：${study.insufficient}` : '',
    ].filter(Boolean).join('\n');
  }
  dispose(): void {
    if (this.disposed) return; const session = this.session; this.stop(); this.disposed = true;
    if (session) void this.options.api.closeLanguageAuthoring(session.id).catch(() => {});
    this.drafts.clear();
  }
}
