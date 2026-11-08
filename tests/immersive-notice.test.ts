import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {ImmersiveNotice} from '../src/ui/ImmersiveNotice';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';

class Element {
  textContent=''; hidden=false; private names=new Set<string>(); private events=new Map<string,()=>void>();
  get className(){return [...this.names].join(' ');} set className(value:string){this.names=new Set(value.split(/\s+/).filter(Boolean));}
  classList={contains:(name:string)=>this.names.has(name),remove:(name:string)=>this.names.delete(name)};
  addEventListener(name:string,fn:()=>void){this.events.set(name,fn);} removeEventListener(name:string,fn:()=>void){if(this.events.get(name)===fn)this.events.delete(name);}
  click(){this.events.get('click')?.();}
}
test('ordinary notices stay quiet, failures retain explicit text details and developer mode never leaks after disable',()=>{
  const nodes=Object.fromEntries(['toast','notice-details','notice-detail-panel','notice-detail-text','notice-detail-close'].map(k=>[k,new Element()]));
  nodes['notice-details'].hidden=true;nodes['notice-detail-panel'].hidden=true;
  const doc={getElementById:(id:string)=>nodes[id]} as unknown as Document;
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;let tick:(()=>void)|undefined;
  globalThis.setTimeout=((fn:()=>void)=>{tick=fn;return 1;}) as typeof setTimeout;
  globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  try {
    const p=new ImmersiveNotice(doc);
    p.publish('内部状态');assert.equal(nodes.toast.textContent,'');assert.equal(nodes['notice-details'].hidden,true);
    const raw='<script>not markup</script> network failure';p.publish(raw,true);
    assert.equal(nodes.toast.textContent,'操作没有完成，可查看详情。');assert.equal(nodes['notice-detail-text'].textContent,raw);
    assert.equal(nodes['notice-details'].hidden,false);assert.equal(nodes['notice-detail-panel'].hidden,true);
    nodes['notice-details'].click();assert.equal(nodes['notice-detail-panel'].hidden,false);
    nodes['notice-detail-close'].click();assert.equal(nodes['notice-detail-panel'].hidden,true);
    tick?.();assert.equal(nodes.toast.classList.contains('show'),false);assert.equal(nodes['notice-details'].hidden,false);
    p.publish('input length diagnostic',true,'消息太长，请缩短后重试。');assert.equal(nodes.toast.textContent,'消息太长，请缩短后重试。');
    p.setDeveloperMode(true);p.publish('调试细节',true);assert.equal(nodes.toast.textContent,'调试细节');
    p.setDeveloperMode(false);assert.equal(nodes.toast.textContent,'操作没有完成，可查看详情。');
    p.setDeveloperMode(true);p.publish('仅诊断');p.setDeveloperMode(false);assert.equal(nodes.toast.classList.contains('show'),false);
    p.dispose();nodes['notice-details'].click();assert.equal(nodes['notice-detail-panel'].hidden,true);assert.equal(nodes['notice-details'].hidden,true);assert.equal(nodes['notice-detail-text'].textContent,'');
  } finally { globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear; }
});

test('actual PetUI developer toggle controls the status visibility class',()=>{
  const source=readFileSync(new URL('../src/ui/PetUI.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('PetUI.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='PetUI');assert.ok(klass&&ts.isClassDeclaration(klass));
  const methods=klass.members.filter(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='setDeveloperMode');assert.equal(methods.length,1);
  const code=transformSync(`class Fixture{${methods[0].getText(ast)}}`,{loader:'ts',target:'es2022'}).code;
  const button={attrs:{} as Record<string,string>,dataset:{} as Record<string,string>,setAttribute(k:string,v:string){this.attrs[k]=v;}};
  const classes=new Set<string>(),old=globalThis.document;
  Object.assign(globalThis,{document:{body:{classList:{toggle:(name:string,enabled:boolean)=>enabled?classes.add(name):classes.delete(name)}},getElementById:()=>button}});
  try{const Ctor=new Function('uiText','uiHtml','uiMarkup','uiTemplate',code+'\nreturn Fixture').bind(null, uiText, uiHtml, uiMarkup, uiTemplate)();const f=new Ctor();f.setDeveloperMode(true);assert.ok(classes.has('developer-mode'));assert.equal(button.attrs['aria-pressed'],'true');f.setDeveloperMode(false);assert.equal(classes.has('developer-mode'),false);assert.equal(button.attrs['aria-pressed'],'false');}
  finally{Object.assign(globalThis,{document:old});}
});

test('pet window in ordinary mode shows no failure notice; the latest one appears once developer mode is on', () => {
  const nodes=Object.fromEntries(['toast','notice-details','notice-detail-panel','notice-detail-text','notice-detail-close'].map(k=>[k,new Element()]));
  nodes['notice-details'].hidden=true;nodes['notice-detail-panel'].hidden=true;
  const doc={getElementById:(id:string)=>nodes[id]} as unknown as Document;
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=(()=>1) as unknown as typeof setTimeout; globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  try {
    const p=new ImmersiveNotice(doc,{quietOrdinaryFailures:true});
    p.publish('first failure',true); p.publish('second failure',true,'连接暂时不可用，请检查服务后重试。');
    assert.equal(nodes.toast.classList.contains('show'),false); assert.equal(nodes.toast.textContent,'');
    assert.equal(nodes['notice-details'].hidden,true);
    p.setDeveloperMode(true);
    assert.equal(nodes.toast.textContent,'second failure'); assert.equal(nodes.toast.classList.contains('show'),true);
    assert.equal(nodes['notice-detail-text'].textContent,'second failure'); assert.equal(nodes['notice-details'].hidden,false);
    p.setDeveloperMode(false);
    assert.equal(nodes.toast.classList.contains('show'),false); assert.equal(nodes['notice-details'].hidden,true);
    p.setDeveloperMode(true); assert.equal(nodes.toast.textContent,'second failure', 'a shown failure is not replayed again');
    p.publishAction('语音需要连接服务，请在“连接与声音”查看设置说明。');
    assert.equal(nodes.toast.textContent,'语音需要连接服务，请在“连接与声音”查看设置说明。');
    // Mood broadcasts re-send ordinary mode all the time; fixed guidance stays up (2026-11-03, camera-refused line).
    p.setDeveloperMode(false); p.setDeveloperMode(false);
    assert.equal(nodes.toast.classList.contains('show'),true);
    assert.equal(nodes.toast.textContent,'语音需要连接服务，请在“连接与声音”查看设置说明。');
    // A failure published in developer mode still goes away when it is turned off.
    p.setDeveloperMode(true); p.publish('third failure',true); p.setDeveloperMode(false);
    assert.equal(nodes.toast.classList.contains('show'),false);
  } finally { globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear; }
});

test('the control window keeps the ordinary failure summary (quiet mode is pet-only)', () => {
  const nodes=Object.fromEntries(['toast','notice-details','notice-detail-panel','notice-detail-text','notice-detail-close'].map(k=>[k,new Element()]));
  const doc={getElementById:(id:string)=>nodes[id]} as unknown as Document;
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=(()=>1) as unknown as typeof setTimeout; globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  try {
    const p=new ImmersiveNotice(doc);
    p.publish('raw',true); assert.equal(nodes.toast.textContent,'操作没有完成，可查看详情。');
  } finally { globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear; }
});
