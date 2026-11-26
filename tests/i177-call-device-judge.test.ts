import assert from 'node:assert/strict';
import test from 'node:test';
import { CallDeviceJudge, cleanDeviceNames, parseCallDeviceAnswer, callDevicePrompt, CALL_DEVICE_SYSTEM } from '../electron/voice/call-device-judge';
import { CALL_DEVICES_KNOBS } from '../shared/behaviors/call-devices/knobs';
import type { DeviceInfo } from '../shared/voice/call-devices';
import { CallMicAdvisor, emptyCallDeviceState, type CallBarPorts, type CallDeviceState } from '../src/voice/voice-call/call-mic';

/*
 * I-177 batch 2:
 * the host side of Claude's device judgement. Fake haiku, fake clock; no real Claude call.
 */

const names = { inputs: ['Headset (AirPods Pro Hands-Free)', 'Microphone Array (Realtek(R) Audio)'], outputs: ['Headphones (AirPods Pro)', 'Speakers (Realtek(R) Audio)'] };
const good = JSON.stringify({
  kinds: { 'Headphones (AirPods Pro)': 'headphones', 'Speakers (Realtek(R) Audio)': 'speakers', 'Microphone Array (Realtek(R) Audio)': 'microphone', 'Headset (AirPods Pro Hands-Free)': 'microphone' },
  pairs: { 'Headphones (AirPods Pro)': 'Headset (AirPods Pro Hands-Free)' },
  inputOrder: ['Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)'], outputOrder: ['Headphones (AirPods Pro)', 'Speakers (Realtek(R) Audio)'], headsetMicOnly: false,
});

function judge(options: { answer?: (prompt: string) => string | Promise<string>; available?: () => boolean; day?: () => string } = {}) {
  const prompts: string[] = [], systems: string[] = [];
  let day = '2026-11-22';
  const j = new CallDeviceJudge({
    ask: async (prompt, system) => { prompts.push(prompt); systems.push(system); return options.answer ? options.answer(prompt) : good; },
    available: options.available ?? (() => true), now: () => 0, localDate: () => options.day?.() ?? day,
  });
  return { j, prompts, systems, setDay: (d: string) => { day = d; } };
}

test('judge: one ask per new device set; a known set (any order) gets the same answer without a second call', async () => {
  const { j, prompts } = judge();
  const first = await j.ask(names);
  assert.ok(first);
  assert.deepEqual(first!.inputOrder, ['Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)']);
  assert.equal(first!.kinds['Headphones (AirPods Pro)'], 'headphones');
  const again = await j.ask({ inputs: [...names.inputs].reverse(), outputs: [...names.outputs].reverse() });
  assert.deepEqual(again, first);
  assert.equal(prompts.length, 1, 'the same set is never asked twice');
  await j.ask({ inputs: ['USB Audio Device'], outputs: names.outputs });
  assert.equal(prompts.length, 2, 'a new set is asked once');
  assert.equal(j.stats.asked, 2); assert.equal(j.stats.repeated, 1);
});

test('judge: never sends an owner name, an id or anything but the two name lists', async () => {
  const { j, prompts, systems } = judge();
  await j.ask({ inputs: ["Headset (Alex's AirPods Pro Hands-Free)", '艾乐的 Microphone Array', 42, { deviceId: 'abc' }], outputs: ['Default - Headphones (艾乐的 AirPods Pro)'], deviceId: 'x', groupId: 'g' });
  assert.equal(prompts.length, 1);
  const sent = prompts[0] + systems[0];
  assert.doesNotMatch(sent, /艾乐|Alex|deviceId|groupId|abc/);
  assert.match(prompts[0], /Headset \(AirPods Pro Hands-Free\)/);
  assert.match(prompts[0], /Headphones \(AirPods Pro\)/);
  assert.equal(prompts[0], callDevicePrompt(cleanDeviceNames({ inputs: ["Headset (Alex's AirPods Pro Hands-Free)", '艾乐的 Microphone Array'], outputs: ['Default - Headphones (艾乐的 AirPods Pro)'] })!));
  assert.match(CALL_DEVICE_SYSTEM, /JSON/);
});

test('judge: bad input asks nothing; names are capped and control characters removed', async () => {
  const { j, prompts } = judge();
  for (const bad of [null, 'AirPods', [], { inputs: 'x', outputs: [] }, { inputs: [], outputs: [] }]) assert.equal(await j.ask(bad), null);
  assert.equal(prompts.length, 0);
  const many = cleanDeviceNames({ inputs: Array.from({ length: 60 }, (_, i) => `Mic ${i}\u0007` + 'x'.repeat(200)), outputs: [] })!;
  assert.equal(many.inputs.length, 24);
  assert.ok(many.inputs.every(name => name.length <= 80 && !/[\u0000-\u001f]/.test(name)));
});

test('judge: only while the user\'s Claude answers, and at most callsPerDay a day', async () => {
  let up = false;
  const t = judge({ available: () => up });
  assert.equal(await t.j.ask(names), null);
  assert.equal(t.prompts.length, 0, 'Claude unavailable: no call');
  up = true;
  assert.ok(await t.j.ask(names), 'not remembered while unavailable: the next call may ask');
  for (let i = 0; i < CALL_DEVICES_KNOBS.callsPerDay + 3; i++) await t.j.ask({ inputs: [`Mic ${i}`], outputs: ['Speakers'] });
  assert.equal(t.prompts.length, CALL_DEVICES_KNOBS.callsPerDay, 'the daily cap holds');
  assert.equal(t.j.stats.capped, 4);
  t.setDay('2026-11-23');
  await t.j.ask({ inputs: ['Mic tomorrow'], outputs: ['Speakers'] });
  assert.equal(t.prompts.length, CALL_DEVICES_KNOBS.callsPerDay + 1, 'a new day, a new allowance');
});

test('judge: the answer is cut to names that were sent and the three kinds; nonsense is null', () => {
  assert.equal(parseCallDeviceAnswer('I think the AirPods are headphones.', names), null);
  assert.equal(parseCallDeviceAnswer('{not json}', names), null);
  assert.equal(parseCallDeviceAnswer(JSON.stringify({ inputOrder: 'x', outputOrder: [] }), names), null);
  assert.equal(parseCallDeviceAnswer(JSON.stringify({ inputOrder: ['Ghost Mic'], outputOrder: ['Ghost Out'] }), names), null, 'nothing real left');
  const cut = parseCallDeviceAnswer('Sure! ' + JSON.stringify({
    kinds: { 'Headphones (AirPods Pro)': 'earbuds', 'Speakers (Realtek(R) Audio)': 'speakers', 'Ghost': 'microphone' },
    pairs: { 'Headphones (AirPods Pro)': 'Ghost', 'Speakers (Realtek(R) Audio)': 'Microphone Array (Realtek(R) Audio)' },
    inputOrder: ['Ghost', 'Microphone Array (Realtek(R) Audio)', 'Microphone Array (Realtek(R) Audio)'], outputOrder: ['Headphones (AirPods Pro)'], headsetMicOnly: 'yes',
  }) + ' hope that helps', names)!;
  assert.deepEqual(cut.kinds, { 'Speakers (Realtek(R) Audio)': 'speakers' }, 'unknown kinds and names dropped');
  assert.deepEqual(cut.pairs, { 'Speakers (Realtek(R) Audio)': 'Microphone Array (Realtek(R) Audio)' });
  assert.deepEqual(cut.inputOrder, ['Microphone Array (Realtek(R) Audio)']);
  assert.equal(cut.headsetMicOnly, false, 'only a real true counts');
});

test('judge: a failing or slow call is null and never thrown into the window', async () => {
  const failing = new CallDeviceJudge({ ask: async () => { throw new Error('offline'); }, available: () => true });
  assert.equal(await failing.ask(names), null);
  assert.equal(failing.stats.failed, 1);
  let fire: (() => void) | null = null;
  const slow = new CallDeviceJudge({ ask: (_p, _s, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    available: () => true, timers: { set: callback => { fire = callback; return 1; }, clear: () => {} } });
  const pending = slow.ask(names);
  fire!();
  assert.equal(await pending, null);
  assert.equal(slow.stats.failed, 1);
});

// ---------------------------------------------------------------- window ↔ host: the advisor's ask goes to the judge

const out = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audiooutput', deviceId, groupId, label });
const mic = (label: string, groupId = '', deviceId = label): DeviceInfo => ({ kind: 'audioinput', deviceId, groupId, label });
const desk = [out('Headphones (艾乐的 AirPods Pro)', 'g1', 'o1'), out('Speakers (Realtek(R) Audio)', 'g2', 'o2'), mic('Headset (艾乐的 AirPods Pro Hands-Free)', 'g1', 'i1'),
  mic('Microphone Array (Realtek(R) Audio)', 'g2', 'i2'), mic('Logitech Webcam C920', 'g3', 'i3')];

function advisor(ask: (devices: { inputs: string[]; outputs: string[] }) => Promise<unknown>) {
  let state: CallDeviceState = emptyCallDeviceState();
  const cards: string[] = [];
  const bar: CallBarPorts = { line() {}, card: text => { cards.push(text); }, clear() {} };
  const a = new CallMicAdvisor({ read: async () => desk, storage: { load: () => JSON.parse(JSON.stringify(state)), save: next => { state = JSON.parse(JSON.stringify(next)); } }, now: () => 0, bar, ask });
  return { a, cards, state: () => state };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('window → host: the advisor asks the judge once per set with stripped names; Claude\'s order becomes the card; nonsense keeps the keyword card', async () => {
  const sent: unknown[] = [];
  const host = judge({ answer: () => JSON.stringify({ inputOrder: ['Logitech Webcam C920', 'Microphone Array (Realtek(R) Audio)', 'Headset (AirPods Pro Hands-Free)'], outputOrder: ['Headphones (AirPods Pro)'], kinds: {}, pairs: {} }) });
  const w = advisor(devices => { sent.push(devices); return host.j.ask(devices); });
  await w.a.callStarted(); await settle();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /艾乐/);
  assert.equal(w.cards.length, 2, 'the keyword card, then Claude\'s');
  assert.match(w.cards[1], /Logitech Webcam C920/);
  await w.a.callStarted(); await settle();
  assert.equal(sent.length, 1, 'a known set is not asked again');
  assert.equal(host.prompts.length, 1);
  // Nonsense from Claude: the keyword verdict stands (one card only).
  const bad = judge({ answer: () => 'no idea' });
  const v = advisor(devices => bad.j.ask(devices));
  await v.a.callStarted(); await settle();
  assert.equal(v.cards.length, 1);
  assert.match(v.cards[0], /Microphone Array/);
});
