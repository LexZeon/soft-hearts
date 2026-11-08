import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {WindowVisibilityTracker} from '../src/ui/window-visibility';

const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const declarations=['projectPetVisibility','requestPetVisibility','acceptWindowVisibility'].map(name=>{
  const rows=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(rows.length,1);return rows[0].getText(ast);
}).join('\n');
const handlers:string[]=[];
function visit(n:ts.Node){if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.left.getText(ast)==="$<HTMLInputElement>('pet-visible').onchange")handlers.push(n.getText(ast));ts.forEachChild(n,visit);}
visit(ast);assert.equal(handlers.length,1);
const script=transformSync(`function fixture(deps:any){
 const {document,window,notify,windowVisibility,petVisibilityIntent,settings,stage,petUI,moodCompanion,replyPresentation}=deps;
 const $=(id:string)=>document.getElementById(id);
 let pendingPetVisibility=false,petVisibilityRequest=0,hostVisible=false;
 let isPet=false,ambientAudioController=null,captureController=null,attachments=[],activeChat=null,reply='';
 // Optional profile panel is absent in this native-visibility fixture.
 const userProfilePanel=null;
  const textMemorialOffer = null; let activeMemorialSpeechId = null;
 function hideWaitingPresentation(){} function stopMotionPreview(){} function renderAttachments(){}
 ${declarations}
 ${handlers[0]};
 return {projectPetVisibility,acceptWindowVisibility};
}`,{loader:'ts',target:'es2022'}).code;
const fixture=new Function(script+'\nreturn fixture')() as (deps:unknown)=>{projectPetVisibility():void;acceptWindowVisibility(v:unknown):void};

test('actual checkbox handler preserves latest intent until its authority query and then converges',async()=>{
  const tracker=new WindowVisibilityTracker();tracker.accept({windowId:1,revision:1,visible:true,petVisible:true});
  const input={checked:true,disabled:false,onchange:null as null|((event:unknown)=>void)}, button={disabled:false};
  const document={getElementById:(id:string)=>id==='pet-visible'?input:id==='show-pet'?button:null};
  const pending:Array<()=>void>=[];const intent={request:()=>new Promise<void>(r=>pending.push(r))};
  const queries:Array<(v:unknown)=>void>=[];const window={desktop:{getWindowVisibility:()=>new Promise(r=>queries.push(r))}};const errors:unknown[]=[];const notify=(e:unknown)=>errors.push(e);
  const settings={pet:{visible:true,alwaysOnTop:true},camera:{yaw:.3}};
  const f=fixture({document,window,notify,windowVisibility:tracker,petVisibilityIntent:intent,settings,stage:{setVisible(){}},petUI:null,moodCompanion:null,replyPresentation:{canPresent:()=>false}});
  input.checked=false;input.onchange!({target:input});assert.equal(input.checked,false);
  f.projectPetVisibility();assert.equal(input.checked,false);assert.equal(settings.pet.visible,true);
  f.acceptWindowVisibility({windowId:1,revision:2,visible:false,petVisible:true});assert.equal(input.checked,false);
  f.acceptWindowVisibility({windowId:1,revision:3,visible:true,petVisible:false});assert.equal(input.checked,false);assert.equal(settings.pet.visible,false);
  input.checked=true;input.onchange!({target:input});assert.equal(input.checked,true);
  pending[0]();await Promise.resolve();await Promise.resolve();assert.equal(input.checked,true);
  f.acceptWindowVisibility({windowId:1,revision:4,visible:true,petVisible:true});assert.equal(input.checked,true);
  f.acceptWindowVisibility({windowId:1,revision:5,visible:true,petVisible:false});assert.equal(input.checked,true);assert.equal(settings.pet.visible,false);
  pending[1]();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(queries.length,1);assert.equal(input.checked,true);
  queries[0]({windowId:1,revision:5,visible:true,petVisible:false});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(input.checked,false);
  input.checked=true;input.onchange!({target:input});pending[2]();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(input.checked,true);
  queries[1]({windowId:1,revision:5,visible:true,petVisible:false});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(input.checked,false);
  assert.deepEqual(errors,[]);assert.equal(settings.pet.alwaysOnTop,true);assert.equal(settings.camera.yaw,.3);
});
