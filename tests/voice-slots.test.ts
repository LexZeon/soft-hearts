import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';

function render(path:string,name:string): string {
  const source=readFileSync(new URL(path,import.meta.url),'utf8');
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(fn);
  const code=transformSync(fn.getText(ast).replace(/^export\s+/,''),{loader:'ts'}).code;
  const f=new Function('uiText','uiHtml','uiMarkup','uiTemplate','icon', 'button', 'toggle', 'number', 'range', 'renderControlNavigation', `${code}; return ${name}`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate)(()=>'',(id:string)=>`<button id="${id}" type="button"></button>`,()=>'',()=>'',()=>'',()=>'');
  const app={innerHTML:''};f(app);return app.innerHTML;
}
function elements(html:string): {id:string; ancestors:string[]}[] {
  const stack:{tag:string;id:string}[]=[],found:{id:string;ancestors:string[]}[]=[];
  for(const m of html.matchAll(/<\s*(\/?)\s*([a-z][\w-]*)([^>]*)>/gi)) {
    const [,end,raw,attrs]=m,tag=raw.toLowerCase();
    if(end){while(stack.length){if(stack.pop()!.tag===tag)break;}continue;}
    const id=/\bid="([^"]+)"/.exec(attrs)?.[1]??'';
    if(id)found.push({id,ancestors:stack.map(n=>n.id||n.tag)});
    if(!/\/$/.test(attrs.trim())&&!['input','br','img','hr','meta','link'].includes(tag))stack.push({tag,id});
  }
  return found;
}
test('both actual templates provide one separate voice slot and retain input/send controls',()=>{
  for(const [path,name,insideForm] of [['../src/ui/PetUI.ts','renderPet',false],['../src/ui/layout.ts','renderControls',true]] as const){
    const nodes=elements(render(path,name));
    for(const id of ['voice-action-slot','chat-form','chat-input','send-chat','stop-chat'])assert.equal(nodes.filter(n=>n.id===id).length,1,`${name} ${id}`);
    const slot=nodes.find(n=>n.id==='voice-action-slot')!,input=nodes.find(n=>n.id==='chat-input')!,send=nodes.find(n=>n.id==='send-chat')!;
    assert.equal(slot.ancestors.includes('chat-form'),insideForm);assert.ok(input.ancestors.includes('chat-form'));assert.ok(send.ancestors.includes('chat-form'));
  }
});
