import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChatRequest } from '../electron/validation';
import { ambientCommentHistoryText, appendReplyHistory, outgoingChatMessages, trimReplyHistory } from '../src/ui/reply-history';
import type { ChatMessage } from '../shared/contracts';

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

test('production append, proactive append and outgoing never retain a reply whose original user was evicted', () => {
  const history = [msg('user', 'U0'), msg('assistant', 'A0a'), msg('assistant', 'A0b'), msg('assistant', 'A0c'),
    msg('user', 'U1'), ...Array.from({ length: 19 }, (_, i) => msg('assistant', `A1-${i}`))];
  assert.equal(history.length, 24);
  const original = structuredClone(history), nextUser = msg('user', 'U2'), nextBefore = structuredClone(nextUser);
  const added = appendReplyHistory(history, nextUser, 'A2');
  assert.deepEqual(added, [...history.slice(4), nextUser, msg('assistant', 'A2')]);
  assert.ok(added.every(item => !['A0a', 'A0b', 'A0c'].includes(item.content)));
  const proactive: ChatMessage = { role: 'assistant', content: ambientCommentHistoryText('主动评论原文'),
    origin: { kind: 'proactive', id: 'initiative', at: 1000, sources: ['ambient'], labels: ['系统播放声音'] } };
  const proactiveBefore = structuredClone(proactive);
  const withProactive = trimReplyHistory([...added, proactive]);
  const finalUser = msg('user', 'U3 原文😀');
  const outgoing = outgoingChatMessages(withProactive, finalUser);
  assert.deepEqual(outgoing, [...added, proactive, finalUser]);
  assert.deepEqual(outgoing.at(-2)?.origin, proactive.origin);
  assert.deepEqual(history, original); assert.deepEqual(nextUser, nextBefore); assert.deepEqual(proactive, proactiveBefore);
  const validated = validateChatRequest({ id: 'production_chain', messages: outgoing, attachments: [] });
  assert.deepEqual(validated.messages.map(({ role, content }) => ({ role, content })),
    outgoing.map(({ role, content }) => ({ role, content })));
  assert.match(validated.messages.at(-2)!.content, /系统播放声音.*不是用户发言或偏好/u);
  assert.equal(validated.messages.at(-1)!.content, 'U3 原文😀');
});

test('uncut greeting and consecutive roles remain unchanged, including proactive metadata', () => {
  const greeting: ChatMessage = { role: 'assistant', content: '问候', origin: {
    kind: 'proactive', id: 'greeting', at: 2000, sources: ['text'], labels: ['文字'] } };
  const history = [greeting, msg('assistant', '紧接着的问候'), msg('user', '用户一'), msg('user', '用户二')];
  const before = structuredClone(history);
  assert.deepEqual(trimReplyHistory(history), history);
  assert.deepEqual(outgoingChatMessages(history, msg('user', '当前')), [...history, msg('user', '当前')]);
  assert.deepEqual(history, before);
  const assistantOnly = Array.from({ length: 25 }, (_, i) => msg('assistant', `问候${i}`));
  assert.deepEqual(trimReplyHistory(assistantOnly), assistantOnly.slice(1), 'a cut containing no user preserves surviving greetings');
});

test('a production cut retains consecutive later users and does not mutate the original list', () => {
  const history = [msg('user', 'removed'), msg('assistant', 'orphan'), msg('assistant', 'orphan2'),
    msg('user', 'later1'), msg('user', 'later2'), ...Array.from({ length: 20 }, (_, i) => msg('assistant', `kept${i}`))];
  const before = structuredClone(history);
  assert.deepEqual(trimReplyHistory(history), history.slice(3));
  assert.deepEqual(history, before);
});
