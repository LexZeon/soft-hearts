import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplySpeechState } from '../src/ui/reply-speech';

test('a chat is held only after expecting speech and releases on its matching end', () => {
  const state = new ReplySpeechState();
  assert.equal(state.pending, false);
  state.begin('chat-a'); assert.equal(state.pending, false);
  assert.equal(state.expect('chat-a'), true); assert.equal(state.pending, true);
  assert.equal(state.end('chat-a'), true); assert.equal(state.pending, false);
});

test('end before expect does not hold or renew a completed playback', () => {
  const state = new ReplySpeechState(); state.begin('chat-a');
  assert.equal(state.end('chat-a'), true); assert.equal(state.pending, false);
  assert.equal(state.expect('chat-a'), true); assert.equal(state.pending, false);
  assert.equal(state.end('chat-a'), false); assert.equal(state.expect('chat-a'), false);
  state.begin('chat-a'); assert.equal(state.pending, false, 'duplicate begin cannot revive the same completed reply');
});

test('cross-window end before begin is consumed without changing the current reply', () => {
  const state = new ReplySpeechState(); state.begin('chat-a'); state.expect('chat-a');
  assert.equal(state.end('chat-b'), false); assert.equal(state.pending, true);
  state.begin('chat-b'); assert.equal(state.expect('chat-b'), true); assert.equal(state.pending, false);
});

test('a new reply rejects stale expectations and ends without releasing its own hold', () => {
  const state = new ReplySpeechState(); state.begin('chat-a'); state.expect('chat-a');
  state.begin('chat-b'); state.expect('chat-b');
  assert.equal(state.expect('chat-a'), false); assert.equal(state.end('chat-a'), false); assert.equal(state.pending, true);
  assert.equal(state.expect('chat-b'), false); assert.equal(state.pending, true);
  assert.equal(state.end('chat-b'), true); assert.equal(state.pending, false);
});

test('clear drops pending and early state so greetings and new contexts stay independent', () => {
  const state = new ReplySpeechState(); state.begin('chat-a'); state.expect('chat-a'); state.end('early-b');
  state.clear(); assert.equal(state.pending, false);
  assert.equal(state.expect('chat-a'), false); assert.equal(state.end('chat-a'), false); assert.equal(state.pending, false);
  state.begin('early-b'); state.expect('early-b'); assert.equal(state.pending, true, 'clear removed the cached end');
  state.clear(); state.begin('fresh-c'); state.expect('fresh-c');
  assert.equal(state.end('chat-a'), false); assert.equal(state.pending, true);
});

test('early-end storage is bounded and keeps the most recent eight distinct IDs', () => {
  const evicted = new ReplySpeechState();
  for (let index = 0; index < 9; index++) assert.equal(evicted.end(`early-${index}`), false);
  evicted.begin('early-0'); evicted.expect('early-0'); assert.equal(evicted.pending, true);
  const retained = new ReplySpeechState();
  for (let index = 0; index < 9; index++) retained.end(`early-${index}`);
  retained.begin('early-1'); retained.expect('early-1'); assert.equal(retained.pending, false);
  retained.begin('early-8'); retained.expect('early-8'); assert.equal(retained.pending, false);
});

test('a late old playback promise cannot release the next chat', async () => {
  const state = new ReplySpeechState(); state.begin('chat-a'); state.expect('chat-a');
  let finish!: () => void;
  const oldPlayback = new Promise<void>(resolve => { finish = resolve; });
  const release = oldPlayback.finally(() => state.end('chat-a'));
  state.begin('chat-b'); state.expect('chat-b'); finish(); await release;
  assert.equal(state.pending, true); state.end('chat-b'); assert.equal(state.pending, false);
});
