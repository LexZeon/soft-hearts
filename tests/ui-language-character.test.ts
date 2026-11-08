import assert from 'node:assert/strict';
import test from 'node:test';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_CHARACTER_UI_COPY } from '../shared/ui-copy.character.en';
import { CharacterResponseControls } from '../src/ui/CharacterResponseControls';
import { PersonalizeLanguageControls } from '../src/ui/PersonalizeLanguageControls';
import { PersonalizeVisualControls } from '../src/ui/PersonalizeVisualControls';
import { PersonalizeBodyControls } from '../src/ui/PersonalizeBodyControls';
import { emptyLanguageRules } from '../shared/personalize-language';
import { MoodPanel, moodExtendedDifferences } from '../src/ui/MoodPanel';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';

class Element {
  children:Element[]=[]; textContent=''; value=''; disabled=false; hidden=false; open=false; className=''; src=''; alt=''; id='';
  dataset:Record<string,string>={}; attributes:Record<string,string>={};
  readonly classList={toggle:()=>false};
  constructor(readonly tagName:string){}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.children=[...children];}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
  addEventListener(){}
  remove(){}
}
const all=(node:Element):Element[]=>[node,...node.children.flatMap(all)];
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};

test('actual character tuning and authoring constructors render English fixed copy with unchanged action IDs',()=>{
  registerUiMessages({en:ENGLISH_CHARACTER_UI_COPY,'zh-CN':{}});setUiLanguage('en');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
  const roots=Array.from({length:4},()=>new Element('div'));
  const noop=()=>()=>{};
  const response=new CharacterResponseControls(roots[0] as unknown as HTMLElement,{api:{getCharacterResponse:async()=>{throw Error('unexpected read');},saveCharacterResponse:async()=>{throw Error('unexpected save');},onCharacterResponse:noop},onError:()=>{}});
  const language=new PersonalizeLanguageControls(roots[1] as unknown as HTMLElement,{api:{onPersonalizeLanguage:noop} as never,onError:()=>{}});
  const visual=new PersonalizeVisualControls(roots[2] as unknown as HTMLElement,{api:{onVisualPreviewCancelled:noop} as never});
  const body=new PersonalizeBodyControls(roots[3] as unknown as HTMLElement,{api:{onBodyPreviewCancelled:noop} as never,preview:async()=>false});
  try {
    const captions=roots.flatMap(all).flatMap(n=>[n.textContent,n.alt,...Object.values(n.attributes)]).filter(Boolean);
    assert.deepEqual(captions.filter(text=>/[\u3400-\u9fff]/u.test(text)),[]);
    assert.ok(captions.includes('Tune responses by mood'));
    assert.ok(captions.includes('personalize · Speaking habits'));
    assert.ok(captions.includes('personalize · Brows & eyes'));
    assert.ok(captions.includes('personalize · Body pose'));
    assert.ok(all(roots[0]).some(n=>n.id==='response-save'));
    assert.ok(all(roots[2]).some(n=>n.dataset.visualAction==='research'));
    assert.ok(all(roots[3]).some(n=>n.dataset.bodyAction==='preview-fixed'));
    visual.select({id:'private-card',name:'保存并启用'});body.select({id:'private-card',name:'保存并启用'});
    assert.ok(all(roots[2]).some(n=>n.textContent==='Target card: 保存并启用 · private-card'));
    assert.ok(all(roots[3]).some(n=>n.textContent==='Target card: 保存并启用 · private-card'));
  } finally {
    response.dispose();language.dispose();visual.dispose();body.dispose();setUiLanguage('zh-CN');
    if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
});

test('extended-value descriptions and fatigue labels are English while raw awake identity keeps wake disabled',()=>{
  registerUiMessages({en:ENGLISH_CHARACTER_UI_COPY,'zh-CN':{}});setUiLanguage('en');
  const original=structuredClone(DEFAULT_MOOD_PARAMETERS),candidate=structuredClone(original);
  candidate.sensitivity.D=2;candidate.halfLifeMs.C=200*60_000;candidate.weights.playful=2;
  const descriptions=moodExtendedDifferences(candidate,original);
  assert.equal(descriptions.length,3);
  assert.ok(descriptions.some(text=>text.includes('D event sensitivity')));
  assert.ok(descriptions.every(text=>!/[\u3400-\u9fff]/u.test(text)));
  assert.deepEqual(original,DEFAULT_MOOD_PARAMETERS);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
  const root=new Element('div'),panel=new MoodPanel(root as unknown as HTMLElement,{onApply(){},onRestore(){},onWake(){}});
  try{
    const captions=all(root).flatMap(n=>[n.textContent,...Object.values(n.attributes)]).filter(Boolean);
    assert.deepEqual(captions.filter(text=>/[\u3400-\u9fff]/u.test(text)),[]);
    const channels={D:50,O:50,E:50,N:50,C:50};
    const view={characterId:'private-card',revision:1,snapshot:{primary:'calm',companion:null,phase:'idle',values:channels,trend:channels,fast:{},boredom:0,longing:0,lastInteractionAt:null,reason:'',event:null},parameters:original,
      fatigue:{version:1,A:.5,F:.5,W:.5,phase:'awake',sleepEntryReady:true}};
    panel.update(view as never);
    const internal=panel as unknown as {wakeButton:Element;fatigueSummary:Element;setBusy(busy:boolean):void};
    assert.equal(internal.wakeButton.disabled,true);assert.match(internal.fatigueSummary.textContent,/Awake/);
    internal.setBusy(false);assert.equal(internal.wakeButton.disabled,true);
    panel.update({...view,revision:2,fatigue:{...view.fatigue,phase:'asleep'}} as never);
    assert.equal(internal.wakeButton.disabled,false);assert.match(internal.fatigueSummary.textContent,/Asleep/);
  }finally{
    panel.dispose();setUiLanguage('zh-CN');
    if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
});

test('actual language preview translates headings while preserving private rule text and rule IDs',async()=>{
  registerUiMessages({en:ENGLISH_CHARACTER_UI_COPY,'zh-CN':{}});setUiLanguage('en');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
  const root=new Element('div'),rules={...emptyLanguageRules(),tone:'保存并启用\n<private> {0}'};
  const state={characterId:'private-card',revision:1,profile:{enabled:true,rules}};
  const ui=new PersonalizeLanguageControls(root as unknown as HTMLElement,{api:{getPersonalizeLanguage:async()=>state,onPersonalizeLanguage:()=>()=>{}} as never,onError:()=>{}});
  try {
    ui.select({id:'private-card',name:'保存并启用'});await flush();
    const preview=all(root).find(n=>n.dataset.languagePreview==='rules');assert.ok(preview);
    assert.equal(preview.textContent,'Tone & directness:\n保存并启用\n<private> {0}');
    assert.equal(all(root).find(n=>n.dataset.languageField==='tone')?.value,rules.tone);
    assert.deepEqual(state.profile.rules,rules);
  } finally {
    ui.dispose();setUiLanguage('zh-CN');
    if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
});
