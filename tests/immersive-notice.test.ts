import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {ImmersiveNotice} from '../src/stage/ImmersiveNotice';
import { installPetWindow } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { PetUI, renderPet } from '../src/stage/PetUI'; // no-pet-ok: the existing file and class names

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

// 2026-11-22 (I-190): drives the real class on the fake companion window instead of evaluating a slice of its source (the toolbar's buttons
// moved to src/stage/companion-toolbar.ts).
test('actual PetUI developer toggle controls the status visibility class', t => { // no-pet-ok: the existing class name
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // no-pet-ok: the existing helper's and host calls' names
  const dom = installPetWindow(t, { openControls: async () => {}, updatePetReply: async () => undefined, setPetWindowOperation: async () => undefined });
  renderPet(dom.app as unknown as HTMLElement); // no-pet-ok: the existing function name
  const ui = new PetUI({ edit() {}, feature() {}, send() {}, stop() {}, error: message => { throw Error(message); }, // no-pet-ok: the existing class name
    popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } } });
  dom.beforeClose(() => ui.dispose());
  const button = dom.byId('pet-developer-mode'); // no-pet-ok: an existing element id
  ui.setDeveloperMode(true);
  assert.ok(dom.document.body.classList.contains('developer-mode')); assert.equal(button.getAttribute('aria-pressed'), 'true');
  ui.setDeveloperMode(false);
  assert.equal(dom.document.body.classList.contains('developer-mode'), false); assert.equal(button.getAttribute('aria-pressed'), 'false');
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
