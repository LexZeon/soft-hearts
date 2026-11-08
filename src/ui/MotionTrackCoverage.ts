import { uiText, uiTemplate } from './ui-language';
import type { CatalogMotion, MotionCatalog, MotionPackId } from '../../shared/motion-library';
import { matchesMotionTrackFilter, passesMotionTrackExclusion, motionTrackKey, MOTION_STRUCTURE_PARTS,
  type MotionTrackAssetId, type MotionTrackCoverage, type MotionTrackCoverageView, type MotionTrackFilter, type MotionTrackExclusion } from '../../shared/motion-track-coverage';

const partLabels = { head:'头', neck:'颈', 'left-arm':'左臂', 'right-arm':'右臂', torso:'躯干／根', legs:'下肢', 'eyes-brows':'眉眼', mouth:'口' };
const kindLabels = { position:'位置 position', quaternion:'旋转 quaternion', morph:'morph权重' };
const stateLabels = { dynamic:'动态', 'static-default':'默认静态（同骨轨仍占用）', 'static-nondefault':'非默认静态 · 占用' };
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text=''):HTMLElementTagNameMap[K]{const n=document.createElement(tag);n.textContent=text;return n;}
interface PackView { element:HTMLElement; read:HTMLButtonElement; a:HTMLButtonElement; b:HTMLButtonElement; output:HTMLElement; motion:CatalogMotion|null; available:boolean; serial:number; reading:boolean; }
interface Ports {
  motionTrackCoverageRead(request:{assets:MotionTrackAssetId[]}):Promise<MotionTrackCoverageView>;
  onWindowVisibility(callback:(view:{visible:boolean})=>void):()=>void;
}
/** Readonly inspection UI. No preview, playback, settings save, asset URL or model parsing. */
export class MotionTrackCoverageControls {
  readonly element=node('section');
  private readonly select=node('select');
  private readonly exclude=node('select');
  private readonly status=node('p');
  private readonly compare=node('button',uiText('比较两动作轨道'));
  private readonly comparison=node('div');
  private readonly packs=new Map<MotionPackId,PackView>();
  private readonly cache=new Map<string,MotionTrackCoverage>();
  private filter:MotionTrackFilter={kind:'all'};
  private exclusion:MotionTrackExclusion={kind:'none'};
  private a:MotionTrackAssetId|null=null;
  private b:MotionTrackAssetId|null=null;
  private epoch=0;
  private compareSerial=0;
  private disposed=false;
  private modelKey='';
  private hostContextId:string|null=null;
  private readonly unsubscribe:()=>void;
  constructor(private readonly catalog:MotionCatalog,private readonly changed:()=>void,private readonly api:Ports=window.desktop){
    this.element.className='motion-track-coverage';this.element.setAttribute('aria-label',uiText('动作结构覆盖'));
    const title=node('h4',uiText('结构覆盖 · 只读轨道事实')),hint=node('p',uiText('文件骨骼／morph目标名不是已核模型部位；含右臂轨道不表示已提取只动右臂的片段。只有主动读取的动作参与结构筛选，不后台扫描全库。'));
    const label=node('label',uiText('显式结构筛选'));label.append(this.select);this.select.setAttribute('aria-label',uiText('按已知轨道目标或已核模型部位筛选'));
    this.select.onchange=()=>{const raw=this.select.value;if(raw==='all')this.filter={kind:'all'};
      else if(raw.startsWith('part:'))this.filter={kind:'part',part:raw.slice(5)as typeof MOTION_STRUCTURE_PARTS[number]};
      else {const choice=this.targets().find(row=>row.value===raw);if(!choice)return;this.filter={kind:'target',target:choice.target,channel:choice.channel};}
      this.changed();this.updateSummary();};
    const excludeLabel=node('label',uiText('硬排除轨道（与上方筛选同时满足）'));excludeLabel.append(this.exclude);this.exclude.setAttribute('aria-label',uiText('排除已读源目标或已核部位'));
    this.exclude.onchange=()=>{const raw=this.exclude.value;if(raw==='none')this.exclusion={kind:'none'};
      else if(raw.startsWith('part:')){const part=raw.slice(5)as typeof MOTION_STRUCTURE_PARTS[number];if(!MOTION_STRUCTURE_PARTS.includes(part))return;this.exclusion={kind:'part',part};}
      else{const choice=this.targets().find(row=>row.value===raw);if(!choice)return;this.exclusion={kind:'target',target:choice.target,channel:choice.channel};}
      this.changed();this.updateSummary();};
    this.compare.type='button';this.compare.onclick=()=>{void this.compareSelected();};this.status.setAttribute('role','status');this.comparison.setAttribute('role','status');
    this.element.append(title,hint,label,excludeLabel,this.status,this.compare,this.comparison);this.rebuildFilters();this.updateSummary();
    this.unsubscribe=api.onWindowVisibility(view=>{if(!view.visible)this.invalidate();});
  }
  get filtering():boolean{return this.filter.kind!=='all'||this.exclusion.kind!=='none';}
  matches(packId:MotionPackId,motion:CatalogMotion):boolean{
    if(!this.filtering)return true;const fact=this.cache.get(motionTrackKey({packId,motionId:motion.id}));
    return !!fact&&fact.sha256===motion.sha256&&matchesMotionTrackFilter(fact,this.filter)&&passesMotionTrackExclusion(fact,this.exclusion);
  }
  createPack(packId:MotionPackId):HTMLElement{
    const root=node('div');root.className='motion-track-pack';const read=node('button',uiText('读取当前动作轨道')),a=node('button',uiText('选为比较A')),b=node('button',uiText('选为比较B')),output=node('div');
    for(const button of [read,a,b])button.type='button';root.append(read,a,b,output);
    const pack:PackView={element:root,read,a,b,output,motion:null,available:false,serial:0,reading:false};this.packs.set(packId,pack);
    read.onclick=()=>{void this.read(packId,pack);};a.onclick=()=>this.chooseComparison('a',packId,pack);b.onclick=()=>this.chooseComparison('b',packId,pack);
    this.setAvailable(packId,false);return root;
  }
  selectMotion(packId:MotionPackId,motion:CatalogMotion|null):void{
    const pack=this.packs.get(packId);if(!pack)return;
    if(pack.motion?.id!==motion?.id||pack.motion?.sha256!==motion?.sha256){pack.serial++;pack.reading=false;pack.motion=motion;pack.output.replaceChildren();}
  }
  setAvailable(packId:MotionPackId,value:boolean):void{const pack=this.packs.get(packId);if(!pack)return;pack.available=value;
    if(!value){pack.serial++;pack.reading=false;
      if(this.a?.packId===packId||this.b?.packId===packId){this.compareSerial++;if(this.a?.packId===packId)this.a=null;if(this.b?.packId===packId)this.b=null;
        this.comparison.textContent=uiText('动作来源当前不可用，请重新选择比较；不改变播放。');this.updateSummary();}}for(const button of [pack.read,pack.a,pack.b])button.disabled=!value||!pack.motion;pack.read.disabled ||= pack.reading;}
  setModelKey(value:string):void{if(value!==this.modelKey){this.modelKey=value;this.invalidate();}}
  private invalidate():void{if(this.disposed)return;const filtered=this.filtering;this.epoch++;this.compareSerial++;this.cache.clear();this.hostContextId=null;this.a=this.b=null;this.filter={kind:'all'};this.select.value='all';this.exclusion={kind:'none'};this.exclude.value='none';
    for(const pack of this.packs.values()){pack.serial++;pack.reading=false;pack.output.replaceChildren();}this.comparison.textContent=uiText('窗口或模型作用域已变化，请重新读取；不改变播放。');this.rebuildFilters();this.updateSummary();if(filtered)this.changed();}
  dispose():void{if(this.disposed)return;this.invalidate();this.disposed=true;this.unsubscribe();this.packs.clear();this.element.replaceChildren();}
  private targets(){const rows=new Map<string,{value:string;target:string;channel:'bone'|'morph'}>();for(const fact of this.cache.values())for(const p of fact.properties){const channel=p.kind==='morph'?'morph':'bone',value=JSON.stringify([channel,p.target]);rows.set(value,{value,target:p.target,channel});}return[...rows.values()].sort((a,b)=>a.value.localeCompare(b.value));}
  private rebuildFilters():void{const before=this.select.value;this.select.replaceChildren(new Option(uiText('全部动作（原筛选不变）'),'all'));
    for(const part of MOTION_STRUCTURE_PARTS)this.select.append(new Option(uiText('已核模型部位：')+uiText(partLabels[part])+uiText('（未知映射不匹配）'),'part:'+part));
    for(const row of this.targets())this.select.append(new Option((row.channel==='bone'?uiText('VMD骨目标：'):uiText('VMD morph目标：'))+row.target,row.value));
    this.select.value=before||'all';if(this.select.selectedIndex<0){this.select.value='all';this.filter={kind:'all'};}
    const oldExclude=this.exclude.value;this.exclude.replaceChildren(new Option(uiText('不排除轨道（原筛选不变）'),'none'));
    for(const part of MOTION_STRUCTURE_PARTS)this.exclude.append(new Option(uiText('排除已核源部位：')+uiText(partLabels[part])+uiText('（部位未知不证不含）'),'part:'+part));
    for(const row of this.targets())this.exclude.append(new Option((row.channel==='bone'?uiText('排除VMD骨目标：'):uiText('排除VMD morph目标：'))+row.target,row.value));
    this.exclude.value=oldExclude||'none';if(this.exclude.selectedIndex<0){this.exclude.value='none';this.exclusion={kind:'none'};}}
  private updateSummary():void{const total=this.catalog.packs.reduce((n,p)=>n+p.motions.length,0),known=[...this.cache.values()].some(f=>f.modelMapping==='verified-public-gene');this.status.textContent=uiTemplate`已主动读取${this.cache.size}个内容版本；其余未评估，不作“不包含”判断。${known?uiText('当前固定Gene内容已核头／颈／双臂／躯干根／下肢结构；眉眼口morph部位未核。'):uiText('当前模型部位映射未知，回退到VMD源目标。')}骨链及IK/grant组合依赖闭包仍未知。${this.filtering?uiText('仅匹配已读、已知结构事实；unknown不虚签。'):uiText('精确AND及七维权重保持原语义。')}目录共${total}项。硬排除按播放器完整保留的轨道判断；已省略全默认骨轨／全零morph，非默认静态仍占用。部位未知不证不含。`;
    this.compare.disabled=!this.a||!this.b;this.compare.textContent=uiTemplate`比较两动作轨道（A：${this.a?.motionId??uiText('未选')}；B：${this.b?.motionId??uiText('未选')}）`;}
  private validate(view:MotionTrackCoverageView,ids:MotionTrackAssetId[]):void{if(!view||view.assets.length!==ids.length)throw Error(uiText('轨道回执不匹配。'));
    ids.forEach((id,i)=>{const fact=view.assets[i],motion=this.catalog.packs.find(p=>p.id===id.packId)?.motions.find(m=>m.id===id.motionId);
      if(!motion||motionTrackKey(fact.asset)!==motionTrackKey(id)||fact.sha256!==motion.sha256)throw Error(uiText('动作版本已变化，请重新读取。'));});}
  private remember(view:MotionTrackCoverageView):void{const changedContext=this.hostContextId!==null&&this.hostContextId!==view.contextId,filtered=this.filtering;
    if(changedContext){this.cache.clear();this.filter={kind:'all'};this.select.value='all';this.exclusion={kind:'none'};this.exclude.value='none';this.compareSerial++;
      this.comparison.textContent=uiText('当前模型内容身份已变化，旧结构关系已清除；请重新比较。');}this.hostContextId=view.contextId;
    for(const fact of view.assets){const key=motionTrackKey(fact.asset);this.cache.delete(key);this.cache.set(key,structuredClone(fact));if(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);}this.rebuildFilters();this.updateSummary();if(filtered||this.filtering)this.changed();}
  private show(pack:PackView,fact:MotionTrackCoverage):void{
    const details=node('details'),summary=node('summary',uiTemplate`${fact.properties.length}条属性 · 原骨／morph时长${(fact.durationFrames/30).toFixed(2)}秒 · 内容${fact.sha256.slice(0,12)}`);
    details.append(summary,node('p',uiTemplate`仅内存省略${fact.removedDefaultBones}条全默认骨轨、${fact.removedZeroMorphs}条全零morph；原文件不改。${fact.modelMapping==='verified-public-gene'?uiText('按固定内容Gene结构核索引；部位仅限已核子集。'):uiText('当前模型部位映射未知。')}非默认静态属性仍占用。`));
    const table=node('table'),header=node('tr');for(const label of [uiText('文件目标'),uiText('属性'),uiText('关键帧'),uiText('状态'),uiText('PMX结构索引／已核部位')])header.append(node('th',label));table.append(header);
    for(const property of fact.properties.slice(0,256)){const row=node('tr');for(const text of [property.target,uiText(kindLabels[property.kind]),String(property.keyframes),uiText(stateLabels[property.state]),`${property.modelIndex??uiText('未知')} / ${property.part?uiText(partLabels[property.part]):uiText('未知')}`])row.append(node('td',text));table.append(row);}details.append(table);
    if(fact.properties.length>256)details.append(node('p',uiText('详情显示前256条；筛选与对比使用完整有界属性集。')));pack.output.replaceChildren(details);
  }
  private async read(packId:MotionPackId,pack:PackView):Promise<void>{const motion=pack.motion;if(!motion||!pack.available||this.disposed)return;
    const id={packId,motionId:motion.id},serial=++pack.serial,epoch=this.epoch;pack.reading=true;pack.read.disabled=true;pack.output.textContent=uiText('正在校验当前内容并读取轨道…');
    try{const view=await this.api.motionTrackCoverageRead({assets:[id]});if(this.disposed||epoch!==this.epoch||serial!==pack.serial||pack.motion!==motion)return;
      this.validate(view,[id]);this.remember(view);this.show(pack,view.assets[0]);}
    catch(error){if(!this.disposed&&epoch===this.epoch&&serial===pack.serial)pack.output.textContent=String(error);}
    finally{if(!this.disposed&&epoch===this.epoch&&serial===pack.serial){pack.reading=false;pack.read.disabled=!pack.available;}}}
  private showComparison(view:MotionTrackCoverageView):void {
    const overlap=view.directOverlap.map(row=>row.target+' · '+row.kind).join('；');
    this.comparison.replaceChildren(node('p',uiTemplate`文件同名属性重叠：${view.directOverlap.length}项；当前已核模型索引重叠：${view.assets.every(a=>a.modelMapping==='verified-public-gene')?view.modelOverlap.length:uiText('未知')}。${overlap} 父子骨链、IK/grant动态组合耦合闭包未知；${view.directOverlap.length?uiText('存在直接文件属性重叠。'):uiText('未见直接同名重叠，仍不代表可安全组合。')}组合效果未验证，不提取片段或生成mask。`));
    const facts=view.recordedRelations;
    if(!facts||facts.status!=='recorded-public-gene'){this.comparison.append(node('p',uiText('当前模型结构绑定未知，不能列出已记录静态结构关系。')));return;}
    if(!view.assets.every(a=>a.modelMapping==='verified-public-gene'&&a.modelSha256===facts.modelSha256))throw Error(uiText('结构关系的模型内容身份不一致。'));
    const details=node('details'),summary=node('summary',uiTemplate`已记录静态结构关系：${facts.total}条（祖先${facts.counts.ancestor}、grant${facts.counts.grant}、同IK记录${facts.counts.ik}）`);
    details.append(summary,node('p',uiTemplate`仅固定Gene源索引记录，不读取当前求解器状态；A/B尚未覆盖的morph或未绑定属性：${facts.unresolvedProperties[0]}/${facts.unresolvedProperties[1]}条。${facts.total?uiText('这些关联不判定当前实际影响或能否组合。'):uiText('未见这些已记录关系，仍不表示没有动态耦合。')}`));
    const table=node('table'),header=node('tr');for(const title of [uiText('A骨／属性'),uiText('已记录关系'),uiText('B骨／属性'),uiText('源索引见证')])header.append(node('th',title));table.append(header);
    for(const relation of facts.rows.slice(0,64)){const row=node('tr'),label=relation.kind==='ancestor'?uiText('祖先层级'):relation.kind==='grant'?uiText('显式grant'):uiText('同IK记录'),direction=relation.direction==='a-to-b'?'A→B':relation.direction==='b-to-a'?'B→A':uiText('共享记录');
      for(const text of [`${relation.a.target} #${relation.a.index} · ${relation.a.properties.join('/')}`,label+' '+direction,`${relation.b.target} #${relation.b.index} · ${relation.b.properties.join('/')}`,relation.kind==='ik'?uiTemplate`IK控制骨 #${relation.via}`:relation.chain.map(index=>'#'+index).join(' → ')])row.append(node('td',text));table.append(row);}
    details.append(table);if(facts.truncated)details.append(node('p',uiText('仅显示前64条已记录关系；总数仍为完整有界索引比较结果，不能据隐藏条目推断无关联。')));this.comparison.append(details);
  }
  private chooseComparison(slot:'a'|'b',packId:MotionPackId,pack:PackView):void{if(!pack.motion||!pack.available)return;this.compareSerial++;this[slot]={packId,motionId:pack.motion.id};this.comparison.textContent=uiText('只比较文件属性，不启用或预览动作。');this.updateSummary();}
  private async compareSelected():Promise<void>{if(!this.a||!this.b||this.disposed)return;const ids=[{...this.a},{...this.b}],serial=++this.compareSerial,epoch=this.epoch;this.compare.disabled=true;this.comparison.textContent=uiText('正在核对两份当前内容…');
    try{const view=await this.api.motionTrackCoverageRead({assets:ids});if(this.disposed||epoch!==this.epoch||serial!==this.compareSerial)return;this.validate(view,ids);this.remember(view);
      this.showComparison(view);}
    catch(error){if(!this.disposed&&epoch===this.epoch&&serial===this.compareSerial)this.comparison.textContent=String(error);}
    finally{if(!this.disposed&&epoch===this.epoch&&serial===this.compareSerial)this.updateSummary();}}
}
