// 嗯"了。"; I-204 (2026-11-23, the user changed the
// first rule): "我在想检测出来几个字就打断。" "不写过滤程序。认出3个字？"
// Three recognized characters interrupt her; sound alone, fewer characters and her own echo never do, and noise recognized as "嗯" (while
// she is silent) is never a turn. Synthetic clips and a fake Claude; no microphone, no paid voice, no Electron. The I-204 rule itself:
// tests/i204-barge-in.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INTERRUPT_KNOBS } from '../shared/behaviors/interrupt/knobs';
import { classifyWords, clipLevels, echoMatch, judgeUtterance, type ClipLevels } from '../shared/behaviors/interrupt/judge';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG } from '../shared/voice/tts';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { VoiceCallHost, type VoiceCallJournalInput } from '../electron/voice/voice-call/host';
import { gateClip, herVoiceFrom, type UtteranceGatePorts } from '../electron/voice/utterance-gate';
import { CallControls } from '../src/voice/voice-call/call-controls';
import { encodeWav, OVER_HER_IDLE_MS } from '../src/senses/MediaInput';
import { chunk, echo, mic, mix, wavSeconds } from './helpers/call-mic';

const loud = (seconds: number): ClipLevels => ({ peakDb: -8, voicedSeconds: seconds });
const judge = (text: string, overHer: boolean, levels: ClipLevels | null = loud(1), herText = '') => judgeUtterance({ text, levels, overHer, continuous: true, herText });

// ---------------------------------------------------------------- the rule (pure)

test('words: filler sounds only, or words; every recognized character counts (I-204: no filler filter)', () => {
  for (const text of ['嗯', '嗯嗯。', '啊？', '呃……', '哦', '唔', '额', 'Hmm...', 'mm', 'uh', 'um']) assert.equal(classifyWords(text).kind, 'filler', text);
  for (const text of ['等一下', '停', '你听我说', '嗯，好', '我觉得', 'ok']) assert.equal(classifyWords(text).kind, 'words', text);
  assert.deepEqual([classifyWords('嗯我想想').units, classifyWords('嗯嗯。').units, classifyWords('I want to go').units], [4, 2, 8]);
  assert.equal(classifyWords('……').kind, 'empty');
});

test('she is not speaking: a short or quiet filler-only clip in a call is held (noise heard as "嗯"); a long loud "嗯" and filler + words pass', () => {
  assert.deepEqual(judge('嗯', false, { peakDb: -8, voicedSeconds: 0.2 }), { pass: false, kind: 'filler', held: 'filler', chars: 1, match: null }, 'short');
  assert.deepEqual(judge('嗯', false, { peakDb: -38, voicedSeconds: 1.2 }), { pass: false, kind: 'filler', held: 'filler', chars: 1, match: null }, 'quiet');
  assert.deepEqual(judge('嗯。', false, loud(0.8)), { pass: true, kind: 'filler', interrupt: null, chars: 1, match: null }, 'a long, loud "嗯" is the user\'s answer (often "yes")');
  for (const text of ['嗯，好', '嗯我想想', '好的']) assert.equal(judge(text, false, { peakDb: -38, voicedSeconds: 0.2 }).pass, true, `${text}: words go through as before`);
  assert.equal(judgeUtterance({ text: '嗯', levels: { peakDb: -38, voicedSeconds: 0.2 }, overHer: false, continuous: false }).pass, true, 'hold-T (not continuous): the user meant it');
  assert.equal(judge('嗯', false, null).pass, true, 'levels unreadable: only the words decide, as before');
});

test('she is speaking: under three recognized characters never interrupts; three or more do; her own echo never does', () => {
  for (const text of ['嗯', '嗯嗯', '啊']) assert.deepEqual(judge(text, true, loud(2)), { pass: false, kind: 'filler', held: 'filler', chars: countOf(text), match: null }, `${text}: even long and loud`);
  for (const text of ['好的', '对对', '停', 'ok']) assert.deepEqual(judge(text, true), { pass: false, kind: 'words', held: 'fragment', chars: countOf(text), match: null }, text);
  for (const text of ['嗯我想想', '我觉得', '你先听我说一下', '等一下', 'wait now', '嗯嗯嗯']) assert.equal(judge(text, true).pass, true, `${text}: three or more characters`);
  assert.equal(judge('我觉得', true, { peakDb: -60, voicedSeconds: 0.1 }).pass, true, 'no loudness or duration gate over her');
  assert.equal(judge('等一下', true, null).pass, true, 'levels unreadable: the words decide');
  assert.deepEqual(judge('我在呢你说吧', true, loud(1), '嗯，我在呢，你说吧。今天怎么样？'), { pass: false, kind: 'words', held: 'echo', chars: 6, match: 1 });
  assert.equal(judge('我想去公园走走', true, loud(1), '嗯，我在呢，你说吧。').pass, true, 'the user\'s own sentence is not her echo');
  assert.equal(echoMatch('晚安', '你说晚安是什么意思'), 1);
  assert.ok(echoMatch('你说的晚安是什么意思呀', '晚安，早点睡') < INTERRUPT_KNOBS.echoMatchRatio, 'sharing a word is not an echo');
});
const countOf = (text: string) => classifyWords(text).units;

test('levels: the voiced time and the peak of a 16 kHz clip', () => {
  assert.deepEqual(clipLevels(new Float32Array(16_000)), { peakDb: -120, voicedSeconds: 0 });
  const clip = new Float32Array(32_000);
  for (let i = 8_000; i < 16_000; i++) clip[i] = 0.3 * Math.sin(i / 3);
  const levels = clipLevels(clip);
  assert.ok(Math.abs(levels.peakDb - 20 * Math.log10(0.3)) < 0.5, `peak ${levels.peakDb}`);
  assert.ok(Math.abs(levels.voicedSeconds - 0.5) <= 0.04, `voiced ${levels.voicedSeconds}`);
  const hum = new Float32Array(16_000).fill(0.003);
  assert.equal(clipLevels(hum).voicedSeconds, 0, 'a hum under the floor is not voiced');
});

// ---------------------------------------------------------------- the host: held clips go nowhere; clear words stop her

/** A 16 kHz clip: `seconds` of a voice-like tone at `amplitude`, with short silence around it. */
function clip(seconds: number, amplitude: number): ArrayBuffer {
  const samples = new Float32Array(Math.round((seconds + 0.4) * 16_000));
  for (let i = 3_200; i < 3_200 + seconds * 16_000; i++) samples[i] = amplitude * Math.sin(i / 4) * (0.6 + 0.4 * Math.sin(i / 900));
  return encodeWav(samples);
}

async function world(run: (w: { say(text: string, wav: ArrayBuffer): Promise<void>; personas: string[]; stops: (string | undefined)[]; held: unknown[]; interrupts: unknown[];
  events: string[]; herSpeaking(on: boolean, text?: string): void; host: VoiceChatHost; sessionId: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-gate-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const personas: string[] = [], stops: (string | undefined)[] = [], held: unknown[] = [], interrupts: unknown[] = [], events: string[] = [];
  const asr: string[] = [], pending = new Set<string>(), media = { voiceInput: true, voiceOwner: 'controls' as const };
  let speaking = false, herText = '';
  const gate: UtteranceGatePorts = { herVoice: () => speaking, herText: () => herText, continuous: () => true,
    held: (kind, overHer) => held.push({ kind, overHer }), interrupted: (_owner, by) => interrupts.push(by) };
  const host = new VoiceChatHost({
    broadcast: event => events.push(event.type), memoryChanged() {}, windowVisible: () => true, media: () => media,
    turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => { personas.push(task.session!.persona); emit('delta', '好呀。'); return { superseded: false, output: '好呀。' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading: mode => { stops.push(mode); }, prepareSpeech() {}, gate,
  });
  try {
    const binding = host.open(77, 'controls');
    stops.length = 0; // opening the microphone asks the reading window to finish its sentence, as before
    let seq = 0;
    const say = async (text: string, wav: ArrayBuffer) => {
      asr.push(text);
      const before = personas.length + held.length;
      host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav });
      host.pipeline.finishSpeaking(77, binding.captureSessionId);
      for (let i = 0; i < 400 && personas.length + held.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drain();
    };
    await run({ say, personas, stops, held, interrupts, events, host, sessionId: binding.captureSessionId, herSpeaking: (on, text = '') => { speaking = on; herText = text; } });
  } finally { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); }
}

test('host: a quiet or short "嗯" in a call (noise) is never a turn: nothing sent, shown, kept or noted as unheard; only counted', async () => {
  await world(async w => {
    await w.say('嗯', clip(0.25, 0.3));
    await w.say('嗯。', clip(1, 0.01));
    assert.deepEqual(w.held, [{ kind: 'filler', overHer: false }, { kind: 'filler', overHer: false }]);
    assert.equal(w.personas.length, 0, 'nothing reached Claude');
    assert.ok(!w.events.includes('row') && !w.events.includes('unheard') && !w.events.includes('start'), `nothing shown: ${w.events}`);
    assert.deepEqual(w.stops, [], 'and nothing stopped her');
    await w.say('嗯。', clip(0.8, 0.4));
    assert.equal(w.personas.length, 1, 'a long, loud "嗯" is the user\'s answer and goes through');
  });
});

test('host: while she speaks, sound alone never stops her; "好的" is held; three recognized characters stop her and are the user\'s turn', async () => {
  await world(async w => {
    w.herSpeaking(true, '嗯，我在呢，你说吧。今天过得怎么样？');
    assert.equal(w.host.pipeline.speechStarted(77, w.sessionId), true);
    assert.deepEqual(w.stops, [], 'a speech start (VAD or loudness) does not stop her any more');
    await w.say('好的', clip(1, 0.3));
    await w.say('嗯', clip(1.5, 0.5));
    await w.say('我在呢你说吧', clip(1, 0.3));
    // ("嗯" is in what she is reading, so it is judged her echo first; held either way.)
    assert.deepEqual(w.held, [{ kind: 'fragment', overHer: true }, { kind: 'echo', overHer: true }, { kind: 'echo', overHer: true }]);
    assert.equal(w.events.filter(type => type === 'held').length, 3, 'I-177 batch 2: each held clip tells the window (its duck lets her voice come back)');
    assert.deepEqual(w.stops, [], 'mid-reply short lines and her echo never stop her');
    assert.equal(w.personas.length, 0);
    await w.say('等一下', clip(0.3, 0.3));
    assert.deepEqual(w.interrupts, ['chars']);
    assert.ok(w.stops.length >= 1 && w.stops.every(mode => mode === undefined), 'three characters stop her at once');
    assert.equal(w.personas.length, 1, 'and are the user\'s turn');
  });
  await world(async w => {
    w.herSpeaking(true, '今天天气很好。');
    await w.say('你先听我说一下好不好', clip(1.2, 0.3));
    assert.deepEqual(w.interrupts, ['chars']);
    assert.ok(w.stops.length >= 1);
    assert.equal(w.personas.length, 1);
  });
});

test('gate: she is speaking only while a window says so or the host reads; a failing port never changes the verdict', () => {
  assert.equal(herVoiceFrom(new Set(), { busy: false }, { reading: () => false }), false, 'silent: nothing to interrupt');
  assert.equal(herVoiceFrom(new Set([3]), { busy: false }, { reading: () => false }), true, 'a window says she is speaking');
  assert.equal(herVoiceFrom(new Set(), { busy: true }, { reading: () => false }), true, 'the host is reading (the window may lag)');
  const ports: UtteranceGatePorts = { herVoice: () => { throw Error('x'); }, continuous: () => { throw Error('x'); }, held: () => { throw Error('x'); } };
  assert.equal(gateClip(ports, 'controls', '我想去公园', clip(1, 0.3)).pass, true);
  assert.equal(gateClip({ ...ports, continuous: () => true }, 'controls', '嗯', clip(0.2, 0.3)).pass, false);
  assert.equal(gateClip({}, 'controls', '嗯', new ArrayBuffer(3)).pass, true, 'an unreadable clip: the words alone decide');
});

// ---------------------------------------------------------------- the call: counted, the plan stopped, the reply marked

test('call: three characters over her are the barge-in (counted, her reading plan stopped, the next turn told); outside the call only journaled', async () => {
  const journal: VoiceCallJournalInput[] = [], cancelled: (string | null)[] = [];
  const host = new VoiceCallHost({ now: () => 0, timers: { set: () => 0, clear() {} }, media: () => ({ voiceInput: true, voiceOwner: 'controls' }),
    turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true, asleep: () => false, ttsConfig: () => ({ ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'system' }),
    characterId: () => 'c1', mood: () => ({}), keepWarm() {}, broadcast() {}, journal: entry => journal.push(entry), directory: () => null,
    cancelReading: id => cancelled.push(id), synthesize: async () => {} });
  assert.equal(host.heardOverHer('controls', 'chars'), false, 'no call');
  host.held('filler', false, 'controls');
  await host.set('controls', true);
  host.noteSpeech('reply-1');
  host.held('fragment', true, 'controls', { chars: 2, match: 0.5 });
  assert.equal(host.heardOverHer('controls', 'chars', true, { text: '等一下', chars: 3, match: 0 }), true);
  assert.deepEqual(cancelled, ['reply-1'], 'the host stops the sentence-by-sentence plan of the reply being read');
  const note = host.turnNote('zh-CN');
  assert.match(note, /你被用户打断了/, 'the next turn knows she was cut off');
  assert.match(note, /用户打断你时说的：「等一下」/);
  host.set('controls', false);
  assert.deepEqual(journal.filter(entry => entry.event === 'held' || entry.event === 'interrupt'), [
    { event: 'interrupt', by: 'chars', overHer: true, call: false }, { event: 'held', kind: 'filler', overHer: false, call: false },
    { event: 'held', kind: 'fragment', overHer: true, call: true, chars: 2, match: 0.5 }, { event: 'interrupt', by: 'chars', overHer: true, call: true, chars: 3, match: 0 }]);
  assert.equal((journal.find(entry => entry.event === 'end') as { bargeIns: number }).bargeIns, 1);
  for (const entry of journal.filter(entry => entry.event === 'held' || entry.event === 'interrupt')) {
    const built = buildJournalEntry({ type: 'voice-call', characterId: 'c1', ...entry } as never, 1_800_000_000_000);
    assert.ok(built, `journal accepts ${JSON.stringify(entry)}`);
    assert.ok(!/嗯|等一下/.test(JSON.stringify(built)), 'never the words');
    assert.ok(describeJournalEntry(built!, (text: string, ...args: unknown[]) => args.reduce<string>((t, a, i) => t.replace(`{${i}}`, String(a)), text)).length > 0);
  }
});

// ---------------------------------------------------------------- the window: sound over her only opens listening

test('window: talking over her opens listening; her next sentence does not drop the words; afterwards her echo starts nothing', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10);
    m.media.setSpeaking(true);
    for (let i = 0; i < 40; i++) m.feed(echo(i, 0.02, 0.035));
    for (let i = 0; i < 6; i++) m.feed(mix(echo(i, 0.02, 0.035), chunk(0.15, i + 3)));
    m.media.setSpeaking(false); m.media.setSpeaking(true); // between two of her sentences
    for (let i = 0; i < 8; i++) m.feed(mix(echo(i, 0.02, 0.035), chunk(0.15, i + 30)));
    for (let i = 0; i < 16; i++) m.feed(echo(i, 0.02, 0.035)); // the user stopped; she goes on
    await m.settle();
    assert.equal(m.events.filter(type => type === 'barge-in').length, 1);
    assert.equal(m.submits.length, 1, 'one clip of the user\'s words');
    assert.ok(wavSeconds(m.submits[0]) >= 0.8, `the words over her are kept together (${wavSeconds(m.submits[0])} s)`);
    const starts = m.signals.filter(signal => signal === 'speech-start').length;
    for (let i = 0; i < 60; i++) m.feed(echo(i, 0.02, 0.035));
    await m.settle();
    assert.equal(m.signals.filter(signal => signal === 'speech-start').length, starts, 'listening over her ended: her own voice starts nothing');
    assert.equal(m.submits.length, 1);
    for (let i = 0; i < 10; i++) m.feed(mix(echo(i, 0.02, 0.035), chunk(0.15, i + 60)));
    await m.settle();
    assert.equal(m.events.filter(type => type === 'barge-in').length, 2, 'the user talking over her again opens listening again');
  });
});

test('window: the call window never stops her on sound (no call to the host on barge-in)', async () => {
  const calls: string[] = [];
  const api = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { calls.push(String(name)); return name === 'getVoiceCall' ? Promise.resolve({ on: true, owner: 'controls', since: 1, ended: null, fillers: null })
    : name === 'onVoiceCall' ? () => {} : Promise.resolve(args.length ? null : null); } });
  const set: unknown[] = [];
  const controls = new CallControls({ windowKind: 'controls', api: api as never, audio: {} as never, voice: () => DEFAULT_SETTINGS.voice,
    media: () => ({ setCall: knobs => set.push(knobs), setEchoGuard() {} }), replyBusy: () => true, notify() {} });
  await controls.init(null);
  assert.equal(controls.inCall, true);
  calls.length = 0;
  controls.heard({ type: 'barge-in' });
  assert.deepEqual(calls, [], 'sound over her calls nothing on the host: she keeps reading');
  assert.ok(OVER_HER_IDLE_MS >= 1000 && OVER_HER_IDLE_MS <= 3000);
});
