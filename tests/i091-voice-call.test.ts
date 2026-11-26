// I-091 像打语音电话一样和她聊天, steps 1 and 2.
// Synthetic audio frames, a fake reading runtime, a fake Claude; no microphone, no paid voice, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { callFillerChance, chooseCallFiller } from '../shared/behaviors/voice-call/choose';
import { CALL_FILLER_IDS, CALL_FILLER_TEXT, callFillerPaidNotice, type CallFillerId } from '../shared/voice/voice-call';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice/tts';
import { AGENT_SETTINGS, settingAlwaysDialog, type AgentSettingSpec } from '../shared/safety/agent-channel';
import { BargeInDetector } from '../src/voice/voice-call/barge-in';
import { CallFillerScheduler } from '../src/voice/voice-call/filler-scheduler';
import { CallTurnClock } from '../src/voice/voice-call/turn-clock';
import { VoiceCallController } from '../electron/voice/voice-call/controller';
import { InterruptionLedger } from '../electron/voice/voice-call/interruption';
import { CallFillerStore, callFillerVoiceKey, type CallFillerFs } from '../electron/voice/voice-call/fillers';
import { VoiceCallHost } from '../electron/voice/voice-call/host';
import { teeCallTiming } from '../electron/voice/voice-call/timing';
import { AgentToolRegistry, type AgentConfirmRequest } from '../electron/safety/agent-channel/registry';
import { createAppTools, type AgentAppBridge } from '../electron/safety/agent-channel/app-tools';
import { AGENT_HOST_OPERATIONS, AGENT_PET_OPERATIONS } from '../electron/safety/agent-channel/bridge';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { PersistentClaudeChat } from '../electron/brain/claude-session';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { encodeWav } from '../src/senses/MediaInput';
import { CHUNK, RATE, chunk, echo, mic, mix, wavSeconds } from './helpers/call-mic';

// ---------------------------------------------------------------- barge-in detector

test('barge-in: her own voice through the speakers (echo up to 3.5× the room gate) never counts; the user talking over her does, once', () => {
  for (const [low, high] of [[0.01, 0.02], [0.02, 0.035], [0.04, 0.08]] as const) {
    const detector = new BargeInDetector();
    let fired = 0;
    for (let i = 0; i < 80; i++) if (detector.push(echo(i, low, high), RATE, 0.01)) fired++; // ~5 s of her reading
    assert.equal(fired, 0, `echo ${low}–${high} must not interrupt her`);
    let at = -1;
    for (let i = 80; i < 100; i++) if (detector.push(mix(echo(i, low, high), chunk(high * 4, i + 7)), RATE, 0.01)) { fired++; if (at < 0) at = i - 80; }
    assert.equal(fired, 1, `user over echo ${low}–${high}: exactly one barge-in`);
    assert.ok(at >= 0 && (at + 1) * CHUNK / RATE * 1000 <= 400, `noticed within 400 ms (chunk ${at})`);
    assert.ok(detector.takePreroll().reduce((n, c) => n + c.length, 0) >= RATE * 0.5, 'the first words are kept for recognition');
  }
});

test('barge-in: a single cough-like burst is not enough; nothing counts while it learns the echo', () => {
  const detector = new BargeInDetector();
  assert.equal(detector.push(chunk(0.5), RATE, 0.01), false, 'learning: the first 250 ms never fire');
  for (let i = 0; i < 20; i++) detector.push(chunk(0.005, i), RATE, 0.01);
  assert.equal(detector.push(chunk(0.3), RATE, 0.01), false, 'one 64 ms burst');
  for (let i = 0; i < 10; i++) assert.equal(detector.push(chunk(0.005, i), RATE, 0.01), false);
});

// ---------------------------------------------------------------- MediaInput in a call

test('call mode: no T key, the end is decided after the call\'s shorter silence and handed over at once (not after 1.5 s)', async () => {
  await mic(async m => {
    m.feed(0.0005, 10);
    m.feed(0.1, 12); // ~0.77 s of the user's speech
    await m.settle();
    assert.deepEqual(m.signals, [], 'outside a call, hold-to-talk drops speech without T');
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 5);
    m.feed(0.1, 12);
    await m.settle();
    assert.deepEqual(m.signals, ['speech-start']);
    m.feed(0.0005, Math.ceil(VOICE_CALL_KNOBS.endpointSilenceMs / 64) - 1);
    await m.settle();
    assert.equal(m.submits.length, 0, 'still inside the silence wait');
    m.feed(0.0005, 2);
    await m.settle();
    assert.equal(m.submits.length, 1, 'cut after the call\'s silence wait and handed to recognition');
    assert.deepEqual(m.timers.map(timer => timer.ms), [0], 'no 1500 ms timer in a call');
    await m.runTimers();
    assert.deepEqual(m.signals, ['speech-start', 'endpoint']);
    assert.ok(m.events.includes('pause') && m.events.includes('endpoint') && m.events.includes('handed-in'));
    assert.ok(m.events.indexOf('pause') < m.events.indexOf('endpoint'), 'the pause (for her "嗯") comes before the cut');
  });
});

test('outside a call (continuous mode as before) the 1500 ms endpoint timer is unchanged', async () => {
  await mic(async m => {
    m.feed(0.0005, 5); m.feed(0.1, 12); m.feed(0.0005, 12);
    await m.settle();
    assert.equal(m.submits.length, 1);
    assert.deepEqual(m.timers.map(timer => timer.ms), [1500]);
    assert.deepEqual(m.events, [], 'no call events outside a call');
  }, false);
});

test('call barge-in: echo of her reading is ignored; the user talking over her opens listening once (she keeps reading) and the first words reach recognition', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10);
    m.media.setSpeaking(true);
    for (let i = 0; i < 60; i++) m.feed(echo(i, 0.02, 0.035)); // ~3.8 s of her voice in the room
    await m.settle();
    assert.deepEqual(m.signals, [], 'her own voice never starts a turn');
    assert.deepEqual(m.events, []);
    for (let i = 0; i < 8; i++) m.feed(mix(echo(i, 0.02, 0.035), chunk(0.15, i + 3)));
    m.media.setSpeaking(true); // her next sentence starts: listening over her goes on (sound alone never stops her)
    for (let i = 0; i < 6; i++) m.feed(chunk(0.15, i + 30));
    m.feed(0.0005, 14);
    await m.settle();
    assert.equal(m.events.filter(type => type === 'barge-in').length, 1, 'listening over her opened exactly once');
    assert.equal(m.signals.filter(signal => signal === 'speech-start').length, 1);
    assert.equal(m.submits.length, 1);
    assert.ok(wavSeconds(m.submits[0]) >= 0.8, `the interruption's first words are in the clip (${wavSeconds(m.submits[0])} s)`);
  });
});

test('not in a call, her speaking still pauses the microphone completely (no barge-in)', async () => {
  await mic(async m => {
    m.media.setSpeaking(true);
    for (let i = 0; i < 20; i++) m.feed(chunk(0.2, i));
    await m.settle();
    assert.deepEqual(m.signals, []); assert.deepEqual(m.events, []);
  }, false);
});

test('while her short "嗯" plays, its sound must reach the barge-in gate to count as the user', async () => {
  await mic(async m => {
    m.media.setCall(VOICE_CALL_KNOBS);
    m.feed(0.0005, 10);
    m.media.setEchoGuard(true);
    m.feed(0.025, 8);
    await m.settle();
    assert.deepEqual(m.signals, [], 'her "嗯" through the speakers');
    m.feed(0.2, 4);
    await m.settle();
    assert.deepEqual(m.signals, ['speech-start'], 'the user, louder');
  });
});

// ---------------------------------------------------------------- filler scheduling

function scheduler(picks: (CallFillerId | null)[], opts: { busy?: () => boolean } = {}) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [], log: string[] = [], lasts: (CallFillerId | null)[] = [];
  let playing: string | null = null, endPlay: (() => void) | null = null;
  const s = new CallFillerScheduler({
    choose: async last => { lasts.push(last); const id = picks.shift() ?? null; return id && { id, delayMs: 400 }; },
    player: {
      play: async id => { if (playing) log.push('OVERLAP'); playing = id; log.push('play:' + id); return { ended: new Promise<void>(resolve => { endPlay = () => { playing = null; resolve(); }; }) }; },
      stop: () => { if (playing) log.push('stop:' + playing); playing = null; endPlay?.(); },
    },
    replyBusy: () => opts.busy?.() ?? false,
    timers: { set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: handle => { (handle as { live: boolean }).live = false; } },
  });
  const run = async () => { await new Promise(resolve => setImmediate(resolve)); for (const t of timers.splice(0)) if (t.live) t.fn(); await new Promise(resolve => setImmediate(resolve)); };
  return { s, log, lasts, run, timers, isPlaying: () => playing, end: () => endPlay?.() };
}

test('filler: one short sound per user turn, after the pause (delay minus the quiet already passed), cut by her real first sound', async () => {
  const f = scheduler(['mm', 'eh']);
  f.s.paused(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.timers[0].ms, 300);
  await f.run();
  assert.deepEqual(f.log, ['play:mm']);
  f.s.paused(50); await f.run();
  assert.deepEqual(f.log, ['play:mm'], 'never a second one in the same turn');
  f.s.replySounding();
  assert.deepEqual(f.log, ['play:mm', 'stop:mm'], 'her real reply cuts it');
  assert.equal(f.isPlaying(), null);
  f.s.spoke(); f.s.paused(0); await f.run();
  assert.deepEqual(f.log.slice(2), ['play:eh']);
  assert.deepEqual(f.lasts, [null, 'mm'], 'the pick is told the last sound (never twice in a row)');
  assert.ok(!f.log.includes('OVERLAP'));
});

test('filler: never starts while her reply is loading or sounding; the user talking again cancels one not yet started', async () => {
  let busy = true;
  const f = scheduler(['mm', 'wu'], { busy: () => busy });
  f.s.paused(0); await f.run();
  assert.deepEqual(f.log, [], 'reply busy: no sound');
  busy = false;
  f.s.answered(); f.s.spoke();
  f.s.paused(0);
  await new Promise(resolve => setImmediate(resolve));
  f.s.spoke(); // the user goes on before the 400 ms
  await f.run();
  assert.deepEqual(f.log, []);
});

test('filler choice reads her mood only: never the last sound, tense → less often, sleepy → later; nothing is written', () => {
  const mood = Object.freeze({ values: Object.freeze({ D: 50, O: 50, E: 50, N: 50, C: 50 }), baseline: Object.freeze({ D: 50, O: 50, E: 50, N: 50, C: 50 }), A: 0.1 });
  let r = 0;
  const random = () => { r = (r * 7 + 3) % 10; return r / 10; };
  for (let i = 0; i < 200; i++) {
    const last = CALL_FILLER_IDS[i % CALL_FILLER_IDS.length];
    const pick = chooseCallFiller({ ...mood, last, random });
    if (pick) assert.notEqual(pick.id, last);
  }
  const tense = callFillerChance({ ...mood, values: { ...mood.values, C: 90 } }), calm = callFillerChance(mood), happy = callFillerChance({ ...mood, values: { ...mood.values, D: 85, O: 80 } });
  assert.ok(tense < calm && calm < happy, `${tense} < ${calm} < ${happy}`);
  assert.ok(tense >= VOICE_CALL_KNOBS.filler.chanceMin && happy <= VOICE_CALL_KNOBS.filler.chanceMax);
  const sleepy = chooseCallFiller({ ...mood, A: 0.9, last: null, random: () => 0 });
  assert.equal(sleepy?.delayMs, VOICE_CALL_KNOBS.filler.delayMs + VOICE_CALL_KNOBS.filler.sleepyExtraMs);
  assert.ok(['mm', 'wu', 'en', 'ahmm', 'mmmm'].includes(sleepy!.id), 'sleepy: never a bright "诶？"');
  assert.deepEqual(mood.values, { D: 50, O: 50, E: 50, N: 50, C: 50 });
});

// ---------------------------------------------------------------- the call on the host

function controller(over: Partial<{ voice: { on: boolean; owner: 'pet' | 'controls' | null }; shown: boolean; asleep: boolean; turnOn: boolean }> = {}) {
  let now = 0;
  const state = { voice: over.voice ?? { on: false, owner: null as 'pet' | 'controls' | null }, shown: over.shown ?? true, asleep: over.asleep ?? false };
  const warm: boolean[] = [], views: boolean[] = [], journal: unknown[] = [], off: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const c = new VoiceCallController({
    now: () => now,
    timers: { set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clear: handle => { (handle as { live: boolean }).live = false; } },
    voiceInput: () => ({ ...state.voice }),
    turnOnVoice: owner => { if (over.turnOn === false) return false; state.voice = { on: true, owner }; return true; },
    turnOffVoice: owner => { off.push(owner); state.voice = { on: false, owner: null }; },
    windowShown: () => state.shown, asleep: () => state.asleep, fillers: () => null,
    keepWarm: on => warm.push(on), publish: view => views.push(view.on), journal: entry => journal.push(entry),
  }, 150_000);
  const advance = (ms: number) => { const end = now + ms; while (now < end) { now += 1000; for (const t of timers.splice(0)) if (t.live) t.fn(); } };
  return { c, state, warm, views, journal, off, advance };
}

test('call: starting opens the microphone and keeps her process warm; a long silence hangs up and closes what the call opened', async () => {
  const h = controller();
  const view = await h.c.start('pet', 'button');
  assert.equal(view.on, true); assert.deepEqual(h.state.voice, { on: true, owner: 'pet' }); assert.deepEqual(h.warm, [true]);
  h.advance(100_000); h.c.heard(); h.advance(149_000);
  assert.equal(h.c.on, true, 'speaking restarts the silence clock');
  h.advance(2_000);
  assert.equal(h.c.on, false);
  assert.equal(h.c.view().ended, 'silence');
  assert.deepEqual(h.off, ['pet'], 'the microphone the call opened is closed');
  assert.deepEqual(h.warm, [true, false]);
  const end = h.journal.at(-1) as Record<string, unknown>;
  assert.deepEqual(Object.keys(end).sort(), ['bargeIns', 'event', 'reason', 'seconds', 'turns']);
  assert.equal(end.reason, 'silence');
});

test('call: voice input off, her falling asleep, or the window leaving the screen end it at once; hold-T voice input stays as it was', async () => {
  for (const [change, reason] of [[(h: ReturnType<typeof controller>) => { h.state.voice = { on: false, owner: null }; }, 'voice-off'],
    [(h: ReturnType<typeof controller>) => { h.state.asleep = true; }, 'asleep'], [(h: ReturnType<typeof controller>) => { h.state.shown = false; }, 'hidden']] as const) {
    const h = controller({ voice: { on: true, owner: 'controls' } });
    await h.c.start('pet', 'chat');
    assert.equal(h.c.owner, 'controls', 'the call uses the window that owns the microphone');
    change(h);
    assert.equal(h.c.check(), reason);
    assert.equal(h.c.on, false);
    assert.deepEqual(h.off, [], 'voice input that was on before the call is not turned off by hanging up');
  }
  const asleep = controller({ asleep: true });
  await assert.rejects(asleep.c.start('pet', 'button'), /睡着/);
  assert.equal(asleep.state.voice.on, false, 'nothing opened');
  const refused = controller({ turnOn: false });
  await assert.rejects(refused.c.start('pet', 'button'), /麦克风没有打开/);
  assert.equal(refused.c.on, false);
});

test('interruption: marked once, only for the reply she is reading; the next turn gets one private line (I-204: where, said, rest, the user\'s line)', () => {
  const ledger = new InterruptionLedger();
  ledger.noteReading('reply-1');
  assert.equal(ledger.mark('reply-1'), true);
  assert.equal(ledger.mark('reply-1'), false, 'never twice');
  ledger.noteReading('reply-2');
  const late = new InterruptionLedger();
  late.noteReading('old'); late.noteReading('new');
  assert.equal(late.mark('old'), false, 'a late mark for an older reply (a newer one is being read) is ignored');
  assert.equal(late.takeNote(() => null), '');
  assert.match(ledger.takeNote(() => null), /你被用户打断了/);
  assert.equal(ledger.takeNote(() => null), '', 'taken once');
});

test('interruption reaches only her next voice request, once, and nothing is archived or rewarded twice', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i091-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku'; settings.voice.enabled = true;
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const rewards: string[] = [], original = service.mood.event.bind(service.mood);
  service.mood.event = (...args) => { rewards.push(args[0].type); original(...args); };
  const personas: string[] = [], ledger = new InterruptionLedger(), media = { voiceInput: true, voiceOwner: 'controls' as const };
  const pending = new Set<string>(), asr: string[] = [];
  const host = new VoiceChatHost({
    broadcast: event => { if (event.type === 'speech') ledger.noteReading(event.replyId); }, memoryChanged() {}, windowVisible: () => true, media: () => media,
    turnOffVoiceInput() {}, speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async (task, _signal, emit) => { personas.push(task.session!.persona); emit('delta', '好呀。'); return { superseded: false, output: '好呀。' }; } },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    turnNote: () => ledger.takeNote(() => null),
  });
  try {
    const binding = host.open(77, 'controls');
    let seq = 0;
    const say = async (text: string) => {
      asr.push(text);
      host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
      host.pipeline.finishSpeaking(77, binding.captureSessionId);
      const before = personas.length;
      for (let i = 0; i < 400 && personas.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drain();
    };
    await say('第一句');
    ledger.noteReading('reply-x'); assert.equal(ledger.mark('reply-x'), true); assert.equal(ledger.mark('reply-x'), false);
    await say('第二句');
    await say('第三句');
    assert.equal(personas.length, 3);
    const CUT = '你被用户打断了'; // I-204's note (shared/voice/call-cut-note.ts)
    assert.ok(!personas[0].includes(CUT));
    assert.ok(personas[1].includes(CUT), 'the turn after the interruption knows');
    assert.ok(!personas[2].includes(CUT), 'only once');
    const scope = service.currentScope();
    const archived = () => { const page = service.memory.list(scope); return page.total ? service.memory.read(scope, page.records[0].id)! : null; };
    for (let i = 0; i < 100 && (archived()?.messages.length ?? 0) < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await host.drain(); await service.flush(); }
    // (The conversation record catches up with the newest utterance on the next one; the first two are there.)
    assert.equal(service.memory.list(scope).total, 1);
    const users = archived()!.messages.filter(message => message.role === 'user').map(message => message.content);
    assert.deepEqual(users.slice(0, 2), ['第一句', '第二句'], 'the utterance after the interruption archived once');
    assert.equal(new Set(users).size, users.length, 'nothing archived twice');
    assert.equal(rewards.filter(type => type === 'chat').length, 3, 'one acceptance per utterance, none for the interruption');
  } finally { host.dispose(); await host.drain(); await service.flush(); await rm(directory, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- filler clips: cache, voice change, spending

function memoryFs(): CallFillerFs & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const norm = (p: string) => p.replace(/\\/g, '/');
  return { files,
    readFile: async file => { const data = files.get(norm(file)); if (!data) throw Error('ENOENT'); return data; },
    writeFile: async (file, data) => { files.set(norm(file), Buffer.from(data)); },
    mkdir: async () => undefined,
    readdir: async dir => [...new Set([...files.keys()].filter(key => key.startsWith(norm(dir) + '/')).map(key => key.slice(norm(dir).length + 1).split('/')[0]))],
    rm: async target => { for (const key of [...files.keys()]) if (key.startsWith(norm(target) + '/')) files.delete(key); },
    exists: file => files.has(norm(file)),
  };
}
const bailian = (voice = 'Cherry'): TtsConfig => ({ ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'bailian', apiHost: 'https://dashscope.aliyuncs.com', model: 'qwen3-tts-flash', voice, apiKey: 'k' });

test('filler clips: the system voice needs none and spends nothing; a paid voice makes ≤ 8 clips only after the notice, once, and again when the voice changes', async () => {
  const fs = memoryFs(); let calls = 0;
  const store = new CallFillerStore({ directory: () => '/profile', fs, synthesize: async (_config, _text, _signal, emit) => {
    calls++; await emit({ type: 'audio', data: Buffer.alloc(4800).toString('base64'), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  } });
  const system = { ...structuredClone(DEFAULT_TTS_CONFIG), provider: 'system' as const };
  assert.deepEqual({ ...store.status('c1', system), voiceKey: '' }, { provider: 'system', paid: false, ready: true, missing: 0, voiceKey: '' });
  assert.deepEqual(await store.generate('c1', system, undefined), { generated: 0, failed: 0 });
  const first = bailian();
  assert.equal(store.status('c1', first).missing, CALL_FILLER_IDS.length);
  assert.ok(CALL_FILLER_IDS.length <= 8);
  // every quick sound is a sound, never words.
  for (const id of CALL_FILLER_IDS) assert.match(CALL_FILLER_TEXT[id], /^[嗯啊哦唔诶额呃哼噢欸，。！？…—\s]+$/u, `${id}: sounds only, no words`);
  await assert.rejects(store.generate('c1', first, 'wrong-key'), /费用说明/);
  assert.equal(calls, 0, 'no notice for this voice: no paid call');
  assert.deepEqual(await store.generate('c1', first, callFillerVoiceKey(first)), { generated: CALL_FILLER_IDS.length, failed: 0 });
  assert.equal(calls, CALL_FILLER_IDS.length);
  assert.equal(store.status('c1', first).ready, true);
  assert.equal(Object.keys((await store.clips('c1', first)).clips).length, CALL_FILLER_IDS.length);
  await store.generate('c1', first, callFillerVoiceKey(first));
  assert.equal(calls, CALL_FILLER_IDS.length, 'cached: never generated twice');
  const second = bailian('Serena');
  assert.notEqual(callFillerVoiceKey(second), callFillerVoiceKey(first));
  assert.equal(store.status('c1', second).ready, false, 'a new voice needs its own clips');
  await store.generate('c1', second, callFillerVoiceKey(second));
  assert.equal(calls, CALL_FILLER_IDS.length * 2);
  assert.equal(store.status('c1', first).ready, false, 'the old voice\'s clips were removed');
  assert.ok([...fs.files.keys()].every(key => /\/voice-call-fillers\/[0-9a-f]{16}\/[0-9a-f]{16}\/[a-z]+\.pcm$/.test(key)), 'hashed folders, fixed ids: no voice name or key on disk');
  assert.ok(!JSON.stringify([...fs.files.keys()]).includes('Serena'));
  assert.match(callFillerPaidNotice('bailian', 8), /约 8 次很短的朗读调用（会产生少量费用）/);
});

test('host: no sound pick for a paid voice without its clips; the pick carries the voice key; outside a call nothing', async () => {
  let config: TtsConfig | null = bailian();
  const fs = memoryFs();
  const host = new VoiceCallHost({ now: () => 0, timers: { set: () => 0, clear() {} }, media: () => ({ voiceInput: true, voiceOwner: 'pet' }),
    turnOnVoice: () => true, turnOffVoice() {}, windowShown: () => true, asleep: () => false, ttsConfig: () => config, characterId: () => 'c1',
    mood: () => ({}), keepWarm() {}, broadcast() {}, journal() {}, directory: () => '/p', fs, random: () => 0,
    synthesize: async (_c, _t, _s, emit) => { await emit({ type: 'audio', data: Buffer.alloc(480).toString('base64'), format: 'pcm_s16le', sampleRate: 24000, channels: 1 }); } });
  assert.equal(host.filler('pet', null), null, 'no call');
  await host.set('pet', true);
  assert.equal(host.filler('pet', null), null, 'paid voice, clips missing: silent until the notice was shown');
  await host.prepare('pet', host.view().fillers!.voiceKey);
  const pick = host.filler('pet', 'mm');
  assert.ok(pick && pick.id !== 'mm' && pick.voiceKey === callFillerVoiceKey(config));
  assert.equal(host.filler('controls', null), null, 'only the call\'s window');
  config = null;
  assert.equal(host.filler('pet', null), null, 'read-aloud off: no sound');
  host.dispose();
});

// ---------------------------------------------------------------- the user's own Claude: always the dialog

test('channel: starting a call is sensitive (the dialog after the user\'s words); hanging up is direct', async () => {
  const spec = AGENT_SETTINGS.find(item => item.id === 'voice_call') as AgentSettingSpec;
  assert.ok(spec && settingAlwaysDialog(spec), 'privacy: the dialog even with the user\'s words');
  let on = false; const calls: [boolean, string][] = [];
  const bridge = {
    settings: () => structuredClone(DEFAULT_SETTINGS), interconnected: () => true, windows: () => ({ pet: { visible: true, minimized: false }, controls: null }),
    characters: () => ({ activeId: 'a', revision: 1, cards: [{ id: 'a', name: '阿棠' }] }),
    voiceCall: () => on, setVoiceCall: async (value: boolean, via: string) => { calls.push([value, via]); on = value; },
  } as unknown as AgentAppBridge;
  const asked: AgentConfirmRequest[] = [];
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true, confirmTimeoutMs: 2_000,
    confirm: async request => { asked.push(request); return true; } });
  const refused = await registry.call('set_setting', { id: 'voice_call', value: true });
  assert.equal((refused as any).error?.code, 'needs_user_words');
  assert.deepEqual(calls, [], 'nothing opened without the user\'s words');
  const started = await registry.call('set_setting', { id: 'voice_call', value: true, userWords: '我们打电话吧' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(asked.length, 1, 'the dialog was shown');
  assert.match(asked[0].title, /通话/); assert.match(asked[0].detail, /麦克风一直开着/); assert.match(asked[0].detail, /我们打电话吧/);
  const ended = await registry.call('set_setting', { id: 'voice_call', value: false });
  assert.equal(ended.ok, true);
  assert.equal(asked.length, 1, 'hanging up: no dialog, no words');
  assert.deepEqual(calls, [[true, 'agent'], [false, 'agent']]);
  assert.ok(AGENT_HOST_OPERATIONS.includes('setVoiceCall') && AGENT_PET_OPERATIONS.includes('setVoiceCall'), 'the pet window\'s own handler');
});

test('channel with the consent check removed would start the call without a dialog (mutation guard)', async () => {
  const spec = AGENT_SETTINGS.find(item => item.id === 'voice_call')!;
  assert.equal(settingAlwaysDialog({ ...spec, consent: 'behavior' }), false, 'a non-sensitive reason drops the dialog: the catalog must say privacy');
  assert.equal(spec.consent, 'privacy');
  assert.deepEqual(spec.confirmWhen, [true]);
});

// ---------------------------------------------------------------- journal: numbers only; timing; warm process

test('journal: call lines keep numbers and closed words only', () => {
  const entries = [
    buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'start', via: 'channel', words: '我们打电话吧' }, 1),
    buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'end', reason: 'silence', seconds: 61.4, turns: 3, bargeIns: 1, text: '秘密' }, 2),
    buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'turn', endpointMs: 712.3, handInMs: 760, textMs: 820, fillerMs: 1105, firstCharMs: 2500, firstSoundMs: null, bargeIn: true, transcript: 'x' }, 3),
    buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'claude', process: 'warm', firstDeltaMs: 1597 }, 4),
  ];
  for (const entry of entries) assert.ok(entry);
  const json = JSON.stringify(entries);
  assert.doesNotMatch(json, /我们打电话吧|秘密|transcript|words/);
  assert.equal((entries[2] as any).endpointMs, 712);
  assert.equal(buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'end', reason: 'because', seconds: 1, turns: 0, bargeIns: 0 }, 5), null);
  assert.equal(buildJournalEntry({ type: 'voice-call', characterId: 'c', event: 'claude', process: 'hot', firstDeltaMs: 1 }, 5), null);
  for (const entry of entries) assert.ok(describeJournalEntry(entry!, (text: string, ...args: unknown[]) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), text)).length > 0);
});

test('turn clock: one line per turn from the last voiced moment; a turn cut short is sent as it is', () => {
  let now = 0; const sent: unknown[] = [];
  const clock = new CallTurnClock(() => now, timing => sent.push(timing));
  clock.voiced(); now = 700; clock.endpoint(); now = 760; clock.handedIn(); now = 820; clock.text(); now = 1100; clock.filler(); now = 2900; clock.firstChar(); now = 4200; clock.firstSound();
  assert.deepEqual(sent, [{ endpointMs: 700, handInMs: 760, textMs: 820, fillerMs: 1100, firstCharMs: 2900, firstSoundMs: 4200, soundAfterCharMs: 1300, earlyRead: true, bargeIn: false,
    endToSoundMs: 1100, vad: false, endBy: 'silence' }]); // I-099: her first sound of any kind was the "嗯" at 1100 ms; I-099/I-100: no turn model, the plain silence rule
  clock.interrupted(); clock.voiced(); now = 5000; clock.endpoint(); clock.flush();
  assert.equal((sent[1] as any).bargeIn, true);
  assert.equal((sent[1] as any).firstSoundMs, null);
});

test('Claude timing during a call: warm or not and the first delta, recorded only while a call is on; the dev probe still sees everything', () => {
  let on = false, now = 0; const recorded: unknown[] = [], base: string[] = [];
  const tee = teeCallTiming({ dispatched: id => base.push('d:' + id), firstDelta: id => base.push('f:' + id) }, { on: () => on, record: (process, ms) => recorded.push([process, ms]) }, () => now);
  tee.dispatched('a', { mode: 'persistent', process: 'warm', sessionTurn: 2 }); now = 900; tee.firstDelta('a');
  on = true;
  tee.dispatched('b', { mode: 'persistent', process: 'prewarmed', sessionTurn: 1 }); now = 2300; tee.firstDelta('b');
  assert.deepEqual(recorded, [['prewarmed', 1400]]);
  assert.deepEqual(base, ['d:a', 'f:a', 'd:b', 'f:b']);
});

test('her Claude process is never closed for idling while a call is on', async () => {
  const claude = await fakeClaudeStream();
  const timers = new Map<number, { callback: () => void; ms: number }>(); let next = 0;
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, idleMs: 600_000, hiddenIdleMs: 180_000,
    timers: { set: (callback: () => void, ms: number) => { timers.set(++next, { callback, ms }); return next; }, clear: (handle: unknown) => { timers.delete(handle as number); } } });
  const idle = () => [...timers.values()].filter(timer => timer.ms > 60_000);
  try {
    chat.noteVisible(true);
    for (let i = 0; i < 200 && (await claude.spawns()).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(idle().length, 1, 'an idle clock runs normally');
    chat.holdWarm(true);
    assert.equal(idle().length, 0, 'held during the call');
    chat.noteVisible(true);
    assert.equal(idle().length, 0);
    chat.holdWarm(false);
    assert.equal(idle().length, 1, 'after the call the idle clock runs again');
  } finally { chat.dispose(); await claude.cleanup(); }
});
