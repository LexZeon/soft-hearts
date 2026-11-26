import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERRUPT_KNOBS } from '../shared/behaviors/interrupt/knobs';
import { judgeUtterance, type ClipLevels } from '../shared/behaviors/interrupt/judge';
import { CALL_DUCK_KNOBS } from '../shared/behaviors/call-duck/knobs';
import { playbackKind, readCallDevices, type DeviceInfo } from '../shared/voice/call-devices';
import { CallDuck, type DuckEnd } from '../src/voice/voice-call/call-duck';
import { CallMicAdvisor, localCallDeviceStorage, type CallBarPorts } from '../src/voice/voice-call/call-mic';

/*
 * T-260 (Codex's review of the call interrupt, 2026-11-22) claims, each checked on the current code:
 *  (1) a stop word said over her was held as her echo before the command check; (2) the headphones gate read the system default output,
 *  not the device her voice plays on; (3) a clip handed in at 5.5 s with no result left her voice ducked until 8.5 s.
 * I-204 replaced (1): there is no stop-word list and no loudness tie-break any more;
 * a line is her echo only when it matches what she is reading NOW (the sentence and the one before, electron/voice/voice-call/interruption.ts)
 * at least INTERRUPT_KNOBS.echoMatchRatio, so "等一下" said over a sentence that does not contain it always stops her.
 */

const levels = (peakDb: number, voicedSeconds = 0.6): ClipLevels => ({ peakDb, voicedSeconds });
const judge = (text: string, herText: string, l: ClipLevels | null) => judgeUtterance({ text, levels: l, overHer: true, continuous: true, herText });

// ---------------------------------------------------------------- (1) a stop word over her own words (I-204: by the match ratio)

test('stop word: over a sentence without it, "等一下" stops her at any loudness; a partial overlap (等一会儿) is not her echo', () => {
  for (const l of [levels(-12), levels(-38), null]) assert.equal(judge('等一下', '好像是这样的，我想想。', l).pass, true);
  assert.equal(judge('等一下', '我等一会儿再告诉你。', levels(-38)).pass, true, '0.67 < the ratio');
  assert.ok(INTERRUPT_KNOBS.echoMatchRatio > 2 / 3);
});

test('stop word: an exact stretch of the sentence she is saying now is her echo, whatever its loudness (one knob)', () => {
  const held = (verdict: ReturnType<typeof judge>) => (verdict as { held?: string }).held;
  assert.equal(held(judge('等一下就好', '我等一下就好。', levels(-5))), 'echo');
  assert.equal(held(judge('我在呢你说吧', '嗯，我在呢，你说吧。今天怎么样？', levels(-5))), 'echo');
  assert.equal(judge('诶，等一下啊', '我等一下就好。', levels(-5)).pass, true, 'two of five characters differ (0.6): the user');
});

// ---------------------------------------------------------------- (2) the device her voice plays on

const out = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audiooutput', deviceId, groupId, label });
const mic = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audioinput', deviceId, groupId, label });
const AIRPODS = 'Headphones (AirPods Pro)', SPEAKERS = 'Speakers (Realtek(R) Audio)';
const bar = (): CallBarPorts => ({ line() {}, card() {}, clear() {} });

test('playback: her voice plays on the first plugged-in entry of the 「听」 list, not on the system default', () => {
  const devices = [out('Default - Headphones (AirPods Pro)', 'g1', 'default'), out(AIRPODS, 'g1', 'o-a'), out(SPEAKERS, 'g2', 'o-s'), mic('Microphone Array', 'g2', 'i')];
  assert.equal(readCallDevices(devices).output, 'headphones', 'the system default is the AirPods');
  assert.equal(playbackKind(devices, [SPEAKERS, AIRPODS]), 'speakers', 'but the list puts the speakers first');
  assert.equal(playbackKind(devices, []), 'headphones', 'empty list: the system default');
  assert.equal(playbackKind(devices, ['Gone Device']), 'headphones', 'nothing on the list is plugged in: the system default');
  const reverse = [out('Default - Speakers (Realtek(R) Audio)', 'g2', 'default'), out(SPEAKERS, 'g2', 'o-s'), out(AIRPODS, 'g1', 'o-a')];
  assert.equal(playbackKind(reverse, [AIRPODS]), 'headphones');
  assert.equal(playbackKind([out('', '', 'default')], [AIRPODS]), 'unknown', 'names blank: no judgement');
});

test('playback: a call reads the kind of the device she plays on, and a plug event re-reads it', async () => {
  let devices = [out('Default - Headphones (AirPods Pro)', 'g1', 'default'), out(AIRPODS, 'g1', 'o-a'), out(SPEAKERS, 'g2', 'o-s'), mic('Microphone Array', 'g2', 'i')];
  const map = new Map<string, string>();
  const storage = localCallDeviceStorage({ getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } });
  const advisor = new CallMicAdvisor({ read: async () => devices, storage, now: () => 0, bar: bar() });
  advisor.setOrders([], [SPEAKERS, AIRPODS]);
  assert.equal((await advisor.callStarted())?.output, 'speakers', 'listed speakers first: the echo gate stays the speakers one');
  devices = devices.filter(d => d.deviceId !== 'o-s'); // the speakers go away: she moves to the AirPods
  assert.equal((await advisor.devicesChanged())?.output, 'headphones');
});

// ---------------------------------------------------------------- (3) the duck recovers promptly

function world() {
  let now = 0, id = 0;
  const due: { id: number; at: number; fn: () => void }[] = [], ends: [DuckEnd, number][] = [];
  const duck = new CallDuck({ level: () => {}, canDuck: () => true, now: () => now,
    timers: { set: (fn, ms) => { due.push({ id: ++id, at: now + ms, fn }); return id; }, clear: h => { const i = due.findIndex(d => d.id === h); if (i >= 0) due.splice(i, 1); } },
    ended: (how, ms) => ends.push([how, ms]) });
  const advance = (ms: number) => { const end = now + ms; for (;;) { due.sort((a, b) => a.at - b.at); const next = due[0]; if (!next || next.at > end) break; due.shift(); now = next.at; next.fn(); } now = end; };
  return { duck, ends, advance };
}

test('duck: a clip handed in at 5.5 s with no result is back at the 6 s limit, not 8.5 s', () => {
  const w = world();
  w.duck.overHer();
  w.advance(5500);
  w.duck.clipEnded(true);
  w.advance(499);
  assert.equal(w.duck.ducked, true);
  w.advance(1);
  assert.deepEqual(w.ends, [['timeout', CALL_DUCK_KNOBS.maxHoldMs]], 'the absolute limit still holds');
});

test('duck: a clip handed in early still waits its own verdict time; a held verdict ends it at once', () => {
  const w = world();
  w.duck.overHer(); w.advance(1000); w.duck.clipEnded(true);
  w.advance(CALL_DUCK_KNOBS.verdictWaitMs - 1); assert.equal(w.duck.ducked, true);
  w.advance(1); assert.deepEqual(w.ends, [['timeout', 1000 + CALL_DUCK_KNOBS.verdictWaitMs]]);
  const v = world(); v.duck.overHer(); v.advance(5900); v.duck.clipEnded(true); v.duck.held();
  assert.deepEqual(v.ends, [['resume', 5900]]);
});

// ---------------------------------------------------------------- (2) in a window: a plug event mid-call

test('call window: unplugging the speakers for headphones mid-call lowers the talking-over-her gate at once', async () => {
  const { CallControls } = await import('../src/voice/voice-call/call-controls');
  let devices: DeviceInfo[] = [out('Speakers (Realtek(R) Audio)', 'g2', 'o-s'), mic('Microphone Array', 'g2', 'i')];
  let change: (() => void) | null = null;
  const fake = { enumerateDevices: async () => devices.map(d => ({ ...d })), addEventListener: (_t: string, fn: () => void) => { change = fn; } };
  const saved = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: fake, configurable: true });
  try {
    const floors: number[] = [];
    const api = new Proxy({}, { get: (_t, name) => (..._args: unknown[]) => name === 'getVoiceCall' ? Promise.resolve({ on: true, owner: 'controls', since: 1, ended: null, fillers: null })
      : name === 'onVoiceCall' ? () => {} : Promise.resolve(null) });
    const controls = new CallControls({ windowKind: 'controls', api: api as never, audio: { duck() {}, sinkChanged() {} } as never, voice: () => ({ enabled: true, volume: 1 }) as never,
      media: () => ({ setCall: (knobs: { bargeIn: { floor: number } } | null) => { if (knobs) floors.push(knobs.bargeIn.floor); }, setEchoGuard() {} }), replyBusy: () => false, notify() {} });
    await controls.init(null);
    await new Promise(resolve => setTimeout(resolve, 20));
    devices = [out('Headphones (AirPods Pro)', 'g1', 'o-a'), mic('Microphone Array', 'g2', 'i')];
    assert.ok(change, 'the window listens for device changes');
    (change as () => void)();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(floors.at(-1), CALL_DUCK_KNOBS.headphonesFloor, `gate floors seen: ${floors.join(',')}`);
  } finally {
    if (saved) Object.defineProperty(globalThis.navigator, 'mediaDevices', saved); else delete (globalThis.navigator as { mediaDevices?: unknown }).mediaDevices;
  }
});
