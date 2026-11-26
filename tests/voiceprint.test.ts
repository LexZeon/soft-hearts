// Unbound v1 step 3, sub-step 3 (docs/claude/2026-11-17-unbound-step3.md): 只认你的声音. The rule (clearly not you → ignored; unsure,
// short, noisy or mixed → counted as you and said), the user's own calibration, the encrypted store, the host's privacy gates (off by
// default, nothing without the switch and a voiceprint, no runtime download, delete and 「允许记录」 off remove it, nothing leaves),
// and the two checks in the voice path (a clip that is clearly someone else never becomes words; listening for her name).
// Synthetic audio only; the model process is a fake (the real model has its own opt-in test, voiceprint-real.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VOICEPRINT_KNOBS, counted, decideVoice, enrolVoice, voiceCheckLine, voiceQuality } from '../shared/senses/voiceprint';
import { VoiceprintHost, type VoiceprintWorkerHandle } from '../electron/senses/voiceprint/host';
import { VoiceprintDataStore, VoiceprintEncryptionUnavailable } from '../electron/senses/voiceprint/store';
import { listensForName, screenClip, wakeFilter } from '../electron/senses/voiceprint/gate';
import { VOICEPRINT_MODEL_PIN, approvedFetch } from '../electron/senses/voiceprint/manifest';
import { recordingOffRegistry, runRecordingOff } from '../electron/memory/privacy-wiring';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { encodeWav } from '../src/senses/MediaInput';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { VoiceConversationEvent } from '../shared/voice/voice-conversation';

const RATE = 16_000;
/** A synthetic "voice": a tone at `hz` (its identity here), with a little quiet before and after, as a short sentence has. */
function voice(hz: number, seconds: number, amplitude = 0.3): Float32Array {
  const quiet = Math.round(0.3 * RATE), body = Math.round(seconds * RATE), out = new Float32Array(quiet * 2 + body);
  for (let i = 0; i < body; i++) out[quiet + i] = amplitude * Math.sin(2 * Math.PI * hz * i / RATE) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * i / RATE));
  return out;
}
function noise(seconds: number): Float32Array { let seed = 7; const out = new Float32Array(Math.round(seconds * RATE)); for (let i = 0; i < out.length; i++) { seed = (seed * 16807) % 2147483647; out[i] = (seed / 2147483647 - 0.5) * 0.4; } return out; }
const join = (a: Float32Array, b: Float32Array) => { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** The fake model: the dominant pitch decides the direction (who), the clip's length a small wobble (each clip differs a little). */
function fakeEmbed(samples: Float32Array): Float32Array {
  let crossings = 0, voiced = 0;
  for (let i = 1; i < samples.length; i++) { if (Math.abs(samples[i]) > 0.01) { voiced++; if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++; } }
  const hz = voiced ? crossings / 2 / (voiced / RATE) : 0, who = Math.round(hz / 40);
  const out = new Float32Array(192);
  for (let i = 0; i < 192; i++) out[i] = Math.sin(who * 12.9898 + i * 78.233) + 0.08 * Math.sin(samples.length * 0.001 + i);
  return out;
}

test('quality: silence is too short, a steady hiss is too noisy, a spoken sentence can be judged', () => {
  assert.equal(voiceQuality(new Float32Array(RATE)).quality, 'short');
  assert.equal(voiceQuality(voice(200, 0.4)).quality, 'short', 'less than the minimum of speech');
  assert.equal(voiceQuality(noise(2)).quality, 'noisy');
  const ok = voiceQuality(voice(200, 2));
  assert.equal(ok.quality, 'ok'); assert.ok(ok.voicedSeconds > 1.8 && ok.voicedSeconds < 2.2, String(ok.voicedSeconds));
  const clipped = voice(200, 2, 1.5).map(x => Math.max(-1, Math.min(1, x)));
  assert.equal(voiceQuality(clipped).quality, 'noisy', 'clipped');
});

test('the rule: clearly not you is ignored; unsure, too short, noisy or two voices mixed count as you, and each is said', () => {
  const user = [0, 1, 2, 3, 4, 5].map(i => fakeEmbed(voice(200, 3 + i * 0.3)));
  const { centroid, calibration } = enrolVoice(user);
  assert.ok(calibration.accept > calibration.reject, 'two cut-offs from the user\'s own clips');
  const score = (samples: Float32Array) => { const v = fakeEmbed(samples); let d = 0, a = 0, b = 0; for (let i = 0; i < 192; i++) { d += v[i] * centroid[i]; a += v[i] ** 2; b += centroid[i] ** 2; } return d / Math.sqrt(a * b); };
  assert.equal(decideVoice({ quality: 'ok', score: score(voice(200, 2.4)), calibration }).check, 'you');
  assert.equal(decideVoice({ quality: 'ok', score: score(voice(330, 2.4)), calibration }).check, 'not-you', 'another voice');
  assert.equal(decideVoice({ quality: 'ok', score: (calibration.accept + calibration.reject) / 2, calibration }).check, 'unsure');
  assert.deepEqual(decideVoice({ quality: 'short', score: null, calibration }), { check: 'cannot', why: 'short' });
  assert.deepEqual(decideVoice({ quality: 'noisy', score: 0.99, calibration }), { check: 'cannot', why: 'noisy' });
  assert.deepEqual(decideVoice({ quality: 'ok', score: 0.99, halves: calibration.reject - 0.2, calibration }), { check: 'cannot', why: 'mixed' });
  assert.equal(counted('not-you'), false);
  for (const check of ['you', 'unsure', 'cannot'] as const) assert.equal(counted(check), true, `${check} counts as you`);
  assert.match(voiceCheckLine({ check: 'cannot', why: 'short', at: 1 }), /太短，确认不了/);
  assert.match(voiceCheckLine({ check: 'cannot', why: 'mixed', at: 1 }), /混在一起/);
  assert.throws(() => enrolVoice([user[0]]), 'one clip is not a voiceprint');
});

const secret = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text: string) => Buffer.from('enc:' + Buffer.from(text, 'utf8').toString('hex').split('').reverse().join('')),
  decryptString: (bytes: Buffer) => Buffer.from(bytes.toString().slice(4).split('').reverse().join(''), 'hex').toString('utf8'),
});

test('store: only encrypted numbers; no secure storage, nothing saved; delete removes the file', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new VoiceprintDataStore(dir, secret());
  const centroid = new Float32Array(192).map((_, i) => Math.sin(i));
  await store.save({ enabled: true, print: { centroid, calibration: { reject: 0.2, accept: 0.5 }, clips: 6, seconds: 25, at: 1 } });
  const raw = await readFile(path.join(dir, 'voiceprint.json'), 'utf8');
  assert.ok(!raw.includes(Buffer.from(centroid.buffer).toString('base64')), 'never in the clear');
  assert.ok(!/"reject"|"accept"|0\.5/.test(raw.replace(/"print":"[^"]+"/, '')), 'nothing but the switch outside the encrypted part');
  const back = await store.load();
  assert.equal(back.enabled, true); assert.deepEqual(Array.from(back.print!.centroid), Array.from(centroid));
  assert.equal((await new VoiceprintDataStore(dir, secret(false)).load()).print, null, 'no secure storage: unreadable, as nothing');
  await assert.rejects(new VoiceprintDataStore(dir, secret(false)).save({ enabled: true, print: back.print }), VoiceprintEncryptionUnavailable);
  await store.deleteAll();
  await assert.rejects(stat(path.join(dir, 'voiceprint.json')));
  assert.deepEqual(await store.load(), { enabled: false, print: null });
});

function rig(dir: string, options: { shared?: boolean; encryption?: boolean } = {}) {
  const views: unknown[] = [], forks: number[] = [], installs: number[] = [], embeds: number[] = [];
  const component = { installed: false, working: false, refresh: async () => component.installed, installedBytes: 0,
    install: async () => { installs.push(1); component.installed = true; }, remove: async () => { component.installed = false; },
    installedDir: () => component.installed ? path.join(dir, 'component') : null, installedFile: (to: string) => component.installed ? path.join(dir, 'component', to) : null };
  const fork = (): VoiceprintWorkerHandle => {
    forks.push(1);
    let listener: (message: unknown) => void = () => {};
    return { onMessage: l => { listener = l; }, onExit: () => {}, kill: () => {},
      postMessage: message => { queueMicrotask(() => {
        if (message.type === 'init') listener({ type: 'ready', loadMs: 1 });
        else if (message.type === 'embed') { embeds.push(message.samples.length); listener({ type: 'result', id: message.id, vector: fakeEmbed(message.samples), ms: 1 }); }
      }); } };
  };
  const data = new VoiceprintDataStore(dir, secret(options.encryption !== false));
  const host = new VoiceprintHost({ store: component as never, data, fork, publish: view => views.push(view), sharedRuntime: () => options.shared !== false, setTimer: () => 0, clearTimer: () => {} });
  return { host, views, forks, installs, embeds, component, data };
}

async function enrol(host: VoiceprintHost, hz = 200) {
  host.startEnrol();
  for (let i = 0; i < VOICEPRINT_KNOBS.enrol.clips; i++) assert.equal(await host.take(voice(hz, 4.2 + i * 0.1)), true, 'the clip is taken for the sample, not for her chat');
}

test('off by default: no clip is judged, nothing is started, nothing is downloaded', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = rig(dir);
  await r.host.init();
  assert.equal(r.host.enabled, false);
  assert.equal(await r.host.check(voice(200, 2)), null);
  assert.equal(await screenClip(r.host, encodeWav(voice(330, 2))), 'pass', 'off: every clip passes as before');
  assert.deepEqual([r.forks.length, r.installs.length], [0, 0]);
  assert.throws(() => r.host.startEnrol(), /先打开/);
});

test('turning it on downloads only the model, and only when a runtime can be copied (no runtime download)', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const none = rig(dir, { shared: false });
  await none.host.init(); await none.host.setEnabled(true); await tick();
  assert.equal(none.installs.length, 0, 'no runtime to copy: nothing is installed');
  assert.equal(none.host.view().phase, 'needs-runtime');
  const fetched: string[] = [];
  const guard = approvedFetch((async (url: string) => { fetched.push(url); return new Response('x'); }) as never);
  await (guard as unknown as (url: string) => Promise<unknown>)(VOICEPRINT_MODEL_PIN.url);
  await assert.rejects((guard as unknown as (url: string) => Promise<unknown>)('https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz'), /not approved/);
  assert.deepEqual(fetched, [VOICEPRINT_MODEL_PIN.url], 'only the approved file is ever fetched');
  const ok = rig(dir);
  await ok.host.init(); await ok.host.setEnabled(true); await tick(); await tick();
  assert.equal(ok.installs.length, 1);
});

test('enrolling: the user\'s own clips become one encrypted voiceprint; then only a clearly different voice is dropped', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = rig(dir);
  await r.host.init(); await r.host.setEnabled(true); await tick(); await tick();
  assert.equal(await r.host.take(voice(200, 3)), false, 'not enrolling: nothing is taken');
  r.host.startEnrol();
  assert.equal(await r.host.take(voice(200, 0.5)), true); assert.equal(r.host.view().notice, 'enrol-skipped', 'too short: said, not counted');
  r.host.cancelEnrol();
  await enrol(r.host);
  const view = r.host.view();
  assert.equal(view.enrolled?.clips, VOICEPRINT_KNOBS.enrol.clips); assert.equal(view.enrolling, null); assert.equal(view.notice, 'enrolled');
  assert.ok(!/centroid|calibration|reject|accept|score/.test(JSON.stringify(r.views)), 'no voiceprint and no score ever leaves the host');
  assert.equal((await r.host.check(voice(200, 2.5)))?.check, 'you');
  assert.equal((await r.host.check(voice(330, 2.5)))?.check, 'not-you');
  assert.deepEqual(await r.host.check(voice(200, 0.4)), { check: 'cannot', why: 'short' });
  assert.deepEqual(await r.host.check(join(voice(200, 2), voice(330, 2))), { check: 'cannot', why: 'mixed' }, 'two voices: can\'t confirm, counted as you');
  assert.equal(r.host.view().lastCheck?.check, 'cannot');
  const wav = (samples: Float32Array) => encodeWav(samples);
  assert.equal(await screenClip(r.host, wav(voice(330, 2.5))), 'drop', 'someone else: never recognized');
  assert.equal(await screenClip(r.host, wav(voice(200, 2.5))), 'pass');
  assert.equal(await screenClip(r.host, wav(voice(330, 0.4))), 'pass', 'too short to tell: counted as you');
  r.host.startEnrol();
  assert.equal(await screenClip(r.host, wav(voice(200, 4.5))), 'taken', 'while recording the sample a clip is taken for it, never for her chat');
  r.host.cancelEnrol();
  await r.host.setEnabled(false);
  assert.equal(await r.host.check(voice(330, 2.5)), null, 'switched off: nothing is judged although a voiceprint exists');
  assert.equal(await screenClip(r.host, wav(voice(330, 2.5))), 'pass');
  assert.equal(r.host.view().lastCheck, null, 'and nothing about it is shown');
  const reloaded = rig(dir); await reloaded.host.init(); reloaded.component.installed = true;
  assert.equal(reloaded.host.view().enrolled?.clips, VOICEPRINT_KNOBS.enrol.clips, 'kept (encrypted) across a restart');
});

test('no secure storage: nothing is enrolled', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = rig(dir, { encryption: false });
  await r.host.init(); await r.host.setEnabled(true); await tick(); await tick();
  assert.throws(() => r.host.startEnrol(), /加密/);
  assert.equal(r.host.view().notice, 'no-encryption');
});

test('delete and 「允许记录」 off remove the voiceprint at once; a check under way then judges nothing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voiceprint-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = rig(dir);
  await r.host.init(); await r.host.setEnabled(true); await tick(); await tick(); await enrol(r.host);
  const pending = r.host.check(voice(330, 2.5));
  await r.host.deleteData();
  assert.equal(await pending, null, 'deleted while checking: nothing judged');
  await assert.rejects(stat(path.join(dir, 'voiceprint.json')));
  assert.equal(r.host.view().enrolled, null); assert.equal(r.host.enabled, false);
  assert.equal(await r.host.check(voice(330, 2.5)), null);
  // 「允许记录」 off goes through the data map's registry.
  const s = rig(dir); await s.host.init(); await s.host.setEnabled(true); await tick(); await tick(); await enrol(s.host);
  const registry = recordingOffRegistry({ voiceprint: s.host } as never);
  assert.ok(registry.voiceprint, 'the voiceprint has a clear in the recording-off registry');
  runRecordingOff(registry, { characterId: 'c', providerScope: 'p' }, 'recording-off');
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(stat(path.join(dir, 'voiceprint.json')));
  assert.equal(s.host.view().enrolled, null);
});

test('listening for her name: only while it listens; words without her name are dropped; her name starts the call', async () => {
  const started: string[] = [];
  let call = false, listening = true, starts = true;
  const ports = { callOn: () => call, listening: () => listening, names: () => ['艾琳', '小艾'], startCall: async (owner: string) => { started.push(owner); call = starts; return starts; } };
  assert.equal(await wakeFilter(ports, 'pet', '今天好累啊'), false, 'no name: dropped');
  assert.equal(await wakeFilter(ports, 'pet', ''), false, 'no words: dropped quietly');
  assert.deepEqual(started, []);
  assert.equal(await wakeFilter(ports, 'pet', '小艾，你看这个'), true, 'her name: the words go on as the first turn');
  assert.deepEqual(started, ['pet']);
  assert.equal(await wakeFilter(ports, 'pet', '随便说点什么'), true, 'in the call: everything goes on');
  call = false; listening = false;
  assert.equal(await wakeFilter(ports, 'pet', '随便说点什么'), true, 'not listening for her name: as before');
  listening = true; starts = false;
  assert.equal(await wakeFilter(ports, 'pet', '艾琳在吗'), false, 'the call could not start (asleep): dropped too');
});

test('the microphone stays open for her name only when every condition holds (out, your microphone, voiceprint in use, local recognition, awake)', () => {
  const all = { out: true, voiceInput: true, voiceOwner: 'pet' as const, voiceprintActive: true, localRecognition: true, asleep: false };
  assert.equal(listensForName(all, 'pet'), true, 'all hold: it listens');
  assert.equal(listensForName(all, 'controls'), false, 'only the window whose microphone it is');
  assert.equal(listensForName({ ...all, out: false }, 'pet'), false, 'at home in the pet window: no always-on listening');
  assert.equal(listensForName({ ...all, voiceInput: false }, 'pet'), false, 'microphone off: nothing');
  assert.equal(listensForName({ ...all, voiceOwner: null }, 'pet'), false, 'no microphone owner: nothing');
  assert.equal(listensForName({ ...all, voiceprintActive: false }, 'pet'), false, 'no voiceprint in use: not her name alone (the user chose name AND your voice)');
  assert.equal(listensForName({ ...all, localRecognition: false }, 'pet'), false, 'recognition not on this computer: nothing is sent to listen for her name');
  assert.equal(listensForName({ ...all, asleep: true }, 'pet'), false, 'asleep: no');
});

const SETTINGS = DEFAULT_SETTINGS;
function voiceHost(events: VoiceConversationEvent[], transcribed: number[], ports: { screen?: () => Promise<'pass' | 'drop' | 'taken'>; wake?: (owner: string, text: string) => Promise<boolean> }, text = '你好呀') {
  return new VoiceChatHost({
    broadcast: event => { events.push(event); }, memoryChanged() {}, windowVisible: () => true,
    media: () => ({ voiceInput: true, voiceOwner: 'pet' }), turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => SETTINGS, companion: () => ({ beginVoiceGroup: async () => { throw new Error('stop here'); } }) as never,
    ambient: () => null, reserveChat: () => true, releaseChat() {}, userTurn() {}, activityChanged() {}, cancelProactive() {},
    claude: { stream: async () => { throw new Error('stop here'); } } as never, languageProfile: () => null, chatDirectory: () => '.', tempDirectory: () => '.',
    transcribe: async () => { transcribed.push(1); return text; }, stopReading() {}, prepareSpeech() {}, unheard() {},
    ...(ports.screen ? { screen: ports.screen } : {}), ...(ports.wake ? { wake: ports.wake as never } : {}),
  });
}
async function say(host: VoiceChatHost) {
  const binding = host.open(5, 'pet');
  host.pipeline.submit(5, { captureSessionId: binding.captureSessionId, captureSeq: 1, wav: encodeWav(voice(200, 2)) });
  for (let i = 0; i < 6; i++) await tick();
}

test('in the voice path: a clip that is clearly someone else is never recognized and never shown; one taken for the sample neither', async () => {
  for (const verdict of ['drop', 'taken'] as const) {
    const events: VoiceConversationEvent[] = [], transcribed: number[] = [];
    await say(voiceHost(events, transcribed, { screen: async () => verdict }));
    assert.deepEqual(transcribed, [], `${verdict}: not recognized`);
    assert.ok(!events.some(event => event.type === 'row' || event.type === 'unheard'), `${verdict}: nothing shown, no "unheard" note`);
  }
  const events: VoiceConversationEvent[] = [], transcribed: number[] = [];
  await say(voiceHost(events, transcribed, { screen: async () => 'pass' }));
  assert.deepEqual(transcribed, [1]); assert.ok(events.some(event => event.type === 'row'), 'passed: as before');
});

test('in the voice path: while she listens for her name, words without it never show; a failing check drops them', async () => {
  for (const wake of [async () => false, async () => { throw new Error('x'); }]) {
    const events: VoiceConversationEvent[] = [], transcribed: number[] = [];
    await say(voiceHost(events, transcribed, { wake }));
    assert.deepEqual(transcribed, [1]);
    assert.ok(!events.some(event => event.type === 'row' || event.type === 'unheard'), 'dropped unseen');
  }
  const events: VoiceConversationEvent[] = [], transcribed: number[] = [];
  await say(voiceHost(events, transcribed, { wake: async () => true }));
  assert.ok(events.some(event => event.type === 'row' && event.text === '你好呀'));
});
