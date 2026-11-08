import assert from 'node:assert/strict';
import test from 'node:test';
import { TextMemorialPanel } from '../src/ui/TextMemorialPanel';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';

class Element {
  children: Element[] = []; textContent='';value='';className='';type='';disabled=false;
  attributes: Record<string,string>={};onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;
  constructor(readonly tagName:string){}
  append(...values:Element[]){this.children.push(...values);}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
}
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];

test('English keepsake management preserves private text and purpose without granting recording or writes',async()=>{
  registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');
  const privateText='保存纪念修改'.repeat(20),purpose='删除纪念';let writes=0;
  const snapshot={scopeId:'scope',generation:1,revision:1,entries:[{id:'entry',text:privateText,purpose,createdAt:1,updatedAt:1}]};
  const panel=new TextMemorialPanel({getTextMemorials:async()=>snapshot,editTextMemorial:async()=>{writes++;return snapshot;},deleteTextMemorial:async()=>{writes++;return snapshot;},onTextMemorialsChanged:()=>()=>{}},()=>{});
  try{
    panel.open();await Promise.resolve();await Promise.resolve();
    const doc={createElement:(tag:string)=>new Element(tag)} as unknown as Document;
    const root=panel.render(doc) as unknown as Element,nodes=all(root);
    assert.ok(nodes.some(node=>node.textContent==='Text keepsakes'));
    assert.ok(nodes.some(node=>node.textContent==='Save keepsake changes'));
    assert.equal(nodes.find(node=>node.attributes['aria-label']==='Keepsake text')?.value,privateText);
    assert.equal(nodes.find(node=>node.attributes['aria-label']==='Keepsake purpose')?.value,purpose);
    assert.equal(writes,0);
  }finally{panel.dispose();setUiLanguage('zh-CN');}
});
