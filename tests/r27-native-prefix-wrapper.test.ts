import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {CompletedPrefixProof} from '../electron/completed-prefix-proof';import {ReplyPresentation} from '../electron/reply-presentation';
const raw=readFileSync(new URL('../electron/reply-window.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('reply-window.ts',raw,ts.ScriptTarget.Latest,true);
const cls=ast.statements.find((n):n is ts.ClassDeclaration=>ts.isClassDeclaration(n)&&n.name?.text==='PetReplyWindow');assert.ok(cls);
const property=cls.members.find((n):n is ts.PropertyDeclaration=>ts.isPropertyDeclaration(n)&&n.name.getText(ast)==='completedPrefixProof');assert.ok(property?.initializer);
const names=['waitForCompletedPrefix','isCompletedPrefixCurrent','waitForPresentation','isPresentationCurrent','proofCurrent'];
const methods=names.map(name=>{const n=cls.members.find((n):n is ts.MethodDeclaration=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);assert.ok(n);return n.getText(ast);}).join('\n');
const code=ts.transpileModule('return class Excerpt {constructor(deps){Object.assign(this,deps);this.completedPrefixProof='+property.initializer.getText(ast)+';}\n'+methods+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const Excerpt=new Function('CompletedPrefixProof','REPLY_URL',code)(CompletedPrefixProof,'exact-native-reply-url');
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(text:string){
 let visible=true,serial=0;const recipient={isDestroyed:()=>false,getURL:()=> 'exact-native-reply-url',mainFrame:{url:'exact-native-reply-url'}};
 const win={isDestroyed:()=>false,webContents:recipient,isVisible:()=>visible,isMinimized:()=>false};
 const native=new ReplyPresentation({createToken:()=> 'native-token-'+(++serial).toString().padStart(8,'0')});const token=native.begin(text,recipient);assert.ok(token);
 const ui=new Excerpt({owner:{isDestroyed:()=>false,isVisible:()=>visible,isMinimized:()=>false,getOpacity:()=>1},window:win,text,contentRevision:1,disposed:false,ready:true,waiting:false,segmented:false,interactionOpacity:1,presentation:native,lastConfirmed:null,completedPrefixPaint:null,currentLayout:()=>({}),actuallyVisible:()=>visible});
 return{ui,native,token,recipient,hide(){visible=false;ui.completedPrefixProof.changed();},close(){ui.completedPrefixProof.cancel();native.dispose();}};
}
test('actual PetReplyWindow wrapper accepts genuine prefix ACK and reuses consumed current paint across lease signals',{timeout:4000},async t=>{
 const f=fixture('第一句。第二句。');t.after(()=>f.close());const first=new AbortController();let commits=0;
 const pending=f.ui.waitForCompletedPrefix('第一句。第二句。',4,first.signal,10000,()=>{commits++;return true;});await flush();assert.equal(commits,0);
 assert.equal(f.native.acknowledge(f.token,f.recipient,true),true);assert.equal(await pending,true);assert.equal(commits,1);first.abort();
 assert.equal(f.ui.isCompletedPrefixCurrent('第一句。第二句。'),true,'paint fact stays current; new lease still needs independent host authority');
 assert.equal(await f.ui.waitForCompletedPrefix('第一句。第二句。',8,new AbortController().signal,10000,()=>{commits++;return true;}),true);assert.equal(commits,2);
});
test('actual wrapper rejects native context loss and cannot use its late acknowledgement',{timeout:4000},async t=>{
 const f=fixture('第一句。');t.after(()=>f.close());let commits=0;
 const pending=f.ui.waitForCompletedPrefix('第一句。第二句。',4,new AbortController().signal,10000,()=>{commits++;return true;});await flush();f.hide();
 assert.equal(await pending,false);assert.equal(f.ui.isCompletedPrefixCurrent('第一句。'),false);assert.equal(commits,0);
});
