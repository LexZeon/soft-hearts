import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { createVmdParser } from '../src/stage/vmd';
import geneStructure from '../shared/motion-track-gene-structure.json';
import { recordedMotionTrackRelations } from './motion-track-relations';
import type { VmdTrackData, VmdTrackReport } from '../src/stage/vmd-tracks';
import type { CatalogMotion, MotionCatalog } from '../shared/motion-library';
import type { MotionTrackAssetId, MotionTrackCoverage, MotionTrackCoverageRequest, MotionTrackCoverageView, MotionTrackProperty } from '../shared/motion-track-coverage';

const MAX_BYTES = 8 * 1024 * 1024, MAX_PROPERTIES = 4096;
const plain = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key] && 'value' in descriptors[key]);
};
const safeName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(v);
export function parseMotionTrackCoverageRequest(value: unknown): MotionTrackCoverageRequest {
  if (!plain(value, ['assets']) || !Array.isArray(value.assets) || types.isProxy(value.assets)
    || value.assets.length < 1 || value.assets.length > 2 || Reflect.ownKeys(value.assets).length !== value.assets.length + 1) throw Error('轨道查询只接受一至两个已安装动作编号。');
  const assets = [];
  for (let i = 0; i < value.assets.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.assets, String(i));
    if (!descriptor || !('value' in descriptor) || !plain(descriptor.value, ['packId','motionId'])
      || !safeName(descriptor.value.packId) || !safeName(descriptor.value.motionId)) throw Error('动作编号不正确。');
    assets.push({ packId: descriptor.value.packId, motionId: descriptor.value.motionId } as MotionTrackAssetId);
  }
  return { assets };
}
/** Parsed with the same readonly normalization used by the Stage; no files or clocks are changed. */
function parse(bytes: Uint8Array): { data: VmdTrackData; report: VmdTrackReport } {
  let report: VmdTrackReport | undefined;
  const parser = createVmdParser(value => { report = value; }) as { parseVmd(buffer: ArrayBuffer, handedness: boolean): VmdTrackData };
  const copy = new Uint8Array(bytes);
  const data = parser.parseVmd(copy.buffer, true);
  if (!report) throw Error('无法确认VMD轨道结构。');
  return { data, report };
}
export function motionTrackFacts(data: VmdTrackData): MotionTrackProperty[] {
  const rows: MotionTrackProperty[] = [];
  const grouped = new Map<string, typeof data.motions[number][]>();
  for (const frame of data.motions) {
    if (!safeName(frame.boneName) || !Number.isSafeInteger(frame.frameNum) || frame.frameNum < 0
      || frame.position.length !== 3 || frame.rotation.length !== 4 || ![...frame.position,...frame.rotation].every(Number.isFinite)) throw Error('骨骼轨道数据不完整。');
    const frames = grouped.get(frame.boneName) ?? []; frames.push(frame); grouped.set(frame.boneName,frames);
  }
  for (const [target, frames] of grouped) {
    const first = frames[0];
    const positionStatic = frames.every(frame => frame.position.every((v,i) => v === first.position[i]));
    const rotationStatic = frames.every(frame => { const sign=frame.rotation.reduce((n,v,i)=>n+v*first.rotation[i],0)<0?-1:1;return frame.rotation.every((v,i)=>Math.abs(v*sign-first.rotation[i])<=1e-8); });
    rows.push({ target, kind:'position', keyframes:frames.length, state:positionStatic ? first.position.every(v=>v===0)?'static-default':'static-nondefault':'dynamic', part:null,modelIndex:null });
    rows.push({ target, kind:'quaternion', keyframes:frames.length, state:rotationStatic ? first.rotation.slice(0,3).every(v=>Math.abs(v)<=1e-8)&&Math.abs(Math.abs(first.rotation[3])-1)<=1e-8?'static-default':'static-nondefault':'dynamic', part:null,modelIndex:null });
  }
  const morphs = new Map<string, typeof data.morphs[number][]>();
  for (const frame of data.morphs) {
    if (!safeName(frame.morphName) || !Number.isSafeInteger(frame.frameNum) || frame.frameNum < 0 || !Number.isFinite(frame.weight)) throw Error('morph轨道数据不完整。');
    const frames=morphs.get(frame.morphName)??[];frames.push(frame);morphs.set(frame.morphName,frames);
  }
  for (const [target,frames] of morphs) rows.push({target,kind:'morph',keyframes:frames.length,
    state:frames.every(frame=>frame.weight===frames[0].weight)?frames[0].weight===0?'static-default':'static-nondefault':'dynamic',part:null,modelIndex:null});
  if (rows.length > MAX_PROPERTIES) throw Error('轨道属性数量超出有界详情范围。');
  return rows.sort((a,b)=>a.target.localeCompare(b.target)||a.kind.localeCompare(b.kind));
}
interface Ports {
  catalog: MotionCatalog;
  /** Current owned controls/model context, null on hide/lost owner; no model file IO. */
  context(sender: number): string | null;
  /** Existing host content verifier only; never a renderer-supplied path/hash. */
  modelIdentity?():Promise<string|null>;
  resolve(packId: string, motionId: string): Promise<string>;
  read?(file: string): Promise<Uint8Array>;
  parse?(bytes: Uint8Array): { data: VmdTrackData; report: VmdTrackReport };
}
export class MotionTrackCoverageHost {
  private readonly cache = new Map<string, Omit<MotionTrackCoverage,'asset'>>();
  private active = 0;
  constructor(private readonly ports: Ports) {}
  async read(sender: number, value: unknown): Promise<MotionTrackCoverageView> {
    if(this.active>=2)throw Error('轨道读取仍在进行，请稍后再试。');
    this.active++;
    try{return await this.inspect(sender,value);}finally{this.active--;}
  }
  private async inspect(sender: number, value: unknown): Promise<MotionTrackCoverageView> {
    const request=parseMotionTrackCoverageRequest(value), contextId=this.ports.context(sender);
    if (!contextId) throw Error('请在当前控制窗口读取轨道详情。');
    const current=()=>{if(this.ports.context(sender)!==contextId)throw Error('模型或窗口已变化，请重新读取轨道。');};
    let modelSha:string|null=null;
    try {modelSha=await this.ports.modelIdentity?.()??null;} catch { /* Unknown model identity does not invent a part mapping. */ }
    current();
    const assets:MotionTrackCoverage[]=[];
    for(const id of request.assets){
      current();const pack=this.ports.catalog.packs.find(row=>row.id===id.packId), motion=pack?.motions.find(row=>row.id===id.motionId);
      if(!motion)throw Error('动作不在当前已审核目录。');
      const file=await this.ports.resolve(id.packId,id.motionId);current();
      const bytes=await (this.ports.read??readFile)(file);current();
      this.checkBytes(bytes,motion); // Always revalidate current installed bytes, even on a parse-cache hit.
      let facts=this.cache.get(motion.sha256);
      if(!facts){const parsed=(this.ports.parse??parse)(bytes);current();facts={sha256:motion.sha256,properties:motionTrackFacts(parsed.data),durationFrames:parsed.report.durationFrames,
        removedDefaultBones:parsed.report.removedBoneNames.length,removedZeroMorphs:parsed.report.removedMorphNames.length,modelMapping:'unknown',modelSha256:null};
        this.cache.set(motion.sha256,structuredClone(facts));if(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);}
      assets.push(bindMotionTrackStructure({...structuredClone(facts),asset:{...id}},modelSha));
    }
    current();const directOverlap=assets.length===2?assets[0].properties.filter(a=>assets[1].properties.some(b=>a.kind===b.kind&&a.target===b.target)).map(({target,kind})=>({target,kind})):[];
    const modelOverlap=assets.length===2&&assets.every(a=>a.modelMapping==='verified-public-gene')
      ?assets[0].properties.filter(a=>a.modelIndex!==null&&assets[1].properties.some(b=>a.kind===b.kind&&a.modelIndex===b.modelIndex)).map(({target,kind,modelIndex})=>({target,kind,modelIndex})):[];
    const bindingContextId=createHash('sha256').update(JSON.stringify([contextId,modelSha])).digest('hex');
    return {contextId:bindingContextId,assets,directOverlap,modelOverlap,recordedRelations:recordedMotionTrackRelations(assets),hierarchy:'unknown',ik:'unknown',combination:'not-validated'};
  }
  private checkBytes(bytes: Uint8Array, motion: CatalogMotion): void {
    if(bytes.byteLength<1||bytes.byteLength>MAX_BYTES||bytes.byteLength!==motion.bytes
      ||createHash('sha256').update(bytes).digest('hex')!==motion.sha256)throw Error('已安装动作内容已变化或无法核对。');
  }
}

/** Binds only one hash-pinned, structurally audited public model. No name-only model inference. */
export function bindMotionTrackStructure(fact:MotionTrackCoverage,modelSha:string|null):MotionTrackCoverage{
  if(modelSha!==geneStructure.modelSha256)return {...fact,modelMapping:'unknown',modelSha256:null,
    properties:fact.properties.map(row=>({...row,part:null,modelIndex:null}))};
  return {...fact,modelMapping:'verified-public-gene',modelSha256:modelSha,properties:fact.properties.map(row=>{
    const candidates=(row.kind==='morph'?geneStructure.morphs:geneStructure.bones).filter(b=>b.name===row.target);
    if(candidates.length!==1)return {...row,part:null,modelIndex:null};const target=candidates[0];
    return {...row,part:target.part as MotionTrackProperty['part'],modelIndex:row.kind==='morph'&&'type' in target&&target.type!==1?null:target.index};
  })};
}
