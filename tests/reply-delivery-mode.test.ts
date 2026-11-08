import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';


test('actual Claude stdout consumer labels first completed-only text and preserves real update deltas without launching CLI',()=>{
  const raw=fs.readFileSync(new URL('../electron/codex.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('codex.ts',raw,ts.ScriptTarget.Latest,true);
  const matches:ts.Expression[]=[];
  function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='consume'&&node.initializer)matches.push(node.initializer);ts.forEachChild(node,visit);}visit(tree);
  assert.equal(matches.length,1);const code=ts.transpileModule('('+matches[0].getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  for(const mode of ['completed','updated','agent']as const){
    const rows:{type:string,text:string}[]=[],context:any={task:{kind:mode==='agent'?'agent':'chat'},seen:new Map(),output:'',turnFailure:'',emit:(type:string,text:string)=>rows.push({type,text}),stop:()=>assert.fail('no process is present or stoppable in this source fixture')};
    vm.createContext(context);const consume=vm.runInContext(code,context);
    const send=(type:string,text:string)=>consume(JSON.stringify({type,item:{id:'answer',type:'agent_message',text}}));
    if(mode==='updated')send('item.updated','先到。');
    send('item.completed',mode==='updated'?'先到。后到。':'整段。');
    if(mode==='completed')assert.deepEqual(rows,[{type:'status',text:'本次回复整段到达，将逐句展示。'},{type:'delta',text:'整段。'}]);
    if(mode==='updated')assert.deepEqual(rows,[{type:'delta',text:'先到。'},{type:'delta',text:'后到。'}]);
    if(mode==='agent')assert.deepEqual(rows,[{type:'delta',text:'整段。'}]);
    assert.equal(context.turnFailure,'');
  }
});
