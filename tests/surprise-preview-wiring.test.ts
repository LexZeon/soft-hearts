import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';
import {SurprisePreviewHost} from '../electron/surprise-preview-host';import {MotionPreviewSession} from '../src/ui/motion-preview';import {DEFAULT_SETTINGS} from '../shared/defaults';
import {bindPreviewCardButtons} from '../src/ui/ExpressionPreviewButtons';import {showSupport,type ShowCapabilities} from '../src/stage/expression-show';

const parse=(name:string,text:string)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const evaluate=<T>(code:string,env:Record<string,unknown>):T=>new Function('uiText','uiHtml','uiMarkup','uiTemplate',...Object.keys(env), ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText).bind(null, uiText, uiHtml, uiMarkup, uiTemplate)(...Object.values(env));
const fn=(tree:ts.SourceFile,name:string)=>{const x=tree.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(x);return x;};

test('actual scoped host registrations accept only the fixed controls request and deny pet or foreign frame',async()=>{
 const tree=parse('main.ts',await readFile(new URL('../electron/main.ts',import.meta.url),'utf8'));
 const register=fn(tree,'registerIPC'),methods=['beginSurprisePreview','resolveSurprisePreview','stopSurprisePreview'];
 const rows=register.body!.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(tree)==='scopedHost'&&ts.isStringLiteral(n.expression.arguments[0])&&methods.includes(n.expression.arguments[0].text));assert.equal(rows.length,3);
 const handlers=new Map<string,(event:any,...args:any[])=>any>(),frame={},controls={webContents:{id:1,mainFrame:frame}},pet={webContents:{id:2,mainFrame:{}}};
 const host=new SurprisePreviewHost({context:owner=>owner===1?{modelKey:'synthetic',modelUrl:'asset://gene',visible:true}:null,verifyTarget:async()=>true});
 evaluate(`${fn(tree,'scopedHost').getText(tree)}\n${rows.map(x=>x.getText(tree)).join('\n')}`,{ipcMain:{handle:(key:string,value:any)=>handlers.set(key,value)},windows:()=>[controls,pet],controls,surprisePreviewHost:host});
 const event={sender:controls.webContents,senderFrame:frame},foreign={sender:controls.webContents,senderFrame:{}},petEvent={sender:pet.webContents,senderFrame:pet.webContents.mainFrame};
 const begin=handlers.get('desk:beginSurprisePreview')!,resolve=handlers.get('desk:resolveSurprisePreview')!,stop=handlers.get('desk:stopSurprisePreview')!;
 assert.throws(()=>begin(petEvent));assert.throws(()=>begin(foreign));assert.throws(()=>begin(event,'renderer-path'));
 const view=await begin(event);assert.equal(resolve(event,view.id,5).id,view.id);assert.throws(()=>resolve(event,view.id,5,'extra'));
 const shy=await begin(event,'shy');assert.equal(shy.clipId,'original-shy-offline-001');assert.throws(()=>resolve(event,view.id,5));
 assert.throws(()=>begin(event,'shy','extra'));assert.throws(()=>begin(event,{clip:'shy'}));
 stop(event,view.id);assert.equal(resolve(event,shy.id,5).id,shy.id);stop(event,shy.id);assert.throws(()=>resolve(event,shy.id,5));
});

test('actual preload exposes only fixed surprise routes and removes its exact cancellation listener',async()=>{
 const tree=parse('preload.ts',await readFile(new URL('../electron/preload.ts',import.meta.url),'utf8'));
 const variable=(name:string)=>{const row=tree.statements.find((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)===name));assert.ok(row);return row.getText(tree);};
 const calls:any[][]=[],listeners=new Map<string,Function>();const ipcRenderer={invoke:(...a:any[])=>{calls.push(a);return Promise.resolve(null);},on:(key:string,f:Function)=>listeners.set(key,f),removeListener:(key:string,f:Function)=>{assert.equal(listeners.get(key),f);listeners.delete(key);}};
 const api=evaluate<any>(`${variable('invoke')}\n${fn(tree,'subscribe').getText(tree)}\n${variable('api')}\nreturn api;`,{ipcRenderer});
 await api.beginSurprisePreview();await api.beginSurprisePreview('shy');await api.resolveSurprisePreview('lease',7);await api.stopSurprisePreview('lease');
 assert.deepEqual(calls,[['desk:beginSurprisePreview'],['desk:beginSurprisePreview','shy'],['desk:resolveSurprisePreview','lease',7],['desk:stopSurprisePreview','lease']]);
 const seen:any[]=[],unsubscribe=api.onSurprisePreviewCancelled((x:any)=>seen.push(x));listeners.get('desk:surprise-preview-cancelled')!({}, {id:'lease'});assert.deepEqual(seen,[{id:'lease'}]);unsubscribe();assert.equal(listeners.size,0);
});

// E1 (U-008): the preview card's 惊喜试作 / 害羞试作 no longer take the Gene-only host lease above; they play the
// model-agnostic show (src/stage/expression-show.ts) on every window through the same relay as the new 「预览」 buttons.
// The old source-text checks of src/main.ts are replaced by the imported binding (bindPreviewCardButtons).
test('E1: the preview card buttons play the model-agnostic show on any model, name what shows, and save nothing',async()=>{
 const buttons:Record<string,{onclick:(()=>void)|null}>={'surprise-preview':{onclick:null},'shy-preview':{onclick:null}},played:string[]=[],lines:string[]=[],errors:string[]=[];
 let capabilities:ShowCapabilities={head:true,upperBody:false,eyes:false,lids:true,browUp:false,browSad:true,eyeWide:true,smileEyes:false,mouthSmile:true,mouthOpen:false,blush:false};
 bindPreviewCardButtons({button:id=>buttons[id] as never,support:recipe=>showSupport(recipe,capabilities),play:async recipe=>{played.push(recipe);return {sent:true,petVisible:true};},
  status:line=>lines.push(line),error:message=>errors.push(message)});
 buttons['shy-preview'].onclick!();for(let i=0;i<5;i++)await Promise.resolve();
 buttons['surprise-preview'].onclick!();for(let i=0;i<5;i++)await Promise.resolve();
 assert.deepEqual(played,['shy','surprise'],'a non-Gene model plays too');
 assert.match(lines[0],/^害羞：垂眼看向一侧、半垂眼皮、低头侧转、抿嘴笑、有点为难的眉 · 这个模型没有：脸红、身体微微一缩（跳过）$/);
 capabilities=Object.fromEntries(Object.keys(capabilities).map(key=>[key,false])) as unknown as ShowCapabilities;
 buttons['shy-preview'].onclick!();for(let i=0;i<5;i++)await Promise.resolve();
 assert.deepEqual(played,['shy','surprise'],'nothing usable: not sent');assert.match(lines.at(-1)!,/没法预览/);assert.deepEqual(errors,[]);
});

test('actual controls layout exposes distinct surprise and shy buttons and one stop',async()=>{
 const tree=parse('layout.ts',await readFile(new URL('../src/ui/layout.ts',import.meta.url),'utf8'));
 const definitions=['button','toggle','number','range','renderControls'].map(name=>fn(tree,name).getText(tree).replace(/^export\s+/,''));
 const render=evaluate<(app:{innerHTML:string})=>void>(`${definitions.join('\n')}\nreturn renderControls;`,{icon:()=>'',renderControlNavigation:()=>''});
 const app={innerHTML:''};render(app);
 for(const id of ['surprise-preview','shy-preview','surprise-stop'])assert.equal((app.innerHTML.match(new RegExp(`id="${id}"`,'g'))??[]).length,1);
 assert.match(app.innerHTML,/害羞试作/);assert.match(app.innerHTML,/惊喜试作/);
});

test('E1: a failed relay is a notice, never a saved motion or a thrown handler',async()=>{
 const buttons:Record<string,{onclick:(()=>void)|null}>={'surprise-preview':{onclick:null},'shy-preview':{onclick:null}},errors:string[]=[],settings=structuredClone(DEFAULT_SETTINGS),before=structuredClone(settings);
 const all:ShowCapabilities={head:true,upperBody:true,eyes:true,lids:true,browUp:true,browSad:true,eyeWide:true,smileEyes:true,mouthSmile:true,mouthOpen:true,blush:true};
 bindPreviewCardButtons({button:id=>buttons[id] as never,support:recipe=>showSupport(recipe,all),play:async()=>{throw Error('窗口已关闭');},status:()=>{},error:message=>errors.push(message)});
 buttons['surprise-preview'].onclick!();for(let i=0;i<5;i++)await Promise.resolve();
 assert.deepEqual(errors,['Error: 窗口已关闭']);assert.deepEqual(settings,before);void MotionPreviewSession;
});
