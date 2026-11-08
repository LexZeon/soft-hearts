import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { setUiLanguage } from '../shared/ui-language';
import { uiHtml, uiMarkup, uiTemplate, uiText } from '../src/ui/ui-language';

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
  renderer('../src/ui/layout.ts','renderControls')(controls);
  renderer('../src/ui/PetUI.ts','renderPet')(pet);
  for(const text of ['Show companion','Recover companion','Interface language']) assert.ok(controls.innerHTML.includes(text),text);
  assert.match(controls.innerHTML,/id="ui-language"/);
  assert.match(controls.innerHTML,/value="system">System default/);
  assert.match(pet.innerHTML,/aria-label="Send message"/);
  assert.match(pet.innerHTML,/id="pet-move-window" title="Hold to move the window"/);
  const visible=(controls.innerHTML+pet.innerHTML).replace(/<[^>]*>/g,'').replaceAll('简体中文','');
  assert.deepEqual(visible.match(/[\u3400-\u9fff][^<>\n]*/gu),null,'primary authored copy must be readable in English');
  assert.doesNotMatch(controls.innerHTML+pet.innerHTML,/id="voice-(?:start|finish)"/);
  setUiLanguage('zh-CN');
  renderer('../src/ui/layout.ts','renderControls')(controls);
  assert.ok(controls.innerHTML.includes('显示桌宠'));
});

test('actual host and preload expose only fixed language methods and controls-owned writes', t => {
  const read=(file:string)=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const main=read('../electron/main.ts'),preload=read('../electron/preload.ts'),rendererSource=read('../src/main.ts');
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
 const raw=fs.readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('host.ts',raw,ts.ScriptTarget.Latest,true);
 const find=(name:string)=>tree.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!;
 const registration=find('registerIPC').body!.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&['getUiLanguage','setUiLanguage'].includes((n.expression.arguments[0] as ts.StringLiteral)?.text??''));
 const code=[find('host').getText(tree),find('scopedHost').getText(tree),...registration.map(n=>n.getText(tree))].join('\n');
 const handlers=new Map<string,Function>(),controls={webContents:{id:10}},pet={webContents:{id:11}};let writes=0;
 const state={preference:'system',language:'en'};
 Function('ipcMain','windows','controls','uiLanguage',ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(
  {handle:(key:string,callback:Function)=>handlers.set(key,callback)},()=>[controls,pet],controls,{current:state,persist:async()=>{writes++;return state;}});
 const invoke=(method:string,id:number,mainFrame=true)=>{const frame={};return handlers.get('desk:'+method)!({sender:{id,mainFrame:frame},senderFrame:mainFrame?frame:{}},'en');};
 assert.deepEqual(invoke('getUiLanguage',10),state);assert.deepEqual(invoke('getUiLanguage',11),state);
 assert.throws(()=>invoke('setUiLanguage',11));assert.throws(()=>invoke('setUiLanguage',99));assert.throws(()=>invoke('setUiLanguage',10,false));assert.equal(writes,0);
 await invoke('setUiLanguage',10);assert.equal(writes,1);
});
