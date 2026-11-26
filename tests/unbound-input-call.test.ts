// The Unbound small input box's 「打电话」 button: it starts and ends the same call the companion window's button does, only the
// box's own frame can ask, and its label follows whether a call is on. No microphone is used: the call controller runs on fake ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputCallBridge, inputCallPort, isInputWindowSender, CALL_HINTS, type InputCallHost } from '../electron/unbound/input-call';
import { createUnboundInputApi, UNBOUND_INPUT_API_KEYS, UNBOUND_INPUT_CHANNELS } from '../electron/unbound/input-preload-api';
import { VoiceCallController, type VoiceCallPorts } from '../electron/voice/voice-call/controller';
import { callSurfaceShown } from '../electron/voice/voice-call/surface';
import { SUBMIT_HINTS } from '../electron/unbound/typing';
import { setUiLanguage } from '../shared/foundation/ui-language';
import type { VoiceCallOwner } from '../shared/voice/voice-call';
import type { UnboundState } from '../shared/unbound/scene';

/** A call controller on fake ports, wrapped as the voice-call host's `set` (electron/voice/voice-call/host.ts does exactly this mapping). */
function callRig(options: { micRefused?: boolean; asleep?: boolean } = {}) {
  const place = { pet: false, controls: true, held: true }; // no-pet-ok: media owner keys. Out in Unbound: her companion window is hidden only because she is out
  let voice = { on: false, owner: null as VoiceCallOwner | null };
  const calls: Array<[VoiceCallOwner, boolean, string]> = [];
  const mic: string[] = [];
  const ports: VoiceCallPorts = {
    now: () => 1_000, timers: { set: () => 0, clear: () => {} }, voiceInput: () => voice,
    turnOnVoice: owner => { mic.push('on'); if (options.micRefused) return false; voice = { on: true, owner }; return true; },
    turnOffVoice: () => { mic.push('off'); voice = { on: false, owner: null }; },
    windowShown: owner => callSurfaceShown(owner, place), out: () => place.held, asleep: () => options.asleep === true,
    fillers: () => null, keepWarm: () => {}, publish: () => {}, journal: () => {},
  };
  const controller = new VoiceCallController(ports, 60_000);
  const host: InputCallHost = {
    get on() { return controller.on; },
    set: async (owner, on, via) => { calls.push([owner, on, via]); return on ? controller.start(owner, via) : controller.stop('user'); },
  };
  return { controller, host, calls, mic, place };
}
const OUT: () => UnboundState = () => 'unbound';

test('the button starts the call as the companion window\'s own button does: its owner value, via button, through the call controller; the box is told it is on', async () => {
  const rig = callRig();
  const bridge = new InputCallBridge(); bridge.connect(inputCallPort(rig.host));
  const told: boolean[] = []; bridge.subscribe(on => told.push(on));
  assert.equal(bridge.isOn(), false);
  const result = await bridge.request(true, OUT);
  assert.deepEqual(result, { ok: true, on: true });
  assert.deepEqual(rig.calls, [['pet', true, 'button']]); // no-pet-ok: the call owner value the voice-call host uses
  assert.equal(rig.controller.on, true); assert.equal(rig.controller.owner, 'pet'); // no-pet-ok: the call owner value the voice-call host uses
  assert.equal(bridge.isOn(), true);
  bridge.changed(true); assert.deepEqual(told, [true]);
});

test('hanging up ends the call and gives the microphone back as the call found it; it is allowed even when she is no longer out', async () => {
  const rig = callRig();
  const bridge = new InputCallBridge(); bridge.connect(inputCallPort(rig.host));
  await bridge.request(true, OUT);
  const result = await bridge.request(false, () => 'normal');
  assert.deepEqual(result, { ok: true, on: false });
  assert.equal(rig.controller.on, false);
  assert.deepEqual(rig.mic, ['on', 'off'], 'the call turned the microphone on, hanging up turned it off again (no third state)');
});

test('the call\'s own refusals come back as the reason and the box stays as it was: microphone not available, she is asleep', async () => {
  const noMic = callRig({ micRefused: true });
  const a = new InputCallBridge(); a.connect(inputCallPort(noMic.host));
  const refused = await a.request(true, OUT);
  assert.equal(refused.ok, false); assert.equal(refused.on, false);
  assert.match(refused.hint ?? '', /麦克风没有打开/);
  assert.equal(noMic.controller.on, false);
  const asleep = callRig({ asleep: true });
  const b = new InputCallBridge(); b.connect(inputCallPort(asleep.host));
  const sleeping = await b.request(true, OUT);
  assert.equal(sleeping.ok, false); assert.match(sleeping.hint ?? '', /睡着了/);
  assert.deepEqual(asleep.mic, [], 'nothing turned the microphone on for a call she is asleep for');
});

test('the button does not turn the microphone on by any other way: no call host, no call; a call cannot start unless she is out', async () => {
  const bridge = new InputCallBridge();
  assert.deepEqual(await bridge.request(true, OUT), { ok: false, on: false, hint: CALL_HINTS.unavailable });
  const rig = callRig(); bridge.connect(inputCallPort(rig.host));
  assert.deepEqual(await bridge.request(true, () => 'normal'), { ok: false, on: false, hint: SUBMIT_HINTS.away });
  assert.deepEqual(await bridge.request(true, () => 'entering' as UnboundState), { ok: false, on: false, hint: SUBMIT_HINTS.away });
  assert.deepEqual(rig.calls, [], 'the host was never asked'); assert.deepEqual(rig.mic, []);
  for (const bad of [undefined, null, 1, 'true', {}]) assert.equal((await bridge.request(bad, OUT)).ok, false, 'only a real boolean asks for anything');
  assert.deepEqual(rig.calls, []);
});

test('a second press while the call is already on does not start a second one', async () => {
  const rig = callRig();
  const bridge = new InputCallBridge(); bridge.connect(inputCallPort(rig.host));
  await bridge.request(true, OUT); await bridge.request(true, OUT);
  assert.deepEqual(rig.mic, ['on'], 'one microphone start');
});

// ---- who may ask ---------------------------------------------------------------------------------------------------------------

test('only the box\'s own window and its top frame may ask (the same test answers submit, cancel and call)', () => {
  const frame = {};
  const win = { isDestroyed: () => false, webContents: { id: 7, isDestroyed: () => false } };
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: frame }, senderFrame: frame }, win), true);
  assert.equal(isInputWindowSender({ sender: { id: 8, mainFrame: frame }, senderFrame: frame }, win), false, 'another window (her companion window, the control window, the Unbound window)');
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: frame }, senderFrame: {} }, win), false, 'a sub-frame of the box');
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: undefined }, senderFrame: {} }, win), false);
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: frame }, senderFrame: frame }, null), false, 'no box window');
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: frame }, senderFrame: frame }, { ...win, isDestroyed: () => true }), false, 'a destroyed window');
  assert.equal(isInputWindowSender({ sender: { id: 7, mainFrame: frame }, senderFrame: frame }, { ...win, webContents: { id: 7, isDestroyed: () => true } }), false);
});

// ---- the page's API ------------------------------------------------------------------------------------------------------------

test('the box\'s API gains exactly two things: call(boolean) and onCallState', async () => {
  const invoked: Array<[string, unknown[]]> = [];
  const listeners = new Map<string, Set<(event: unknown, value?: unknown) => void>>();
  const api = createUnboundInputApi({
    invoke: async (channel, ...args) => { invoked.push([channel, args]); return { ok: true, on: true }; },
    on: (channel, listener) => { (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!).add(listener); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  });
  // I-190 adds the senses panel's six requests and two events (tests/i190-source-pickers.test.ts, tests/i190-unbound-watch.test.ts).
  assert.deepEqual([...UNBOUND_INPUT_API_KEYS].sort(), ['call', 'cancel', 'chooseScreenSource', 'company', 'defaultPlace', 'onCallState', 'onOpen', 'onPanelOpen', 'onScreenSource', 'panel', 'screenSourceMenu', 'senses', 'setCompany', 'setDefaultPlace', 'submit', 'toggleWatchTogether', 'typed', 'watchTogether']); // 2026-11-23: defaultPlace and setDefaultPlace (the panel's 设为默认位置, tests/unbound-default-place.test.ts); typed (a key went in; no content); I-209 step 1: company and setCompany (the panel's 谁在场, tests/i209-company-presence.test.ts)
  assert.deepEqual(Object.keys(api).sort(), [...UNBOUND_INPUT_API_KEYS].sort());
  assert.deepEqual(await api.call(true), { ok: true, on: true });
  assert.deepEqual(invoked, [[UNBOUND_INPUT_CHANNELS.call, [true]]]);
  await assert.rejects(api.call('yes' as unknown as boolean), TypeError);
  await assert.rejects(api.call(undefined as unknown as boolean), TypeError);
  const got: boolean[] = []; const off = api.onCallState(on => got.push(on));
  const emit = (value: unknown) => listeners.get(UNBOUND_INPUT_CHANNELS.callState)!.forEach(l => l({}, value));
  emit(true); emit(false); emit('true'); emit(undefined); off(); emit(true);
  assert.deepEqual(got, [true, false, false, false], 'only a real true counts as on; unsubscribed means silent');
  assert.throws(() => api.onCallState(undefined as unknown as () => void), TypeError);
  for (const channel of Object.values(UNBOUND_INPUT_CHANNELS)) assert.match(channel, /^unbound:[a-z-]+$/);
});

test('the page: the button reads 打电话 / 挂断 (Call / Hang up in English), follows the host\'s call state, and a press asks for the opposite', async () => {
  const handlers = new Map<string, (event?: unknown) => void>();
  const field = { value: '', placeholder: '', focus() {}, addEventListener() {} };
  const hint = { textContent: '', dataset: {} as Record<string, string> };
  const classes = new Set<string>();
  const button = { textContent: '', classList: { toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); } }, addEventListener: (type: string, fn: (event?: unknown) => void) => { handlers.set(type, fn); } };
  const asked: boolean[] = [];
  let reply: { ok: boolean; on: boolean; hint?: string } = { ok: true, on: true };
  let onOpen!: (language: string) => void, onCallState!: (on: boolean) => void;
  Object.assign(globalThis, {
    document: { title: '', documentElement: { lang: 'zh-CN' }, getElementById: (id: string) => id === 'line' ? field : id === 'call' ? button : hint },
    window: { addEventListener() {}, unboundInput: {
      submit: async () => ({ ok: true }), cancel: async () => {},
      onOpen: (cb: (language: string) => void) => { onOpen = cb; return () => {}; }, onCallState: (cb: (on: boolean) => void) => { onCallState = cb; return () => {}; },
      call: async (on: boolean) => { asked.push(on); return reply; } } },
  });
  try {
    await import('../src/unbound/input');
    assert.equal(button.textContent, '打电话');
    onCallState(true); assert.equal(button.textContent, '挂断'); assert.ok(classes.has('on'));
    onCallState(false); assert.equal(button.textContent, '打电话'); assert.ok(!classes.has('on'));
    onOpen('en'); assert.equal(button.textContent, 'Call');
    onCallState(true); assert.equal(button.textContent, 'Hang up');
    onOpen('zh-CN'); assert.equal(button.textContent, '挂断', 'a new language keeps the state, only the words change');
    onCallState(false);
    const mousedown = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers.get('mousedown')!(mousedown); assert.ok(mousedown.prevented, 'pressing the button does not take the keyboard from the line');
    handlers.get('click')!(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked, [true], 'off: a press asks to start');
    assert.equal(button.textContent, '挂断');
    handlers.get('click')!(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(asked, [true, false], 'on: a press asks to hang up');
    reply = { ok: false, on: false, hint: '她睡着了，先别打电话吧。' };
    handlers.get('click')!(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(button.textContent, '打电话'); assert.equal(hint.textContent, '她睡着了，先别打电话吧。', 'the call\'s own reason shows under the line');
  } finally { setUiLanguage('zh-CN'); }
});

test('every line the call button can show has English: its label, its own two hints and the call\'s reasons the box shows', async () => {
  const { t } = await import('../shared/foundation/ui-language');
  setUiLanguage('en');
  try {
    for (const line of ['打电话', '挂断', CALL_HINTS.unavailable, CALL_HINTS.failed, '请先让这个窗口显示出来，再打电话。', '她睡着了，先别打电话吧。', '麦克风没有打开，通话没有开始。',
      '麦克风没有打开，通话没有开始：可能还没有本机语音识别，设置里会有说明。'])
      assert.match(t(line), /^[\x20-\x7e]+$/, `English for: ${line}`);
  } finally { setUiLanguage('zh-CN'); }
});
