import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {ImmersiveNotice} from '../src/ui/ImmersiveNotice';

class Element {
  textContent=''; hidden=false; private names=new Set<string>(); private events=new Map<string,()=>void>();
  set className(value:string){this.names=new Set(value.split(/\s+/).filter(Boolean));}
  classList={contains:(name:string)=>this.names.has(name),remove:(name:string)=>this.names.delete(name)};
  addEventListener(name:string,fn:()=>void){this.events.set(name,fn);} removeEventListener(name:string,fn:()=>void){if(this.events.get(name)===fn)this.events.delete(name);}
  click(){this.events.get('click')?.();}
}
test('fixed action guidance survives mode change, expires, and does not invent an error',()=>{
  const n=Object.fromEntries(['toast','notice-details','notice-detail-panel','notice-detail-text','notice-detail-close'].map(k=>[k,new Element()]));
  n['notice-details'].hidden=true;n['notice-detail-panel'].hidden=true;
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;let tick:(()=>void)|undefined;let delay=0;let clears=0;
  globalThis.setTimeout=((fn:()=>void,ms:number)=>{tick=fn;delay=ms;return 1;}) as typeof setTimeout;
  globalThis.clearTimeout=(()=>{clears++;}) as typeof clearTimeout;
  try {
    const p=new ImmersiveNotice({getElementById:(id:string)=>n[id]} as unknown as Document);
    p.publishAction('请先连接语音服务。');
    assert.equal(n.toast.textContent,'请先连接语音服务。');assert.equal(n.toast.classList.contains('show'),true);assert.equal(n.toast.classList.contains('error'),false);assert.equal(n['notice-details'].hidden,true);assert.equal(delay,4000);
    p.setDeveloperMode(true);p.setDeveloperMode(false);assert.equal(n.toast.classList.contains('show'),true);
    p.publishAction('x'.repeat(161));p.publishAction('   ');assert.equal(n.toast.textContent,'请先连接语音服务。');
    tick?.();assert.equal(n.toast.classList.contains('show'),false);
    p.publish('原始故障',true);p.publishAction('请检查设置。');assert.equal(n.toast.classList.contains('error'),false);assert.equal(n['notice-detail-text'].textContent,'原始故障');
    p.setDeveloperMode(true);p.setDeveloperMode(false);assert.equal(n.toast.textContent,'请检查设置。');
    p.dispose();assert.equal(n.toast.textContent,'');assert.equal(n.toast.classList.contains('show'),false);assert.ok(clears>=3);
  } finally {globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
