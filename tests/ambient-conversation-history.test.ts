import test from 'node:test';import assert from 'node:assert/strict';
import { ambientCommentHistoryText } from '../src/ui/reply-history';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { validateChatRequest } from '../electron/validation';

test('after audio closes, the next Claude request retains a fixed source label and the complete current user',async()=>{
 const comment='这段合成配乐听起来很轻快。';
 const latest='那是电影的台词，不是我的偏好。先陪我聊聊；不要执行任何任务。';
 const message={role:'assistant' as const,content:ambientCommentHistoryText(comment)};
 const request=validateChatRequest({id:'audio-closed-next',messages:[message,{role:'user',content:latest}],attachments:[]});
 const persona='合成角色；本轮音频已关闭，没有新的观察资料。';
 assert.match(message.content,/系统播放声音.*不是用户发言或偏好/);assert.ok(message.content.endsWith(comment));
 const prompt=buildCodexChatPrompt(persona,request.messages),match=prompt.match(/<conversation-data>\n([\s\S]*)\n<\/conversation-data>$/);assert.ok(match);
 const data=JSON.parse(match[1]);assert.deepEqual(data.history,[message]);assert.equal(data.currentUser,latest);
 assert.equal(comment,'这段合成配乐听起来很轻快。','display/TTS/archive literal is unchanged');
});
