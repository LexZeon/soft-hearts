import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeviceInfo } from '../shared/voice/call-devices';
import { SharedAudioOutput } from '../src/voice/audio-output';
import { OutputSink, sinkSupported } from '../src/voice/output-sink';
import { WAKE_LEAD_MS } from '../src/voice/output-wake/knobs';
import { CallMicAdvisor, callOutputOrder, chooseCallOutput, localCallDeviceStorage, type CallBarPorts } from '../src/voice/voice-call/call-mic';

/*
 * I-177 batch 2, items 2 and 3 (docs/claude/2026-11-22-i177-batch2.md).
 * Both windows read the same lists; the 「听」 list routes her cloud voice (AudioContext.setSinkId), and the I-150 wake follows the device.
 * Fake devices and fake audio contexts: no microphone, no audio.
 */

const out = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audiooutput', deviceId, groupId, label });
const mic1 = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audioinput', deviceId, groupId, label });
const AIRPODS = 'Headphones (AirPods Pro)', SPEAKERS = 'Speakers (Realtek(R) Audio)';
const plugged = [out(AIRPODS, 'g1', 'o-airpods'), out(SPEAKERS, 'g2', 'o-speakers'), mic1('Microphone Array (Realtek(R) Audio)', 'g2', 'i-array'), mic1('USB Mic', 'g3', 'i-usb')];

/** One Storage both windows' pages see (the same origin in the same session). */
function sharedStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
}
const bar = (): CallBarPorts => ({ line() {}, card() {}, clear() {} });

// ---------------------------------------------------------------- item 3: both windows read the same lists

test('storage: a list changed in the control window reaches the companion window\'s call, and the companion window never writes an old copy back', async () => {
  const storage = sharedStorage();
  let devices = plugged;
  const controls = new CallMicAdvisor({ read: async () => devices, storage: localCallDeviceStorage(storage), now: () => 0, bar: bar() });
  const companion = new CallMicAdvisor({ read: async () => devices, storage: localCallDeviceStorage(storage), now: () => 0, bar: bar() });
  assert.deepEqual(await companion.choice(), { deviceId: null, labelsKnown: true }, 'empty list: the system default');
  controls.setOrders(['USB Mic'], [AIRPODS]); // the settings page
  assert.deepEqual(await companion.choice(), { deviceId: 'i-usb', labelsKnown: true }, 'the companion window\'s next microphone follows the new list');
  assert.deepEqual(companion.prefs.outputOrder, [AIRPODS]);
  devices = [...plugged, mic1('Logitech Webcam C920', 'g4', 'i-cam')];
  await companion.devicesChanged(); // the companion window records a new set (and saves)
  assert.deepEqual(controls.prefs.inputOrder, ['USB Mic'], 'its save did not write back the list it loaded at start');
  companion.setHintOff(true);
  assert.equal(controls.prefs.hintOff, true);
  assert.deepEqual(callOutputOrder(localCallDeviceStorage(storage)), [AIRPODS]);
  assert.equal(await chooseCallOutput(async () => devices, localCallDeviceStorage(storage)), 'o-airpods', 'her voice\'s output is read fresh too');
});

// ---------------------------------------------------------------- item 2: the 「听」 list routes her cloud voice

interface Ctx { state: AudioContextState; sinkId: string; currentTime: number; destination: object; sinks: string[]; createGain(): GainNode; resume(): Promise<void>; suspend(): Promise<void>; close(): Promise<void>; setSinkId(id: string): Promise<void> }
function fakeContext(options: { refuse?: (id: string) => boolean; hang?: (id: string) => boolean; log?: string[] } = {}): Ctx {
  const ctx: Ctx = {
    state: 'running', sinkId: '', currentTime: 1, destination: {}, sinks: [],
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }) as unknown as GainNode,
    resume: async () => { ctx.state = 'running'; }, suspend: async () => { ctx.state = 'suspended'; }, close: async () => { ctx.state = 'closed'; },
    setSinkId: (id: string) => {
      options.log?.push(`sink ${id || 'default'}`);
      if (options.hang?.(id)) return new Promise<void>(() => {});
      if (options.refuse?.(id)) return Promise.reject(new Error('NotFoundError'));
      ctx.sinks.push(id); ctx.sinkId = id; return Promise.resolve();
    },
  };
  return ctx;
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const idleTimers = { set: () => 0, clear() {} };

test('sink: her voice goes to the first plugged-in entry of the list; an empty list never touches the device; unplugged → back to the default', async () => {
  const storage = sharedStorage();
  let devices = plugged, reads = 0;
  const ctx = fakeContext();
  const output = new SharedAudioOutput({ createContext: () => ctx as unknown as AudioContext, timers: idleTimers, visibility: null, wake: false,
    sink: { choose: () => chooseCallOutput(async () => { reads++; return devices; }, localCallDeviceStorage(storage)) } });
  output.warm();
  (await output.acquire()).release();
  assert.deepEqual(ctx.sinks, [], 'empty list: the system default, no switch');
  assert.equal(reads, 0, 'and not even the device list was read');
  localCallDeviceStorage(storage).save({ ...localCallDeviceStorage(storage).load(), prefs: { inputOrder: [], outputOrder: ['Ghost Speaker', AIRPODS, SPEAKERS], hintOff: false } });
  const lease = await output.acquire();
  assert.equal(ctx.sinkId, 'o-airpods', 'the highest entry that is plugged in');
  lease.release();
  devices = plugged.filter(d => d.deviceId !== 'o-airpods'); // AirPods taken off
  output.sinkChanged(); await flush();
  assert.equal(ctx.sinkId, 'o-speakers', 'the next entry');
  devices = plugged.filter(d => d.kind === 'audioinput'); // nothing of the list left
  output.sinkChanged(); await flush();
  assert.equal(ctx.sinkId, '', 'none of the list plugged in: back to the system default');
});

test('sink: a device that refuses or hangs never holds her voice: the system default', async () => {
  const log: string[] = [];
  const refusing = fakeContext({ refuse: id => id === 'o-gone', log });
  const sink = new OutputSink({ choose: async () => 'o-gone' });
  refusing.sinkId = 'o-airpods';
  assert.equal(await sink.align(refusing as unknown as AudioContext), 'moved');
  assert.equal(refusing.sinkId, '', 'refused: the default');
  assert.deepEqual(log, ['sink o-gone', 'sink default']);
  let fire: (() => void) | null = null;
  const hanging = fakeContext({ hang: id => id === 'o-slow' });
  const slow = new OutputSink({ choose: async () => 'o-slow', timers: { set: callback => { fire = callback; return 1; }, clear() {} } });
  const pending = slow.align(hanging as unknown as AudioContext);
  await flush(); fire!();
  assert.equal(await pending, 'same', 'gave up; the context stays where it was (the default)');
  assert.equal(sinkSupported({}), false, 'a context without setSinkId: the list stays labelled 暂未生效');
  assert.equal(sinkSupported(hanging), true);
});

test('sink + wake (I-150): a move wakes the NEW device from cold: the tone restarts after the switch and her first sound waits the lead', async () => {
  const log: string[] = [];
  const ctx = fakeContext({ log });
  let wanted: string | null = null;
  const tones: { at: number; stopped: boolean }[] = [];
  const output = new SharedAudioOutput({ createContext: () => ctx as unknown as AudioContext, timers: idleTimers, visibility: null, now: () => ctx.currentTime * 1000,
    wake: { start: () => { log.push('tone'); const tone = { at: ctx.currentTime, stopped: false }; tones.push(tone); return { startedAt: tone.at, stop: () => { tone.stopped = true; log.push('tone off'); } }; } },
    sink: { choose: async () => wanted } });
  output.warm();
  output.wake(); await flush();
  assert.equal(tones.length, 1);
  const lease = await output.acquire(); ctx.currentTime += 3; lease.release(); // a reading played: the output is warm
  output.wake(); await flush();
  assert.ok(output.wakeReadyAt(ctx as unknown as AudioContext) <= ctx.currentTime, 'warm and not moved: her first sound never waits');
  wanted = 'o-airpods'; log.length = 0; // the user put AirPods first
  const next = await output.acquire();
  assert.deepEqual(log, ['sink o-airpods', 'tone off', 'tone'], 'switch first, then the tone on the new device');
  assert.equal(output.wakeReadyAt(next.context), tones[1].at + WAKE_LEAD_MS / 1000, 'the new device is cold: her first sound waits the lead');
  next.release();
  log.length = 0;
  (await output.acquire()).release();
  assert.deepEqual(log, [], 'no move: no switch, no restart');
});
