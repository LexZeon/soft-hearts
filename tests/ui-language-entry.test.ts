import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiHtml, uiMarkup, uiTemplate, uiText } from '../src/foundation/ui-language';
import { ipcGuardSource, wiringNodes, wiringSource } from './helpers/wiring-source';
import { rendererSource as readRendererSource } from './helpers/renderer-source'; // overhaul step 5: src/main.ts and src/wiring/*.ts

function renderer(file: string, name: string): (app: {innerHTML:string}) => void {
  const raw=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const tree=ts.createSourceFile(file,raw,ts.ScriptTarget.Latest,true);
  const declarations=tree.statements.filter(ts.isFunctionDeclaration).filter(n=>
    ['button','toggle','number','range',name].includes(n.name?.text??'')).map(n=>n.getText(tree).replace(/^export /,''));
  const body=ts.transpileModule(declarations.join('\n')+`\nreturn ${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return Function('icon','renderControlNavigation','uiText','uiHtml','uiMarkup','uiTemplate',body)(()=>'',()=>'',uiText,uiHtml,uiMarkup,uiTemplate);
}

test('actual controls and companion render an English entry with unchanged action IDs', () => {
  setUiLanguage('en');
  const controls={innerHTML:''},pet={innerHTML:''};
  renderer('../src/settings/layout.ts','renderControls')(controls);
  renderer('../src/stage/PetUI.ts','renderPet')(pet);
  for(const text of ['Show companion','Recover companion','Interface language']) assert.ok(controls.innerHTML.includes(text),text);
  assert.match(controls.innerHTML,/id="ui-language"/);
  assert.match(controls.innerHTML,/value="system">System default/);
  assert.match(pet.innerHTML,/aria-label="Send message"/);
  assert.match(pet.innerHTML,/id="pet-move-window" title="Hold to move the window"/);
  const visible=(controls.innerHTML+pet.innerHTML).replace(/<[^>]*>/g,'').replaceAll('简体中文','');
  assert.deepEqual(visible.match(/[\u3400-\u9fff][^<>\n]*/gu),null,'primary authored copy must be readable in English');
  assert.doesNotMatch(controls.innerHTML+pet.innerHTML,/id="voice-(?:start|finish)"/);
  setUiLanguage('zh-CN');
  renderer('../src/settings/layout.ts','renderControls')(controls);
  assert.ok(controls.innerHTML.includes('显示桌宠'));
});

test('actual host and preload expose only fixed language methods and controls-owned writes', t => {
  const read=(file:string)=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
  // Wiring rewrite step 5: the two handlers moved, unchanged, from electron/main.ts registerIPC to electron/wiring/settings-wiring.ts register.
  const main=wiringSource(),preload=read('../electron/safety/preload.ts'),rendererSource=readRendererSource();
  assert.match(main,/host\('getUiLanguage', \(\) => uiLanguage.current, false\)/);
  assert.match(main,/host\('setUiLanguage', preference => uiLanguage.persist\(preference\), true\)/);
  assert.match(preload,/setUiLanguage: preference => invoke\('setUiLanguage', preference\)/);
  assert.ok(rendererSource.indexOf('await window.desktop.getUiLanguage()') < rendererSource.indexOf('    renderPet(app)'));
  assert.match(rendererSource,/document.documentElement.lang = interfaceLanguage.language/);
  const languageHandler=rendererSource.slice(rendererSource.indexOf("languageSelect.addEventListener('change'"),rendererSource.indexOf('    new SingleEmojiControls'));
  assert.doesNotMatch(languageHandler,/location\.reload\(/);
  t.diagnostic('actual renderer sha256 '+createHash('sha256').update(rendererSource).digest('hex'));
});

test('actual language IPC gate allows reads in both owned windows and rejects non-controls writes before persistence',async()=>{
 // Wiring rewrite step 5: the two registrations moved, unchanged, from electron/main.ts registerIPC to electron/wiring/settings-wiring.ts register.
 const registration=wiringNodes((n):n is ts.ExpressionStatement=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText()==='host'&&['getUiLanguage','setUiLanguage'].includes((n.expression.arguments[0] as ts.StringLiteral)?.text??''));
 assert.equal(registration.length,2);
 const code=[ipcGuardSource() /* wiring rewrite step 3: electron/wiring/ipc-wiring.ts */,...registration.map(r=>r.node.getText(r.ast))].join('\n');
 const handlers=new Map<string,Function>(),controls={webContents:{id:10}},pet={webContents:{id:11}};let writes=0;
 const state={preference:'system',language:'en'};
 Function('ipcMain','windows','controls','uiLanguage',ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(
  {handle:(key:string,callback:Function)=>handlers.set(key,callback)},()=>[controls,pet],controls,{current:state,persist:async()=>{writes++;return state;}});
 const invoke=(method:string,id:number,mainFrame=true)=>{const frame={};return handlers.get('desk:'+method)!({sender:{id,mainFrame:frame},senderFrame:mainFrame?frame:{}},'en');};
 assert.deepEqual(invoke('getUiLanguage',10),state);assert.deepEqual(invoke('getUiLanguage',11),state);
 assert.throws(()=>invoke('setUiLanguage',11));assert.throws(()=>invoke('setUiLanguage',99));assert.throws(()=>invoke('setUiLanguage',10,false));assert.equal(writes,0);
 await invoke('setUiLanguage',10);assert.equal(writes,1);
});
