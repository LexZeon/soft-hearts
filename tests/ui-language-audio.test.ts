import test from 'node:test';
import assert from 'node:assert/strict';
import {setUiLanguage} from '../shared/ui-language';
import {ListenTogetherSwitch} from '../src/ui/ListenTogetherSwitch';
import {AmbientAudioControls} from '../src/ui/AmbientAudio';
import {AudioReadingHostBroker} from '../electron/audio-reading-host-broker';

class Element {
 textContent='';className='';hidden=false;disabled=false;type='';id='';checked=false;dataset:Record<string,string>={};
 children:Element[]=[];attributes:Record<string,string>={};onclick:(()=>void)|null=null;
 constructor(public tagName:string){}
 append(...children:Element[]){this.children.push(...children);}
 setAttribute(key:string,value:string){this.attributes[key]=value;}
 focus(){}remove(){}
}
const all=(node:Element):Element[]=>[node,...node.children.flatMap(all)];

test('actual English audio purposes remain default off and opening their panel creates no capture request',()=>{
 const previous=globalThis.document,calls:string[]=[];
 globalThis.document={createElement:(tag:string)=>new Element(tag)} as unknown as Document;
 setUiLanguage('en');
 try{
  const root=new Element('div');
  const panel=new AmbientAudioControls(root as unknown as HTMLElement,{onStart:async()=>{calls.push('start');},onStop:async()=>{calls.push('stop');}});
  panel.setExpanded(true);
  const text=all(root).map(n=>n.textContent).join('\n');
  assert.match(text,/Listen to music/);assert.match(text,/Start listening/);assert.deepEqual(calls,[]);
  // I-016: the one switch 「和她一起听」 replaced the four reading toggles; it starts off and asks nothing on its own.
  const toggle=new ListenTogetherSwitch(root as unknown as HTMLElement,{set:async()=>{throw Error('No implicit intent allowed');}});
  assert.ok(all(root).filter(n=>n.tagName==='input').every(n=>!n.checked&&n.disabled));
  assert.match(all(root).map(n=>n.textContent).join('\n'),/Listen with her/);
  toggle.dispose();panel.dispose();assert.deepEqual(calls,[]);
 }finally{globalThis.document=previous;setUiLanguage('zh-CN');}
});

test('host broker translates fixed status while source and purpose identities and release ownership stay exact',async()=>{
 setUiLanguage('en');let releases=0;
 const broker=new AudioReadingHostBroker('fixture-language',{acquire:async()=>({captureId:'capture-original',release:async()=>{releases++;}}),transcribe:async()=>({text:'private unmodified'}),publicationReady:()=>undefined});
 try{
  await broker.setIntent('system-audio','music',true);
  for(let i=0;i<5;i++)await Promise.resolve();
  const view=broker.getView();assert.equal(view.sources['system-audio'].music.intent,true);assert.equal(view.sources.microphone.music.intent,false);
  assert.equal(view.sources['system-audio'].capture.status,'Capture ready');
  await broker.setIntent('system-audio','music',false);
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(releases,1);
 }finally{await broker.dispose();setUiLanguage('zh-CN');}
});
