import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';

test('actual pet handlers switch profile, audio, details and reader without changing media intent',()=>{
  const source=readFileSync(new URL('../src/ui/PetUI.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('PetUI.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='PetUI');assert.ok(klass&&ts.isClassDeclaration(klass));
  const ctor=klass.members.find(ts.isConstructorDeclaration);assert.ok(ctor?.body);
  const statement=(needle:string)=>{const hits=ctor.body!.statements.filter(n=>n.getText(ast).includes(needle));assert.equal(hits.length,1);return hits[0].getText(ast);};
  const notice=klass.members.find(n=>ts.isPropertyDeclaration(n)&&n.name.getText(ast)==='openNoticeDetails');assert.ok(notice);
  const code=transformSync(`class Fixture { ${notice.getText(ast)} init(actions:any,byId:any){ ${statement('this.replyReader = new ReplyReader')} ${statement("byId('pet-system-audio-sharing').onclick =")} ${statement("byId('user-profile-toggle').onclick =")} } }`,{loader:'ts'}).code;
  const names=['pet-system-audio-sharing','notice-detail-panel','pet-reply-reader','pet-reply-reader-body','pet-read-reply','pet-reply-reader-close','pet-reply-reader-status','user-profile-toggle'];
  const nodes=Object.fromEntries(names.map(id=>[id,{hidden:false,open:false,attrs:{} as Record<string,string>,getAttribute(k:string){return this.attrs[k]},close(){this.open=false},onclick:()=>{}}]));
  let closes=0,profileCloses=0,toggles=0,mediaMutations=0,changed=()=>{};
  const actions={closeSystemAudioPanel(){closes++},closeUserProfile(){profileCloses++},toggleUserProfile(){toggles++},systemAudio(){},edit(){},feature(){mediaMutations++},stop(){mediaMutations++}};
  const Reader=class {opened=true;constructor(...args:any[]){changed=args[5]}};
  const Ctor=new Function('document','ReplyReader',`${code};return Fixture`)({getElementById:(id:string)=>nodes[id]},Reader);
  const f=new Ctor();f.actions=actions;f.setWindowAdjusting=()=>{};f.syncInteractionBlock=()=>{};f.init(actions,(id:string)=>nodes[id]);
  nodes['pet-reply-reader'].open=true;nodes['user-profile-toggle'].onclick();assert.equal(closes,1);assert.equal(toggles,1);assert.equal(nodes['notice-detail-panel'].hidden,true);assert.equal(nodes['pet-reply-reader'].open,false);
  nodes['pet-system-audio-sharing'].onclick();assert.equal(profileCloses,1);
  f.openNoticeDetails();assert.equal(profileCloses,2);changed();assert.equal(profileCloses,3);assert.equal(mediaMutations,0);
});
