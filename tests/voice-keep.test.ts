// 保存她念出来的声音（用来比对）: the dev-only keep-her-voice tool (docs/claude/2026-11-24-voice-keep.md). What it must hold:
//  - it exists only on development builds and source runs; on stable (or a packaged build with no channel) nothing is written even when a
//    stale settings file says on, the view says "not here", and the channel's tool refuses;
//  - off writes nothing; on writes one .wav and one sidecar per read sentence with the right provider, voice and character;
//  - only her own reading is kept (a microphone or user origin is refused);
//  - old days go, new days and the tool's own files stay; 清空 asks first; the size cap stops keeping and says so;
//  - turning it on through the channel needs the user's words and the dialog; turning it off and reading are direct.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechRuntime, type SpeechSynthesizer } from '../electron/voice/speech-runtime';
import { VoiceKeepHost } from '../electron/voice/voice-keep/host';
import { HER_READING, VoiceKeepRecorder } from '../electron/voice/voice-keep/recorder';
import { voiceKeepAvailable } from '../electron/voice/voice-keep/availability';
import { dayKey, oldestKeptDay, VoiceKeepStore } from '../electron/voice/voice-keep/store';
import { voiceKeepChannelTool, VOICE_KEEP_DESCRIPTOR } from '../electron/voice/voice-keep/channel-tool';
import { VOICE_KEEP_SIZE_CAP_BYTES } from '../electron/voice/voice-keep/knobs';
import { AgentToolRegistry, type AgentConfirmRequest } from '../electron/safety/agent-channel/registry';
import { AGENT_TOOLS } from '../shared/safety/agent-channel';
import { CAPABILITIES } from '../shared/settings/capabilities';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/voice';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { VoiceKeepPanel, voiceKeepStatus } from '../src/settings/voice-keep-panel';

setUiLanguage('zh-CN');

const HOUR = 3_600_000, DAY_MS = 24 * HOUR;
const NOON = new Date(2026, 10, 24, 12, 0, 0).getTime();
const tick = () => new Promise(resolve => setImmediate(resolve));
const pcmBase64 = (bytes = 480) => Buffer.alloc(bytes, 7).toString('base64');

async function profile(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-keep-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function hostFor(dir: string, over: { available?: () => boolean; confirm?: (count: { sentences: number; bytes: number }) => Promise<boolean>; now?: () => number } = {}) {
  const opened: string[] = [];
  const host = new VoiceKeepHost({ profileDirectory: dir, available: over.available ?? (() => true), now: over.now ?? (() => NOON), character: () => ({ id: 'card-1', name: '阿棠' }),
    confirmClear: over.confirm ?? (async () => true), openFolder: folder => { opened.push(folder); } });
  return { host, opened };
}
/** A synthesizer that answers like the providers: audio chunks, then done. */
const fakeSynth = (chunks = 2): SpeechSynthesizer => async (_config, _text, _signal, emit) => {
  for (let i = 0; i < chunks; i++) await emit({ type: 'audio', data: pcmBase64(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await emit({ type: 'done', firstAudioMs: 5, audioBytes: 480 * chunks });
};
function runtimeFor(host: VoiceKeepHost, config: Partial<TtsConfig> = {}) {
  const events: unknown[] = [];
  const runtime = new SpeechRuntime(() => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://example.invalid', apiKey: 'k', voice: 'longtest', ...config }) as TtsConfig,
    (_owner, event) => { events.push(event); }, fakeSynth(), undefined, {}, undefined, info => host.recorder.begin(HER_READING, info));
  return { runtime, events };
}
const files = async (dir: string) => {
  const root = path.join(dir, 'voice-keep'); const out: string[] = [];
  try { for (const day of await readdir(root, { withFileTypes: true })) if (day.isDirectory()) for (const name of await readdir(path.join(root, day.name))) out.push(`${day.name}/${name}`); } catch { /* none */ }
  return out.sort();
};

test('availability: development builds and source runs only', () => {
  assert.equal(voiceKeepAvailable('development', true), true);
  assert.equal(voiceKeepAvailable('stable', true), false);
  assert.equal(voiceKeepAvailable('stable', false), false);
  assert.equal(voiceKeepAvailable('', false), true, 'a source run');
  assert.equal(voiceKeepAvailable(undefined, true), false, 'a packaged build with no channel is never a test build');
});

test('off writes nothing; on keeps one .wav and one sidecar per read sentence, with the provider, voice and character', async () => {
  const p = await profile();
  try {
    const { host } = hostFor(p.dir);
    const { runtime, events } = runtimeFor(host);
    await runtime.speak(1, 's1', '你好呀。', { replyId: 'r1', segmentIndex: 0 });
    await host.recorder.idle();
    assert.deepEqual(await files(p.dir), [], 'the switch is off');
    assert.equal(events.some(e => (e as { type: string }).type === 'audio'), true, 'she still read it');

    await host.setOn(true);
    await runtime.speak(1, 's2', '你好呀。', { replyId: 'r2', segmentIndex: 0 });
    await runtime.speak(1, 's3', '今天过得怎么样？', { replyId: 'r2', segmentIndex: 1 });
    await host.recorder.idle();
    const day = dayKey(NOON);
    const kept = (await files(p.dir)).filter(name => !name.endsWith('settings.json'));
    assert.equal(kept.filter(n => n.endsWith('.wav')).length, 2);
    assert.equal(kept.filter(n => n.endsWith('.json')).length, 2);
    const wavs = kept.filter(n => n.endsWith('.wav'));
    assert.ok(wavs.every(n => n.startsWith(`${day}/`)));
    assert.ok(wavs[0]!.includes('_r2_00') && wavs[1]!.includes('_r2_01'), 'a reply\'s sentences sort together, in order');
    const side = JSON.parse(await readFile(path.join(p.dir, 'voice-keep', wavs[1]!.replace(/\.wav$/, '.json')), 'utf8'));
    assert.equal(side.provider, 'bailian'); assert.equal(side.voiceId, 'longtest'); assert.equal(side.characterId, 'card-1'); assert.equal(side.characterName, '阿棠');
    assert.equal(side.text, '今天过得怎么样？'); assert.equal(side.replyId, 'r2'); assert.equal(side.sentenceIndex, 1);
    const wav = await readFile(path.join(p.dir, 'voice-keep', wavs[0]!));
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.length, 44 + 960);

    // Drama 3: its own voice id, and the settings page's number matches the file.
    const fish = runtimeFor(host, { provider: 'fish', fishApiKey: 'k', fishVoiceId: 'fish-voice-9' });
    await fish.runtime.speak(1, 's4', '这是另一个声音。', { replyId: 'r3', segmentIndex: 0 });
    await host.recorder.idle();
    const fishSide = (await files(p.dir)).find(n => n.includes('_r3_00.json'))!;
    const fishInfo = JSON.parse(await readFile(path.join(p.dir, 'voice-keep', fishSide), 'utf8'));
    assert.equal(fishInfo.provider, 'fish'); assert.equal(fishInfo.voiceId, 'fish-voice-9');
  } finally { await p.cleanup(); }
});

test('stable: the view says not here, nothing is written even when a stale settings file says on, and the keep refuses', async () => {
  const p = await profile();
  try {
    await mkdir(path.join(p.dir, 'voice-keep'), { recursive: true });
    await writeFile(path.join(p.dir, 'voice-keep', 'settings.json'), JSON.stringify({ on: true, days: 7 }));
    const { host } = hostFor(p.dir, { available: () => false });
    const { runtime } = runtimeFor(host);
    await runtime.speak(1, 's1', '你好呀。', { replyId: 'r1', segmentIndex: 0 });
    await host.recorder.idle();
    assert.deepEqual((await files(p.dir)), [], 'no audio, no day folder');
    assert.equal(host.view().available, false); assert.equal(host.view().on, false);
    assert.equal((await host.setOn(true)).on, false, 'a call to turn it on does nothing');
    assert.equal(await host.openFolder(), false);
    assert.equal((await host.handle({ op: 'on' })).available, false);
    // Even a host that loaded "on" while it was available stops the moment the build says not here.
    let here = true;
    const flipping = hostFor(p.dir, { available: () => here });
    flipping.host.recorder.measured(0);
    await flipping.host.setOn(true);
    here = false;
    assert.equal(flipping.host.recorder.begin(HER_READING, { provider: 'bailian', voiceId: 'v', text: 'x' }), null);
    // The tool the channel would register refuses on a host that is not available.
    const { tool } = voiceKeepChannelTool(() => host);
    assert.throws(() => (tool.prepare as (i: unknown) => unknown)({ on: false }), /没有这个功能/);
  } finally { await p.cleanup(); }
});

test('only her own reading is kept: any other origin (microphone, the user\'s voice, a call) is refused', async () => {
  const p = await profile();
  try {
    const { host } = hostFor(p.dir);
    await host.setOn(true);
    for (const origin of ['microphone', 'user-voice', 'call-user', 'voice-input', '']) {
      const tee = host.recorder.begin(origin, { provider: 'bailian', voiceId: 'v', text: 'x' });
      assert.equal(tee, null, origin);
    }
    await host.recorder.idle();
    assert.deepEqual((await files(p.dir)).filter(n => !n.endsWith('settings.json')), []);
    assert.ok(host.recorder.begin(HER_READING, { provider: 'bailian', voiceId: 'v', text: 'x' }));
  } finally { await p.cleanup(); }
});

test('expiry: old days go (the tool\'s own files stay), today and the kept days stay, shortening the days sweeps at once', async () => {
  const p = await profile();
  try {
    const store = new VoiceKeepStore(p.dir);
    const base = { characterId: 'c', characterName: 'n', provider: 'bailian' as const, voiceId: 'v', text: 't', replyId: 'r', sentenceIndex: 0 };
    for (const ago of [0, 3, 6, 7, 10]) await store.keep({ ...base, at: NOON - ago * DAY_MS, replyAt: NOON - ago * DAY_MS }, Buffer.alloc(100));
    await writeFile(path.join(store.root, 'settings.json'), '{}'); await writeFile(path.join(store.root, 'events.jsonl'), '');
    assert.equal((await store.days()).length, 5);
    assert.equal(oldestKeptDay(NOON, 7), dayKey(NOON - 6 * DAY_MS));
    assert.equal(await store.sweep(NOON, 7), 2, 'days 7 and 10 ago');
    assert.deepEqual(await store.days(), [0, 3, 6].map(ago => dayKey(NOON - ago * DAY_MS)).reverse());
    const { host } = hostFor(p.dir);
    await host.setDays(2);
    assert.deepEqual(await store.days(), [dayKey(NOON), dayKey(NOON - 3 * DAY_MS)].slice(0, 1), 'days = 2 keeps today and yesterday only');
    const names = await readdir(store.root);
    assert.ok(names.includes('settings.json') && names.includes('events.jsonl'), 'a sweep never touches the tool\'s own files');
    assert.equal(host.view().days, 2);
    await host.setDays(500); assert.equal(host.view().days, 30, 'clamped to 1-30');
    await host.setDays(0); assert.equal(host.view().days, 1);
  } finally { await p.cleanup(); }
});

test('清空 asks first: no answer yes, nothing removed; yes removes the audio and keeps the settings', async () => {
  const p = await profile();
  try {
    let answer = false, asked: { sentences: number }[] = [];
    const { host } = hostFor(p.dir, { confirm: async count => { asked.push(count); return answer; } });
    await host.setOn(true);
    const { runtime } = runtimeFor(host);
    await runtime.speak(1, 's1', '你好呀。', { replyId: 'r1', segmentIndex: 0 });
    await host.recorder.idle();
    const before = await files(p.dir);
    const refused = await host.clear();
    assert.equal(refused.cleared, false); assert.equal(asked.length, 1); assert.equal(asked[0]!.sentences, 1);
    assert.deepEqual(await files(p.dir), before, 'nothing removed without a yes');
    answer = true;
    assert.equal((await host.clear()).cleared, true);
    assert.deepEqual((await files(p.dir)).filter(n => n.endsWith('.wav') || n.endsWith('.json') && !n.includes('settings')), []);
    assert.equal(host.view().on, true, 'the switch is the user\'s; clearing does not touch it');
    assert.equal((await host.handle({ op: 'clear' })).sentences, 0);
  } finally { await p.cleanup(); }
});

test('size guard: above the cap nothing more is kept and the event file says so once; keeping resumes under the cap', async () => {
  const p = await profile();
  try {
    const { host } = hostFor(p.dir);
    await host.setOn(true);
    host.recorder.measured(VOICE_KEEP_SIZE_CAP_BYTES);
    const info = { provider: 'bailian' as const, voiceId: 'v', text: 'x' };
    assert.equal(host.recorder.begin(HER_READING, info), null);
    assert.equal(host.recorder.begin(HER_READING, info), null);
    assert.equal(host.view().capped, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    const rows = (await readFile(path.join(p.dir, 'voice-keep', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.kind === 'size-cap').length, 1, 'once per crossing');
    host.recorder.measured(1000);
    assert.ok(host.recorder.begin(HER_READING, info), 'room again');
    assert.equal(host.view().capped, false);
  } finally { await p.cleanup(); }
});

test('a cancelled or failed sentence leaves no half file; a synthesizer that never says done keeps nothing', async () => {
  const p = await profile();
  try {
    const { host } = hostFor(p.dir);
    await host.setOn(true);
    const halfway: SpeechSynthesizer = async (_c, _t, _s, emit) => { await emit({ type: 'audio', data: pcmBase64(), format: 'pcm_s16le', sampleRate: 24000, channels: 1 }); throw new Error('boom'); };
    const runtime = new SpeechRuntime(() => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://example.invalid', apiKey: 'k' }) as TtsConfig, () => {}, halfway, undefined, {}, undefined,
      info => host.recorder.begin(HER_READING, info));
    await runtime.speak(1, 's1', '你好呀。', { replyId: 'r1', segmentIndex: 0 });
    await host.recorder.idle();
    assert.deepEqual((await files(p.dir)).filter(n => !n.endsWith('settings.json')), []);
  } finally { await p.cleanup(); }
});

test('a keep that throws never changes a reading', async () => {
  const events: unknown[] = [];
  const runtime = new SpeechRuntime(() => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://example.invalid', apiKey: 'k' }) as TtsConfig, (_o, e) => { events.push(e); }, fakeSynth(), undefined, {}, undefined,
    () => ({ audio: () => { throw new Error('disk'); }, done: () => { throw new Error('disk'); } }));
  await runtime.speak(1, 's1', '你好呀。', { replyId: 'r1', segmentIndex: 0 });
  assert.equal(events.filter(e => (e as { type: string }).type === 'audio').length, 2);
  assert.equal(events.filter(e => (e as { type: string }).type === 'done').length, 1);
});

test('the channel: turning it on needs the user\'s words and the dialog; off and reading are direct; it is not in the shared catalog or handbook', async () => {
  const p = await profile();
  try {
    const { host } = hostFor(p.dir);
    const { tool } = voiceKeepChannelTool(() => host);
    const asked: AgentConfirmRequest[] = [];
    let answer = true;
    const make = (interconnect: boolean) => new AgentToolRegistry([tool], { enabled: () => true, interconnect: () => interconnect, confirmTimeoutMs: 2_000,
      confirm: async request => { asked.push(request); return answer; } });
    const on = make(true);
    const noWords = await on.call('voice_keep', { on: true });
    assert.equal(noWords.ok, false); assert.equal(host.view().on, false, 'no words: nothing ran');
    const WORDS = '可以，帮我打开保存她声音的开关';
    answer = false;
    const declined = await on.call('voice_keep', { on: true, userWords: WORDS });
    assert.equal(declined.ok, false); assert.equal(asked.length, 1, 'the dialog opens even with the words'); assert.match(asked[0]!.detail, new RegExp(WORDS));
    assert.equal(host.view().on, false, 'declined');
    answer = true;
    const accepted = await on.call('voice_keep', { on: true, userWords: WORDS });
    assert.equal(accepted.ok, true); assert.equal(asked.length, 2); assert.equal(host.view().on, true);
    const off = await on.call('voice_keep', { on: false });
    assert.equal(off.ok, true); assert.equal(asked.length, 2, 'off asks nothing'); assert.equal(host.view().on, false);
    const read = await on.call('voice_keep', {});
    assert.equal(read.ok, true); assert.equal(asked.length, 2);
    assert.equal(JSON.stringify(read).includes(p.dir), false, 'no path ever crosses');
    // With 三方互通 off the same dialog asks, no words needed.
    const dialogOnly = make(false);
    await dialogOnly.call('voice_keep', { on: true }); assert.equal(asked.length, 3);
    // Bad arguments.
    assert.equal((await on.call('voice_keep', { on: 'yes' })).ok, false);
    assert.equal((await on.call('voice_keep', { path: 'C:\\x' })).ok, false);
    // Not in the shared catalog, so a build that does not register it never lists it; the handbook does not name it either.
    assert.equal(AGENT_TOOLS.some(t => t.name === 'voice_keep'), false);
    assert.equal(CAPABILITIES.some(c => JSON.stringify(c).includes('voice_keep')), false);
    assert.equal(VOICE_KEEP_DESCRIPTOR.name, 'voice_keep'); assert.equal(VOICE_KEEP_DESCRIPTOR.tier, 'reversible');
    await tick();
  } finally { await p.cleanup(); }
});

test('openFolder opens the tool\'s folder only, and the window cannot name a path', async () => {
  const p = await profile();
  try {
    const { host, opened } = hostFor(p.dir);
    await host.handle({ op: 'open', path: 'C:\\Windows' } as never);
    assert.deepEqual(opened, [path.join(p.dir, 'voice-keep')]);
    assert.equal((await host.handle({ op: 'nonsense' })).available, true);
  } finally { await p.cleanup(); }
});

class El {
  children: El[] = []; textContent = ''; type = ''; id = ''; className = ''; disabled = false; hidden = false; checked = false; value = ''; min = ''; max = ''; step = '';
  onchange: (() => void) | null = null; onclick: (() => void) | null = null;
  ownerDocument = { createElement: () => new El() };
  append(...els: El[]) { this.children.push(...els); }
  replaceChildren(...els: El[]) { this.children = els; }
  setAttribute() {}
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the control window page: hidden and empty of any switch on a build without the tool; shown with its switch where the host says it exists', async () => {
  const hidden = new El();
  const sent: unknown[] = [];
  new VoiceKeepPanel(hidden as unknown as HTMLElement, { call: async request => { sent.push(request); return { available: false, on: false, days: 7, sentences: 0, bytes: 0, capped: false, capBytes: 1 }; } });
  await settle();
  assert.equal(hidden.hidden, true, 'stable: nothing shown');
  const root = new El();
  let view = { available: true, on: false, days: 7, sentences: 3, bytes: 5 * 1024 * 1024, capped: false, capBytes: VOICE_KEEP_SIZE_CAP_BYTES };
  const calls: unknown[] = [];
  new VoiceKeepPanel(root as unknown as HTMLElement, { call: async request => { calls.push(request); if (request.op === 'on') view = { ...view, on: true }; return view; } });
  await settle();
  assert.equal(root.hidden, false);
  const toggle = root.children[2]!.children[1]!;
  assert.equal(toggle.id, 'voice-keep-on'); assert.equal(toggle.checked, false);
  toggle.checked = true; toggle.onchange?.();
  await settle();
  assert.deepEqual(calls, [{ op: 'get' }, { op: 'on' }]);
  assert.equal(toggle.checked, true);
  const text = JSON.stringify(root.children.map(child => child.textContent));
  assert.match(text, /不会发到任何地方，也不会交给任何模型/); assert.match(text, /稳定版和发布版没有/); assert.match(text, /1 到 30 天，默认 7 天/);
  assert.equal(voiceKeepStatus(view), '已保存 3 句，约 5 MB。');
  setUiLanguage('en');
  try { assert.match(voiceKeepStatus(view), /sentences kept/); } finally { setUiLanguage('zh-CN'); }
});

