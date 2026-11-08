import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChatRequest } from '../electron/validation';
import { outgoingChatMessages } from '../src/ui/reply-history';
import type { ChatMessage } from '../shared/contracts';

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });
const request = (messages: ChatMessage[]) => ({ id: 'history_boundary', messages, attachments: [] });

test('sender removes orphaned consecutive assistants only when the 24-message cut removed a user', () => {
  const history = [message('user', 'old user'), message('assistant', 'old first'), message('assistant', 'old second'),
    message('user', 'kept user'), ...Array.from({ length: 20 }, (_, i) => message('assistant', `kept assistant ${i}`))];
  const user = message('user', 'current 😀');
  const historyBefore = structuredClone(history), userBefore = structuredClone(user);
  const result = outgoingChatMessages(history, user);
  assert.deepEqual(result, [...history.slice(3), user]);
  assert.equal(result[0].role, 'user'); assert.equal(result.at(-1)?.content, 'current 😀');
  assert.deepEqual(history, historyBefore); assert.deepEqual(user, userBefore);
});

test('greetings and consecutive roles survive when no user was cut from the sender window', () => {
  const greeting = [message('assistant', 'hello'), message('assistant', 'also hello'), message('user', 'earlier')];
  const current = message('user', 'now');
  assert.deepEqual(outgoingChatMessages(greeting, current), [...greeting, current]);
  const assistants = Array.from({ length: 24 }, (_, i) => message('assistant', `greeting ${i}`));
  assert.deepEqual(outgoingChatMessages(assistants, current), [...assistants.slice(1), current]);
  assert.equal(assistants[0].content, 'greeting 0');
});

test('host budget eviction drops answers orphaned by an evicted user while preserving later consecutive roles', () => {
  const input = request([message('user', 'U'.repeat(12000)), message('assistant', 'A'.repeat(12000)),
    message('assistant', 'B'.repeat(1000)), message('user', 'C'.repeat(12000)),
    message('assistant', 'D'.repeat(11000)), message('user', 'current'.repeat(429))]);
  const before = structuredClone(input);
  const output = validateChatRequest(input);
  assert.deepEqual(output.messages, input.messages.slice(3));
  assert.ok(output.messages.reduce((n, m) => n + m.content.length, 0) <= 48000);
  assert.deepEqual(input, before);
});

test('host preserves an uncut greeting and truncates only old long text with valid surrogate boundaries', () => {
  const long = 'head' + 'a'.repeat(16010) + '😀TAIL';
  const input = request([message('assistant', 'greeting'), message('user', 'old question'),
    message('assistant', long), message('user', 'current original')]);
  const before = structuredClone(input);
  const output = validateChatRequest(input);
  assert.equal(output.messages[0].content, 'greeting');
  assert.equal(output.messages[1].content, 'old question');
  assert.match(output.messages[2].content, /中段已省略/u);
  assert.ok(output.messages[2].content.includes('head'));
  assert.ok(output.messages[2].content.endsWith('😀TAIL'));
  assert.ok(output.messages[2].content.length <= 16000);
  assert.equal(output.messages[3].content, 'current original');
  assert.deepEqual(input, before);
});

test('host rejects oversized current user text without altering the input', () => {
  const input = request([message('assistant', 'greeting'), message('user', 'x'.repeat(16001))]);
  const before = structuredClone(input);
  assert.throws(() => validateChatRequest(input), /16000/);
  assert.deepEqual(input, before);
});
