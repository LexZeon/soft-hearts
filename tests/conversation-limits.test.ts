import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChatRequest } from '../electron/validation';

test('host rejects oversized current user text rather than silently losing final constraints', () => {
  const exact = 'a'.repeat(15983) + '最终要求：只讨论，不执行。';
  const result = validateChatRequest({id:'full-user',messages:[{role:'user',content:exact}],attachments:[]});
  assert.equal(result.messages.at(-1)?.content, exact);
  assert.throws(() => validateChatRequest({id:'oversize',messages:[{role:'user',content:'a'.repeat(16000)+'尾部禁止执行'}],attachments:[]}), /16000.*没有发送/);
});

test('long old replies preserve their setup and continuation tail with a Unicode-safe explicit omission', () => {
  const old = '开头要求：零预算，只讨论。' + '😀'.repeat(16000) + '末尾刚写到：第二项比较，下一项请继续。';
  const current = '请继续，并保持原来的限制。';
  const result = validateChatRequest({id:'long-continuation',messages:[{role:'user',content:'原问题'},{role:'assistant',content:old},{role:'user',content:current}],attachments:[]});
  const previous = result.messages.at(-2)!.content;
  assert.ok(previous.length <= 16000); assert.match(previous,/开头要求：零预算，只讨论/); assert.ok(previous.endsWith('末尾刚写到：第二项比较，下一项请继续。'));
  assert.match(previous,/历史中段省略/); assert.equal(Buffer.from(previous,'utf8').toString('utf8'),previous); assert.equal(result.messages.at(-1)!.content,current);
  assert.ok(result.messages.reduce((sum,item)=>sum+item.content.length,0)<=48000);
});

