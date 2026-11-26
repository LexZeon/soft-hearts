// I-091 step 4 (user: "按你建议"): during a call her reply is read sentence by sentence while it is still being written, she gets
// short spoken-style lines, the warm process lasts the whole call, and the journal records how soon she starts after writing.
// Fakes only: a fake Claude, the real host plan (CompletedReplySpeech), no microphone, no model call, no paid voice, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { VOICE_CALL_SPOKEN_STYLE } from '../shared/voice/voice-call';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import type { ChatMessage } from '../shared/foundation/chat';
import { CompanionService } from '../electron/brain/companion';
import { speechBeatsFor } from '../electron/brain/speech-beats/host';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';
import { speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { CompletedReplySpeech } from '../electron/voice/completed-reply-speech';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { VoiceCallHost } from '../electron/voice/voice-call/host';
import { CallStreamingSpeech } from '../electron/voice/voice-call/streaming-speech';
import { MergeShortPieces } from '../electron/voice/voice-call/merge-short';
import { CLAUDE_CALL_SESSION_MAX_TURNS, CLAUDE_SESSION_MAX_TURNS, PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { CallTurnClock } from '../src/voice/voice-call/turn-clock';
import { encodeWav } from '../src/senses/MediaInput';
import { fakeClaudeStream } from './helpers/fake-claude-stream';

// ---------------------------------------------------------------- harness: the voice host in a call, with the real reading plan

type Step = string | (() => Promise<void>);
interface HarnessOptions { call: boolean; provider?: 'system' | 'bailian'; opening?: boolean; /** 边说边演: the beats ports (the switch on or off); absent: the host is given none. */ beats?: 'on' | 'off' }
const OWNER = 77, SCOPE = 'scope';

async function harness(options: HarnessOptions) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i091s4-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  if (options.opening) service.setReplyOpening('fixed');
  const rewards: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };

  const plan = new CompletedReplySpeech();
  const log: string[] = [];
  const planSpy = {
    beginCommit: (...args: Parameters<CompletedReplySpeech['beginCommit']>) => { log.push('begin'); return plan.beginCommit(...args); },
    append: (fence: object, delta: string) => { log.push('append:' + delta); plan.append(fence, delta); },
    record: (...args: Parameters<CompletedReplySpeech['record']>) => { log.push('record'); return plan.record(...args); },
    cancelPending: (fence: object) => { log.push('cancel'); plan.cancelPending(fence); },
  };
  const frozen: string[] = [];
  const streaming = new CallStreamingSpeech({
    plan: planSpy, active: () => options.call, voice: () => ({ provider: options.provider ?? 'system' }),
    freeze: ({ replyId, userText }) => { frozen.push(replyId + ':' + userText); }, started: id => callHost.noteSpeech(id),
  });
  const media = { voiceInput: true, voiceOwner: 'controls' as const };
  const callHost = new VoiceCallHost({ now: () => Date.now(), timers: { set: () => 0, clear() {} }, media: () => media, turnOnVoice: () => true, turnOffVoice() {},
    windowShown: () => true, asleep: () => false, ttsConfig: () => null, characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal() {},
    directory: () => null, synthesize: async () => undefined,
    cancelReading: id => { streaming.cancelAll(); plan.cancel(OWNER, id ?? plan.identity()?.id ?? ''); },
    sentence: (id, index) => plan.segmentRange(id, index), writtenText: id => streaming.writtenText(id) }); // I-204, as electron/wiring/voice-wiring.ts
  if (options.call) await callHost.set('controls', true);

  const events: { type: string; replyId?: string; groupId?: string; text?: string; beats?: SpeechBeatsEvent }[] = [];
  const personas: string[] = [], bases: string[] = [];
  let script: Step[] = [], outcome: 'complete' | 'superseded' | 'throw' = 'complete';
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast: event => { events.push({ type: event.type, replyId: 'replyId' in event ? (event.replyId ?? undefined) : undefined, groupId: 'groupId' in event ? (event.groupId ?? undefined) : undefined, text: 'text' in event ? event.text : undefined,
      ...(event.type === 'beats' ? { beats: event.speechBeats } : {}) }); },
    memoryChanged() {}, windowVisible: () => true, media: () => media, turnOffVoiceInput() {}, speechScope: () => SCOPE, settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() { callHost.turn(); }, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => {
      personas.push(task.session!.persona); bases.push(task.session!.basePersona);
      let all = '';
      for (const step of script) {
        if (typeof step === 'string') { emit('delta', step); all += step; } else await step();
        if (outcome === 'superseded' && all) return { superseded: true, output: all };
      }
      if (outcome === 'throw') throw Error('fake provider failure');
      return { superseded: false, output: all };
    } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    turnNote: () => callHost.turnNote(), callStyle: () => callHost.callStyle(),
    ...(options.beats ? { speechBeats: { begin: (on: boolean, send: (event: SpeechBeatsEvent) => void) => speechBeatsFor(directory).begin(on, send), enabled: () => options.beats === 'on',
      record: (scope: unknown, replyId: string, outcome: Parameters<ReturnType<typeof speechBeatsFor>['archive']['record']>[2]) => { void speechBeatsFor(directory).archive.record(scope as never, replyId, outcome); } } } : {}),
    callSpeech: { begin: input => streaming.begin(input), delta: (id, text) => streaming.delta(id, text), complete: id => streaming.complete(id), cancel: id => streaming.cancel(id) },
  });
  const binding = host.open(OWNER, 'controls');
  let seq = 0;
  /** The user says `text`; resolves when Claude was asked (the reply may still be streaming at a pause in the script). */
  const say = async (text: string, steps: Step[], how: typeof outcome = 'complete') => {
    script = steps; outcome = how; asr.push(text);
    host.pipeline.submit(OWNER, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(OWNER, binding.captureSessionId);
    const before = personas.length;
    for (let i = 0; i < 400 && personas.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  const settle = async () => { for (let i = 0; i < 400 && pending.size; i++) await new Promise(resolve => setTimeout(resolve, 5)); await host.drain(); };
  const replyId = () => events.find(event => event.type === 'start')?.replyId ?? events.at(-1)?.replyId ?? '';
  /** What her reading would take next: waits for the plan like the window does, returns the sentence (null: nothing more). */
  const pull = async (index?: number) => {
    const id = replyId();
    if (!await plan.waitForCommit(OWNER, id, SCOPE) ) return null;
    if (!await plan.waitForPiece(OWNER, id, SCOPE, index)) return null;
    try { return plan.next(OWNER, id, SCOPE, index)?.text ?? null; } catch { return null; }
  };
  const gate = () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let reached!: () => void; const at = new Promise<void>(resolve => { reached = resolve; });
    return { step: async () => { reached(); await wait; }, at, release }; };
  const dispose = async () => { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); };
  return { service, plan, log, host, callHost, streaming, events, personas, bases, rewards, frozen, say, settle, replyId, pull, gate, dispose, directory };
}

// ---------------------------------------------------------------- reading starts before the reply is finished

test('call: her first sentence is readable while the rest is still being written; the reply is read once, archived once, rewarded once', async () => {
  const h = await harness({ call: true, opening: true });
  try {
    const g = h.gate();
    await h.say('你好呀', ['<sh-open>好呀，我在。', g.step, '你慢慢说，我听着。']);
    await g.at;
    assert.ok(!h.log.includes('record'), 'the reply is not finished');
    assert.equal(await h.pull(), '好呀，我在。', 'the first sentence is already readable');
    g.release(); await h.settle();
    assert.equal(await h.pull(0), '你慢慢说，我听着。', 'the rest follows through the same plan');
    assert.equal(h.log.filter(line => line === 'begin').length, 1);
    assert.equal(h.log.filter(line => line === 'record').length, 1, 'finished once');
    assert.equal(h.events.filter(event => event.type === 'speech').length, 0, 'no second, whole-reply reading at settlement');
    assert.equal(h.rewards.filter(type => type === 'chat').length, 1, 'rewarded once');
    assert.equal(h.frozen.length, 1, 'her voice and pace were frozen for this reply');
  } finally { await h.dispose(); }
});

test('outside a call a voice turn is read whole at settlement exactly as before: no plan, one speech event, no call lines', async () => {
  const h = await harness({ call: false, opening: true });
  try {
    await h.say('你好呀', ['<sh-open>好呀，我在。', '你慢慢说，我听着。']);
    await h.settle();
    assert.deepEqual(h.log, [], 'the streaming plan is never touched');
    const speech = h.events.filter(event => event.type === 'speech');
    assert.equal(speech.length, 1);
    assert.equal(speech[0].text, '好呀，我在。你慢慢说，我听着。', 'the whole reply, once');
    assert.ok(!h.personas[0].includes(VOICE_CALL_SPOKEN_STYLE));
    assert.equal(h.frozen.length, 0);
  } finally { await h.dispose(); }
});

test('text the draft filter holds is never read early: a reply without its opening marker is read at the end, whole', async () => {
  const h = await harness({ call: true, opening: true });
  try {
    const g = h.gate();
    await h.say('你好呀', ['好呀，我在这儿。', g.step, '你慢慢说。']);
    await g.at;
    assert.equal(h.log.filter(line => line.startsWith('append:')).length, 0, 'nothing held was handed to the reading plan');
    g.release(); await h.settle();
    const appended = h.log.filter(line => line.startsWith('append:')).map(line => line.slice(7)).join('');
    const shown = h.events.filter(event => event.type === 'delta').map(event => event.text).join('');
    assert.equal(appended, shown, 'what is read is exactly what the window shows, and only after the filter let it through');
    assert.ok(appended.length > 0 && h.log.includes('record'));
  } finally { await h.dispose(); }
});

// ---------------------------------------------------------------- barge-in, merge and failure stop the reading

test('barge-in: reading stops at once and nothing more of that reply is read, while the shown reply keeps all its text and her next turn knows', async () => {
  const h = await harness({ call: true, opening: true });
  try {
    const g = h.gate();
    await h.say('你好呀', ['<sh-open>好呀，我在。', g.step, '你慢慢说，我听着。']);
    await g.at;
    assert.equal(await h.pull(), '好呀，我在。');
    const id = h.replyId();
    h.callHost.sentenceHeard(id, 0, 'start'); // the reading window: her first sentence is audible (I-204: where her voice is)
    assert.equal(h.callHost.bargeIn('controls', id, '等一下'), true, 'marked as interrupted');
    assert.equal(h.plan.identity(), null, 'the host plan is cancelled');
    g.release(); await h.settle();
    assert.equal(await h.pull(0), null, 'the unwritten rest is never read');
    assert.equal(h.log.filter(line => line === 'record').length, 0, 'a cancelled reply is not revived by its own completion');
    const shown = h.events.filter(event => event.type === 'delta').map(event => event.text).join('');
    assert.equal(shown, '好呀，我在。你慢慢说，我听着。', 'the written text is all still shown');
    await h.say('等一下', ['<sh-open>好。']);
    // I-204: her next turn knows where she was cut, what she said, the unread rest (written after the cut too) and the user's line.
    assert.match(h.personas[1], /你被用户打断了/);
    assert.match(h.personas[1], /已经念出声的：「（还没有）」/);
    assert.match(h.personas[1], /正在念的这一句（可能只念出了一部分）：「好呀，我在。」/);
    assert.match(h.personas[1], /还没念出来的[^「]*「你慢慢说，我听着。」/, 'the unread part, as information');
    assert.match(h.personas[1], /用户打断你时说的：「等一下」/);
  } finally { await h.dispose(); }
});

test('a reply stopped to merge the user\'s next words, or one that fails, stops being read and is never finished by the plan', async () => {
  for (const how of ['superseded', 'throw'] as const) {
    const h = await harness({ call: true, opening: true });
    try {
      await h.say('你好呀', ['<sh-open>好呀，我在。', '你慢慢说。'], how);
      await h.settle();
      assert.ok(h.log.some(line => line.startsWith('append:')), how + ': the first sentence did reach the plan');
      assert.ok(h.log.includes('cancel'), how);
      assert.ok(!h.log.includes('record'), how + ': never completed');
      assert.equal(h.plan.identity(), null, how + ': nothing left to read');
      assert.equal(h.events.filter(event => event.type === 'speech').length, 0, how);
    } finally { await h.dispose(); }
  }
});

test('mutation guard: without the host cancel on barge-in the plan would keep issuing sentences', async () => {
  const h = await harness({ call: true, opening: true });
  try {
    const g = h.gate();
    await h.say('你好呀', ['<sh-open>好呀，我在。', g.step, '你慢慢说，我听着。']);
    await g.at;
    assert.equal(await h.pull(), '好呀，我在。');
    // (No bargeIn here: this is what the plan does when nothing cancels it.)
    g.release(); await h.settle();
    assert.equal(await h.pull(0), '你慢慢说，我听着。');
  } finally { await h.dispose(); }
});

// ---------------------------------------------------------------- paid voices: one call per piece, short pieces joined

test('paid voice: short sentences are joined (fewer synthesis calls), never more than one call per piece; the system voice is free and unjoined', async () => {
  const sentences = ['好。', '嗯。', '对。', '是。', '行。', '那我们现在就开始吧，好不好呀。'];
  const run = async (provider: 'system' | 'bailian') => {
    const plan = new CompletedReplySpeech();
    const streaming = new CallStreamingSpeech({ plan, active: () => true, voice: () => ({ provider }), freeze() {}, started() {} });
    assert.equal(streaming.begin({ owner: 'controls', sender: OWNER, replyId: 'r1', scope: SCOPE, userText: '开始' }), true);
    for (const sentence of sentences) streaming.delta('r1', sentence);
    assert.equal(streaming.complete('r1'), true);
    const pieces: string[] = [];
    let index: number | undefined;
    for (;;) {
      if (!await plan.waitForPiece(OWNER, 'r1', SCOPE, index)) break;
      const lease = plan.next(OWNER, 'r1', SCOPE, index);
      if (!lease) break;
      pieces.push(lease.text); index = lease.index;
      plan.approvePresentation(OWNER, 'r1', SCOPE, lease, plan.fullPresentationText(OWNER, 'r1', SCOPE, lease)!);
      plan.authorizeCloud(OWNER, 'r1', SCOPE, lease.index, lease.text); // one synthesis claim per piece
      assert.throws(() => plan.authorizeCloud(OWNER, 'r1', SCOPE, lease.index, lease.text), 'a second call for the same piece is refused');
    }
    return pieces;
  };
  const system = await run('system'), paid = await run('bailian');
  assert.equal(system.length, sentences.length, 'free voice: one piece per sentence');
  assert.ok(paid.length < system.length, `joined: ${paid.length} < ${system.length}`);
  assert.equal(paid.join(''), sentences.join(''), 'every character is still read, in order');
  for (const piece of paid.slice(0, -1)) assert.ok(piece.trim().length >= VOICE_CALL_KNOBS.speech.paidMinChunkChars, 'only the last piece may be short: ' + piece);
});

test('merge-short: contiguous pieces only, what is held at the end is sent as it is, a cancelled reply forgets it', () => {
  const inner = { next: [] as { start: number; end: number; text: string }[][], push() { return this.next.shift() ?? []; }, finish() { return this.next.shift() ?? []; }, cancel() {} };
  const parser = new MergeShortPieces(inner, 6);
  inner.next = [[{ start: 0, end: 2, text: '好。' }]];
  assert.deepEqual(parser.push('好。'), [], 'short: held');
  inner.next = [[{ start: 2, end: 14, text: '我们开始吧，好吗。' }]];
  assert.deepEqual(parser.push('x'), [{ start: 0, end: 14, text: '好。我们开始吧，好吗。' }]);
  inner.next = [[{ start: 14, end: 16, text: '嗯。' }]];
  assert.deepEqual(parser.push('y'), []);
  inner.next = [[]];
  assert.deepEqual(parser.finish(), [{ start: 14, end: 16, text: '嗯。' }]);
  const cut = new MergeShortPieces(inner, 6);
  inner.next = [[{ start: 0, end: 1, text: '好' }]]; cut.push('好'); cut.cancel();
  inner.next = [[]];
  assert.deepEqual(cut.finish(), []);
});

// ---------------------------------------------------------------- spoken style lines

test('call turns get the short spoken-style lines in their private context only; the stable persona is unchanged; she is not told "phone call"', async () => {
  const inCall = await harness({ call: true }), outside = await harness({ call: false });
  try {
    await inCall.say('你好', ['好呀。']); await inCall.settle();
    await outside.say('你好', ['好呀。']); await outside.settle();
    assert.ok(inCall.personas[0].includes(VOICE_CALL_SPOKEN_STYLE));
    assert.equal(inCall.personas[0].split(VOICE_CALL_SPOKEN_STYLE).length, 2, 'once');
    assert.ok(!outside.personas[0].includes(VOICE_CALL_SPOKEN_STYLE));
    assert.equal(inCall.bases[0], outside.bases[0], 'the stable prompt prefix is the same in and out of a call');
    assert.match(VOICE_CALL_SPOKEN_STYLE, /用声音和你说话/);
    assert.match(VOICE_CALL_SPOKEN_STYLE, /听到/);
    assert.doesNotMatch(VOICE_CALL_SPOKEN_STYLE, /电话|听不到|看不到|无法/, 'never invites "I cannot hear you"');
    assert.ok(VOICE_CALL_SPOKEN_STYLE.split('\n').length <= 3 && VOICE_CALL_SPOKEN_STYLE.length < 160, 'a few lines');
    for (const rule of ['短', '第一句', '语气词', '列表', '括号', 'markdown']) assert.ok(VOICE_CALL_SPOKEN_STYLE.includes(rule), rule);
  } finally { await inCall.dispose(); await outside.dispose(); }
});

// ---------------------------------------------------------------- the warm process lasts the whole call

function task(messages: ChatMessage[], id: string): CompanionClaudeTask {
  const base = '你是测试角色小桃，说话温柔。', composed = `${base}\n\n当前心情：平静。`;
  return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(composed, messages); },
    imageDataUrls: [], replyId: id, session: { key: 'call-conversation', basePersona: base, persona: composed, messages, data: () => null } };
}

test('the call keeps one warm process past the ordinary turn cap; the character budget and the ordinary cap return after the call', async () => {
  assert.equal(CLAUDE_SESSION_MAX_TURNS, 12);
  assert.ok(CLAUDE_CALL_SESSION_MAX_TURNS >= 40, 'the call cap covers a long call');
  const claude = await fakeClaudeStream();
  const turns: number[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, maxTurns: 2, callMaxTurns: 5, maxChars: 10_000_000,
    timing: { dispatched: (_id, info) => turns.push(info?.sessionTurn ?? -1), firstDelta() {} } });
  try {
    const messages: ChatMessage[] = [];
    const ask = async (index: number) => {
      messages.push({ role: 'user', content: `第${index}句` });
      let reply = '';
      await chat.stream(task([...messages], 'r' + index), new AbortController().signal, (type, text) => { if (type === 'delta') reply += text; });
      messages.push({ role: 'assistant', content: reply });
    };
    chat.holdWarm(true);
    for (let i = 1; i <= 4; i++) await ask(i);
    assert.deepEqual(turns, [1, 2, 3, 4], 'during the call the same process serves turns 3 and 4 (the ordinary cap would have retired it after 2)');
    chat.holdWarm(false);
    await ask(5); await ask(6); await ask(7);
    const after = turns.slice(4);
    // The first turn after the call still runs on the old process (the retire check comes after a turn), then the ordinary cap (2) retires it.
    assert.deepEqual(after, [5, 1, 2], 'after the call the ordinary cap applies again from the next retire check');
  } finally { chat.dispose(); await claude.cleanup(); }
});

test('the character budget still retires a held process', async () => {
  const claude = await fakeClaudeStream();
  const turns: number[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, maxTurns: 2, callMaxTurns: 50, maxChars: 1,
    timing: { dispatched: (_id, info) => turns.push(info?.sessionTurn ?? -1), firstDelta() {} } });
  try {
    chat.holdWarm(true);
    const messages: ChatMessage[] = [];
    for (let i = 1; i <= 3; i++) {
      messages.push({ role: 'user', content: `第${i}句` });
      let reply = '';
      await chat.stream(task([...messages], 'b' + i), new AbortController().signal, (type, text) => { if (type === 'delta') reply += text; });
      messages.push({ role: 'assistant', content: reply });
    }
    assert.deepEqual(turns, [1, 1, 1], 'every turn is over the (tiny) character budget, call or not');
  } finally { chat.dispose(); await claude.cleanup(); }
});

// ---------------------------------------------------------------- journal: numbers only

test('turn clock: how soon she speaks after she starts writing, and whether she began before the reply was finished', () => {
  for (const early of [true, false]) {
    let now = 0; const sent: any[] = [];
    const clock = new CallTurnClock(() => now, timing => sent.push(timing));
    clock.voiced(); now = 700; clock.endpoint(); now = 2000; clock.firstChar();
    if (!early) { now = 2300; clock.replyDone(); }
    now = early ? 2600 : 3100; clock.firstSound();
    if (early) { now = 3400; clock.replyDone(); }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].soundAfterCharMs, early ? 600 : 1100);
    assert.equal(sent[0].earlyRead, early);
    assert.equal('replyDone' in sent[0], false, 'no internal field leaves the clock');
  }
  let now = 0; const sent: any[] = [];
  const clock = new CallTurnClock(() => now, timing => sent.push(timing));
  clock.voiced(); now = 700; clock.endpoint(); clock.flush();
  assert.equal(sent[0].soundAfterCharMs, null); assert.equal(sent[0].earlyRead, null, 'no sound: neither');
});

test('journal: the two new call numbers are kept as numbers and a flag, never text', () => {
  const entry = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 700, handInMs: 760, textMs: 820, fillerMs: 1100, firstCharMs: 2000, firstSoundMs: 2600,
    soundAfterCharMs: 600.4, earlyRead: true, bargeIn: false, text: '秘密', transcript: '内容' } as any, 1) as any;
  assert.ok(entry);
  assert.equal(entry.soundAfterCharMs, 600); assert.equal(entry.earlyRead, true);
  assert.doesNotMatch(JSON.stringify(entry), /秘密|内容|transcript/);
  const odd = buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 1, handInMs: 1, textMs: 1, fillerMs: null, firstCharMs: null, firstSoundMs: null,
    soundAfterCharMs: 'x', earlyRead: 'yes', bargeIn: false } as any, 2) as any;
  assert.equal(odd.soundAfterCharMs, null); assert.equal(odd.earlyRead, null);
  const line = describeJournalEntry(entry, (text: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), text));
  assert.match(line, /0\.60/); assert.match(line, /还没写完/);
});

// ---------------------------------------------------------------- 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md)

test('边说边演: her beat markers, split across chunks, never reach a call\'s reading, her bubble or her archive', async () => {
  const h = await harness({ call: true, opening: true });
  try {
    await h.say('你好呀', ['<sh-open>⟦smi', 'le-warm⟧好呀，我在。⟦ti', 'lt⟧你慢慢说。⟦v']);
    await h.settle();
    const appended = h.log.filter(line => line.startsWith('append:')).map(line => line.slice('append:'.length));
    assert.equal(appended.join(''), '好呀，我在。你慢慢说。', 'what the reading plan is given');
    const marker = /[⟦⟧]|smile-warm|tilt/u;
    for (const text of [...appended, ...h.events.map(event => event.text ?? '')]) assert.ok(!marker.test(text), `leaked: ${text}`);
    const recent = h.service.recentChat?.() as unknown;
    assert.ok(!marker.test(JSON.stringify(recent ?? '')), 'the archive keeps clean words');
  } finally { await h.dispose(); }
});

// ---------------------------------------------------------------- 边说边演 in a call (docs/claude/2026-11-20-speech-beats-leftovers.md)

const BEAT_SPEECH = ['<sh-open>⟦smile-warm⟧好呀，我在。', '⟦ti', 'lt⟧你慢慢说。⟦v⟧'];
const beatsOf = (h: Awaited<ReturnType<typeof harness>>) => h.events.filter(event => event.type === 'beats');

test('call + switch on: the beats go out before the words they sit in front of, once, and the reply\'s final comes before its terminal', async () => {
  const h = await harness({ call: true, opening: true, beats: 'on' });
  try {
    await h.say('你好呀', BEAT_SPEECH);
    await h.settle();
    const order = h.events.filter(event => ['beats', 'delta', 'terminal'].includes(event.type));
    const firstWords = order.findIndex(event => event.type === 'delta' && (event.text ?? '').includes('好呀，我在'));
    const firstBeats = order.findIndex(event => event.type === 'beats' && event.beats?.beats?.some(beat => beat.word === 'smile-warm'));
    assert.ok(firstBeats >= 0 && firstBeats < firstWords, 'the first beat is sent before the words it sits in front of');
    const played = beatsOf(h).flatMap(event => event.beats?.beats ?? []);
    assert.deepEqual(played.map(beat => beat.word), ['smile-warm', 'tilt', 'v'], 'each beat once, in order (also the one split across chunks)');
    assert.deepEqual(played.map(beat => beat.at), [0, 6, 11], 'at = the position in the clean words');
    const finals = beatsOf(h).filter(event => event.beats?.final);
    assert.equal(finals.length, 1);
    assert.equal(finals[0]!.beats!.final!.performanceOnly, false);
    assert.ok(order.indexOf(finals[0]!) < order.findIndex(event => event.type === 'terminal'), 'the final is sent before the terminal');
    assert.equal(beatsOf(h).every(event => event.replyId === h.replyId()), true, 'every beat names the reply it belongs to');
    assert.ok(h.personas[0]!.includes(speechBeatSentence(undefined, true)), 'she is told she may write the markers (one line in the call\'s persona, the spoken form: every reply has words)');
    assert.ok(!h.personas[0]!.includes('可以整条只写标记'), 'and not that a whole reply may be only markers: a call has no such reply');
    const filed = speechBeatsFor(h.directory).archive.get(h.service.currentScope(), h.events.find(event => event.type === 'start')!.groupId!);
    assert.deepEqual(filed?.beats.map(beat => beat.word), ['smile-warm', 'tilt', 'v'], 'filed under the utterance\'s turn (the long window and the grey line need it)');
  } finally { await h.dispose(); }
});

test('call + switch off: not one character added to her persona, nothing played; only the markers are taken out', async () => {
  const on = await harness({ call: true, opening: true, beats: 'on' }), off = await harness({ call: true, opening: true, beats: 'off' }), none = await harness({ call: true, opening: true });
  try {
    for (const h of [on, off, none]) { await h.say('你好呀', BEAT_SPEECH); await h.settle(); }
    const plain = (persona: string) => persona.replace(/sh-state-[a-f0-9]+/g, 'sh-state');
    assert.equal(plain(off.personas[0]!), plain(none.personas[0]!), 'off is the persona there was before this existed');
    assert.ok(on.personas[0]!.length > off.personas[0]!.length, 'on adds the one line');
    assert.deepEqual(beatsOf(off).flatMap(event => event.beats?.beats ?? []), [], 'no beat is sent while it is off');
    assert.deepEqual(beatsOf(none), [], 'no ports: nothing sent');
    for (const h of [off, none]) {
      const appended = h.log.filter(line => line.startsWith('append:')).map(line => line.slice('append:'.length)).join('');
      assert.equal(appended, '好呀，我在。你慢慢说。', 'the reading plan still gets clean words');
    }
  } finally { await on.dispose(); await off.dispose(); await none.dispose(); }
});

test('a voice turn outside a call is not performed: no event, no persona line, no file entry', async () => {
  const h = await harness({ call: false, opening: true, beats: 'on' });
  try {
    await h.say('你好呀', BEAT_SPEECH);
    await h.settle();
    assert.deepEqual(beatsOf(h), []);
    assert.ok(!h.personas[0]!.includes('tilt'), 'no line about the markers outside a call');
    assert.equal(h.events.filter(event => event.type === 'speech').length, 1, 'read whole at settlement as before');
  } finally { await h.dispose(); }
});

test('a leg stopped to merge, or one that failed, sends no final and files nothing', async () => {
  for (const how of ['superseded', 'throw'] as const) {
    const h = await harness({ call: true, opening: true, beats: 'on' });
    try {
      await h.say('你好呀', BEAT_SPEECH, how);
      await h.settle();
      assert.deepEqual(beatsOf(h).filter(event => event.beats?.final), [], `${how}: no final`);
      const id = h.events.find(event => event.type === 'start')!.groupId!;
      assert.equal(speechBeatsFor(h.directory).archive.get(h.service.currentScope(), id), null, `${how}: nothing filed`);
    } finally { await h.dispose(); }
  }
});

test('a call reply that is only markers (she is told not to, but it can happen): nothing is read, the beats and the final (performance-only, a grey line) still go out', async () => {
  const h = await harness({ call: true, beats: 'on' });
  try {
    await h.say('你真好看', ['⟦shy⟧⟦look-down⟧']);
    await h.settle();
    const sent = beatsOf(h).flatMap(event => event.beats ? [event.beats] : []);
    assert.deepEqual(sent.flatMap(event => event.beats ?? []).map(beat => beat.word), ['shy', 'look-down']);
    const final = sent.find(event => event.final)?.final;
    assert.equal(final?.performanceOnly, true);
    assert.ok(final?.line, 'a grey line');
    assert.deepEqual(h.log.filter(line => line.startsWith('append:')), [], 'nothing is given to the reading');
  } finally { await h.dispose(); }
});
