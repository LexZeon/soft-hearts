import test from 'node:test';import assert from 'node:assert/strict';
import { appendReplyHistory } from '../src/ui/reply-history';
import { validateChatRequest } from '../electron/validation';
import { MoodReplyProtocol } from '../electron/mood-chat';

test('an interrupted original is available to the next continue request exactly once without display/error suffixes',()=>{
 const user={role:'user' as const,content:'比较休息和画画；先考虑疲惫和零预算。'};
 const body='先休息。\n理由一：本周疲惫。';
 const history=appendReplyHistory([],user,body);
 const next=validateChatRequest({id:'continue',messages:[...history,{role:'user',content:'请从末尾继续。'}],attachments:[]});
 assert.deepEqual(next.messages,[user,{role:'assistant',content:body},{role:'user',content:'请从末尾继续。'}]);
 assert.deepEqual(appendReplyHistory(history,null,body),history,'late done/stop after the active user was cleared cannot append twice');
 assert.deepEqual(appendReplyHistory([],user,' \n'),[]);
});

for(const complete of [true,false])test(`ending mid-nonce never releases private protocol text (allowAppraisal=${complete})`,()=>{
 for(let extra=1;extra<34;extra++){
   let output='';const protocol=new MoodReplyProtocol(delta=>{output+=delta;});
   const cut=Math.min('<sh-state-'.length+extra,protocol.start.length-1);
   const marker=protocol.start.slice(0,cut);
   for(const char of '第一句。\n'+marker)protocol.push(char);
   assert.equal(protocol.finish(complete),null);assert.equal(output,'第一句。',`cut ${cut}`);
   assert.equal(protocol.finish(complete),null);assert.equal(output,'第一句。');
 }
 let ordinary='';const protocol=new MoodReplyProtocol(delta=>{ordinary+=delta;});protocol.push('自然文末 <sh-state-');protocol.finish(complete);assert.equal(ordinary,'自然文末 <sh-state-');
});
