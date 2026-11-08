import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {MotionTrackCoverageControls} from '../src/ui/MotionTrackCoverage';
import {MotionTrackCoverageHost} from '../electron/motion-track-coverage';
import {MotionWeightControls} from '../src/ui/MotionWeights';
import {stripDefaultVmdTracks,type VmdTrackData} from '../src/stage/vmd-tracks';
import * as filters from '../src/ui/motion-filters';
import * as layers from '../shared/motion-layers';
import type {MotionCatalog} from '../shared/motion-library';
import type {MotionTrackCoverageView} from '../shared/motion-track-coverage';
import gene from '../shared/motion-track-gene-structure.json';

class Element{
  children:Element[]=[];parent:Element|null=null;id='';className='';private textValue='';value='';disabled=false;hidden=false;open=false;
  get textContent():string{return this.textValue+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.textValue=value;this.children=[];}
  attributes:Record<string,string>={};dataset:Record<string,string>={};onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;onchange:(()=>void)|null=null;ontoggle:(()=>void)|null=null;
  constructor(readonly tagName:string){}
  readonly classList={add:(...values:string[])=>{this.className=[...new Set([...this.className.split(' '),...values])].join(' ');},remove:(...values:string[])=>{this.className=this.className.split(' ').filter(v=>!values.includes(v)).join(' ');},toggle:(value:string,on?:boolean)=>{const s=new Set(this.className.split(' ').filter(Boolean));if(on??!s.has(value))s.add(value);else s.delete(value);this.className=[...s].join(' ');return s.has(value);}};
  append(...nodes:Element[]){for(const child of nodes){child.parent=this;this.children.push(child);if(this.tagName==='select'&&!this.value&&child.tagName==='option')this.value=child.value;}}
  replaceChildren(...nodes:Element[]){this.textValue='';this.children=[];this.append(...nodes);}
  setAttribute(key:string,value:string){this.attributes[key]=value;}
  get selectedIndex(){return this.children.findIndex(n=>n.tagName==='option'&&n.value===this.value);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  click(){for(let p:Element|null=this;p;p=p.parent)assert.equal(p.disabled,false);this.onclick?.();}
}
class OptionElement extends Element{constructor(text:string,value:string){super('option');this.textContent=text;this.value=value;}}
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
const find=(root:Element,p:(n:Element)=>boolean)=>{const result=all(root).find(p);assert.ok(result);return result;};
const click=(root:Element,text:string)=>find(root,n=>n.tagName==='button'&&n.textContent===text).click();
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function globals(t:TestContext,api:unknown){for(const[key,value]of Object.entries({document:{createElement:(tag:string)=>new Element(tag)},window:{desktop:api},Option:OptionElement})){
  const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});}}
function catalog(){return{schemaVersion:1,packs:[{id:'gene',name:'Synthetic owned library',source:'synthetic',sourceUrl:'',revision:'f'.repeat(40),license:{id:'synthetic',url:'',attribution:''},documents:[],motions:['first','second'].map((id,i)=>({id,name:id,category:'gesture',tags:[i===0?'head':'right-arm','common'],relativePath:id+'.vmd',originalPath:id,downloadUrl:'',bytes:1,sha256:createHash('sha256').update(new Uint8Array([i+1])).digest('hex'),durationFrames:30,boneFrames:1,morphFrames:0}))}]}as MotionCatalog;}
function host(c:MotionCatalog,modelSha:string|null=gene.modelSha256,boneNames=['右腕','頭']){return new MotionTrackCoverageHost({catalog:c,context:()=> 'host-current',modelIdentity:async()=>modelSha,resolve:async(_pack,id)=>id,read:async file=>new Uint8Array([file==='first'?1:2]),
  parse:bytes=>{const d:VmdTrackData={metadata:{motionCount:1,morphCount:0},motions:[{boneName:boneNames[bytes[0]===1?0:1],frameNum:30,position:[0,.1,0],rotation:[0,0,0,1]}],morphs:[]};const stripped=stripDefaultVmdTracks(d);return{data:stripped.vmd,report:stripped.report};}});}

test('actual complete library caller reads one selected content, filters by known Gene part instead of tags, and compares without playback',async t=>{
  let ui:any;t.after(()=>ui?.dispose());const c=catalog(),backend=host(c,gene.modelSha256,['右腕','右ひじ']),requests:unknown[]=[],listeners:Array<(v:{visible:boolean})=>void>=[];let enabled=0,previewed=0;
  const api={motionTrackCoverageRead:async(request:any)=>{requests.push(structuredClone(request));return backend.read(7,request);},
    onWindowVisibility:(callback:(v:{visible:boolean})=>void)=>{listeners.push(callback);return()=>{listeners.splice(listeners.indexOf(callback),1);};},
    getMotionLibrary:async()=>({directory:'synthetic-source-only',packs:[{id:'gene',installedMotionIds:['first','second'],complete:true,bundled:true}]}),onMotionDownload:()=>()=>{},
    invalidateMotionWeightSelection:async()=>{},readMotionWeights:async()=>{throw Error('No annotation read requested');}};
  globals(t,api);const exports={},context={exports,document:(globalThis as any).document,window:(globalThis as any).window,Option:OptionElement,
    require:(name:string)=>{if(name==='./ui-language')return uiCopy;if(name.endsWith('.css'))return{};if(name.endsWith('motion-catalog.json'))return c;if(name==='./MotionWeights')return{MotionWeightControls};if(name==='./MotionTrackCoverage')return{MotionTrackCoverageControls};if(name==='./motion-filters')return filters;if(name.endsWith('motion-layers'))return layers;throw Error('Unexpected import '+name);}};
  const source=fs.readFileSync(new URL('../src/ui/MotionLibrary.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));
  const root=new Element('div');ui=new(exports as any).MotionLibraryControls(root,{getModel:()=>({path:'synthetic.pmx',url:'synthetic-model',name:'synthetic'}),onEnabled:async()=>{enabled++;},onPreview:async()=>{previewed++;return true;},onStopPreview:async()=>{},onError:(message:string)=>assert.fail(message)});await ui.init();
  assert.equal(requests.length,0,'No background whole-library coverage scan');click(root,'读取当前动作轨道');await flush();assert.equal(requests.length,1);
  assert.ok(all(root).some(n=>n.textContent.includes('非默认静态')));assert.ok(all(root).some(n=>n.textContent.includes('右臂')));
  const structural=find(root,n=>n.attributes['aria-label']==='按已知轨道目标或已核模型部位筛选');structural.value='part:right-arm';structural.onchange?.();
  const selection=find(root,n=>n.id==='motion-select-gene');assert.deepEqual(all(selection).filter(n=>n.tagName==='option').map(n=>n.value),['first'],'Source tag says head; actual weighted Gene arm structure wins');
  assert.ok(all(root).some(n=>n.textContent.includes('其余未评估')));structural.value='all';structural.onchange?.();click(root,'选为比较A');selection.value='second';selection.onchange?.();click(root,'选为比较B');
  find(root,n=>n.tagName==='button'&&n.textContent.startsWith('比较两动作轨道')).click();await flush();assert.equal(requests.length,2);
  assert.ok(all(root).some(n=>n.textContent.includes('未见直接同名重叠，仍不代表可安全组合')));assert.ok(all(root).some(n=>n.textContent.includes('IK/grant')));
  assert.ok(all(root).some(n=>n.tagName==='summary'&&n.textContent.includes('已记录静态结构关系：')));
  assert.ok(all(root).some(n=>n.tagName==='td'&&n.textContent.includes('祖先层级')));
  assert.equal(enabled,0);assert.equal(previewed,0);assert.equal(listeners.length,1);
});

test('real coverage UI ignores late selected/model/hidden/disposed results and keeps requests inert until explicit click',async t=>{
  let ui:MotionTrackCoverageControls|undefined;t.after(()=>ui?.dispose());const c=catalog(),backend=host(c),listeners:Array<(v:{visible:boolean})=>void>=[];let resolve!:(v:MotionTrackCoverageView)=>void,calls=0;
  const api={motionTrackCoverageRead:async()=>{calls++;return new Promise<MotionTrackCoverageView>(yes=>resolve=yes);},onWindowVisibility:(fn:(v:{visible:boolean})=>void)=>{listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1);}};
  globals(t,api);ui=new MotionTrackCoverageControls(c,()=>{},api);const pack=ui.createPack('gene')as unknown as Element;ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);assert.equal(calls,0);
  click(pack,'读取当前动作轨道');ui.selectMotion('gene',c.packs[0].motions[1]);resolve(await backend.read(7,{assets:[{packId:'gene',motionId:'first'}]}));await flush();assert.equal(all(pack).some(n=>n.tagName==='table'),false);
  for(const reason of ['model','hidden','dispose']){ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);click(pack,'读取当前动作轨道');
    if(reason==='model')ui.setModelKey('new');else if(reason==='hidden')listeners[0]({visible:false});else ui.dispose();
    resolve(await backend.read(7,{assets:[{packId:'gene',motionId:'first'}]}));await flush();assert.equal(all(pack).some(n=>n.tagName==='table'),false);}
  assert.equal(listeners.length,0);
});

test('same-URL changed host content identity clears previous known-part cache and visible filter selection',async t=>{
  let ui:MotionTrackCoverageControls|undefined;t.after(()=>ui?.dispose());const c=catalog();let backend=host(c),changed=0;
  const api={motionTrackCoverageRead:(request:any)=>backend.read(7,request),onWindowVisibility:()=>()=>{}};globals(t,api);
  ui=new MotionTrackCoverageControls(c,()=>{changed++;},api);const pack=ui.createPack('gene')as unknown as Element,root=ui.element as unknown as Element;
  ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);click(pack,'读取当前动作轨道');await flush();
  const select=find(root,n=>n.attributes['aria-label']==='按已知轨道目标或已核模型部位筛选');select.value='part:right-arm';select.onchange?.();assert.equal(ui.matches('gene',c.packs[0].motions[0]),true);
  backend=host(c,null);click(pack,'读取当前动作轨道');await flush();assert.equal(select.value,'all');assert.equal(ui.filtering,false);assert.ok(changed>=2);
  select.value='part:right-arm';select.onchange?.();assert.equal(ui.matches('gene',c.packs[0].motions[0]),false);assert.ok(all(root).some(n=>n.textContent.includes('当前模型部位映射未知')));
});

test('recorded relation UI clears old witnesses on same-URL model rebinding and renders the unknown fallback',async t=>{
  const c=catalog();let backend=host(c,gene.modelSha256,['右腕','右ひじ']);
  let ui:MotionTrackCoverageControls|undefined;t.after(()=>ui?.dispose());
  const api={motionTrackCoverageRead:(request:any)=>backend.read(7,request),onWindowVisibility:()=>()=>{}};globals(t,api);
  ui=new MotionTrackCoverageControls(c,()=>{},api);
  const root=ui.element as unknown as Element,pack=ui.createPack('gene')as unknown as Element;root.append(pack);
  ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);click(pack,'选为比较A');
  ui.selectMotion('gene',c.packs[0].motions[1]);click(pack,'选为比较B');
  find(root,n=>n.tagName==='button'&&n.textContent.startsWith('比较两动作轨道')).click();await flush();
  assert.ok(all(root).some(n=>n.tagName==='summary'&&n.textContent.includes('已记录静态结构关系：')));
  backend=host(c,null);click(pack,'读取当前动作轨道');await flush();
  assert.equal(all(root).some(n=>n.tagName==='summary'&&n.textContent.includes('已记录静态结构关系：')),false);
  assert.ok(all(root).some(n=>n.textContent.includes('旧结构关系已清除')));
  find(root,n=>n.tagName==='button'&&n.textContent.startsWith('比较两动作轨道')).click();await flush();
  assert.ok(all(root).some(n=>n.textContent.includes('当前模型结构绑定未知，不能列出已记录静态结构关系')));
  assert.equal(all(root).some(n=>n.tagName==='td'&&n.textContent.includes('祖先层级')),false);
});

test('late relation comparison cannot repaint after slot choice, unavailable source, hide, model change or disposal',async t=>{
  const c=catalog(),response=await host(c,gene.modelSha256,['右腕','右ひじ']).read(7,{assets:[{packId:'gene',motionId:'first'},{packId:'gene',motionId:'second'}]});
  let resume!:(view:MotionTrackCoverageView)=>void;
  const listeners:Array<(view:{visible:boolean})=>void>=[];
  const api={motionTrackCoverageRead:()=>new Promise<MotionTrackCoverageView>(yes=>resume=yes),onWindowVisibility:(fn:(v:{visible:boolean})=>void)=>{listeners.push(fn);return()=>{listeners.splice(listeners.indexOf(fn),1);};}};
  globals(t,api);
  for(const reason of ['slot','unavailable','hidden','model','dispose']){
    const ui=new MotionTrackCoverageControls(c,()=>{},api);t.after(()=>ui.dispose());
    const root=ui.element as unknown as Element,pack=ui.createPack('gene')as unknown as Element;root.append(pack);
    ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);click(pack,'选为比较A');
    ui.selectMotion('gene',c.packs[0].motions[1]);click(pack,'选为比较B');
    find(root,n=>n.tagName==='button'&&n.textContent.startsWith('比较两动作轨道')).click();
    if(reason==='slot')click(pack,'选为比较A');else if(reason==='unavailable')ui.setAvailable('gene',false);
    else if(reason==='hidden')listeners[0]({visible:false});else if(reason==='model')ui.setModelKey('changed');else ui.dispose();
    resume(structuredClone(response));await flush();
    assert.equal(all(root).some(n=>n.tagName==='summary'&&n.textContent.includes('已记录静态结构关系：')),false,reason);
    if(reason==='unavailable')assert.equal(find(root,n=>n.tagName==='button'&&n.textContent.startsWith('比较两动作轨道')).disabled,true);
    ui.dispose();
  }
  assert.equal(listeners.length,0);
});

test('actual library hard exclusion intersects include filters, distinguishes bone/morph and never treats unread as absent',async t=>{
  let ui:any;t.after(()=>ui?.dispose());const c=catalog(),requests:unknown[]=[],listeners:Array<(v:{visible:boolean})=>void>=[];
  let enabled=0,previewed=0;
  const backend=new MotionTrackCoverageHost({catalog:c,context:()=> 'current',modelIdentity:async()=>gene.modelSha256,
    resolve:async(_pack,id)=>id,read:async id=>new Uint8Array([id==='first'?1:2]),parse:bytes=>{
      const data:VmdTrackData={metadata:{motionCount:1,morphCount:bytes[0]===1?1:0},
        motions:[{boneName:bytes[0]===1?'右腕':'頭',frameNum:30,position:[0,.1,0],rotation:[0,0,0,1]}],
        morphs:bytes[0]===1?[{morphName:'頭',frameNum:30,weight:.4}]:[]};
      const stripped=stripDefaultVmdTracks(data);return{data:stripped.vmd,report:stripped.report};}});
  const api={motionTrackCoverageRead:async(request:any)=>{requests.push(structuredClone(request));return backend.read(7,request);},
    onWindowVisibility:(fn:(v:{visible:boolean})=>void)=>{listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1);},
    getMotionLibrary:async()=>({directory:'synthetic-only',packs:[{id:'gene',installedMotionIds:['first','second'],complete:true,bundled:true}]}),onMotionDownload:()=>()=>{},
    invalidateMotionWeightSelection:async()=>{},readMotionWeights:async()=>{throw Error('No weight read requested');}};
  globals(t,api);const exports={},context={exports,document:(globalThis as any).document,window:(globalThis as any).window,Option:OptionElement,
    require:(name:string)=>{if(name==='./ui-language')return uiCopy;if(name.endsWith('.css'))return{};if(name.endsWith('motion-catalog.json'))return c;if(name==='./MotionWeights')return{MotionWeightControls};if(name==='./MotionTrackCoverage')return{MotionTrackCoverageControls};if(name==='./motion-filters')return filters;if(name.endsWith('motion-layers'))return layers;throw Error('Unexpected import '+name);}};
  const source=fs.readFileSync(new URL('../src/ui/MotionLibrary.ts',import.meta.url),'utf8');vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));
  const root=new Element('div');ui=new(exports as any).MotionLibraryControls(root,{getModel:()=>({path:'synthetic',url:'synthetic',name:'synthetic'}),onEnabled:async()=>{enabled++;},onPreview:async()=>{previewed++;return true;},onStopPreview:async()=>{},onError:(message:string)=>assert.fail(message)});await ui.init();
  const select=find(root,n=>n.id==='motion-select-gene'),include=find(root,n=>n.attributes['aria-label']==='按已知轨道目标或已核模型部位筛选'),exclude=find(root,n=>n.attributes['aria-label']==='排除已读源目标或已核部位');
  const values=()=>all(select).filter(n=>n.tagName==='option').map(n=>n.value);
  assert.equal(exclude.value,'none');assert.deepEqual(values(),['first','second']);assert.equal(requests.length,0);
  click(root,'读取当前动作轨道');await flush();exclude.value=JSON.stringify(['bone','右腕']);exclude.onchange?.();assert.deepEqual(values(),[],'Unread second cannot prove absence');
  exclude.value='none';exclude.onchange?.();select.value='second';select.onchange?.();click(root,'读取当前动作轨道');await flush();
  exclude.value=JSON.stringify(['bone','頭']);exclude.onchange?.();assert.deepEqual(values(),['first'],'Same-named morph is not a bone track');
  include.value='part:head';include.onchange?.();assert.deepEqual(values(),[],'Positive and exclusion conditions both apply');
  include.value='all';include.onchange?.();exclude.value=JSON.stringify(['morph','頭']);exclude.onchange?.();assert.deepEqual(values(),['second']);
  exclude.value='none';exclude.onchange?.();assert.deepEqual(values(),['first','second']);assert.equal(requests.length,2);
  assert.equal(enabled,0);assert.equal(previewed,0);
});

test('exclusion clears with model/hide identity and late reads cannot restore stale absence proof',async t=>{
  let ui:MotionTrackCoverageControls|undefined;t.after(()=>ui?.dispose());const c=catalog();let backend=host(c),resume!:(view:MotionTrackCoverageView)=>void,defer=false;
  const listeners:Array<(v:{visible:boolean})=>void>=[],api={motionTrackCoverageRead:(request:any)=>defer?new Promise<MotionTrackCoverageView>(yes=>resume=yes):backend.read(7,request),
    onWindowVisibility:(fn:(v:{visible:boolean})=>void)=>{listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1);}};
  globals(t,api);ui=new MotionTrackCoverageControls(c,()=>{},api);const root=ui.element as unknown as Element,pack=ui.createPack('gene')as unknown as Element;root.append(pack);
  ui.selectMotion('gene',c.packs[0].motions[0]);ui.setAvailable('gene',true);click(pack,'读取当前动作轨道');await flush();
  const exclude=find(root,n=>n.attributes['aria-label']==='排除已读源目标或已核部位');exclude.value='part:head';exclude.onchange?.();assert.equal(ui.matches('gene',c.packs[0].motions[0]),true);
  assert.equal(ui.matches('gene',{...c.packs[0].motions[0],sha256:'0'.repeat(64)}),false,'Current content identity is mandatory');
  backend=host(c,null);click(pack,'读取当前动作轨道');await flush();assert.equal(exclude.value,'none');
  exclude.value='part:head';exclude.onchange?.();assert.equal(ui.matches('gene',c.packs[0].motions[0]),false,'Unknown anatomy cannot prove no head');
  defer=true;click(pack,'读取当前动作轨道');ui.setModelKey('new');resume(await backend.read(7,{assets:[{packId:'gene',motionId:'first'}]}));await flush();
  assert.equal(exclude.value,'none');assert.equal(ui.filtering,false);assert.equal(all(exclude).some(n=>n.value===JSON.stringify(['bone','右腕'])),false);
  defer=false;backend=host(c);ui.setAvailable('gene',true);click(pack,'读取当前动作轨道');await flush();exclude.value='part:head';exclude.onchange?.();listeners[0]({visible:false});
  assert.equal(exclude.value,'none');assert.equal(ui.filtering,false);
});
