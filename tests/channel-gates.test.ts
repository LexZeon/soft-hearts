// Stable-only defaults: what is not tried yet stays off in the stable channel until the user switches it on;
// development and source runs are as before; a saved choice always wins. Fakes only: no Electron, no profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHANNEL_GATES_STABLE, CHANNEL_GATE_IDS, channelGateDefault, channelGatesView, parseChannelGateChoices, resolveChannelGate,
  type GateChannel } from '../shared/foundation/channel-defaults';
import { ChannelGatesStore } from '../electron/wiring/channel-gates-store-wiring';
import { defaultJellyTuning, jellyOff, normalizeJellyTuning, resolveTouchSoftWithGate } from '../shared/stage/jelly-tuning';
import { UnboundEntry, entryMenuItem, type UnboundEntryPorts } from '../electron/unbound/entry';
import { VoiceprintDataStore } from '../electron/senses/voiceprint/store';
import { UnboundEntryButton } from '../src/unbound/unbound-entry-button';
import { ChannelGatesPanel, channelGateStatus } from '../src/settings/channel-gates-panel';
import { setUiLanguage } from '../shared/foundation/ui-language';
import type { UnboundState } from '../shared/unbound/scene';
import { UnboundHost, type UnboundHostPorts } from '../electron/unbound/host';

setUiLanguage('zh-CN');
const CHANNELS: GateChannel[] = ['stable', 'development', '', null, undefined];

test('every gate is on in every channel, stable included: stable never keeps a development-on default off', () => {
  for (const id of CHANNEL_GATE_IDS) {
    for (const channel of CHANNELS) assert.equal(channelGateDefault(id, channel), true, `${id} on ${String(channel)}`);
    assert.equal(CHANNEL_GATES_STABLE[id], channelGateDefault(id, 'development'), `${id}: stable equals development`);
  }
  assert.deepEqual(CHANNEL_GATES_STABLE, { unboundEntry: true, touchSoft: true, speechBeats: true, threeOnStage: true, chimeIn: true });
});

test('a saved choice wins on every channel; an unset one follows the channel', () => {
  for (const channel of CHANNELS) {
    for (const id of CHANNEL_GATE_IDS) {
      assert.equal(resolveChannelGate(id, { [id]: true }, channel), true);
      assert.equal(resolveChannelGate(id, { [id]: false }, channel), false);
      assert.equal(resolveChannelGate(id, { [id]: null }, channel), channelGateDefault(id, channel));
      assert.equal(resolveChannelGate(id, undefined, channel), channelGateDefault(id, channel));
    }
  }
  const view = channelGatesView({ unboundEntry: false, touchSoft: null }, 'stable');
  assert.deepEqual(view.unboundEntry, { on: false, saved: false, channelDefault: true });
  assert.deepEqual(view.touchSoft, { on: true, saved: null, channelDefault: true });
});

test('parsing keeps only real booleans, and never copies other fields', () => {
  assert.deepEqual(parseChannelGateChoices({ unboundEntry: 'yes', touchSoft: 1, extra: true }), { unboundEntry: null, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null });
  assert.deepEqual(parseChannelGateChoices({ unboundEntry: true, touchSoft: false }), { unboundEntry: true, touchSoft: false, speechBeats: null, threeOnStage: null, chimeIn: null });
  assert.deepEqual(parseChannelGateChoices('nonsense'), { unboundEntry: null, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null });
  assert.deepEqual(parseChannelGateChoices(JSON.parse('{"__proto__":{"unboundEntry":true}}')), { unboundEntry: null, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null });
});

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gates-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('the store: a fresh profile follows the channel and writes nothing by itself', async () => {
  await withDirectory(async directory => {
    const writes: string[] = [];
    for (const [channel, expected] of [['stable', true], ['development', true], ['', true]] as const) {
      const store = new ChannelGatesStore(directory, channel, async (_file, text) => { writes.push(text); });
      assert.equal(store.enabled('unboundEntry'), expected, `unboundEntry on ${channel || 'source'}`);
      assert.equal(store.enabled('touchSoft'), expected, `touchSoft on ${channel || 'source'}`);
      assert.equal(store.enabled('speechBeats'), true, `speechBeats (边说边演) on ${channel || 'source'} (on everywhere since 2026-11-25)`);
    }
    assert.deepEqual(writes, []);
  });
});

test('the store: a saved choice survives a restart, wins over the channel, and forgetting returns to the channel', async () => {
  await withDirectory(async directory => {
    const stable = new ChannelGatesStore(directory, 'stable');
    assert.equal(stable.enabled('unboundEntry'), true);
    await stable.set('unboundEntry', false);
    assert.equal(stable.enabled('unboundEntry'), false);
    assert.equal(stable.enabled('touchSoft'), true, 'the other gate is untouched');
    const saved = JSON.parse(await readFile(path.join(directory, 'channel-gates.json'), 'utf8'));
    assert.deepEqual(saved, { version: 1, unboundEntry: false, touchSoft: null, speechBeats: null, threeOnStage: null, chimeIn: null });
    assert.equal(new ChannelGatesStore(directory, 'stable').enabled('unboundEntry'), false, 'after a restart');
    // An existing user who turned something off on development keeps it off.
    await new ChannelGatesStore(directory, 'development').set('touchSoft', false);
    assert.equal(new ChannelGatesStore(directory, 'development').enabled('touchSoft'), false);
    await stable.set('unboundEntry', null);
    assert.equal(new ChannelGatesStore(directory, 'stable').enabled('unboundEntry'), true, 'forgotten: back to the channel');
  });
});

test('the store: damaged or foreign files read as nothing chosen; bad requests are refused and write nothing', async () => {
  await withDirectory(async directory => {
    const writes: string[] = [];
    const damaged = new ChannelGatesStore(directory, 'stable', async (_f, text) => { writes.push(text); }, () => '{not json');
    assert.equal(damaged.enabled('unboundEntry'), true);
    const foreign = new ChannelGatesStore(directory, 'stable', async () => {}, () => JSON.stringify({ version: 2, unboundEntry: false }));
    assert.equal(foreign.enabled('unboundEntry'), true, 'an unknown version is not trusted');
    await assert.rejects(damaged.set('nope', true));
    await assert.rejects(damaged.set('unboundEntry', 'yes'));
    await assert.rejects(damaged.set('__proto__', true));
    assert.deepEqual(writes, []);
  });
});

test('the store: a failed write does not change what is in force', async () => {
  const store = new ChannelGatesStore('nowhere', 'stable', async () => { throw new Error('disk'); }, () => { throw new Error('none'); });
  await assert.rejects(store.set('unboundEntry', false));
  assert.equal(store.enabled('unboundEntry'), true);
});

test('touch-soft: stable and development default on; the user\'s saved choice beats the lab, the lab beats the channel', () => {
  assert.equal(resolveTouchSoftWithGate(null, null, channelGateDefault('touchSoft', 'stable')).enabled, true);
  assert.equal(resolveTouchSoftWithGate(null, null, channelGateDefault('touchSoft', 'development')).enabled, true);
  const labOn = { ...defaultJellyTuning(), touch: { enabled: true as boolean | null, strength: 1.5 } };
  const labOff = { ...defaultJellyTuning(), touch: { enabled: false as boolean | null, strength: 1 } };
  assert.equal(resolveTouchSoftWithGate(labOn, null, false).enabled, true, 'the lab\'s own choice when the user chose nothing');
  assert.equal(resolveTouchSoftWithGate(labOn, null, false).strength, 1.5);
  assert.equal(resolveTouchSoftWithGate(labOff, null, true).enabled, false);
  assert.equal(resolveTouchSoftWithGate(labOff, true, false).enabled, true, 'the settings switch wins');
  assert.equal(resolveTouchSoftWithGate(labOn, false, true).enabled, false);
  assert.equal(resolveTouchSoftWithGate(labOn, false, true).strength, 1.5, 'only on/off is overridden');
});

test('touch-soft through the store, per channel', async () => {
  await withDirectory(async directory => {
    assert.equal(new ChannelGatesStore(directory, 'stable').touchSoftFor(undefined).enabled, true);
    assert.equal(new ChannelGatesStore(directory, 'development').touchSoftFor(undefined).enabled, true);
    assert.equal(new ChannelGatesStore(directory, '').touchSoftFor(undefined).enabled, true, 'source runs as today');
    const stable = new ChannelGatesStore(directory, 'stable');
    await stable.set('touchSoft', false);
    assert.equal(stable.touchSoftFor(undefined).enabled, false);
    assert.equal(stable.touchSoftFor({ ...defaultJellyTuning(), touch: { enabled: true, strength: 1 } }).enabled, false, 'beats a lab "on"');
  });
});

test('jelly layers and the voiceprint are off by default everywhere', async () => {
  const fresh = defaultJellyTuning();
  assert.equal(fresh.follow.enabled, false); assert.equal(fresh.soft.enabled, false); assert.equal(jellyOff(fresh), true);
  assert.equal(jellyOff(normalizeJellyTuning(undefined)), true); assert.equal(jellyOff(normalizeJellyTuning({})), true);
  assert.equal(jellyOff(normalizeJellyTuning({ follow: { enabled: 'true' }, soft: { enabled: 1 } })), true, 'only a real true turns a layer on');
  await withDirectory(async directory => {
    const store = new VoiceprintDataStore(directory, { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() } as never);
    assert.deepEqual(await store.load(), { enabled: false, print: null }, 'a fresh profile: off, nothing enrolled');
  });
});

function entryPorts(extra: Omit<Partial<UnboundEntryPorts>, 'state'> & { state?: UnboundState } = {}) {
  const log: string[] = [];
  const facts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
  let state: UnboundState = extra.state ?? 'normal';
  const { state: _state, ...ports } = extra;
  const entry = new UnboundEntry({
    state: () => state, enter: () => { log.push('enter'); }, exit: () => { log.push('exit'); state = 'normal'; },
    ask: async () => { log.push('ask'); return { confirmed: true, remember: false }; }, skipAsk: () => null, setSkipAsk: async () => {},
    bundle: { apply: async () => ({ opened: [], failed: [] }), restore: async () => {}, recover: async () => {} } as never,
    read: () => facts, face: () => ({ supported: false, installed: false, enrolled: 0 }), ...ports,
  });
  return { entry, log };
}

test('the way in: held while the gate is off (no page, no entering), open while it is on, and coming back is never held', async () => {
  const held = entryPorts({ allowed: () => false });
  assert.equal(await held.entry.toggle(), 'unavailable');
  assert.deepEqual(held.log, [], 'no permission page, nothing entered');
  const open = entryPorts({ allowed: () => true });
  assert.equal(await open.entry.toggle(), 'entering');
  assert.deepEqual(open.log, ['ask', 'enter']);
  const noGate = entryPorts({});
  assert.equal(await noGate.entry.toggle(), 'entering', 'a host without the gate: as before');
  const out = entryPorts({ allowed: () => false, state: 'unbound' });
  assert.equal(await out.entry.toggle(), 'back', 'she is out and the gate was switched off meanwhile: she can still come back');
  assert.deepEqual(out.log, ['exit']);
});

test('the tray item: out: back (always); in the small window: enter only while allowed, otherwise no item', () => {
  assert.equal(entryMenuItem('unbound', false), 'back');
  assert.equal(entryMenuItem('entering', false), 'back');
  assert.equal(entryMenuItem('unbound', true), 'back');
  assert.equal(entryMenuItem('normal', true), 'enter');
  assert.equal(entryMenuItem('normal', false), null);
  assert.equal(entryMenuItem(undefined, false), null);
  assert.equal(entryMenuItem(undefined, true), 'enter');
});

class El {
  children: El[] = []; textContent = ''; title = ''; type = ''; id = ''; className = ''; disabled = false; hidden = false; checked = false;
  onchange: (() => void) | null = null; listeners: Record<string, () => void> = {};
  ownerDocument = { createElement: () => new El() };
  insertAdjacentElement(_where: string, el: El) { this.children.push(el); return el; }
  addEventListener(name: string, run: () => void) { this.listeners[name] = run; }
  append(...els: El[]) { this.children.push(...els); }
  replaceChildren(...els: El[]) { this.children = els; }
  setAttribute() {} remove() {}
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the control window button: hidden while the gate is off and she is in the small window; coming back always shows', async () => {
  const anchor = new El();
  let push: (view: { state: string; entryAllowed?: boolean }) => void = () => {};
  const button = new UnboundEntryButton(anchor as unknown as HTMLElement, { getUnbound: async () => ({ state: 'normal', entryAllowed: false }) as never,
    onUnbound: callback => { push = callback as typeof push; return () => {}; }, toggleUnbound: async () => 'unavailable', askUnboundAgain: async () => true });
  await settle();
  const ask = anchor.children[0].children[0];
  assert.equal(button.button.hidden, true, 'the host says the entry is not allowed (switched off in settings): no button');
  assert.equal(ask.hidden, true, 'and no 「下次进来时再问我」');
  push({ state: 'normal', entryAllowed: true });
  assert.equal(button.button.hidden, false, 'allowed');
  assert.equal(ask.hidden, false);
  push({ state: 'unbound', entryAllowed: false });
  assert.equal(button.button.hidden, false, 'she is out: 「回到小窗」 stays');
  assert.equal(button.button.textContent, '回到小窗');
  push({ state: 'normal' });
  assert.equal(button.button.hidden, false, 'a host that does not say: as before');
});

test('the host\'s control view carries the gate, and says on when no gate is wired', () => {
  const view = (entryAllowed?: () => boolean) => UnboundHost.prototype.view.call({
    ports: { developerMode: () => false, entryAllowed }, screen: null, mode: { state: 'normal' }, viewerDistanceM: 0.6, her: { placement: null, depthM: 0.4 }, body: {}, debug: false,
    stats: null, error: null, fullscreenInFront: false, peek: null, speechBeat: false, life: null }).entryAllowed;
  assert.equal(view(() => false), false);
  assert.equal(view(() => true), true);
  assert.equal(view(undefined), true);
  void ({} as UnboundHostPorts);
});

test('the settings page: a switch for each gate, saved through the host, in Chinese and in English', async () => {
  const root = new El();
  let view = channelGatesView(null, 'stable');
  const calls: [string, boolean][] = [];
  new ChannelGatesPanel(root as unknown as HTMLElement, { get: async () => view, set: async (id, on) => { calls.push([id, on]); view = channelGatesView({ [id]: on }, 'stable'); return view; } });
  await settle();
  const labels = root.children.filter(child => child.children.length === 2);
  assert.equal(labels.length, 4, 'one switch per gate shown here (speech beats has its own page)');
  const inputs = labels.map(label => label.children[1]);
  assert.deepEqual(inputs.map(input => input.id), ['channel-gate-unbound-entry', 'channel-gate-three-on-stage', 'channel-gate-chime-in', 'channel-gate-touch-soft']);
  assert.deepEqual(inputs.map(input => input.checked), [true, true, true, true], 'stable: every switch on by default');
  assert.match(labels[2].children[0].children.map(c => c.textContent).join(' '), /她们都能接话.*haiku.*一直接下去.*三次 Claude 和三份朗读.*只有你点的那位回你/);
  inputs[0].checked = false; inputs[0].onchange?.();
  await settle();
  assert.deepEqual(calls, [['unboundEntry', false]]);
  assert.equal(inputs[0].checked, false);
  assert.equal(channelGateStatus(view, 'unboundEntry'), '已关闭');
  assert.equal(channelGateStatus(view, 'touchSoft'), '已开启'); assert.equal(channelGateStatus(view, 'threeOnStage'), '已开启'); assert.match(labels[1].children[0].children.map(c => c.textContent).join(' '), /三人同框（Beta）.*最多三位.*每位都能说话.*只有和你说话的那位.*Beta.*三次 Claude 和三份朗读/);
  setUiLanguage('en');
  try { assert.equal(channelGateStatus(view, 'unboundEntry'), 'Off'); assert.equal(channelGateStatus(null, 'touchSoft'), 'Loading…'); } finally { setUiLanguage('zh-CN'); }
});

test('边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): on in stable and development; the saved choice wins and survives a restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-speech-beats-gate-'));
  try {
    assert.equal(channelGateDefault('speechBeats', 'stable'), true);
    for (const channel of ['development', '', null, undefined] as const) assert.equal(channelGateDefault('speechBeats', channel), true);
    const stable = new ChannelGatesStore(directory, 'stable');
    assert.equal(stable.enabled('speechBeats'), true);
    await stable.set('speechBeats', false);
    assert.equal(new ChannelGatesStore(directory, 'stable').enabled('speechBeats'), false, 'saved off wins in stable, after a restart');
    await new ChannelGatesStore(directory, 'development').set('speechBeats', false);
    assert.equal(new ChannelGatesStore(directory, 'development').enabled('speechBeats'), false, 'saved off wins in development');
    assert.equal(new ChannelGatesStore(directory, 'stable').enabled('touchSoft'), true, 'the other gates untouched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('三人同框（Beta）: the switch says what it does in English too (three at most, each talks, default only the one you talk with, Beta, three Claude calls)', async () => {
  setUiLanguage('en');
  try {
    const root = new El();
    new ChannelGatesPanel(root as unknown as HTMLElement, { get: async () => channelGatesView(null, 'stable'), set: async () => channelGatesView(null, 'stable') });
    await settle();
    const label = root.children.filter(child => child.children.length === 2)[1];
    const [title, hint] = label.children[0].children.map(c => c.textContent);
    assert.equal(title, 'Three on stage (Beta)');
    assert.match(hint, /up to three characters.*each can talk, be clicked and be pulled.*only the one you talk with.*Beta.*three Claude calls and three read-alouds/);
    assert.doesNotMatch(hint, /[一-鿿]/, 'no Chinese left in the English words');
  } finally { setUiLanguage('zh-CN'); }
});
