import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {WindowVisibilityTracker} from '../src/ui/window-visibility';
const DEFAULT_SETTINGS={provider:{kind:'claude',baseUrl:'http://127.0.0.1:9/v1',model:'fixture',apiKey:''},pet:{visible:true,alwaysOnTop:true,clickThrough:false,followMouse:true,fps:30,breath:0.5},voice:{enabled:false,rate:1,volume:1},voiceInput:{baseUrl:'http://127.0.0.1:9/v1',model:'fixture',language:'zh',apiKey:''}};
const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['syncForm','syncAsrEngine','projectPetVisibility','requestPetVisibility','acceptWindowVisibility'];
const decl=names.map(name=>{const nodes=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(nodes.length,1);return nodes[0].getText(ast);}).join('\n');
const handlers:string[]=[];function walk(n:ts.Node){if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.left.getText(ast)==="$<HTMLInputElement>('pet-visible').onchange")handlers.push(n.getText(ast));ts.forEachChild(n,walk);}walk(ast);assert.equal(handlers.length,1);
const code=transformSync(`function make(deps:any){
 const {document,window,notify,windowVisibility,petVisibilityIntent,settings,DEFAULT_SETTINGS,stage,petUI,moodCompanion,replyPresentation}=deps;
 const $=(id:string)=>document.getElementById(id); const text=(id:string,v:string)=>{$(id).textContent=v;};
 const syncCamera=()=>{},populateVoices=()=>{},currentTtsConfig=()=>({provider:'system'}),emotionalVoiceControls=null,codexTasks=null,updateSummary=()=>{};
 let pendingPetVisibility=false,petVisibilityRequest=0,hostVisible=false,isPet=false,ambientAudioController=null,captureController=null,attachments=[],activeChat=null,reply='';
 // Optional profile panel is absent in this form/visibility fixture.
 const userProfilePanel=null;
  const textMemorialOffer = null; let activeMemorialSpeechId = null;
 function hideWaitingPresentation(){}function stopMotionPreview(){}function renderAttachments(){}
 ${decl}
 ${handlers[0]};return {syncForm,projectPetVisibility,acceptWindowVisibility};
}`,{loader:'ts',target:'es2022'}).code;
const make=new Function('uiText','uiHtml','uiMarkup','uiTemplate',code+'\nreturn make').bind(null, uiText, uiHtml, uiMarkup, uiTemplate)() as (deps:unknown)=>{syncForm():void;projectPetVisibility():void;acceptWindowVisibility(v:unknown):void};
test('actual syncForm during an old save preserves the pending checkbox and updates unrelated controls',async()=>{
  const tracker=new WindowVisibilityTracker();tracker.accept({windowId:1,revision:1,visible:true,petVisible:true});
  const nodes=new Map<string,any>();const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,{checked:false,disabled:false,value:'',textContent:'',classList:{toggle(){}}});return nodes.get(id);};
  const document={activeElement:null,getElementById:get};const input=get('pet-visible');input.checked=true;
  let finish!:()=>void;const intent={request:()=>new Promise<void>(resolve=>{finish=resolve;})};
  let answer!:(v:unknown)=>void;const window={desktop:{getWindowVisibility:()=>new Promise(r=>{answer=r;})}};const errors:unknown[]=[];const notify=(e:unknown)=>errors.push(e);
  const settings=structuredClone(DEFAULT_SETTINGS);settings.pet.visible=true;settings.pet.alwaysOnTop=false;
  const f=make({document,window,notify,windowVisibility:tracker,petVisibilityIntent:intent,settings,DEFAULT_SETTINGS,stage:{setVisible(){}},petUI:null,moodCompanion:null,replyPresentation:{canPresent:()=>false}});
  input.checked=false;input.onchange({target:input});f.projectPetVisibility();f.syncForm();
  assert.equal(input.checked,false);assert.equal(settings.pet.visible,true);assert.equal(get('always-on-top').checked,false);
  finish();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(input.checked,false);
  f.acceptWindowVisibility({windowId:1,revision:2,visible:true,petVisible:false});f.syncForm();assert.equal(input.checked,false);
  answer({windowId:1,revision:2,visible:true,petVisible:false});await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(input.checked,false);assert.equal(settings.pet.visible,false);assert.equal(get('always-on-top').checked,false);assert.deepEqual(errors,[]);
});
