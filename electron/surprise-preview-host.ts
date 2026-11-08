import {randomUUID} from 'node:crypto';
import {SURPRISE_CLIP_ID as CLIP,SHY_CLIP_ID,SHY_REVISION,SURPRISE_MODEL_SHA as GENE_SHA,type SurprisePreviewGrant,type ManualEmotionRecipe} from '../shared/surprise-preview';

type Context={modelKey:string;modelUrl:string;visible:boolean};
type Dependencies={context(owner:number):Context|null;verifyTarget():Promise<boolean>;cancelled?:(owner:number,id:string)=>void;now?:()=>number};
type Lease={owner:number;contextKey:string;view:SurprisePreviewGrant;stageGeneration:number|null};

/** One explicit, controls-owner-scoped host lease; renderer chooses only a closed recipe. */
export class SurprisePreviewHost {
  private serial=0;
  private lease:Lease|null=null;
  private pendingOwner:number|null=null;
  private readonly now:()=>number;
  constructor(private readonly deps:Dependencies){this.now=deps.now??Date.now;}
  async begin(owner:number,recipe:ManualEmotionRecipe='surprise'):Promise<SurprisePreviewGrant>{
    if(recipe!=='surprise'&&recipe!=='shy')throw Error('试作类型不正确。');
    const old=this.lease,serial=++this.serial;this.lease=null;this.pendingOwner=owner;
    if(old)try{this.deps.cancelled?.(old.owner,old.view.id);}catch{/* Old lease is already revoked. */}
    try {
      const context=this.deps.context(owner);
      if(!context?.visible||!context.modelKey||!context.modelUrl)throw Error('请先显示模型预览。');
      const verified=await this.deps.verifyTarget(),current=this.deps.context(owner);
      if(!verified||serial!==this.serial||!current?.visible||current.modelKey!==context.modelKey||current.modelUrl!==context.modelUrl)throw Error('当前预览模型不支持惊喜试作，或模型已经改变。');
      const identity=recipe==='shy'?{clipId:SHY_CLIP_ID,revision:SHY_REVISION} as const:{clipId:CLIP,revision:2} as const;
      const view:SurprisePreviewGrant={id:randomUUID(),...identity,targetModelSha:GENE_SHA,modelUrl:context.modelUrl,expiresAt:this.now()+10_000};
      this.lease={owner,contextKey:context.modelKey,view,stageGeneration:null};return {...view};
    } finally {if(this.serial===serial)this.pendingOwner=null;}
  }
  resolve(owner:number,id:unknown,stageGeneration:unknown):SurprisePreviewGrant {
    const lease=this.lease,context=this.deps.context(owner);
    if(!lease||lease.owner!==owner||id!==lease.view.id||!Number.isSafeInteger(stageGeneration)||Number(stageGeneration)<1
      ||!context?.visible||context.modelKey!==lease.contextKey||context.modelUrl!==lease.view.modelUrl||lease.view.expiresAt<=this.now()
      ||lease.stageGeneration!==null&&lease.stageGeneration!==stageGeneration)throw Error('惊喜预览已失效。');
    lease.stageGeneration=stageGeneration as number;return {...lease.view};
  }
  stop(owner:number,id?:unknown):void {
    if(id!==undefined&&(!this.lease||this.lease.owner!==owner||this.lease.view.id!==id))return;
    if((this.lease&&this.lease.owner!==owner)||(this.pendingOwner!==null&&this.pendingOwner!==owner))return;
    const old=this.lease;this.serial++;this.lease=null;this.pendingOwner=null;
    if(old)try{this.deps.cancelled?.(old.owner,old.view.id);}catch{/* A closed window cannot retain the lease. */}
  }
  invalidate():void{const old=this.lease;this.serial++;this.lease=null;this.pendingOwner=null;if(old)try{this.deps.cancelled?.(old.owner,old.view.id);}catch{/* Lease remains revoked. */}}
}
