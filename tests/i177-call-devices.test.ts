import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptVerdict, classifyOutput, deviceSetKey, devicesForJudgement, keywordVerdict, pickByPriority, readCallDevices, speakersHintDue, stripDeviceName, suggestionFor,
  type DeviceInfo,
} from '../shared/voice/call-devices';
import { CallMicAdvisor, emptyCallDeviceState, localCallDeviceStorage, type CallBarPorts, type CallDeviceState } from '../src/voice/voice-call/call-mic';

const out = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audiooutput', deviceId, groupId, label });
const mic = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audioinput', deviceId, groupId, label });

test('classifier: names in English and Chinese Windows, jacks, USB headsets, monitors', () => {
  const table: Array<[string, string]> = [
    ['Headphones (AirPods Pro)', 'headphones'], ['Headset (AirPods Pro Hands-Free)', 'headphones'], ['耳机 (AirPods Pro)', 'headphones'],
    ['Galaxy Buds2 Pro', 'headphones'], ['Bluetooth Audio', 'headphones'], ['蓝牙音频', 'headphones'], ['Headset Earphone (HUAWEI FreeBuds)', 'headphones'],
    ['Headphones (Realtek(R) Audio)', 'headphones'], ['Speakers (Realtek(R) Audio)', 'speakers'], ['扬声器 (Realtek(R) Audio)', 'speakers'],
    ['Default - Speakers (Realtek(R) Audio)', 'speakers'], ['Headset (Logitech USB Headset H390)', 'headphones'], ['耳麦 (USB Audio)', 'headphones'],
    ['Bluetooth Speaker (JBL Flip)', 'speakers'], ['LG ULTRAGEAR (NVIDIA High Definition Audio)', 'unknown'], ['Speakers (High Definition Audio Device)', 'speakers'],
    ['', 'unknown'], ['Something odd', 'unknown'],
  ];
  for (const [label, kind] of table) assert.equal(classifyOutput(label), kind, label);
});

test('owner names are stripped from device names', () => {
  assert.equal(stripDeviceName('Default - 艾乐的 AirPods Pro'), 'AirPods Pro');
  assert.equal(stripDeviceName('Headphones (艾乐的 AirPods Pro)'), 'Headphones (AirPods Pro)');
  assert.equal(stripDeviceName("Headset (Alex's AirPods Pro Hands-Free)"), 'Headset (AirPods Pro Hands-Free)');
  assert.equal(stripDeviceName('Alex’s AirPods'), 'AirPods');
  assert.equal(stripDeviceName('Headphones (Realtek(R) Audio)'), 'Headphones (Realtek(R) Audio)');
  const judged = devicesForJudgement([out('Headphones (艾乐的 AirPods Pro)', 'g1'), mic("Headset (Alex's AirPods Pro Hands-Free)", 'g1')]);
  assert.ok(![...judged.inputs, ...judged.outputs].join('|').match(/艾乐|Alex/), 'no owner name in what may be sent');
  assert.equal(deviceSetKey([out('Headphones (艾乐的 AirPods Pro)')]), deviceSetKey([out('Headphones (小明的 AirPods Pro)')]), 'the set key does not depend on the owner');
});

const airpods = [out('Default - Headphones (AirPods Pro)', 'g1', 'default'), out('Headphones (AirPods Pro)', 'g1', 'o1'), mic('Default - Headset (AirPods Pro Hands-Free)', 'g1', 'default'), mic('Headset (AirPods Pro Hands-Free)', 'g1', 'i1')];

test('verdict: headset + laptop array puts the array first', () => {
  const v = keywordVerdict([...airpods, mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2')]);
  assert.deepEqual(v.inputOrder, ['Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)']);
  assert.equal(v.headsetMicOnly, false);
  assert.equal(v.pairs['Headphones (AirPods Pro)'], 'Headset (AirPods Pro Hands-Free)');
});
test('verdict: headset + webcam mic puts the webcam first; a USB mic beats a webcam', () => {
  assert.equal(keywordVerdict([...airpods, mic('Logitech Webcam C920', 'g3', 'i3')]).inputOrder[0], 'Logitech Webcam C920');
  assert.equal(keywordVerdict([...airpods, mic('Logitech Webcam C920', 'g3', 'i3'), mic('USB Audio Device', 'g4', 'i4')]).inputOrder[0], 'USB Audio Device');
});
test('verdict: headset only (a desktop) keeps the headset mic and says so', () => {
  const v = keywordVerdict(airpods);
  assert.equal(v.headsetMicOnly, true);
  assert.deepEqual(v.inputOrder, ['Headset (AirPods Pro Hands-Free)']);
  assert.equal(suggestionFor('k', v, readCallDevices(airpods), []), null, 'a note, not a question');
});
test('verdict: wired Realtek headphones + Realtek mic is not a headset to avoid; unknown names suggest nothing', () => {
  const wired = [out('Headphones (Realtek(R) Audio)', 'r', 'o'), mic('Microphone (Realtek(R) Audio)', 'r', 'i')];
  const v = keywordVerdict(wired);
  assert.equal(v.headsetMicOnly, false);
  assert.equal(suggestionFor('k', v, readCallDevices(wired), []), null, 'she already uses it');
  const odd = [out('Foo 1', 'a'), mic('Bar 2', 'b')];
  assert.equal(suggestionFor('k', keywordVerdict(odd), readCallDevices(odd), []), null);
});
test('blank names (no microphone grant yet) are not read as anything', () => {
  const blank = [out('', '', 'default'), mic('', '', 'default')];
  assert.equal(readCallDevices(blank).labelsKnown, false);
  assert.equal(speakersHintDue({ output: readCallDevices(blank).output, labelsKnown: false, off: false, lastDay: null, today: '2026-11-22' }), false);
});

test('priority pick: first available entry; none available or empty list = system default', () => {
  const devices = [...airpods, mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2')];
  assert.equal(pickByPriority(['Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)'], devices, 'audioinput'), 'i2');
  assert.equal(pickByPriority(['USB Mic', 'Headset (AirPods Pro Hands-Free)'], devices, 'audioinput'), 'i1', 'an unplugged entry is skipped');
  assert.equal(pickByPriority(['USB Mic'], devices, 'audioinput'), null);
  assert.equal(pickByPriority([], devices, 'audioinput'), null);
  assert.equal(pickByPriority(undefined, devices, 'audioinput'), null);
  assert.equal(pickByPriority(['Headset (AirPods Pro Hands-Free)'], airpods, 'audioinput'), 'i1', 'a desktop with only a headset mic');
});

test('the speakers hint: once a day, never when off, never when headphones', () => {
  const base = { output: 'speakers' as const, labelsKnown: true, off: false, lastDay: null as string | null, today: '2026-11-22' };
  assert.equal(speakersHintDue(base), true);
  assert.equal(speakersHintDue({ ...base, lastDay: '2026-11-22' }), false);
  assert.equal(speakersHintDue({ ...base, lastDay: '2026-11-21' }), true);
  assert.equal(speakersHintDue({ ...base, off: true }), false);
  assert.equal(speakersHintDue({ ...base, output: 'headphones' }), false);
  assert.equal(speakersHintDue({ ...base, output: 'unknown' }), true, 'unknown counts as speakers');
});

test('acceptVerdict cuts a claude answer to names that are really there', () => {
  const devices = [...airpods, mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2')];
  const ok = acceptVerdict({ kinds: { 'Microphone Array (Realtek(R) Audio)': 'microphone', Ghost: 'headphones' }, pairs: {}, inputOrder: ['Microphone Array (Realtek(R) Audio)', 'Ghost'], outputOrder: ['Headphones (AirPods Pro)'], headsetMicOnly: false }, devices);
  assert.deepEqual(ok?.inputOrder, ['Microphone Array (Realtek(R) Audio)']);
  assert.equal(ok?.by, 'claude');
  assert.equal(acceptVerdict('nonsense', devices), null);
  assert.equal(acceptVerdict({ inputOrder: 'x', outputOrder: [] }, devices), null);
});

// ---------------------------------------------------------------- the advisor (the window part)

function memoryStorage(initial?: CallDeviceState) {
  let state = initial ?? emptyCallDeviceState();
  return { load: () => structuredClone(state), save: (s: CallDeviceState) => { state = structuredClone(s); }, get: () => state };
}
function setup(devices: DeviceInfo[], options: { ask?: (d: { inputs: string[]; outputs: string[] }) => Promise<unknown>; state?: CallDeviceState; at?: number } = {}) {
  const storage = memoryStorage(options.state);
  const events: Array<{ type: 'line' | 'card' | 'clear'; text?: string; answer?: (v: 'yes' | 'no' | 'later') => void; action?: { label: string; run(): void } }> = [];
  const bar: CallBarPorts = {
    line: (text, action) => events.push({ type: 'line', text, action }), card: (text, answer) => events.push({ type: 'card', text, answer }), clear: () => events.push({ type: 'clear' }),
  };
  const said: string[] = [];
  const advisor = new CallMicAdvisor({ read: async () => devices, storage, now: () => options.at ?? Date.UTC(2026, 10, 22, 12), bar, ask: options.ask, said: t => said.push(t) });
  return { advisor, storage, events, said };
}
const withArray = [...airpods, mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2')];

test('no answer changes nothing: the card is shown, the list stays empty, the call still uses the default', async () => {
  const { advisor, storage, events } = setup(withArray);
  await advisor.callStarted();
  assert.ok(events.some(e => e.type === 'card'));
  assert.deepEqual(storage.get().prefs.inputOrder, []);
  assert.deepEqual(await advisor.choice(), { deviceId: null, labelsKnown: true });
});
test('换 rewrites the list and the next call uses it; 不换 is remembered for that set; 以后再说 changes nothing', async () => {
  const yes = setup(withArray);
  await yes.advisor.callStarted();
  yes.events.find(e => e.type === 'card')!.answer!('yes');
  assert.deepEqual(yes.storage.get().prefs.inputOrder, ['Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)']);
  assert.deepEqual(await yes.advisor.choice(), { deviceId: 'i2', labelsKnown: true });
  assert.ok(yes.said.length === 1);

  const no = setup(withArray);
  await no.advisor.callStarted();
  no.events.find(e => e.type === 'card')!.answer!('no');
  assert.deepEqual(no.storage.get().prefs.inputOrder, []);
  assert.equal(no.storage.get().declined.length, 1);
  const again = setup(withArray, { state: no.storage.get() });
  await again.advisor.callStarted();
  assert.ok(!again.events.some(e => e.type === 'card'), 'a declined set is not asked again');

  const later = setup(withArray);
  await later.advisor.callStarted();
  later.events.find(e => e.type === 'card')!.answer!('later');
  assert.deepEqual(later.storage.get().prefs.inputOrder, []);
  assert.deepEqual(later.storage.get().declined, []);
  const next = setup(withArray, { state: later.storage.get() });
  await next.advisor.callStarted();
  assert.ok(next.events.some(e => e.type === 'card'), 'later: asked again next call');
});
test('claude: one ask per new device set, none for a known set, never the owner name; failure and nonsense fall back to the keyword verdict', async () => {
  const asked: Array<{ inputs: string[]; outputs: string[] }> = [];
  const devices = [out('Headphones (艾乐的 AirPods Pro)', 'g1', 'o1'), mic('Headset (艾乐的 AirPods Pro Hands-Free)', 'g1', 'i1'), mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2')];
  const ask = async (d: { inputs: string[]; outputs: string[] }) => { asked.push(d); return { kinds: {}, pairs: {}, inputOrder: ['Microphone Array (Realtek(R) Audio)'], outputOrder: ['Headphones (AirPods Pro)'], headsetMicOnly: false }; };
  const first = setup(devices, { ask });
  await first.advisor.callStarted();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(asked.length, 1);
  assert.ok(!JSON.stringify(asked).match(/艾乐/), 'the owner name never reaches Claude');
  assert.ok(!JSON.stringify(asked).match(/"(i1|o1|i2|g1)"/), 'no device or group id either');
  assert.ok(first.storage.get().verdicts[Object.keys(first.storage.get().verdicts)[0]], 'the answer is cached');
  const second = setup(devices, { ask, state: first.storage.get() });
  await second.advisor.callStarted(); await second.advisor.callStarted();
  assert.equal(asked.length, 1, 'a known set is not asked again');
  // a new set (a new device) is asked once, a failing ask is not repeated, and the keyword card still shows
  const failing: string[] = [];
  const third = setup([...devices, mic('USB Audio Device', 'g9', 'i9')], { ask: async () => { failing.push('x'); throw new Error('429'); }, state: second.storage.get() });
  await third.advisor.callStarted(); await third.advisor.callStarted();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(failing.length, 1, 'one ask per set even when it failed');
  assert.ok(third.events.some(e => e.type === 'card'), 'the keyword verdict stands');
  const junk = setup(withArray, { ask: async () => 'blah' });
  await junk.advisor.callStarted();
  await new Promise(r => setTimeout(r, 5));
  assert.ok(junk.events.some(e => e.type === 'card'));
});
test('speakers hint: once a day with a way to turn it off; headphones and unreadable names show none', async () => {
  const speakers = [out('Speakers (Realtek(R) Audio)', 'r'), mic('Microphone (Realtek(R) Audio)', 'r')];
  const a = setup(speakers);
  await a.advisor.callStarted();
  const line = a.events.find(e => e.type === 'line');
  assert.match(line!.text!, /戴上耳机会更顺/);
  const b = setup(speakers, { state: a.storage.get() });
  await b.advisor.callStarted();
  assert.ok(!b.events.some(e => e.type === 'line'), 'not twice the same day');
  const c = setup(speakers, { state: a.storage.get(), at: Date.UTC(2026, 10, 24, 12) });
  await c.advisor.callStarted();
  assert.ok(c.events.some(e => e.type === 'line'), 'the next day again');
  c.events.find(e => e.type === 'line')!.action!.run();
  assert.equal(c.storage.get().prefs.hintOff, true);
  const d = setup(speakers, { state: c.storage.get(), at: Date.UTC(2026, 10, 30, 12) });
  await d.advisor.callStarted();
  assert.ok(!d.events.some(e => e.type === 'line'), 'off stays off');
  const e = setup([out('Headphones (Realtek(R) Audio)', 'r'), mic('Microphone (Realtek(R) Audio)', 'r')]);
  await e.advisor.callStarted();
  assert.ok(!e.events.some(ev => ev.type === 'line'));
  const f = setup([out('', '', 'default'), mic('', '', 'default')]);
  await f.advisor.callStarted();
  assert.equal(f.events.length, 0);
});
test('headset-only desktop: the phone-quality note once, no question', async () => {
  const { advisor, events } = setup(airpods);
  await advisor.callStarted();
  assert.match(events.find(e => e.type === 'line')!.text!, /电话音质/);
  assert.ok(!events.some(e => e.type === 'card'));
});
test('local storage: bad or missing data gives an empty state, and writes never throw', () => {
  assert.deepEqual(localCallDeviceStorage({ getItem: () => '{not json', setItem() {} }).load(), emptyCallDeviceState());
  assert.deepEqual(localCallDeviceStorage({ getItem: () => { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }).load(), emptyCallDeviceState());
  assert.doesNotThrow(() => localCallDeviceStorage({ getItem: () => null, setItem() { throw new Error('full'); } }).save(emptyCallDeviceState()));
  const kept: Record<string, string> = {};
  const store = localCallDeviceStorage({ getItem: k => kept[k] ?? null, setItem: (k, v) => { kept[k] = v; } });
  const s = emptyCallDeviceState(); s.prefs.inputOrder = ['A']; s.declined = ['k'];
  store.save(s);
  assert.deepEqual(store.load().prefs.inputOrder, ['A']);
  assert.ok(!JSON.stringify(Object.values(kept)).match(/deviceId|groupId/), 'no device ids in the stored record');
});

// ---------------------------------------------------------------- the microphone itself (deviceId constraint only)

async function openMic(t: import('node:test').TestContext, choices: Array<{ deviceId: string | null; labelsKnown: boolean }>, failExact = false) {
  const keys = ['navigator', 'AudioContext'] as const;
  const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => { for (const [key, value] of originals) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key]; });
  const constraints: any[] = []; let stopped = 0;
  const node = () => ({ connect() {}, disconnect() {} });
  const track = { stop() { stopped++; }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia(c: any) {
    constraints.push(c);
    if (failExact && c.audio.deviceId) throw new Error('OverconstrainedError');
    return { getTracks: () => [track] };
  } } } });
  class AudioMock { state = 'running'; sampleRate = 48000; get destination() { return {}; } createMediaStreamSource() { return node(); }
    createScriptProcessor() { return { ...node(), onaudioprocess: null }; } createGain() { return { ...node(), gain: { value: 1 } }; } async close() { this.state = 'closed'; } }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioMock });
  const { MicrophoneInput } = await import('../src/senses/MicrophoneInput');
  let asked = 0;
  const input = new MicrophoneInput({ owner: 'controls', acknowledge: async () => true, onError: m => assert.fail(m), onPcm: () => {}, micChoice: choices.length ? async () => choices[Math.min(asked++, choices.length - 1)] : undefined });
  await input.apply({ id: 'm', source: 'microphone', owner: 'controls', revision: 1, chat: true, dance: false, ambient: null });
  await input.dispose();
  return { constraints, stopped };
}
test('the microphone: no choice keeps the old constraints; a chosen device is an exact deviceId with the same processing flags', async t => {
  const plain = await openMic(t, []);
  assert.deepEqual(plain.constraints, [{ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }]);
  const chosen = await openMic(t, [{ deviceId: 'i2', labelsKnown: true }]);
  assert.equal(chosen.constraints.length, 1);
  assert.deepEqual(chosen.constraints[0].audio, { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'i2' } });
  const none = await openMic(t, [{ deviceId: null, labelsKnown: true }]);
  assert.equal(none.constraints.length, 1); assert.equal(none.constraints[0].audio.deviceId, undefined);
});
test('the microphone: names blank at first, known after the first grant -> one more open, the first stopped; an unplugged choice falls back', async t => {
  const late = await openMic(t, [{ deviceId: null, labelsKnown: false }, { deviceId: 'i2', labelsKnown: true }]);
  assert.equal(late.constraints.length, 2);
  assert.equal(late.constraints[1].audio.deviceId.exact, 'i2');
  const gone = await openMic(t, [{ deviceId: 'i9', labelsKnown: true }], true);
  assert.equal(gone.constraints.length, 2); assert.equal(gone.constraints[1].audio.deviceId, undefined, 'the default again');
});
