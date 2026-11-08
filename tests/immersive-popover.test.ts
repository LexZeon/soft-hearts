import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';

test('actual toolbar handlers switch panels without changing audio intent',()=>{
  const source=readFileSync(new URL('../src/ui/PetUI.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('PetUI.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='PetUI');assert.ok(klass&&ts.isClassDeclaration(klass));
  const ctor=klass.members.find(ts.isConstructorDeclaration);assert.ok(ctor?.body);
  const find=(s:string)=>{const hits=ctor.body!.statements.filter(n=>n.getText(ast).includes(s));assert.equal(hits.length,1);return hits[0].getText(ast);};
  const notice=klass.members.find(n=>ts.isPropertyDeclaration(n)&&n.name.getText(ast)==='openNoticeDetails');assert.ok(notice&&ts.isPropertyDeclaration(notice));
  const method=klass.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)==='setSystemAudioExpanded');assert.ok(method&&ts.isMethodDeclaration(method));
  const audio=find("byId('pet-system-audio-sharing').onclick =");
  const reply=find('this.replyReader = new ReplyReader');
  const code=transformSync(`class Fixture { ${notice.getText(ast)} ${method.getText(ast)} init(actions:any,byId:any){ ${audio} ${reply} } }`,{loader:'ts'}).code;
  const nodes:Record<string,any>={};for(const id of ['pet-system-audio-sharing','notice-detail-panel','pet-reply-reader','pet-reply-reader-body','pet-read-reply','pet-reply-reader-close','pet-reply-reader-status'])nodes[id]={hidden:false,open:false,attrs:{} as Record<string,string>,getAttribute(k:string){return this.attrs[k]},setAttribute(k:string,v:string){this.attrs[k]=v},close(){this.open=false}};
  let audioOpen=false, stops=0, closeCalls=0, changed=()=>{};
  const actions={systemAudio(){audioOpen=!audioOpen; nodes['pet-system-audio-sharing'].attrs['aria-expanded']=String(audioOpen)},closeSystemAudioPanel(){closeCalls++;audioOpen=false;nodes['pet-system-audio-sharing'].attrs['aria-expanded']='false'},edit(){},stop(){stops++},feature(){stops++}};
  const doc={getElementById:(id:string)=>nodes[id]};
  const Reader=class {opened=true; constructor(...args:any[]){changed=args[5]} };
  const Ctor=new Function('document','ReplyReader',code+'; return Fixture')(doc,Reader);const f=new Ctor();f.actions=actions;f.setWindowAdjusting=()=>{};f.syncInteractionBlock=()=>{};f.init(actions,(id:string)=>nodes[id]);
  nodes['pet-reply-reader'].open=true;nodes['pet-system-audio-sharing'].onclick();assert.equal(audioOpen,true);assert.equal(nodes['notice-detail-panel'].hidden,true);assert.equal(nodes['pet-reply-reader'].open,false);
  f.setSystemAudioExpanded(true);assert.equal(nodes['pet-system-audio-sharing'].attrs['aria-expanded'],'true');
  f.openNoticeDetails();assert.equal(audioOpen,false);assert.equal(closeCalls,1);
  audioOpen=true;nodes['notice-detail-panel'].hidden=false;changed();assert.equal(audioOpen,false);assert.equal(nodes['notice-detail-panel'].hidden,true);assert.equal(stops,0);
});
