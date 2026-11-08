import { AnimationClip, type Interpolant, type KeyframeTrack, type SkinnedMesh } from 'three';
import { EXPRESSION_MORPHS, EXPRESSION_GENE_SHA, EXPRESSION_MASK, validateExpressionRecipe, type ExpressionResource } from '../../shared/expression-composition';
import {
  BEHAVIOR_SEMANTICS, isBehaviorFaceBindingId, isBehaviorSemantic,
  MAX_BEHAVIOR_CUE_AGE_MS, MAX_BEHAVIOR_CUE_LIFETIME_MS, MAX_BEHAVIOR_FACE_STRENGTH,
  type BehaviorFaceBindingId, type BehaviorMotionCue, type BehaviorMotionPlan, type BehaviorMotionResource,
} from '../../shared/behavior-motion';
import type { UniversalTarget } from './universal-target';

export interface BehaviorMotionGates {
  enabled: boolean;
  visible: boolean;
  faceBlocked: boolean;
  directContact: boolean;
  windowAdjusting: boolean;
  cameraAdjusting: boolean;
  protectedMorphIndices?: readonly number[];
  /** The original blink keeps its own output; overlapping authored eye shapes yield. */
  naturalBlink?: number;
}
export interface BehaviorMotionDependencies {
  /** Only the host's content-hash check may authorize the reviewed target. */
  targetSupported?: boolean;
  /**
   * I-038: any other model as a target of the Gene-authored brow/eye shapes and compositions (src/stage/universal-target.ts):
   * its morphs that stand for one of those shapes join, the rest stay untouched. Read once, at first use (the stage makes its
   * retarget plan after this player). Absent or null: only the host-verified Gene, as before.
   */
  universal?: () => UniversalTarget | null;
  resolve(cueId: string, token: string): Promise<BehaviorMotionResource>;
  load(resource: BehaviorMotionResource, mesh: SkinnedMesh): Promise<AnimationClip>;
  /**
   * R29d: whether this library motion (sha256) suits the model (the Stage's
   * fit check). A motion that does not is never started, also from the clip
   * cache; one already playing fades out on recheck().
   */
  suits?(sha256: string): boolean;
  now?: () => number;
}
export interface BehaviorMorphSample { index: number; sample: number; base: number; value: number }
export interface BehaviorMotionLayerState {
  active: boolean;
  pending: boolean;
  id: string | null;
  bindingId: BehaviorFaceBindingId | null;
  stateKey: string | null;
  elapsedMs: number;
  durationMs: number;
  weight: number;
  propertyIndices: number[];
  samples: BehaviorMorphSample[];
  degraded: string | null;
}
interface MorphTrack { index: number; eye: boolean; interpolant: Interpolant }
interface PlayingFace {
  cue: BehaviorMotionCue;
  /** The granted motion's content hash (for the fit recheck). */
  sha256: string;
  duration: number;
  elapsed: number;
  strength: number;
  targetStrength: number;
  weight: number;
  tracks: MorphTrack[];
  samples: BehaviorMorphSample[];
  cancel: { elapsed: number; weight: number } | null;
}
interface FaceSlot {
  current: PlayingFace | null;
  ready: PlayingFace | null;
  pending: BehaviorMotionCue | null;
  key: string | null;
  version: number;
  degraded: string | null;
}

const MAX_IDS = 128, MAX_CACHE = 8, FADE_IN = 0.25, FADE_OUT = 0.45, CANCEL_FADE = 0.2;
// Audited Gene PMX panel 1/2 vertex morphs only. In particular にっこり is a
// mouth morph, まばたき belongs to natural blinking, and 総/赤み are not recipes.
const BROWS = new Set(['真面目', '困る', '困り', '困り左', '困り右', 'にこり', '怒り', '怒り左', '怒り右', '上', '下']);
const EYES = new Set(['笑い', 'びっくり', 'じと目', '見開き', '驚き', 'なぬ！'].map(name => name.normalize('NFKC')));
/** The authored eye shapes this player lets give way to the natural blink (NFKC names); the display guard follows them during a blink. */
export const BEHAVIOR_EYE_SHAPES: ReadonlySet<string> = EYES;
const EMPTY_GATES: BehaviorMotionGates = { enabled: false, visible: false, faceBlocked: false, directContact: false, windowAdjusting: false, cameraAdjusting: false };
const emptySlot = (): FaceSlot => ({ current: null, ready: null, pending: null, key: null, version: 0, degraded: null });
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (value: number) => { const x = clamp(value); return x * x * (3 - 2 * x); };
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const trackIndex = (name: string) => /^\.morphTargetInfluences\[(0|[1-9]\d{0,6})\]$/.exec(name);

/**
 * One removable, per-mesh face sampler. It owns no mixer, body, mouth, blush,
 * reward or persisted selection. restore() precedes the base/procedural update;
 * frame() follows it, before the outer display transition. State then reaction
 * are applied on the current base, and their snapshots restore in reverse order.
 */
export class BehaviorMotionPlayer {
  get supported(): boolean { return this.targetSupported || this.adopt(); }
  /** A local preview suppresses live host cues without queuing them for its exit. */
  consumeSuppressed(plan:BehaviorMotionPlan|null):void{this.consume(plan?.state);this.consume(plan?.reaction);}
  private readonly state = emptySlot();
  private readonly reaction = emptySlot();
  private readonly consumed = new Set<string>();
  private readonly cache = new Map<string, Promise<AnimationClip>>();
  private readonly allowed = new Map<number, boolean>();
  private readonly influences: number[] | undefined;
  private readonly dictionary: string;
  private targetSupported: boolean;
  /** I-038: undefined until read; null when the model cannot be a target; the reviewed identity is never adopted here. */
  private universal: UniversalTarget | null | undefined;
  /** Composition morph (EXPRESSION_MORPHS id) → this mesh's index and amplitude factor; Gene's own fixed indices when verified. */
  private readonly compositionTargets = new Map<string, { index: number; ratio: number }>();
  private readonly snapshots: { index: number; value: number }[] = [];
  private gates: BehaviorMotionGates = { ...EMPTY_GATES };
  private protectedIndices = new Set<number>();
  private token = '';
  private disposed = false;
  private composition: {resource:ExpressionResource;strength:number;samples:BehaviorMorphSample[]} | null = null;

  constructor(private readonly mesh: SkinnedMesh, private readonly dependencies: BehaviorMotionDependencies) {
    this.influences = mesh.morphTargetInfluences;
    this.dictionary = this.dictionaryIdentity();
    this.targetSupported = dependencies.targetSupported === true;
    if (!this.targetSupported) {
      this.state.degraded = this.reaction.degraded = 'unsupported-target';
      return;
    }
    for (const row of EXPRESSION_MORPHS) this.compositionTargets.set(row.id, { index: row.index, ratio: 1 });
    this.allow(name => name);
  }

  /** The allowed brow/eye morphs, each by the Gene shape it stands for (`standard`: this mesh's name → Gene's, or null). */
  private allow(standard: (name: string) => string | null): void {
    const entries = Object.entries(this.mesh.morphTargetDictionary ?? {});
    const counts = new Map<number, number>(), names = new Map<string, number>();
    for (const [name, index] of entries) {
      counts.set(index, (counts.get(index) ?? 0) + 1);
      const normalized = name.normalize('NFKC'); names.set(normalized, (names.get(normalized) ?? 0) + 1);
    }
    for (const [name, index] of entries) {
      const own = standard(name), normalized = own === null ? '' : own.normalize('NFKC');
      if (own !== null && Number.isInteger(index) && index >= 0 && index < (this.influences?.length ?? 0) && counts.get(index) === 1 && names.get(name.normalize('NFKC')) === 1 &&
        (BROWS.has(normalized) || EYES.has(normalized))) this.allowed.set(index, EYES.has(normalized));
    }
  }

  /** I-038: takes another model as a target once its retarget plan exists (see `universal`); true when it now is one. */
  private adopt(): boolean {
    if (this.targetSupported || this.disposed) return this.targetSupported;
    if (this.universal === undefined) {
      let target: UniversalTarget | null = null;
      try { target = this.dependencies.universal?.() ?? null; } catch { target = null; }
      if (target?.reviewed) target = null; // only the host's content check vouches for Gene's fixed indices
      this.universal = target;
      if (!target) return false;
      this.allow(name => target!.standardMorph(name));
      const dictionary = this.mesh.morphTargetDictionary ?? {};
      for (const row of EXPRESSION_MORPHS) {
        const mapped = target.targetMorph(row.name), index = mapped ? dictionary[mapped.name] : undefined;
        if (mapped && index !== undefined && this.allowed.has(index)) this.compositionTargets.set(row.id, { index, ratio: mapped.ratio });
      }
      if (!this.allowed.size) return false;
      this.targetSupported = true;
      this.state.degraded = this.reaction.degraded = null;
    }
    return this.targetSupported;
  }

  update(plan: BehaviorMotionPlan | null, token: string, gates: BehaviorMotionGates): void {
    if (this.disposed) return;
    if (!this.supported) {
      this.consume(plan?.state); this.consume(plan?.reaction); this.stop();
      this.state.degraded = this.reaction.degraded = 'unsupported-target';
      return;
    }
    if (token !== this.token) { this.stop(); this.cache.clear(); this.token = token; }
    this.gates = { ...gates };
    this.protectedIndices = new Set((gates.protectedMorphIndices ?? []).filter(index => Number.isInteger(index) && index >= 0));
    if (!text(token, 1_024) || this.hardBlocked() || !this.sameMesh()) {
      this.consume(plan?.state); this.consume(plan?.reaction);
      this.stop();
      this.state.degraded = this.reaction.degraded = 'blocked';
      return;
    }
    // Pretrial 2026-11-03: a touch, a window or camera adjustment, a picked face or 自动表现 off used to cut the face back in one
    // frame (the display guard caught 0.24 on 上). Nothing new starts and nothing is queued, but what shows fades out from where it is.
    if (this.blocked()) {
      this.consume(plan?.state); this.consume(plan?.reaction);
      for (const slot of [this.state, this.reaction]) { this.cancelPending(slot); this.fade(slot); slot.key = null; slot.degraded = 'blocked'; }
      return;
    }
    this.updateSlot(this.state, plan?.state ?? null, 'state');
    this.updateSlot(this.reaction, plan?.reaction ?? null, 'reaction');
  }

  restore(): void {
    const values = this.mesh.morphTargetInfluences;
    if (values === this.influences) for (let index = this.snapshots.length - 1; index >= 0; index--) {
      const snapshot = this.snapshots[index]; values![snapshot.index] = snapshot.value;
    }
    this.snapshots.length = 0;
  }

  frame(delta: number): ReturnType<BehaviorMotionPlayer['getState']> {
    this.restore();
    if (this.disposed || this.hardBlocked() || !this.sameMesh()) { this.stop(); return this.getState(); }
    const gated = this.blocked();
    if (gated && this.composition) { this.stop(); return this.getState(); }
    if (gated) for (const slot of [this.state, this.reaction]) { this.cancelPending(slot); this.fade(slot); }
    if(this.composition){
      const current=this.composition;
      if(current.resource.expiresAt<=(this.dependencies.now??Date.now)()){this.stop();return this.getState();}
      current.samples=[];
      for(const entry of current.resource.recipe.morphs){
        const target=EXPRESSION_MORPHS.find(row=>row.id===entry.id)!,mapped=this.compositionTargets.get(entry.id);
        if(!mapped)continue; // I-038: a shape this model does not have is skipped (setComposition checked at least one maps)
        const weight=current.strength*(target.eye?1-this.gates.naturalBlink!:1);
        if(weight<=0)continue;
        const sample=Math.min(1,entry.weight*mapped.ratio),base=this.influences![mapped.index],value=base+(sample-base)*weight;
        this.snapshots.push({index:mapped.index,value:base});this.influences![mapped.index]=value;
        current.samples.push({index:mapped.index,sample,base,value});
      }
      return this.getState();
    }
    const dt = Number.isFinite(delta) && delta >= 0 ? delta : 0;
    this.frameSlot(this.state, dt, gated);
    this.frameSlot(this.reaction, dt, gated);
    return this.getState();
  }

  /** Immediate gates/teardown never queue a cancelled reaction or keep its output. */
  stop(): void {
    this.restore();
    this.composition=null;
    for (const slot of [this.state, this.reaction]) {
      slot.version++; slot.current = slot.ready = null; slot.pending = null; slot.key = null;
    }
  }

  dispose(): void {
    this.stop(); this.disposed = true; this.cache.clear(); this.consumed.clear(); this.allowed.clear();
  }

  /**
   * R29d: the fit check changed. A face motion that no longer suits the model
   * is not started (a ready one is dropped) and a playing one fades out by the
   * same cancel fade as any revoked cue, from its current weight.
   */
  recheck(): void {
    const suits = this.dependencies.suits;
    if (!suits || this.disposed) return;
    for (const slot of [this.state, this.reaction]) {
      if (slot.ready && !suits(slot.ready.sha256)) { slot.ready = null; slot.degraded = 'unsuitable-model'; }
      if (slot.current && !suits(slot.current.sha256)) { this.fade(slot); slot.degraded = 'unsuitable-model'; }
    }
  }

  /** Static host-owned candidate in this SAME sampler; no VMD identity, mixer or persisted channel. */
  setComposition(resource:ExpressionResource,token:string,gates:BehaviorMotionGates,strength:number):boolean{
    this.update(null,token,gates);this.stop();
    if(this.disposed||!this.supported||this.blocked()||!this.sameMesh()||!text(token,1024)
      ||resource.token!==token||resource.scope!=='personalize-expression-controls'||resource.targetModelSha!==EXPRESSION_GENE_SHA||resource.mask!==EXPRESSION_MASK
      ||resource.expiresAt<=(this.dependencies.now??Date.now)()||!Number.isFinite(strength)||strength<=0||strength>.7
      ||typeof gates.naturalBlink!=='number'||!Number.isFinite(gates.naturalBlink)||gates.naturalBlink<0||gates.naturalBlink>1
      ||(this.universal?false:this.influences?.length!==184))return false;
    let recipe;try{recipe=validateExpressionRecipe(resource.recipe);}catch{return false;}
    if(recipe.strength<=0)return false;
    // The content pin authorizes only the exact known Gene mapping, never arbitrary matching names.
    // I-038: on another model, the shapes it has (by the universal target), at least one; each still an allowed, unprotected morph.
    if(this.universal){
      const mapped=recipe.morphs.map(entry=>this.compositionTargets.get(entry.id)).filter(value=>value!==undefined);
      if(!mapped.length||mapped.some(value=>!this.allowed.has(value.index)||this.protectedIndices.has(value.index)))return false;
    }else if(recipe.morphs.some(entry=>{const target=EXPRESSION_MORPHS.find(row=>row.id===entry.id)!;
      return this.mesh.morphTargetDictionary?.[target.name]!==target.index||!this.allowed.has(target.index)||this.protectedIndices.has(target.index);}))return false;
    this.composition={resource:{...resource,recipe},strength:Math.min(strength,recipe.strength),samples:[]};return true;
  }
  getCompositionState():{id:string|null;recipeId:string|null;propertyIndices:number[];samples:BehaviorMorphSample[]}{
    const current=this.composition;return {id:current?.resource.id??null,recipeId:current?.resource.recipeId??null,
      propertyIndices:current?.samples.map(row=>row.index)??[],samples:current?.samples.map(row=>({...row}))??[]};
  }

  getState(): { active: boolean; state: BehaviorMotionLayerState; reaction: BehaviorMotionLayerState; cacheSize: number; consumedIds: number } {
    const describe = (slot: FaceSlot): BehaviorMotionLayerState => {
      const playing = slot.current, cue = playing?.cue ?? slot.ready?.cue ?? slot.pending;
      return { active: !!playing, pending: !!(slot.pending || slot.ready), id: cue?.id ?? null, bindingId: cue?.bindingId ?? null,
        stateKey: cue?.stateKey ?? null, elapsedMs: (playing?.elapsed ?? 0) * 1_000, durationMs: (playing?.duration ?? slot.ready?.duration ?? 0) * 1_000,
        weight: playing?.weight ?? 0, propertyIndices: playing?.tracks.filter(track => !this.protectedIndices.has(track.index)).map(track => track.index) ?? [],
        samples: playing?.samples.map(sample => ({ ...sample })) ?? [], degraded: slot.degraded };
    };
    return { active: !!(this.composition || this.state.current || this.reaction.current), state: describe(this.state), reaction: describe(this.reaction),
      cacheSize: this.cache.size, consumedIds: this.consumed.size };
  }

  private updateSlot(slot: FaceSlot, cue: BehaviorMotionCue | null, kind: BehaviorMotionCue['kind']): void {
    if (!cue || !this.validCue(cue, kind, false)) {
      this.consume(cue); slot.key = null; this.cancelPending(slot); this.fade(slot); return;
    }
    if (kind === 'state' && slot.key === cue.stateKey) {
      this.consume(cue);
      for (const playing of [slot.current, slot.ready]) if (playing?.cue.stateKey === cue.stateKey && !playing.cancel) playing.targetStrength = cue.strength;
      return;
    }
    if (kind === 'reaction' && [slot.current?.cue.id, slot.ready?.cue.id, slot.pending?.id].includes(cue.id)) return;
    this.cancelPending(slot); this.fade(slot);
    slot.key = null;
    if (this.consumed.has(cue.id)) return;
    this.consume(cue);
    if (!this.validCue(cue, kind, true)) { slot.degraded = 'expired'; return; }
    slot.key = kind === 'state' ? cue.stateKey : null;
    const accepted = { ...cue }, version = slot.version, token = this.token;
    slot.pending = accepted; slot.degraded = null;
    void this.load(slot, accepted, version, token);
  }

  private async load(slot: FaceSlot, cue: BehaviorMotionCue, version: number, token: string): Promise<void> {
    const current = () => !this.disposed && slot.version === version && slot.pending?.id === cue.id && token === this.token &&
      !this.blocked() && this.sameMesh() && this.validCue(cue, cue.kind, true);
    try {
      const resource = await this.dependencies.resolve(cue.id, token);
      if (!current()) return;
      if (!this.validResource(resource, cue)) { slot.degraded = 'invalid-resource'; return; }
      const key = `${resource.bindingId}:${resource.sha256}:${resource.durationMs}`;
      let promise = this.cache.get(key);
      if (promise) { this.cache.delete(key); this.cache.set(key, promise); }
      else {
        promise = Promise.resolve().then(() => this.dependencies.load(resource, this.mesh));
        this.cache.set(key, promise);
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      }
      let clip: AnimationClip;
      try { clip = await promise; }
      catch (error) { if (this.cache.get(key) === promise) this.cache.delete(key); throw error; }
      if (!current()) return;
      if (this.dependencies.suits?.(resource.sha256) === false) { slot.degraded = 'unsuitable-model'; return; }
      const tracks = this.sampleTracks(clip, resource.durationMs / 1_000);
      if (!tracks?.length) { slot.degraded = tracks ? 'no-compatible-morphs' : 'invalid-clip'; return; }
      slot.ready = { cue, sha256: resource.sha256, duration: resource.durationMs / 1_000, elapsed: 0, strength: cue.strength, targetStrength: cue.strength,
        weight: 0, tracks, samples: [], cancel: null };
      if (!slot.current) { slot.current = slot.ready; slot.ready = null; }
    } catch { if (current()) slot.degraded = 'load-failed'; }
    finally { if (slot.version === version && slot.pending?.id === cue.id) slot.pending = null; }
  }

  private sampleTracks(clip: AnimationClip, duration: number): MorphTrack[] | null {
    if (!(clip instanceof AnimationClip) || !Number.isFinite(clip.duration) || clip.duration < 0 || clip.duration > duration + 1 / 30 + 1e-4 || clip.tracks.length > 2_000) return null;
    const tracks: MorphTrack[] = [], seen = new Set<number>();
    for (const track of clip.tracks) {
      const match = trackIndex(track.name);
      if (!match) continue;
      const index = Number(match[1]);
      if (index >= (this.influences?.length ?? 0) || seen.has(index)) return null;
      seen.add(index);
      if (!this.allowed.has(index)) continue;
      if (!this.validTrack(track, duration)) return null;
      try { tracks.push({ index, eye: this.allowed.get(index)!, interpolant: track.createInterpolant() }); }
      catch { return null; }
    }
    return tracks;
  }

  private validTrack(track: KeyframeTrack, duration: number): boolean {
    if (track.getValueSize() !== 1 || track.times.length < 1 || track.times.length > 100_000 || track.times.length !== track.values.length) return false;
    let previous = -Infinity;
    for (const time of track.times) { if (!Number.isFinite(time) || time < 0 || time < previous || time > duration + 1e-4) return false; previous = time; }
    return [...track.values].every(value => Number.isFinite(value) && value >= 0 && value <= 1);
  }

  private frameSlot(slot: FaceSlot, dt: number, gated = false): void {
    let playing = slot.current;
    if (!playing && slot.ready && !gated) { playing = slot.current = slot.ready; slot.ready = null; }
    if (!playing) return;
    // Pretrial 2026-11-03: a cue that runs out while its face still shows fades from there (it was dropped in one frame: 0.4 of
    // face.convinced, a 0.08 jump on 見開き the display guard had to catch).
    if (!this.validCue(playing.cue, playing.cue.kind, false)) { if (!playing.cancel) playing.cancel = { elapsed: 0, weight: playing.weight }; slot.degraded = 'expired'; }
    playing.elapsed += dt;
    playing.strength += (playing.targetStrength - playing.strength) * (1 - Math.exp(-dt * 10));
    const normal = playing.strength * smooth(playing.elapsed / FADE_IN) * smooth((playing.duration - playing.elapsed) / FADE_OUT);
    if (playing.cancel) playing.cancel.elapsed += dt;
    playing.weight = playing.cancel ? Math.min(normal, playing.cancel.weight * smooth(1 - playing.cancel.elapsed / CANCEL_FADE)) : normal;
    playing.samples = [];
    if (playing.elapsed >= playing.duration || playing.cancel && playing.cancel.elapsed >= CANCEL_FADE) {
      slot.current = slot.ready; slot.ready = null; return;
    }
    const blink = Number.isFinite(this.gates.naturalBlink) ? clamp(this.gates.naturalBlink!) : 0;
    for (const track of playing.tracks) {
      if (this.protectedIndices.has(track.index)) continue;
      const base = this.influences![track.index];
      let sample: number;
      try { sample = track.interpolant.evaluate(playing.elapsed)[0]; } catch { continue; }
      if (!Number.isFinite(base) || !Number.isFinite(sample) || sample < 0 || sample > 1) continue;
      const weight = playing.weight * (track.eye ? 1 - blink : 1);
      const value = base + (sample - base) * weight;
      if (weight > 0) { this.snapshots.push({ index: track.index, value: base }); this.influences![track.index] = value; }
      playing.samples.push({ index: track.index, sample, base, value });
    }
  }

  private validCue(cue: BehaviorMotionCue, kind: BehaviorMotionCue['kind'], starting: boolean): boolean {
    const now = (this.dependencies.now ?? Date.now)();
    if (!cue || cue.kind !== kind || !text(cue.id, 160) || !text(cue.stateKey, 512) || !isBehaviorFaceBindingId(cue.bindingId) || !isBehaviorSemantic(cue.semantic) ||
      ![cue.at, cue.expiresAt, cue.strength, now].every(Number.isFinite) || cue.at < 0 || cue.at > now || cue.expiresAt <= now ||
      cue.expiresAt > cue.at + MAX_BEHAVIOR_CUE_LIFETIME_MS || cue.strength <= 0 || cue.strength > MAX_BEHAVIOR_FACE_STRENGTH ||
      starting && now - cue.at > MAX_BEHAVIOR_CUE_AGE_MS) return false;
    const entry = BEHAVIOR_SEMANTICS[cue.semantic];
    return entry.kind === kind && entry.route === 'face' && (entry.bindingIds as readonly string[]).includes(cue.bindingId);
  }

  private validResource(resource: BehaviorMotionResource, cue: BehaviorMotionCue): boolean {
    return !!resource && resource.cueId === cue.id && resource.bindingId === cue.bindingId && resource.packId === 'gene' &&
      resource.motionId === cue.bindingId.slice(5) && resource.recipe === 'emotion-face' && /^[a-f0-9]{64}$/.test(resource.sha256) &&
      Number.isFinite(resource.durationMs) && resource.durationMs > 0 && resource.durationMs <= 30_000 &&
      text(resource.url, 4_096) && resource.url.startsWith('mmd-asset://');
  }

  /** Not shown at all (hidden, zero-size): nothing to fade on screen, everything stops. */
  private hardBlocked(): boolean { return this.gates.visible !== true; }
  /** No new face may start; what shows fades out (CANCEL_FADE) from where it is. */
  private blocked(): boolean {
    const gates = this.gates;
    return gates.enabled !== true || gates.visible !== true || gates.faceBlocked === true || gates.directContact === true ||
      gates.windowAdjusting === true || gates.cameraAdjusting === true;
  }
  private dictionaryIdentity(): string { return JSON.stringify(Object.entries(this.mesh.morphTargetDictionary ?? {}).sort(([a], [b]) => a.localeCompare(b))); }
  private sameMesh(): boolean { return !!this.influences && this.mesh.morphTargetInfluences === this.influences && this.dictionaryIdentity() === this.dictionary; }
  private consume(cue: BehaviorMotionCue | null | undefined): void {
    if (!cue || !text(cue.id, 160)) return;
    this.consumed.add(cue.id);
    if (this.consumed.size > MAX_IDS) this.consumed.delete(this.consumed.values().next().value!);
  }
  private cancelPending(slot: FaceSlot): void { slot.version++; slot.pending = slot.ready = null; }
  private fade(slot: FaceSlot): void { if (slot.current && !slot.current.cancel) slot.current.cancel = { elapsed: 0, weight: slot.current.weight }; }
}
