import { Quaternion, type Bone, type SkinnedMesh } from 'three';
import curves from './surprise-curves.json';
import shyCurves from './shy-curves.json';
import {SHY_CLIP_ID} from '../../shared/surprise-preview';

// This closed input is the original author's frozen 0f77177a curve; no renderer paths,
// arbitrary properties, other models or externally supplied quaternions are accepted.
export const SURPRISE_GENE_SHA='0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
export const SURPRISE_CLIP='original-surprise-offline-001' as const;
export const SURPRISE_REVISION=2 as const;
export const SURPRISE_DURATION_MS=1800;
type CurveId='brow_raise'|'eye_wide'|'head_z_degrees'|'torso_z_degrees';
type FrameGates={ brow:boolean; eye:boolean; head:boolean; torso:boolean; naturalBlink:number };
export type SurpriseApplied={morphs:number[];bones:number[]};

export function surpriseSample(elapsedMs:number,clipId:string=SURPRISE_CLIP):Record<CurveId,number>|null {
  if(!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>=SURPRISE_DURATION_MS)return null;
  const selected=clipId===SURPRISE_CLIP?curves:clipId===SHY_CLIP_ID?shyCurves:null;
  if(!selected)return null;
  const sample=(id:CurveId):number=>{
    const points=selected.tracks[id];
    for(let i=1;i<points.length;i++){
      const [a,x]=points[i-1], [b,y]=points[i];
      if(elapsedMs<=b){const t=(elapsedMs-a)/(b-a),u=t*t*(3-2*t);return x+(y-x)*u;}
    }
    return 0;
  };
  return {brow_raise:sample('brow_raise'),eye_wide:sample('eye_wide'),head_z_degrees:sample('head_z_degrees'),torso_z_degrees:sample('torso_z_degrees')};
}

/** One frame overlay. The existing preview owner supplies the clock, identity and gates. */
export class SurpriseOverlay {
  private snapshots:{bone:Bone;quaternion:Quaternion}[]=[];
  private faces:{index:number;value:number}[]=[];
  private readonly influences:number[]|undefined;
  private readonly bones:Bone[];
  private readonly faceEligible:boolean;
  private readonly dictionaryIdentity:string;
  constructor(private readonly mesh:SkinnedMesh, hostVerifiedGene:boolean, verifiedFaceMask:boolean,private readonly clipId:string=SURPRISE_CLIP){
    if(hostVerifiedGene!==true)throw Error('惊喜试作仅适配已核验 Gene。');
    if(clipId!==SURPRISE_CLIP&&clipId!==SHY_CLIP_ID)throw Error('未知表情试作。');
    this.influences=mesh.morphTargetInfluences;
    this.bones=mesh.skeleton.bones;
    const dictionary=mesh.morphTargetDictionary,indices=Object.values(dictionary??{}),names=Object.keys(dictionary??{}).map(name=>name.normalize('NFKC'));
    this.dictionaryIdentity=JSON.stringify(Object.entries(dictionary??{}).sort(([a],[b])=>a.localeCompare(b)));
    this.faceEligible=verifiedFaceMask===true&&this.influences?.length===184
      &&dictionary?.['上']===84&&dictionary?.['びっくり']===94
      &&indices.filter(index=>index===84).length===1&&indices.filter(index=>index===94).length===1
      &&names.filter(name=>name==='上'.normalize('NFKC')).length===1&&names.filter(name=>name==='びっくり'.normalize('NFKC')).length===1;
  }
  restore():void {
    for(let i=this.snapshots.length-1;i>=0;i--)this.snapshots[i].bone.quaternion.copy(this.snapshots[i].quaternion);
    this.snapshots=[];
    if(this.mesh.morphTargetInfluences===this.influences&&this.influences){
      for(let i=this.faces.length-1;i>=0;i--)this.influences[this.faces[i].index]=this.faces[i].value;
    }
    this.faces=[];
  }
  /** Caller restores outer bridges/physics before restore(), then supplies this frame's current base. */
  apply(elapsedMs:number, gates:FrameGates):SurpriseApplied {
    if(this.snapshots.length||this.faces.length)throw Error('必须先撤回上帧惊喜试作。');
    const result:SurpriseApplied={morphs:[],bones:[]};
    const sample=surpriseSample(elapsedMs,this.clipId);
    if(!sample||this.mesh.skeleton.bones!==this.bones||!Number.isFinite(gates.naturalBlink)||gates.naturalBlink<0||gates.naturalBlink>1)return result;
    if(this.faceEligible&&this.influences===this.mesh.morphTargetInfluences&&this.influences
      &&this.dictionaryIdentity===JSON.stringify(Object.entries(this.mesh.morphTargetDictionary??{}).sort(([a],[b])=>a.localeCompare(b)))){
      for(const [index,target,weight,allowed] of [[84,sample.brow_raise,1,gates.brow],[94,sample.eye_wide,1-gates.naturalBlink,gates.eye]] as const){
        const base=this.influences[index];
        if(!allowed||target===0||weight<=0||!Number.isFinite(base))continue;
        const value=base+(target-base)*weight;
        if(!Number.isFinite(value)||value===base)continue;
        this.faces.push({index,value:base});this.influences[index]=value;result.morphs.push(index);
      }
    }
    const applyBone=(index:number,name:string,parentIndex:number,parentName:string,degrees:number,allowed:boolean)=>{
      const bone=this.bones[index],parent=this.bones[parentIndex];
      if(!allowed||degrees===0||!Number.isFinite(degrees)||Math.abs(degrees)>10||!bone||bone.name!==name||!parent||parent.name!==parentName||bone.parent!==parent
        ||this.bones.filter(value=>value.name===name).length!==1||this.bones.filter(value=>value.name===parentName).length!==1)return;
      const q=bone.quaternion,maximum=Math.max(Math.abs(q.x),Math.abs(q.y),Math.abs(q.z),Math.abs(q.w));
      if(![q.x,q.y,q.z,q.w].every(Number.isFinite)||!Number.isFinite(maximum)||maximum===0)return;
      const original=q.clone(),base=new Quaternion(q.x/maximum,q.y/maximum,q.z/maximum,q.w/maximum).normalize();
      const half=degrees*Math.PI/360,delta=new Quaternion(0,0,Math.sin(half),Math.cos(half));
      base.multiply(delta).normalize();
      if(![base.x,base.y,base.z,base.w].every(Number.isFinite))return;
      this.snapshots.push({bone,quaternion:original});q.copy(base);result.bones.push(index);
    };
    applyBone(5,'上半身',2,'グルーブ',sample.torso_z_degrees,gates.torso);
    applyBone(9,'頭',8,'首',sample.head_z_degrees,gates.head);
    return result;
  }
}
