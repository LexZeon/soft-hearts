import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { CompanionService } from '../electron/companion';
import { PersistentClaudeChat } from '../electron/claude-session';
import { encodeWav } from '../src/ui/MediaInput';
import { VoiceContinuationStatus } from '../src/ui/VoiceContinuationStatus';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { VoiceConversationEvent } from '../shared/voice-conversation';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { const end = performance.now() + 2000; while (!check() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'bounded current caller did not advance'); }

function body(prompt: string, text: string) {
  const marker = prompt.match(/<sh-state-[a-f0-9]+>/)?.[0]; assert.ok(marker);
  return `${text}\n${marker}{"context":"support","delta":{"O":2},"confidence":0.9,"reason":"原创合成"}${marker.replace('<', '</')}`;
}
function readRecord(service: CompanionService) {
  const scope = service.currentScope(), page = service.memory.list(scope);
  assert.equal(page.total, 1); return service.memory.read(scope, page.records[0].id)!;
}

/**
 * The actual voice host (electron/voice-chat-host.ts, imported, not cut out of
 * main.ts) over Claude's one-process-per-message path, where a reply cannot be
 * stopped and merged: an addition waits and becomes an explicit continuation.
 */
async function host(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r33-caller-'));
  const service = new CompanionService(directory, () => {}), events: VoiceConversationEvent[] = [], rewards: string[] = [];
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.provider.kind = 'claude'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };
  const finals: string[] = [], requests: { prompt: string; done: ReturnType<typeof deferred<void>> }[] = [];
  const output = { textContent: '', hidden: false, setAttribute() {} }, status = new VoiceContinuationStatus(output as any);
  const pending = new Map<string, AbortController>();
  const claude = new PersistentClaudeChat({ enabled: false, async perMessage(task, signal, emit) {
    const request = { prompt: task.prompt, done: deferred<void>() }; requests.push(request);
    await request.done.promise; signal.throwIfAborted(); emit('delta', body(task.prompt, `回复${requests.indexOf(request) + 1}。`));
  } });
  const voice = new VoiceChatHost({
    broadcast: event => { events.push(event); status.receive(event); }, memoryChanged() {},
    windowVisible: sender => sender === 77, media: () => ({ voiceInput: true, voiceOwner: 'controls' }), turnOffVoiceInput() {},
    speechScope: () => 'fixture-context', settings: () => settings, companion: () => service, ambient: () => null,
    reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
    releaseChat: replyId => { pending.delete(replyId); }, userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude, languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => { assert.ok(finals.length); return finals.shift()!; }, stopReading() {}, prepareSpeech() {},
  });
  const binding = voice.open(77, 'controls'); let seq = 0;
  const submit = async (text: string) => {
    finals.push(text); const current = ++seq;
    const result = voice.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: current,
      wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    assert.equal(result.state, 'queued'); await until(() => events.some(value => value.type === 'row' && value.seq === current));
    return result;
  };
  try { await run({ voice, pending, service, events, rewards, requests, output, submit,
    seal: () => voice.pipeline.finishSpeaking(77, binding.captureSessionId) }); }
  finally {
    for (const request of requests) request.done.resolve();
    voice.dispose(); await tick(); await voice.drain(); await service.flush();
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-r33-caller-'));
    await rm(directory, { recursive: true });
  }
}

test('actual host PCM→ASR→per-message caller shows queued and distinct continuation, one archive/appraisal/final speech', async () => {
  await host(async f => {
    await f.submit('先说A'); await until(() => f.requests.length === 1);
    await f.submit('不是A是B'); assert.match(f.output.textContent, /排队/); assert.equal(f.pending.size, 1);
    assert.equal(f.seal(), true); f.requests[0].done.resolve(); await until(() => f.requests.length === 2);
    assert.match(f.output.textContent, /另发续接请求/);
    const starts = f.events.filter((value: any) => value.type === 'start'); assert.equal(starts.length, 2);
    assert.notEqual(starts[0].replyId, starts[1].replyId); assert.equal(starts[0].groupId, starts[1].groupId);
    assert.match(f.requests[1].prompt, /已处理的前文/); assert.match(f.requests[1].prompt, /不是A是B/);
    // R33: the actual request frames a change as the user's, never her mishearing.
    assert.match(f.requests[1].prompt, /不要说成是你听错/); assert.doesNotMatch(f.requests[1].prompt, /纠正理解/);
    assert.equal(f.events.filter((value: any) => value.type === 'speech').length, 0);
    f.requests[1].done.resolve(); await until(() => /已处理完成/.test(f.output.textContent)); await f.voice.drain();
    assert.deepEqual(f.rewards, ['chat', 'appraisal']); assert.equal(f.events.filter((value: any) => value.type === 'speech').length, 1);
    const record = readRecord(f.service);
    assert.equal(record.messages[0].content, '先说A\n不是A是B'); assert.equal(record.messages[1].content, '回复1。回复2。');
    assert.equal(f.pending.size, 0);
  });
});

test('continuation presentation rejects old reply/scope and clears on withdrawal without certifying understanding', () => {
  const output = { textContent: '', hidden: false, setAttribute() {} }, status = new VoiceContinuationStatus(output as any);
  const base = { epoch: 'epoch', owner: 'controls' as const, groupId: 'group' };
  status.receive({ ...base, type: 'row', seq: 1, text: '原文' });
  status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'queued' });
  status.receive({ ...base, type: 'start', replyId: 'first' });
  status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'request' });
  assert.match(output.textContent, /排队/);
  status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'merging' });
  assert.match(output.textContent, /补充已接收，正在合并/);
  status.receive({ ...base, type: 'start', replyId: 'second' });
  status.receive({ ...base, type: 'continuation', replyId: 'second', state: 'merged' });
  const label = output.textContent; assert.match(label, /已合并补充，正在回复/);
  status.receive({ ...base, type: 'continuation', replyId: 'first', state: 'settled' });
  status.receive({ ...base, epoch: 'old', type: 'continuation', replyId: 'second', state: 'continuation' });
  assert.equal(output.textContent, label);
  status.receive({ ...base, type: 'continuation', replyId: 'second', state: 'unconfirmed' });
  assert.match(output.textContent, /不会自动重发/);
  status.receive({ ...base, type: 'cancelled', replyId: 'second' }); assert.equal(output.hidden, true);
  status.receive({ ...base, type: 'continuation', replyId: 'second', state: 'merged' }); assert.equal(output.textContent, '');
});
