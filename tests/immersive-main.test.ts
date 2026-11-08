import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {transformSync} from 'esbuild';
import {conciseFailure,NOTICE_ACTIONS} from '../src/notice-policy';
const text=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',text,ts.ScriptTarget.Latest,true);
function declarations(names:string[]):string{return names.map(name=>{const list=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(list.length,1,name);return list[0].getText(ast);}).join('\n');}
function context(values:Record<string,any>,names:string[]):Record<string,any>{vm.createContext(Object.assign(values, { uiText, uiHtml, uiMarkup, uiTemplate }));vm.runInContext(transformSync(declarations(names),{loader:'ts',target:'es2022'}).code,values);return values;}
test('actual early notice keeps bounded errors for details and accepts only fixed action summaries',()=>{
  const calls:any[]=[];class Presenter{constructor(_:unknown){}dispose(){}setDeveloperMode(v:boolean){calls.push(['mode',v]);}publish(...v:unknown[]){calls.push(['publish',...v]);}publishAction(v:string){calls.push(['action',v]);}}
  const c=context({immersiveNotice:null,immersiveDeveloperMode:false,pendingNotice:null,ImmersiveNotice:Presenter,document:{},isPet:false,conciseFailure,NOTICE_ACTIONS},['notify','mountImmersiveNotice','displayFailure']);
  const raw='Error invoking remote method: TypeError fetch failed https://example.invalid/private';
  c.notify(raw,true);c.notify('routine provider status');c.mountImmersiveNotice();
  const published=calls.find(v=>v[0]==='publish');assert.equal(published[1],raw);assert.equal(published[3],conciseFailure(raw));
  assert.equal(c.displayFailure(raw),conciseFailure(raw,'chat'));assert.ok(!c.displayFailure(raw).includes('example.invalid'));
  c.notify('untrusted dynamic text',false,'voice-setup');assert.deepEqual(calls.at(-1),['action',NOTICE_ACTIONS['voice-setup']]);
  c.immersiveDeveloperMode=true;assert.equal(c.displayFailure(raw),raw);assert.equal(c.displayFailure('x'.repeat(5000)).length,4000);
});
test('actual stage status restores diagnostics only when developer mode is selected',()=>{
  const calls:any[]=[];const c=context({immersiveDeveloperMode:false,lastStageStatus:'',isPet:false,text:(...v:unknown[])=>calls.push(v)},['updateStageStatus']);
  const raw='VMD 播放中 · 身体 / 手势 / 表情独立';c.updateStageStatus(raw);assert.deepEqual(calls.at(-1),['stage-status','模型已就绪']);
  c.immersiveDeveloperMode=true;c.updateStageStatus(c.lastStageStatus);assert.deepEqual(calls.at(-1),['stage-status',raw]);
  c.immersiveDeveloperMode=false;c.updateStageStatus('GPU diagnostic raw');assert.deepEqual(calls.at(-1),['stage-status','']);
});
test('actual startup failure has reachable retry/details and never places raw errors in markup or destroys an initialized view',()=>{
  for(const mounted of [false,true]){
    const nodes=new Map(['startup-retry','startup-controls','startup-quit'].map(id=>[id,{onclick:null as null|(()=>void)}]));
    let html='existing scene',appends=0,published:any,opened=0,quits=0,retries=0;
    const raw='<img src=x onerror=alert(1)>\nTypeError credential information';
    const app={get innerHTML(){return html;},set innerHTML(v:string){html=v;},insertAdjacentHTML(position:string,value:string){assert.equal(position,'afterbegin');appends++;assert.ok(!value.includes(raw));}};
    const presenter={publish:(...values:unknown[])=>published=values};
    const c=context({app,document:{getElementById:(id:string)=>id==='notice-details'&&mounted?{}:null},
      immersiveNotice:null,mountImmersiveNotice(){c.immersiveNotice=presenter;},conciseFailure,
      $:(id:string)=>nodes.get(id),location:{reload:()=>retries++},notify:()=>{},
      window:{desktop:{openControls:async()=>{opened++;},quit:async()=>{quits++;}}},
    },['showStartupFailure']);
    c.showStartupFailure(raw);assert.equal(published[0],raw);assert.equal(published[1],true);assert.equal(published[2],conciseFailure(raw,'startup'));
    assert.ok(!html.includes(raw));assert.equal(appends,mounted?1:0);if(mounted)assert.equal(html,'existing scene');else assert.ok(html.includes('notice-details'));
    assert.equal(opened+quits+retries,0,'presentation never performs recovery automatically');nodes.get('startup-retry')!.onclick!();assert.equal(retries,1);
  }
});
