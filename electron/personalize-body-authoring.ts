import { randomUUID } from 'node:crypto';
import { validateLanguageCharacterId, validateLanguageRevision } from '../shared/personalize-language';
import { VISUAL_MATERIAL_TTL, VISUAL_OUTPUT_LIMIT, visualRecord, visualText } from '../shared/personalize-visual';
import { BODY_AUTHORING_PURPOSE, BODY_VISUAL_PURPOSE, BODY_TWEAK_TARGET, bodyVisualResearchPrompt, makeBodyPoseTweak, makeBodyRightTweak, makeBodyHeadTweak, makeBodyTorsoTweak, parseBodyVisualStudy, validateBodyPoseSelection,
  type BodyAdviceFill, type BodyAdviceView, type BodyPoseBinding, type BodyPosePreview, type BodyPoseSelection, type BodyVisualState, type BodyVisualStudy } from '../shared/personalize-body';
import { applyBodyPoseTweak, applyBodyRightTweak, applyBodyHeadTweak, applyBodyTorsoTweak, bodyBindingForProfile } from './personalize-body-tweak';
import type { SelectedVisualImage } from './selected-visual-image';
import type { PersonalizeBodyStore } from './personalize-body-store';

interface Context { characterId: string; identity: string; codex: boolean; imageSupported: boolean; connectionLabel: string; modelUrl: string | null }
interface Session {
  id: string; owner: number; characterId: string; context: string; savedRevision: number; revision: number;
  targetModelSha: string | null; modelUrl: string | null; study: BodyVisualStudy | null; submitNonce: string | null;
  material: { id: string; image: SelectedVisualImage; expiresAt: number } | null;
  controller?: AbortController; timer?: ReturnType<typeof setTimeout>;
  advice?: { value:BodyAdviceView; materialId:string; revision:number };
  preview?: { value: BodyPosePreview; selection: BodyPoseSelection; generation: number | null; resolved: boolean; ready: boolean };
}
interface Dependencies {
  context(): Context;
  verifyTarget(): Promise<string | null>;
  choices(modelSha: string): readonly BodyPoseBinding[];
  binding(id: string, modelSha: string): BodyPoseBinding | null;
  chooseImage(signal: AbortSignal): Promise<SelectedVisualImage | null>;
  reserve(owner: number, id: string, controller: AbortController): () => void;
  stream(prompt: string, imageDataUrl: string, signal: AbortSignal, append: (text: string) => void): Promise<void>;
  previewCancelled(owner: number, id: string, token: string): void;
  changed(characterId: string): void;
  now?: () => number;
}

/** One owner-scoped body authoring session; image bytes and observations remain transient. */
export class PersonalizeBodyAuthoring {
  private readonly sessions = new Map<number, Session>();
  private readonly opening = new Map<number, string>();
  private readonly now: () => number;
  constructor(private readonly store: PersonalizeBodyStore, private readonly deps: Dependencies) { this.now = deps.now ?? Date.now; }

  private current(s: Session): boolean {
    try { const c = this.deps.context(); return this.sessions.get(s.owner) === s && c.characterId === s.characterId
      && c.identity === s.context && this.store.get(s.characterId).revision === s.savedRevision; } catch { return false; }
  }
  private session(owner: number, id: unknown, revision?: unknown): Session {
    const s = this.sessions.get(owner);
    if (!s || id !== s.id) throw Error('姿势制作上下文已改变，请重新打开。');
    if (!this.current(s)) { this.close(owner, s.id); throw Error('姿势制作上下文已改变，请重新打开。'); }
    if (revision !== undefined && validateLanguageRevision(revision) !== s.revision) throw Error('姿势草稿已有新修改，旧请求已忽略。');
    if (s.material && s.material.expiresAt <= this.now()) { this.close(owner, s.id); throw Error('临时图片已过期，请重新选择。'); }
    return s;
  }
  private state(s: Session): BodyVisualState {
    const c = this.deps.context(), material = s.material;
    const bindings = s.targetModelSha ? this.deps.choices(s.targetModelSha) : [];
    return { id: s.id, characterId: s.characterId, revision: s.revision, savedRevision: s.savedRevision,
      purpose: BODY_AUTHORING_PURPOSE, connectionLabel: c.connectionLabel, imageSupported: c.codex && c.imageSupported,
      targetSupported: !!s.targetModelSha && bindings.length > 0, targetModelSha: s.targetModelSha,
      material: material ? { id: material.id, source: 'selected-image', mime: 'image/jpeg', width: material.image.width,
        height: material.image.height, previewDataUrl: material.image.previewDataUrl, expiresAt: material.expiresAt, transformed: true } : null,
      submitNonce: s.submitNonce, study: s.study ? structuredClone(s.study) : null, advice:s.advice?structuredClone(s.advice.value):null,
      saved: this.store.get(s.characterId), choices: bindings.map(binding => ({ id: binding.id, label: binding.label, qualifiedStrength: binding.qualifiedStrength })) };
  }
  async get(owner: number, value: unknown): Promise<BodyVisualState> {
    const id = validateLanguageCharacterId(value), context = this.deps.context(), saved = this.store.get(id);
    if (context.characterId !== id) throw Error('请先启用这张角色卡，再制作身体姿势。');
    const old = this.sessions.get(owner);
    if (old && old.characterId === id && this.current(old) && (!old.material || old.material.expiresAt > this.now())) return this.state(old);
    this.close(owner); const opening = randomUUID(); this.opening.set(owner, opening); const targetModelSha = await this.deps.verifyTarget();
    if (this.opening.get(owner) !== opening || this.deps.context().identity !== context.identity || this.deps.context().characterId !== id) {
      throw Error('目标角色或模型已改变。');
    }
    const s: Session = { id: randomUUID(), owner, characterId: id, context: context.identity, savedRevision: saved.revision,
      revision: 0, targetModelSha, modelUrl: context.modelUrl, study: null, material: null, submitNonce: null };
    this.opening.delete(owner); this.sessions.set(owner, s); return this.state(s);
  }
  private stopPreview(s: Session): void {
    const preview = s.preview; if (!preview) return; s.preview = undefined;
    this.deps.previewCancelled(s.owner, preview.value.id, preview.value.token);
  }
  private clearMaterial(s: Session): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
    s.material?.image.release(); s.material = null; s.submitNonce = null; s.study = null; s.advice = undefined;
  }
  async choose(owner: number, id: unknown, revision: unknown): Promise<BodyVisualState> {
    const s = this.session(owner, id, revision); s.controller?.abort(); this.stopPreview(s); this.clearMaterial(s); s.revision++;
    const generation = s.revision, controller = new AbortController(); s.controller = controller;
    try {
      const image = await this.deps.chooseImage(controller.signal);
      if (!this.current(s) || controller.signal.aborted || s.revision !== generation) { image?.release(); throw Error('图片选择已取消。'); }
      if (image) {
        s.material = { id: randomUUID(), image, expiresAt: this.now() + VISUAL_MATERIAL_TTL }; s.submitNonce = randomUUID();
        s.timer = setTimeout(() => { if (this.sessions.get(owner) === s) this.close(owner, s.id); }, VISUAL_MATERIAL_TTL); s.timer.unref?.();
      }
      return this.state(s);
    } catch { throw Error('图片未载入；请重新选择合格静态图片，原图和规则未修改。'); }
    finally { if (s.controller === controller) s.controller = undefined; }
  }
  async research(owner: number, input: unknown): Promise<BodyVisualState> {
    const row = visualRecord(input, ['sessionId', 'revision', 'materialId', 'submitNonce', 'purpose', 'refinement']);
    const refinement = visualText(row.refinement, 2_000), s = this.session(owner, row.sessionId, row.revision);
    const context = this.deps.context(), material = s.material;
    if (row.purpose !== BODY_VISUAL_PURPOSE || !material || row.materialId !== material.id
      || row.submitNonce !== s.submitNonce || !s.submitNonce) throw Error('请明确提交当前所选图片；旧同意不能重用。');
    if (!context.codex || !context.imageSupported) throw Error('当前 Claude 连接尚未确认图片支持；不会切换其他模型。');
    if (s.controller) throw Error('上一项图片制作尚未结束，请稍后再试。');
    const controller = new AbortController(), release = this.deps.reserve(owner, randomUUID(), controller);
    this.stopPreview(s); s.advice=undefined; s.controller = controller; s.submitNonce = null; const revision = ++s.revision;
    const materialId = material.id, sha = material.image.sha256, dataUrl = material.image.dataUrl;
    const current = () => this.current(s) && !controller.signal.aborted && s.revision === revision && s.material?.id === materialId
      && s.material.image.sha256 === sha && s.material.expiresAt > this.now();
    let raw = '';
    try {
      await this.deps.stream(bodyVisualResearchPrompt(refinement, s.study), dataUrl, controller.signal, text => {
        if (!current() || raw.length + text.length > VISUAL_OUTPUT_LIMIT) { controller.abort(); return; } raw += text;
      });
      controller.signal.throwIfAborted(); if (!current()) throw Error('Stale selected-image result');
      const parsed=parseBodyVisualStudy(raw), {advice,rightAdvice,headAdvice,torsoAdvice,...study}=parsed;s.study=study;
      if((advice||rightAdvice||headAdvice||torsoAdvice) && s.targetModelSha===BODY_TWEAK_TARGET){
        const available=[advice?.shoulder,advice?.upperArm,advice?.elbow,rightAdvice?.shoulder,rightAdvice?.upperArm,rightAdvice?.elbow,headAdvice,torsoAdvice].some(j=>j&&j.offsetDegrees!==null);
        s.advice={value:{id:available?randomUUID():null,suggestion:advice??null,...(rightAdvice?{rightSuggestion:rightAdvice}:{}),...(headAdvice?{headSuggestion:headAdvice}:{}),...(torsoAdvice?{torsoSuggestion:torsoAdvice}:{})},materialId,revision};
      }
    } catch { throw Error('图片研究已停止或未得到合格结果，当前姿势草稿已保留。'); }
    finally { raw = ''; if (s.controller === controller) s.controller = undefined;
      if (this.current(s) && s.material?.id === materialId) s.submitNonce = randomUUID(); release(); }
    return this.state(s);
  }
  discardAdvice(owner:number,id:unknown,revision:unknown):void {
    const s=this.session(owner,id,revision);s.advice=undefined;
  }
  async consumeAdvice(owner:number,id:unknown,revision:unknown,candidateId:unknown,side:unknown='left'):Promise<BodyAdviceFill> {
    const s=this.session(owner,id,revision),candidate=s.advice;
    if(!candidate||!candidate.value.id||candidate.value.id!==candidateId||candidate.revision!==s.revision||s.controller
      ||!s.material||s.material.id!==candidate.materialId||s.targetModelSha!==BODY_TWEAK_TARGET||!s.modelUrl
      ||!['left','right','both','head','torso','all'].includes(side as string))throw Error('姿势建议已失效，请重新研究。');
    const selectedLeft=side==='left'||side==='both'||side==='all'?candidate.value.suggestion:null;
    const selectedRight=side==='right'||side==='both'||side==='all'?candidate.value.rightSuggestion:null;
    const selectedHead=side==='head'||side==='all'?candidate.value.headSuggestion:null;
    const selectedTorso=side==='torso'||side==='all'?candidate.value.torsoSuggestion:null;
    if(![selectedLeft?.shoulder,selectedLeft?.upperArm,selectedLeft?.elbow,selectedRight?.shoulder,selectedRight?.upperArm,selectedRight?.elbow,selectedHead,selectedTorso].some(j=>j&&j.offsetDegrees!==null))throw Error('所选部位没有可填入的建议。');
    if(await this.deps.verifyTarget()!==BODY_TWEAK_TARGET||this.session(owner,id,revision)!==s||s.advice!==candidate)throw Error('目标或建议已改变。');
    s.advice=undefined;this.stopPreview(s);s.revision++;
    return {revision:s.revision,shoulderOffsetDegrees:selectedLeft?.shoulder.offsetDegrees??null,
      upperArmOffsetDegrees:selectedLeft?.upperArm.offsetDegrees??null,elbowOffsetDegrees:selectedLeft?.elbow.offsetDegrees??null,
      ...((side==='right'||side==='both'||side==='all')?{right:{shoulderOffsetDegrees:selectedRight?.shoulder.offsetDegrees??null,upperArmOffsetDegrees:selectedRight?.upperArm.offsetDegrees??null,elbowOffsetDegrees:selectedRight?.elbow.offsetDegrees??null}}:{}),...((side==='head'||side==='all')?{headOffsetDegrees:selectedHead?.offsetDegrees??null}:{}),...((side==='torso'||side==='all')?{torsoOffsetDegrees:selectedTorso?.offsetDegrees??null}:{})};
  }
  async preview(owner: number, id: unknown, revision: unknown, input: unknown): Promise<BodyPosePreview> {
    return this.previewFor(owner, id, revision, input, 'selected-image');
  }
  async previewFixed(owner: number, id: unknown, revision: unknown, input: unknown): Promise<BodyPosePreview> {
    return this.previewFor(owner, id, revision, input, 'fixed-preset');
  }
  private selectionBinding(selection:BodyPoseSelection,target:string):BodyPoseBinding|null {
    const base=this.deps.binding(selection.bindingId,target);
    const left=selection.offsets?applyBodyPoseTweak(base,selection.offsets,selection.strength):base;
    const right=selection.right?applyBodyRightTweak(left,selection.right,selection.strength):left;
    const head=selection.head?applyBodyHeadTweak(right,selection.head,selection.strength):right;
    return selection.torso?applyBodyTorsoTweak(head,selection.torso,selection.strength):head;
  }
  private async previewFor(owner: number, id: unknown, revision: unknown, input: unknown, sourceKind: BodyPosePreview['sourceKind']): Promise<BodyPosePreview> {
    const s = this.session(owner, id, revision), selection = validateBodyPoseSelection(input);
    // Absence means a left-only edit, never permission to erase an existing right side.
    const savedRight=this.store.get(s.characterId).profile?.right;
    if(!selection.right&&savedRight)selection.right={enabled:savedRight.enabled,strength:savedRight.strength,
      shoulderOffsetDegrees:savedRight.shoulderOffsetDegrees,upperArmOffsetDegrees:savedRight.upperArmOffsetDegrees,elbowOffsetDegrees:savedRight.elbowOffsetDegrees};
    const savedHead=this.store.get(s.characterId).profile?.head;
    if(!selection.head&&savedHead)selection.head={enabled:savedHead.enabled,strength:savedHead.strength,offsetDegrees:savedHead.offsetDegrees};
    const savedTorso=this.store.get(s.characterId).profile?.torso;
    if(!selection.torso&&savedTorso)selection.torso={enabled:savedTorso.enabled,strength:savedTorso.strength,offsetDegrees:savedTorso.offsetDegrees};
    if (!s.targetModelSha || !s.modelUrl || s.controller || (sourceKind === 'selected-image' && (!s.material || !s.study))) throw Error('请使用已适配的空闲目标；图片预览还需要完成当前静图观察。');
    const binding=this.selectionBinding(selection,s.targetModelSha);
    if (!binding || !binding.properties.length || binding.targetModelSha !== s.targetModelSha || selection.strength !== binding.qualifiedStrength) throw Error('当前姿势没有可预览的贡献，或目标不在允许范围内。');
    this.stopPreview(s); s.advice=undefined; s.revision++;
    const value: BodyPosePreview = { id: randomUUID(), token: randomUUID(), sessionId: s.id, revision: s.revision,
      sourceKind, materialId: sourceKind === 'selected-image' ? s.material!.id : null, characterId: s.characterId, targetModelSha: s.targetModelSha, modelUrl: s.modelUrl,
      bindingId: binding.id, sourceSha: binding.sourceSha, mask: binding.mask, strength: selection.strength, expiresAt: this.now() + 11_500 };
    s.preview = { value, selection:structuredClone(selection), generation: null, resolved: false, ready: false };
    return structuredClone(value);
  }
  private previewSession(owner: number, id: unknown, token: unknown, requireLive = true): Session {
    const s = this.sessions.get(owner), p = s?.preview;
    if (!s || !this.current(s) || !p
      || p.value.id !== id || p.value.token !== token || p.value.revision !== s.revision || (requireLive && p.value.expiresAt <= this.now())) {
      throw Error('身体姿势预览已失效。');
    }
    if (p.value.sourceKind === 'selected-image'
      ? !s.material || s.material.expiresAt <= this.now() || p.value.materialId !== s.material.id
      : p.value.sourceKind !== 'fixed-preset' || p.value.materialId !== null) throw Error('身体姿势预览来源已失效。');
    return s;
  }
  receipt(owner: number, input: unknown): void {
    const row = visualRecord(input, ['phase', 'id', 'token', 'stageGeneration']);
    if (row.phase === 'stop') { const s = this.sessions.get(owner), p = s?.preview;
      if (s && p && p.value.id === row.id && p.value.token === row.token) this.stopPreview(s); return; }
    const s = this.previewSession(owner, row.id, row.token), p = s.preview!;
    if (!Number.isSafeInteger(row.stageGeneration) || (row.stageGeneration as number) < 1) throw Error('目标显示代次不正确。');
    if (row.phase === 'bind') { if (p.generation !== null && p.generation !== row.stageGeneration) throw Error('目标显示已更换。');
      p.generation = row.stageGeneration as number; return; }
    if (row.phase !== 'ready' || p.generation !== row.stageGeneration || !p.resolved) throw Error('尚未收到同一身体姿势预览。');
    p.ready = true;
  }
  async resolve(owner: number, id: unknown, token: unknown, generation: unknown): Promise<BodyPoseBinding> {
    const s = this.previewSession(owner, id, token), p = s.preview!;
    if (p.generation !== generation || generation === null) throw Error('目标显示尚未绑定。');
    if (await this.deps.verifyTarget() !== p.value.targetModelSha) throw Error('当前目标尚未通过身体姿势内容验证。');
    const binding=this.selectionBinding(p.selection,p.value.targetModelSha);
    if (!binding || binding.id !== p.value.bindingId || binding.sourceSha !== p.value.sourceSha || binding.mask !== p.value.mask || binding.qualifiedStrength !== p.value.strength
      || binding.targetModelSha !== p.value.targetModelSha || this.previewSession(owner, id, token) !== s || s.preview !== p || p.generation !== generation) {
      throw Error('迟到或不匹配的身体姿势资源已忽略。');
    }
    p.resolved = true; return structuredClone(binding);
  }
  async save(owner: number, input: unknown): Promise<BodyVisualState> {
    const row = visualRecord(input, ['sessionId', 'revision', 'savedRevision', 'previewId', 'previewToken']);
    const s = this.session(owner, row.sessionId, row.revision);
    if (validateLanguageRevision(row.savedRevision) !== s.savedRevision) throw Error('已确认行为版本已改变。');
    const current = this.previewSession(owner, row.previewId, row.previewToken, false), p = s.preview!;
    const binding=this.selectionBinding(p.selection,p.value.targetModelSha);
    if (current !== s || !p.ready || !p.resolved || !binding || binding.sourceSha !== p.value.sourceSha || binding.mask !== p.value.mask || binding.qualifiedStrength !== p.value.strength) {
      throw Error('请先观看当前卡和模型的同属性预览，再明确确认。');
    }
    if (await this.deps.verifyTarget() !== p.value.targetModelSha
      || this.previewSession(owner, row.previewId, row.previewToken, false) !== s || s.preview !== p || !p.ready) {
      throw Error('确认时目标模型或预览已改变，原记录与草稿已保留。');
    }
    let result;
    try { result = await this.store.save(s.characterId, { enabled: true, targetModelSha: p.value.targetModelSha,
      sourceSha: p.value.sourceSha, bindingId: p.value.bindingId, semantic: p.selection.semantic, label: p.selection.label, strength: p.value.strength,
      ...(p.selection.offsets ? {tweak:makeBodyPoseTweak(p.selection.offsets)} : {}),...(p.selection.right?{right:makeBodyRightTweak(p.selection.right)}:{}),...(p.selection.head?{head:makeBodyHeadTweak(p.selection.head)}:{}),...(p.selection.torso?{torso:makeBodyTorsoTweak(p.selection.torso)}:{}) }, s.savedRevision); }
    catch { throw Error('姿势行为写入或修订检查失败，原记录与草稿已保留。'); }
    s.savedRevision = result.revision; this.stopPreview(s); this.deps.changed(s.characterId);
    if (!this.current(s)) throw Error('行为已按原确认卡保存；当前界面已更换。'); return this.state(s);
  }
  async change(owner: number, input: unknown): Promise<BodyVisualState> {
    const row = visualRecord(input, ['sessionId', 'revision', 'kind']), s = this.session(owner, row.sessionId, row.revision);
    const saved = this.store.get(s.characterId);
    if (row.kind !== 'disable' && row.kind !== 'undo') throw Error('行为操作不正确。');
    if (row.kind === 'undo' && saved.previous?.profile?.enabled) {
      const previous = saved.previous.profile, base = s.targetModelSha ? this.deps.binding(previous.bindingId, s.targetModelSha) : null;
      const binding = bodyBindingForProfile(base,previous);
      if (!binding || previous.targetModelSha !== s.targetModelSha || binding.sourceSha !== previous.sourceSha || binding.qualifiedStrength !== previous.strength) throw Error('当前模型或强度尚未适配，不能启用旧姿势。');
      if (await this.deps.verifyTarget() !== previous.targetModelSha || this.session(owner, row.sessionId, row.revision) !== s) {
        throw Error('当前目标模型已改变，不能恢复旧姿势。');
      }
    }
    let result;
    try { result = row.kind === 'undo' ? await this.store.undo(s.characterId, s.savedRevision)
      : await this.store.save(s.characterId, saved.profile ? { ...saved.profile, enabled: false } : null, s.savedRevision); }
    catch { throw Error('姿势行为写入或修订检查失败，原记录与草稿已保留。'); }
    s.savedRevision = result.revision; s.revision++; s.advice=undefined; this.stopPreview(s); this.deps.changed(s.characterId);
    if (!this.current(s)) throw Error('行为已按原确认卡保存；当前界面已更换。'); return this.state(s);
  }
  close(owner: number, id?: unknown): void {
    if (id === undefined) this.opening.delete(owner); const s = this.sessions.get(owner);
    if (!s || (id !== undefined && s.id !== id)) return;
    this.sessions.delete(owner); s.controller?.abort(); this.stopPreview(s); this.clearMaterial(s);
  }
  invalidate(): void { this.opening.clear(); for (const owner of this.sessions.keys()) this.close(owner); }
  stopPreviews(): void { for (const s of this.sessions.values()) this.stopPreview(s); }
}
