import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/contracts';
import { CompanionService } from '../electron/companion';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/claude-session';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { VoiceConversationSession } from '../electron/voice-conversation-session';
import type { VoiceTextCompletion, VoiceTextLeg, VoiceTextSettlement } from '../electron/voice-text-continuation';
import { encodeWav } from '../src/ui/MediaInput';
import { VoiceContinuationStatus } from '../src/ui/VoiceContinuationStatus';
import { appendVoiceReply, outgoingChatMessages, trimReplyHistory } from '../src/ui/reply-history';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { voiceUtteranceMessages, type VoiceConversationEvent } from '../shared/voice-conversation';
import { memoryProviderScope } from '../electron/companion';
import type { ClaudeTimingInfo } from '../electron/claude-session';
import { fakeClaudeStream } from './helpers/fake-claude-stream';

/**
 * R33 continuous voice on the Claude build. Claude Code 2.1.316 never merges a
 * message written mid-turn into that turn (it queues it as a whole new turn),
 * so the merge is: Claude Code's own interrupt for the reply being generated,
 * then only the new sentences as the next turn on the same warm process. A
 * reply that already finished gets an explicit continuation instead. The fake
 * CLI reproduces the measured behaviour (tests/helpers/fake-claude-stream.ts).
 */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, ms = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

type Fake = Awaited<ReturnType<typeof fakeClaudeStream>>;
interface Harness {
  host: VoiceChatHost; chat: PersistentClaudeChat; claude: Fake; service: CompanionService;
  events: VoiceConversationEvent[]; states: string[]; rewards: string[]; ambientTurns: string[]; asr: string[];
  status: { textContent: string; hidden: boolean }; settings: typeof DEFAULT_SETTINGS; captureSessionId: string;
  setScope(value: string): void; blockGroups(gate: Promise<void> | null): void;
  say(text: string): Promise<void>; submitRaw(captureSessionId: string, text: string): unknown; seal(): boolean;
  starts(): string[]; text(replyId: string): string; terminal(replyId: string): Extract<VoiceConversationEvent, { type: 'terminal' }> | undefined;
  speech(): Extract<VoiceConversationEvent, { type: 'speech' }>[]; record(): any; pending: Map<string, AbortController>;
  timing: (ClaudeTimingInfo & { id: string })[];
}

async function voice(run: (h: Harness) => Promise<void>, options: { persistent?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-r33-voice-'));
  const claude = await fakeClaudeStream();
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const rewards: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };
  const timing: (ClaudeTimingInfo & { id: string })[] = [];
  const chat = new PersistentClaudeChat({ enabled: options.persistent ?? true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => settings.provider, chattedBefore: () => false, interruptGraceMs: 3000, log: () => {},
    timing: { dispatched: (id, info) => { timing.push({ id, ...info }); }, firstDelta() {} } });
  const events: VoiceConversationEvent[] = [], states: string[] = [], ambientTurns: string[] = [], asr: string[] = [];
  const output = { textContent: '', hidden: false, setAttribute() {} }, status = new VoiceContinuationStatus(output as any);
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const pending = new Map<string, AbortController>();
  let scope = 'fixture-scope', gate: Promise<void> | null = null;
  const host = new VoiceChatHost({
    broadcast: event => { events.push(event); status.receive(event); if (event.type === 'continuation') states.push(event.state); },
    memoryChanged() {},
    windowVisible: sender => sender === 77,
    media: () => media,
    turnOffVoiceInput: () => { media.voiceInput = false; },
    speechScope: () => scope,
    settings: () => settings,
    companion: () => ({ beginVoiceGroup: async (...args: Parameters<CompanionService['beginVoiceGroup']>) => {
      if (gate) await gate; return service.beginVoiceGroup(...args);
    } }),
    ambient: () => ({ acceptUserTurn: async (_id: string, text: string) => { ambientTurns.push(text); } }),
    reserveChat: (replyId, controller) => { if (pending.size) return false; pending.set(replyId, controller); return true; },
    releaseChat: replyId => { pending.delete(replyId); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: chat,
    languageProfile: () => null,
    chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => { const text = asr.shift(); assert.ok(text !== undefined, 'only microphone PCM reaches recognition'); return text; },
    stopReading() {},
    prepareSpeech() {},
  });
  const binding = host.open(77, 'controls');
  let captureSeq = 0;
  const wav = () => encodeWav(new Float32Array(4096).fill(0.1));
  const rows = () => events.filter((event): event is Extract<VoiceConversationEvent, { type: 'row' }> => event.type === 'row');
  const h: Harness = {
    host, chat, claude, service, events, states, rewards, ambientTurns, asr, status: output, settings, pending, timing,
    captureSessionId: binding.captureSessionId,
    setScope: value => { scope = value; },
    blockGroups: value => { gate = value; },
    async say(text) {
      asr.push(text);
      const receipt = host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++captureSeq, wav: wav() });
      assert.equal(receipt.state, 'queued');
      await until(() => rows().some(row => row.text.split('\n').at(-1) === text), 5000, 'row ' + text);
    },
    submitRaw: (captureSessionId, text) => { asr.push(text); return host.pipeline.submit(77, { captureSessionId, captureSeq: captureSeq + 1, wav: wav() }); },
    seal: () => host.pipeline.finishSpeaking(77, binding.captureSessionId),
    starts: () => events.filter(event => event.type === 'start').map(event => (event as { replyId: string }).replyId),
    text: replyId => events.filter(event => event.type === 'delta' && event.replyId === replyId).map(event => (event as { text: string }).text).join(''),
    terminal: replyId => events.find((event): event is Extract<VoiceConversationEvent, { type: 'terminal' }> => event.type === 'terminal' && event.replyId === replyId),
    speech: () => events.filter((event): event is Extract<VoiceConversationEvent, { type: 'speech' }> => event.type === 'speech'),
    record() {
      const memoryScope = service.currentScope(), page = service.memory.list(memoryScope);
      assert.equal(page.total, 1, 'one utterance is archived once');
      return service.memory.read(memoryScope, page.records[0].id)!;
    },
  };
  try { await run(h); }
  finally {
    gate = null;
    host.dispose(); chat.dispose();
    await host.drain(); await service.flush();
    const pids = (await claude.spawns()).map(spawn => spawn.pid);
    await until(() => pids.every(pid => !alive(pid)), 8000, 'fake Claude processes to exit');
    await claude.cleanup();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
const noTail = (h: Harness) => {
  for (const event of h.events) if (event.type === 'delta' || event.type === 'speech') assert.ok(!event.text.includes('sh-state'), 'no private tail reaches the screen');
};

test('one sentence goes out at once; three more merge into the reply or continue it; one archive, one appraisal, one reading', async () => {
  await voice(async h => {
    await h.say('#hold:a 先说第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    assert.deepEqual(await h.claude.users(), ['#hold:a 先说第一句'], 'the first sentence was sent before the user finished');
    await h.say('#hold:b 第二句');
    await until(() => h.starts().length === 2 && h.text(h.starts()[1]).length > 0, 5000, 'second reply streaming');
    await h.say('#hold:c 第三句');
    await until(() => h.starts().length === 3 && h.text(h.starts()[2]).length > 0, 5000, 'third reply streaming');
    await h.claude.release('c');
    await until(() => !!h.terminal(h.starts()[2]), 5000, 'third reply done');
    await h.say('第四句');
    await until(() => h.starts().length === 4, 5000, 'fourth reply');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();

    assert.deepEqual(await h.claude.users(), ['#hold:a 先说第一句', '#hold:b 第二句', '#hold:c 第三句', '第四句'],
      'every sentence reaches Claude exactly once; the earlier part is never resent');
    assert.deepEqual(await h.claude.controls(), ['interrupt', 'interrupt'], 'two merges, each one Claude Code interrupt');
    assert.equal((await h.claude.spawns()).length, 1, 'all four turns ran on one warm process');
    const [r1, r2, r3, r4] = h.starts();
    assert.equal(new Set(h.starts()).size, 4);
    assert.deepEqual([r1, r2, r3, r4].map(id => h.terminal(id)?.superseded === true), [true, true, false, false]);
    assert.deepEqual([r1, r2, r3, r4].map(id => h.terminal(id)?.complete), [false, false, true, true]);
    const order = ['request', 'merging', 'merged', 'merging', 'merged', 'continuation', 'settled'];
    let at = 0; for (const state of h.states) if (state === order[at]) at++;
    assert.equal(at, order.length, 'UI went request → merging → merged → … → continuation → settled: ' + h.states.join(','));
    assert.deepEqual(h.rewards, ['chat', 'appraisal'], 'one acceptance and one appraisal for the whole utterance');
    assert.equal(h.speech().length, 1); assert.equal(h.speech()[0].replyId, r4);
    assert.equal(h.speech()[0].text, '收到，第四句', 'only the final reply is read aloud');
    const record = h.record();
    assert.equal(record.messages[0].content, '#hold:a 先说第一句\n#hold:b 第二句\n#hold:c 第三句\n第四句');
    assert.equal(record.messages[1].status, 'complete');
    assert.ok(!record.messages[1].content.includes('sh-state'));
    assert.equal(h.pending.size, 0);
    noTail(h);
  });
});

test('race 1: the next sentence arrives before the first one reaches Claude; it waits, then merges without a resend', async () => {
  await voice(async h => {
    const gate = deferred<void>(); h.blockGroups(gate.promise);
    await h.say('#wait:w 第一句');
    await h.say('第二句');
    assert.deepEqual(await h.claude.users(), [], 'nothing was written yet');
    assert.ok(h.states.includes('queued') && !h.states.includes('merging'));
    assert.match(h.status.textContent, /排队/);
    h.blockGroups(null); gate.resolve();
    await until(() => h.starts().length === 2, 5000, 'second reply');
    await until(() => !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    assert.deepEqual(await h.claude.users(), ['#wait:w 第一句', '第二句']);
    assert.deepEqual(await h.claude.controls(), ['interrupt']);
    const [r1, r2] = h.starts();
    assert.equal(h.text(r1), '', 'the stopped first reply showed nothing');
    assert.equal(h.terminal(r1)?.superseded, true);
    assert.equal(h.text(r2).startsWith('收到，第二句'), true);
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
    assert.equal(h.record().messages[0].content, '#wait:w 第一句\n第二句');
  });
});

test('race 2: the next sentence arrives while the reply streams; text already shown stays with that reply, late text included', async () => {
  await voice(async h => {
    await h.say('#hold:g #late 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    await h.say('第二句');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    const [r1, r2] = h.starts();
    assert.equal(h.text(r1), '收到，（迟到的半句）', 'everything Claude streamed before it stopped belongs to the first reply');
    assert.ok(!h.text(r2).includes('迟到'), 'late text of the stopped turn never leaks into the next reply');
    assert.equal(h.text(r2), '收到，第二句');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    const record = h.record();
    assert.equal(record.messages[1].content, '收到，（迟到的半句）\n收到，第二句', 'the archive keeps what was shown; a cut-off reply ends its own line');
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
  });
});

test('race 3: the reply already finished; the next sentence is an explicit continuation, no interrupt', async () => {
  await voice(async h => {
    await h.say('第一句');
    await until(() => h.starts().length === 1 && !!h.terminal(h.starts()[0]), 5000, 'first reply done');
    await h.say('第二句');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    assert.deepEqual(await h.claude.controls(), []);
    assert.ok(h.states.includes('continuation') && !h.states.includes('merging'));
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
    assert.equal(h.speech().length, 1); assert.equal(h.speech()[0].text, '收到，第二句');
  });
});

test('race 3b: the merge was asked for but Claude had just finished; that reply stands and the sentence continues it, still one extra turn', async () => {
  await voice(async h => {
    await h.say('#first:f 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    await h.say('第二句');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    const [r1, r2] = h.starts();
    assert.equal(h.terminal(r1)?.complete, true, 'it finished before the interrupt was read');
    assert.equal(h.terminal(r1)?.superseded ?? false, false);
    assert.equal(h.text(r1), '收到，#first:f 第一句');
    assert.equal(h.text(r2), '收到，第二句', 'the next turn was not hit by the stale interrupt');
    assert.ok(h.states.includes('merging') && h.states.includes('continuation'));
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    assert.deepEqual(await h.claude.users(), ['#first:f 第一句', '第二句'], 'no hidden third request');
    assert.deepEqual(await h.claude.controls(), ['interrupt']);
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
    assert.equal(h.speech()[0].text, '收到，第二句');
  });
});

test('correction "不是A，是B": Claude gets only the correction plus the merge note, the old half tail stays hidden, the answer is about B', async () => {
  await voice(async h => {
    await h.say('#tail:x 我想去A');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    await h.say('不是A，是B');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    const inputs = (await h.claude.inputs()).filter(row => row.user !== undefined);
    assert.equal(inputs[1].user, '不是A，是B');
    assert.match(inputs[1].prompt!, /还没说完就停下了/, 'the turn says why the last reply stopped');
    assert.match(inputs[1].prompt!, /我想去A/, 'the earlier sentence is context, not a new message');
    const nonces = inputs.map(row => [...row.prompt!.matchAll(/<sh-state-([a-f0-9]+)>/g)].map(match => match[1]).at(-1));
    assert.notEqual(nonces[0], nonces[1], 'each Claude turn has its own tail nonce');
    const [r1, r2] = h.starts();
    assert.equal(h.text(r1), '收到，#tail:x 我想去A', 'the half-written tail of the stopped reply is hidden');
    assert.equal(h.text(r2), '收到，不是A，是B');
    assert.equal(h.speech().length, 1); assert.equal(h.speech()[0].text, '收到，不是A，是B');
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
    assert.equal(h.record().messages[0].content, '#tail:x 我想去A\n不是A，是B');
    assert.equal((await h.claude.spawns()).length, 1, 'a reply cut inside its tail still lines up with the warm session');
    noTail(h);
  });
});

test('stopping mid-utterance ends it: no merge afterwards, no settlement or reading, late text dropped, the original kept', async () => {
  await voice(async h => {
    await h.say('#hold:k 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    const before = h.events.length;
    h.host.revoke('stop-generation');
    await until(() => h.pending.size === 0, 5000, 'reply slot released'); await h.host.drain();
    await until(async () => (await h.claude.controls()).length === 1, 5000, 'interrupt');
    const after = h.events.slice(before);
    assert.ok(after.some(event => event.type === 'cancelled'));
    assert.ok(after.some(event => event.type === 'draft' && event.text === '#hold:k 第一句'), 'the original is handed back');
    assert.ok(!after.some(event => event.type === 'delta'), 'no late text after stopping');
    assert.equal(h.speech().length, 0);
    assert.deepEqual(h.rewards, ['chat']);
    assert.equal(h.record().messages[1].status, 'stopped');
    assert.equal(h.host.capture, undefined);
    assert.equal((h.submitRaw(h.captureSessionId, '还想说') as { state: string }).state, 'rejected', 'the stopped capture takes nothing more');
    h.asr.length = 0;
  });
});

for (const change of ['model', 'character'] as const) {
  test(`changing the ${change} during a merged reply cancels it; nothing from the old utterance reaches the new context`, async () => {
    await voice(async h => {
      await h.say('#hold:p 第一句');
      await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
      await h.say('#hold:q 第二句');
      await until(() => h.starts().length === 2 && h.text(h.starts()[1]).length > 0, 5000, 'merged reply streaming');
      const before = h.events.length;
      if (change === 'model') h.settings.provider = { ...h.settings.provider, model: 'sonnet' };
      else { h.setScope('another-character'); await h.service.context('another-character', h.settings.provider, '另一个角色'); }
      // What main does on a settings or context change.
      h.host.revoke('scope-change'); h.chat.close('context');
      await until(() => h.pending.size === 0, 5000, 'reply slot released'); await h.host.drain();
      const after = h.events.slice(before);
      assert.ok(after.some(event => event.type === 'cancelled'));
      assert.ok(!after.some(event => event.type === 'delta' || event.type === 'speech'));
      assert.ok(!h.states.includes('settled'));
      assert.deepEqual(h.rewards, ['chat']);
      assert.deepEqual(await h.claude.users(), ['#hold:p 第一句', '#hold:q 第二句']);
    });
  });
}

test('background audio (system sound, lyrics) never joins the utterance or triggers a merge', async () => {
  await voice(async h => {
    await h.say('#hold:h 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    // System audio has its own capture and IPC route (submitAmbientAudio /
    // submitAudioReadingPcm); even if its audio carried a foreign capture id to
    // the voice route, the voice capture refuses it before recognition.
    const receipt = h.submitRaw('system-audio-capture', '歌词：月亮代表我的心') as { state: string; reason?: string };
    assert.deepEqual(receipt, { state: 'rejected', reason: 'wrong-scope' });
    await tick(); await tick();
    assert.deepEqual(h.asr, ['歌词：月亮代表我的心'], 'the lyric never reached recognition');
    h.asr.length = 0;
    assert.ok(!h.states.includes('merging'));
    assert.deepEqual(await h.claude.controls(), []);
    await h.claude.release('h');
    await until(() => !!h.terminal(h.starts()[0]), 5000, 'reply done');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    assert.equal(h.record().messages[0].content, '#hold:h 第一句');
    assert.deepEqual(await h.claude.users(), ['#hold:h 第一句']);
    assert.deepEqual(h.ambientTurns, ['#hold:h 第一句'], 'the ambient side only learns of the human turn');
  });
});

test('one process per message (persistent off): no merge is possible, the addition waits and continues after the reply', async () => {
  await voice(async h => {
    await h.say('#hold:m 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    await h.say('第二句');
    await tick();
    assert.ok(h.states.includes('queued') && !h.states.includes('merging'));
    assert.match(h.status.textContent, /排队/);
    await h.claude.release('m');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'second reply done');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'settled'); await h.host.drain();
    assert.deepEqual(await h.claude.controls(), []);
    assert.equal((await h.claude.spawns()).length, 2);
    assert.deepEqual(h.rewards, ['chat', 'appraisal']);
    assert.equal(h.speech()[0].text, '收到，第二句');
  }, { persistent: false });
});

/**
 * The renderer's chat history after these events, by its own rules
 * (src/main.ts receiveVoiceConversation / onStream): the first row of an
 * utterance adds one user message that later rows update in place; each reply's
 * terminal adds its shown text through the real appendVoiceReply.
 */
function rendererHistory(events: VoiceConversationEvent[]) {
  let history: { role: 'user' | 'assistant'; content: string }[] = [];
  const users = new Map<string, { role: 'user'; content: string }>(), replies = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'row') {
      const message = users.get(event.groupId);
      if (message) message.content = event.text;
      else { const created = { role: 'user' as const, content: event.text }; users.set(event.groupId, created); history = trimReplyHistory([...history, created]); }
    } else if (event.type === 'delta') replies.set(event.replyId, (replies.get(event.replyId) ?? '') + event.text);
    else if (event.type === 'terminal') history = appendVoiceReply(history, replies.get(event.replyId) ?? '');
  }
  return history.map(message => ({ ...message }));
}
const settledCount = (h: Harness) => h.states.filter(state => state === 'settled').length;

test('after voice (merged, continued, then another utterance) the next typed message stays on the same warm process, nothing resent or missing', async () => {
  await voice(async h => {
    await h.say('#hold:v 第一句');
    await until(() => h.starts().length === 1 && h.text(h.starts()[0]).length > 0, 5000, 'first reply streaming');
    await h.say('第二句');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'merged reply done');
    await h.say('第三句');
    await until(() => h.starts().length === 3 && !!h.terminal(h.starts()[2]), 5000, 'continuation done');
    assert.equal(h.seal(), true);
    await until(() => settledCount(h) === 1, 5000, 'first utterance settled'); await h.host.drain();
    const firstShown = voiceUtteranceMessages('#hold:v 第一句\n第二句\n第三句', h.starts().map(id => h.text(id)));
    assert.deepEqual(rendererHistory(h.events), firstShown, 'renderer and host agree on how the utterance is shown');
    await h.say('再说一段');
    await until(() => h.starts().length === 4 && !!h.terminal(h.starts()[3]), 5000, 'second utterance reply');
    assert.equal(h.seal(), true);
    await until(() => settledCount(h) === 2, 5000, 'second utterance settled'); await h.host.drain();
    const history = rendererHistory(h.events);
    assert.deepEqual(history, [...firstShown, ...voiceUtteranceMessages('再说一段', ['收到，再说一段'])]);

    // The next typed message, exactly as the renderer sends it.
    const typed: string[] = [];
    const outcome = await h.chat.stream({ kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '.', imageDataUrls: [],
      replyId: 'typed', session: { key: 'fixture-scope', basePersona: h.settings.persona, persona: `${h.settings.persona}\n\n当前心情：平静。`,
        messages: outgoingChatMessages(history, { role: 'user', content: '接着打字说一句' }) } },
    new AbortController().signal, (type, text) => { if (type === 'delta') typed.push(text); });
    assert.equal(outcome.superseded, false); assert.equal(typed.join(''), '收到，接着打字说一句');
    assert.equal((await h.claude.spawns()).length, 1, 'no new Claude process after the voice utterances');
    assert.deepEqual(h.timing.map(row => row.process), ['cold', 'warm', 'warm', 'warm', 'warm'], 'only the very first turn was cold');
    const last = (await h.claude.inputs()).filter(row => row.user !== undefined).at(-1)!;
    const data = JSON.parse(last.prompt!.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);
    assert.deepEqual(data, { history: [], currentUser: '接着打字说一句' }, 'Claude already holds both utterances; nothing is resent');
    assert.deepEqual((await h.claude.users()).slice(0, 4), ['#hold:v 第一句', '第二句', '第三句', '再说一段'], 'each sentence reached Claude exactly once');
    assert.deepEqual(h.host.history?.messages, history, 'a following utterance starts from the same shown window');
    assert.equal(h.host.history?.providerScope, memoryProviderScope(h.settings.provider));
  });
});

/* ---------- Claude process / session level ---------- */

const persona = '你是测试角色小桃。';
function task(messages: ChatMessage[], id: string): CompanionClaudeTask {
  const composed = `${persona}\n\n当前心情：平静。`;
  return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, prompt: '.', imageDataUrls: [], replyId: id,
    session: { key: 'conversation', basePersona: persona, persona: composed, messages } };
}
async function process1(run: (chat: PersistentClaudeChat, claude: Fake) => Promise<void>, graceMs = 3000) {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => false, interruptGraceMs: graceMs, log: () => {} });
  try { await run(chat, claude); }
  finally {
    chat.dispose();
    const pids = (await claude.spawns()).map(spawn => spawn.pid);
    await until(() => pids.every(pid => !alive(pid)), 8000, 'exit');
    await claude.cleanup();
  }
}

test('supersede stops a streaming turn early, keeps its text, and the next turn on the same process carries only the new part', async () => {
  await process1(async (chat, claude) => {
    const deltas: string[] = [], hook: { supersede?: () => boolean } = {};
    const first = chat.stream(task([{ role: 'user', content: '#hold:s 说点什么' }], 'one'), new AbortController().signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, { started: value => { hook.supersede = value; } });
    await until(() => deltas.length > 0, 5000, 'delta');
    assert.ok(hook.supersede); assert.equal(hook.supersede(), true); assert.equal(hook.supersede(), false, 'one request per turn');
    const outcome = await first;
    assert.deepEqual(outcome, { superseded: true, output: '收到，' });
    const second: string[] = [];
    const next = await chat.stream(task([{ role: 'user', content: '#hold:s 说点什么' }, { role: 'assistant', content: '收到，' }, { role: 'user', content: '补充' }], 'two'),
      new AbortController().signal, (type, text) => { if (type === 'delta') second.push(text); });
    assert.equal(next.superseded, false); assert.equal(second.join(''), '收到，补充');
    assert.equal((await claude.spawns()).length, 1);
    const prompts = (await claude.inputs()).filter(row => row.user !== undefined).map(row => row.prompt!);
    const data = JSON.parse(prompts[1].split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);
    assert.deepEqual(data, { history: [], currentUser: '补充' }, 'Claude already holds the stopped turn; nothing is resent');
  });
});

test('supersede on a turn that already finished is a no-op: full reply, next turn untouched; never offered per message', async () => {
  await process1(async (chat, claude) => {
    const hook: { supersede?: () => boolean } = {}, deltas: string[] = [];
    const first = chat.stream(task([{ role: 'user', content: '#first:z 你好' }], 'one'), new AbortController().signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, { started: value => { hook.supersede = value; } });
    await until(() => deltas.length > 0, 5000, 'delta');
    assert.equal(hook.supersede?.(), true);
    const outcome = await first;
    assert.equal(outcome.superseded, false);
    assert.ok(outcome.output.startsWith('收到，#first:z 你好'));
    assert.equal(hook.supersede?.(), false, 'nothing to stop any more');
    const next: string[] = [];
    await chat.stream(task([{ role: 'user', content: '#first:z 你好' }, { role: 'assistant', content: '收到，#first:z 你好' }, { role: 'user', content: '再见' }], 'two'),
      new AbortController().signal, (type, text) => { if (type === 'delta') next.push(text); });
    assert.equal(next.join(''), '收到，再见');
    assert.deepEqual(await claude.controls(), ['interrupt']);
  });
  let started = 0;
  const perMessage = new PersistentClaudeChat({ enabled: false, perMessage: async (_task, _signal, emit) => { emit('delta', '一次'); } });
  const outcome = await perMessage.stream(task([{ role: 'user', content: '你好' }], 'p'), new AbortController().signal, () => {}, { started: () => { started++; } });
  assert.deepEqual(outcome, { superseded: false, output: '一次' }); assert.equal(started, 0);
});

test('stopping while a merge is pending sends no second interrupt; the drained process serves the next turn', async () => {
  await process1(async (chat, claude) => {
    const hook: { supersede?: () => boolean } = {}, deltas: string[] = [], controller = new AbortController();
    const first = chat.stream(task([{ role: 'user', content: '#hold:c 说点什么' }], 'one'), controller.signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, { started: value => { hook.supersede = value; } });
    await until(() => deltas.length > 0, 5000, 'delta');
    assert.equal(hook.supersede?.(), true);
    controller.abort(new Error('已停止。'));
    await assert.rejects(first, /已停止/);
    const next: string[] = [];
    await chat.stream(task([{ role: 'user', content: '#hold:c 说点什么' }, { role: 'assistant', content: '收到，' }, { role: 'user', content: '换个话题' }], 'two'),
      new AbortController().signal, (type, text) => { if (type === 'delta') next.push(text); });
    assert.equal(next.join(''), '收到，换个话题');
    assert.deepEqual(await claude.controls(), ['interrupt'], 'one interrupt for the one turn');
    assert.equal((await claude.spawns()).length, 1);
  });
});

test('an interrupt that is accepted but never ends the turn: the process is killed after the grace period, nothing hangs', async () => {
  await process1(async (chat, claude) => {
    const hook: { supersede?: () => boolean } = {}, deltas: string[] = [];
    const first = chat.stream(task([{ role: 'user', content: '#deaf:d 说点什么' }], 'one'), new AbortController().signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, { started: value => { hook.supersede = value; } });
    await until(() => deltas.length > 0, 5000, 'delta');
    const asked = Date.now();
    assert.equal(hook.supersede?.(), true);
    await assert.rejects(first);
    assert.ok(Date.now() - asked < 3000, 'bounded by the grace period');
    const next: string[] = [];
    await chat.stream(task([{ role: 'user', content: '重新开始' }], 'two'), new AbortController().signal, (type, text) => { if (type === 'delta') next.push(text); });
    assert.equal(next.join(''), '收到，重新开始');
    assert.equal((await claude.spawns()).length, 2, 'a fresh process, never the stuck one');
  }, 300);
});

test('regroup only rewrites provably identical turns; anything else leaves the record and the next message reopens', async () => {
  await process1(async (chat, claude) => {
    const u = (content: string): ChatMessage => ({ role: 'user', content }), a = (content: string): ChatMessage => ({ role: 'assistant', content });
    const signal = new AbortController().signal, none = () => {};
    await chat.stream(task([u('你好')], 'text-1'), signal, none);
    await chat.stream(task([u('你好'), a('收到，你好'), u('第一句')], 'v-1'), signal, none);
    await chat.stream(task([u('你好'), a('收到，你好'), u('第一句'), a('收到，第一句'), u('第二句')], 'v-2'), signal, none);
    const shown = voiceUtteranceMessages('第一句\n第二句', ['收到，第一句', '收到，第二句']);
    assert.equal(chat.regroup(['v-2'], shown), false, 'not all turns of the utterance');
    assert.equal(chat.regroup(['text-1', 'v-1', 'v-2'], shown), false, 'a turn that is not part of it');
    assert.equal(chat.regroup(['v-1', 'v-2'], voiceUtteranceMessages('第一句\n第二句\n第三句', ['收到，第一句', '收到，第二句'])), false,
      'a sentence Claude never received');
    assert.equal(chat.regroup(['v-1', 'v-2'], voiceUtteranceMessages('第一句\n第二句', ['收到，第一句', '别的回复'])), false, 'a reply Claude did not give');
    assert.equal(chat.regroup(['v-1', 'v-2'], voiceUtteranceMessages('第一句\n第二句', ['收到，第一句'])), false, 'a reply left out');
    assert.equal(chat.regroup(['v-1', 'v-2'], shown), true);
    assert.equal(chat.regroup(['v-1', 'v-2'], shown), false, 'once');
    const next: string[] = [];
    await chat.stream(task([u('你好'), a('收到，你好'), ...shown, u('打字')], 'text-2'), signal, (type, text) => { if (type === 'delta') next.push(text); });
    assert.equal(next.join(''), '收到，打字');
    assert.equal((await claude.spawns()).length, 1);
    // Without the regroup the same shown window does not line up and opens a fresh session.
    await chat.stream(task([u('你好'), a('收到，你好'), u('第一句'), a('收到，第一句'), u('第二句'), a('收到，第二句'), u('打字'), a('收到，打字'), u('再来')], 'text-3'), signal, none);
    assert.equal((await claude.spawns()).length, 2, 'a window that differs from the record never reuses the process');
  });
});

test('session: a superseded leg is never spoken or settled; the next leg carries only new sentences; refusal falls back to continuation', async () => {
  const final = (seq: number) => ({ epoch: 'epoch', groupId: 'group', segmentId: 's' + seq, seq, text: String(seq) });
  for (const accept of [true, false]) {
    const calls: { leg: VoiceTextLeg; done: ReturnType<typeof deferred<VoiceTextCompletion>> }[] = [];
    const merges: string[] = [], states: string[] = [], settlements: VoiceTextSettlement[] = [], speech: boolean[] = [];
    const session = new VoiceConversationSession('epoch', {
      dispatch(leg) { const done = deferred<VoiceTextCompletion>(); calls.push({ leg, done }); return done.promise; },
      merge(leg) { merges.push(leg.replyId); return accept; },
      progress(value) { states.push(value.state); return undefined; },
      userRow() { return undefined; }, reply(value) { if (value.type === 'terminal') speech.push(value.allowSpeech); return undefined; },
      settlement(value) { settlements.push(value); return undefined; }, stopTts() { return undefined; }, cancelled() { return undefined; }, fault() { return undefined; },
    });
    session.acceptFinal(final(1)); await tick();
    session.acceptFinal(final(2));
    assert.deepEqual(merges, [], 'not offered before the turn reached the provider');
    assert.deepEqual(states, ['queued']);
    session.turnReady(calls[0].leg.replyId);
    assert.deepEqual(merges, [calls[0].leg.replyId]);
    assert.deepEqual(states, accept ? ['queued', 'merging'] : ['queued', 'queued']);
    calls[0].done.resolve(accept ? { status: 'superseded', coveredThroughSeq: 1, hasAppraisal: false } : { status: 'complete', coveredThroughSeq: 1, hasAppraisal: true });
    await tick(); await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].leg.inputText, '2'); assert.equal(calls[1].leg.priorUserText, '1');
    assert.equal(calls[1].leg.kind, 'continuation'); assert.equal(calls[1].leg.merged, accept);
    assert.deepEqual(speech, [false]);
    session.seal({ epoch: 'epoch', groupId: 'group', lastSeq: 2, reason: 'finish-speaking' });
    calls[1].done.resolve({ status: 'complete', coveredThroughSeq: 2, hasAppraisal: true }); await tick(); await tick();
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].status, 'complete');
    assert.equal(settlements[0].appraisalReplyId, calls[1].leg.replyId);
  }
});

// F4 (docs/claude/2026-11-03-draft-first-char.md): a voice reply that was nothing but an internal draft fails like any other voice
// leg (the voice failure line, the user's words kept), never an empty success: no reward, no reading, archived once as an error.
// The microphone stays on; the next utterance is answered as usual. The draft is X-237's synthetic sentence (the fake's #draft).
test('F4: a voice reply the draft filter emptied fails like a voice leg; one error archive, no reward, the microphone stays on', async () => {
  await voice(async h => {
    await h.say('#draft 夸你一下');
    await until(() => h.starts().length === 1 && !!h.terminal(h.starts()[0]), 5000, 'the drafted reply ended');
    const [drafted] = h.starts();
    assert.equal(h.text(drafted), '', 'not one character of the note reaches the bubble or the voice');
    assert.equal(h.terminal(drafted)?.complete, false, 'shown as the voice failure line, not as an empty success');
    assert.equal(h.terminal(drafted)?.superseded, false);
    // The utterance ends (the user stops speaking): a failed last leg settles it as partial.
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('partial'), 5000, 'settled as partial'); await h.host.drain();
    assert.ok(h.events.some(event => event.type === 'draft' && event.text === '#draft 夸你一下'), 'the user\'s words come back');
    assert.ok(!h.events.some(event => event.type === 'fault' || event.type === 'revoked'), 'not a recognition fault; the microphone stays on');
    assert.deepEqual(h.speech(), [], 'nothing is read aloud');
    assert.deepEqual(h.rewards, ['chat'], 'the tail of an emptied reply moves no mood');
    const record = h.record();
    assert.deepEqual(record.messages.map((message: { role: string; content: string; status: string }) => [message.role, message.content, message.status]),
      [['user', '#draft 夸你一下', 'complete'], ['assistant', '', 'error']], 'one failed reply, archived once');

    // Same capture, next utterance: answered, rewarded and read as before.
    await h.say('再说一句');
    await until(() => h.starts().length === 2 && !!h.terminal(h.starts()[1]), 5000, 'next reply');
    assert.equal(h.seal(), true);
    await until(() => h.states.includes('settled'), 5000, 'next utterance settled'); await h.host.drain();
    assert.equal(h.terminal(h.starts()[1])?.complete, true);
    assert.deepEqual(h.rewards, ['chat', 'chat', 'appraisal']);
    assert.equal(h.speech().length, 1); assert.equal(h.speech()[0].text, '收到，再说一句');
    noTail(h);
  });
});
