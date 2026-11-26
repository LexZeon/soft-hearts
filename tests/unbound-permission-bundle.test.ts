// Unbound v1 step 1 (I-136): the permission bundle (electron/unbound/permission-bundle.ts), the entry (entry.ts), its profile file
// (entry-store.ts) and the switches it shares with the internal channel (agent-channel/bridge.ts createPerceptionSwitches).
// Fake switches, fake clock: what turns on, what goes back, what the user changed by hand, a reply being written, a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_ITEMS, BUNDLE_SIGNATURE, PermissionBundle, REOPEN_TRIES, bundleDialog, bundleFactsFrom, bundleSwitch, faceReadinessFrom, notOpenedNotice,
  parseBundleSession, type BundleFacts, type BundleItem, type BundlePorts, type BundleSession, type FaceReadiness,
} from '../electron/unbound/permission-bundle';
import { UnboundEntry } from '../electron/unbound/entry';
import { UnboundEntryStore, parseUnboundEntryRecord } from '../electron/unbound/entry-store';
import { createPerceptionSwitches, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import type { UnboundState } from '../shared/unbound/scene';
import { setUiLanguage, t } from '../shared/foundation/ui-language';
import { unboundEntryLabel } from '../src/unbound/unbound-entry-button';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const OFF: BundleFacts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
const READY_FACE: FaceReadiness = { supported: true, installed: true, enrolled: 3 };

/** Switches that remember who set what; `refuse` items stay off when turned on (a missing component). */
class FakeSwitches {
  facts: BundleFacts;
  calls: string[] = [];
  refuse = new Set<BundleItem>();
  saved: (BundleSession | null)[] = [];
  reply = false;
  waits = 0;
  ticker: (() => void) | null = null;
  face: FaceReadiness = READY_FACE;
  constructor(initial: Partial<BundleFacts> = {}) { this.facts = { ...OFF, ...initial }; }
  /** The user's own hand (not through the bundle). */
  hand(item: BundleItem, on: boolean) { this.facts[item] = on; }
  ports(): BundlePorts {
    return {
      read: () => ({ ...this.facts }),
      face: () => this.face,
      set: async (item, on) => { this.calls.push(`${item}:${on ? 'on' : 'off'}`); await tick(); if (!(on && this.refuse.has(item))) this.facts[item] = on; },
      save: async session => { this.saved.push(session ? structuredClone(session) : null); },
      replyRunning: () => this.reply,
      every: (_ms, run) => { this.ticker = run; return () => { this.ticker = null; }; },
      wait: async () => { this.waits++; if (this.waits >= 3) this.reply = false; },
    };
  }
}

test('the page: one line per sense with what she uses it for, 已经开着 marked, the way back and what is not touched', () => {
  const page = bundleDialog({ ...OFF, microphone: true }, READY_FACE);
  const lines = page.detail.split('\n').filter(line => line.startsWith('· '));
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^· 摄像头（姿势识别）：.*只在这台电脑上识别/);
  assert.match(lines[1], /^· 摄像头（发图片）：/);
  assert.match(lines[2], /^· 麦克风：.*（已经开着）$/);
  assert.ok(!lines[0].includes('已经开着') && !lines[1].includes('已经开着') && !lines[3].includes('已经开着'));
  assert.match(page.detail, /她在外面时，这些一直开着（暂时不能单独关）；回到小窗时，会恢复成你进来前的设置，任何一项随时都能在设置里自己关掉。/);
  assert.match(page.detail, /百炼.*Claude 任务执行和密钥不会因为这里打开/);
  assert.equal(page.checkbox, '以后直接进，不再问');
  assert.ok(!/窗口位置/.test(page.detail), 'reading window positions is not in this bundle (not built yet)');
  assert.match(bundleDialog(OFF, { supported: true, installed: true, enrolled: 0 }).detail, /认出是不是你（Beta）：.*（你还没登记自己的脸，登记之前它什么都不做）/);
  assert.match(bundleDialog(OFF, { supported: true, installed: false, enrolled: 0 }).detail, /认出是不是你（Beta）：.*这里不会替你下载，这一项先不开/);
  assert.equal(bundleDialog(OFF, { supported: false, installed: false, enrolled: 0 }).detail.split('\n').filter(line => line.startsWith('· ')).length, 5, 'no face line where it cannot run');
  assert.equal(bundleDialog(null, READY_FACE).detail.includes('已经开着'), false, 'unknown switches are not claimed on');
});

test('facts and switches: the bundle\'s levels are 姿势识别, 发图片, 和她一起听 (music), and each item maps to the user\'s own switch', () => {
  assert.deepEqual(bundleFactsFrom({ camera: true, cameraImages: true, cameraPose: false, microphone: false, screen: true, systemAudio: { music: false, movie: true }, faceCheck: true } as never),
    { camera: false, images: true, microphone: false, screen: true, listen: true, face: true }, '「发图片」 and 「姿势识别」 are two items; movie counts as listening');
  assert.deepEqual(bundleFactsFrom({ camera: true, cameraPose: true, microphone: false, screen: false, systemAudio: { music: false, movie: false } } as never).images, false,
    '「姿势识别」 alone is not 「发图片」');
  assert.deepEqual(bundleSwitch('camera', true), { kind: 'camera_pose', purposes: [] });
  assert.deepEqual(bundleSwitch('images', true), { kind: 'camera_images', purposes: [] });
  assert.deepEqual(bundleSwitch('images', false), { kind: 'camera_images', purposes: [] });
  assert.deepEqual(bundleSwitch('listen', true), { kind: 'system_audio', purposes: ['music'] });
  assert.deepEqual(bundleSwitch('listen', false), { kind: 'system_audio', purposes: ['music', 'movie'] });
  assert.deepEqual(bundleSwitch('face', false), { kind: 'face_check', purposes: [] });
  assert.deepEqual(faceReadinessFrom({ phase: 'downloading', enrolled: 0 }), { supported: true, installed: false, enrolled: 0 });
  assert.deepEqual(faceReadinessFrom({ phase: 'ready', enrolled: 4 }), { supported: true, installed: true, enrolled: 4 });
  assert.deepEqual(faceReadinessFrom(null), { supported: false, installed: false, enrolled: 0 });
});

test('apply: only what is off turns on, through the switches; the session is saved before anything turns on', async () => {
  const s = new FakeSwitches({ microphone: true });
  s.refuse.add('camera');
  const bundle = new PermissionBundle(s.ports());
  const outcome = await bundle.apply();
  assert.deepEqual(s.calls, ['camera:on', 'images:on', 'screen:on', 'listen:on', 'face:on'], 'the microphone was already on: untouched');
  assert.deepEqual(s.saved[0], { signature: BUNDLE_SIGNATURE, attempted: ['camera', 'images', 'screen', 'listen', 'face'], baseline: {}, touched: [] }, 'saved first');
  assert.deepEqual(outcome, { alreadyOn: ['microphone'], opened: ['images', 'screen', 'listen', 'face'], notOpened: ['camera'], skipped: [] });
  assert.deepEqual(bundle.current!.baseline, { camera: false, images: true, screen: true, listen: true, face: true });
  assert.deepEqual(notOpenedNotice(outcome), { title: '她出来了', detail: '这几样没打开：摄像头（姿势识别）。可能缺少本机组件，或者还没设置好；可以在设置的「输入与共享」和「隐私」里看看。' });
  assert.equal(notOpenedNotice({ alreadyOn: [], opened: ['screen'], notOpened: [], skipped: [] }), null);
  assert.ok(s.ticker, 'watching, to keep them on while she is out');
});

test('apply: the face check is not turned on without its components (that would start a download)', async () => {
  const s = new FakeSwitches();
  s.face = { supported: true, installed: false, enrolled: 0 };
  const outcome = await new PermissionBundle(s.ports()).apply();
  assert.ok(!s.calls.includes('face:on'));
  assert.deepEqual(outcome.skipped, ['face']);
});

test('I-159 A: while she is out every item stays on: anything switched off (by hand, a voice turn ending) is turned on again, items that were on before entering included', async () => {
  const s = new FakeSwitches({ screen: true });
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0;
  s.hand('camera', false); s.hand('microphone', false); s.hand('screen', false); s.ticker!();
  await settle();
  assert.deepEqual([...s.calls].sort(), ['camera:on', 'microphone:on', 'screen:on'], 'all three came back, the screen too (it was on before she went out)');
  assert.deepEqual(s.facts, { camera: true, images: true, microphone: true, screen: true, listen: true, face: true });
  s.calls.length = 0; s.ticker!(); await settle();
  assert.deepEqual(s.calls, [], 'nothing off: nothing touched');
});

test('I-159 A: the face check is not turned on again without its components (no download from here)', async () => {
  const s = new FakeSwitches();
  s.face = { supported: true, installed: false, enrolled: 0 };
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0; s.ticker!(); await settle();
  assert.deepEqual(s.calls, []);
});

test('I-159 A: an item that cannot be turned on is tried a few times, then left alone for the stay (no loop); seen on again it is kept again', async () => {
  const s = new FakeSwitches();
  s.refuse.add('microphone');
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0;
  for (let i = 0; i < 8; i++) { s.ticker!(); await settle(); }
  assert.equal(s.calls.filter(c => c === 'microphone:on').length, REOPEN_TRIES);
  s.refuse.delete('microphone'); s.hand('microphone', true); s.ticker!(); s.hand('microphone', false); s.calls.length = 0; s.ticker!(); await settle();
  assert.deepEqual(s.calls, ['microphone:on'], 'seen on once: the count starts over');
});

test('the way back (I-159 A): the bundle\'s items go back off, items that were on before stay on, nothing is turned on again after it', async () => {
  const s = new FakeSwitches({ screen: true });
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0;
  await bundle.restore('exit');
  assert.deepEqual(s.calls, ['camera:off', 'images:off', 'microphone:off', 'listen:off', 'face:off'], 'the screen was on before she went out: stays on');
  assert.equal(s.facts.screen, true);
  assert.equal(s.saved.at(-1), null, 'the session is gone');
  assert.equal(s.ticker, null, 'no more watching');
  assert.equal(bundle.active, false);
});

test('the way back waits for a reply being written (turning screen sharing off would end it), but not forever', async () => {
  const s = new FakeSwitches();
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.reply = true; s.calls.length = 0;
  await bundle.restore('exit');
  assert.equal(s.waits, 3, 'waited until the reply was done');
  assert.ok(s.calls.includes('screen:off'));
  const stuck = new FakeSwitches();
  const ports = stuck.ports();
  const never = new PermissionBundle({ ...ports, replyRunning: () => true, wait: async () => { stuck.waits++; } });
  await never.apply();
  await never.restore('exit');
  assert.equal(stuck.waits, 240, 'one minute at most');
  assert.ok(stuck.calls.includes('screen:off'));
});

test('quitting while out: only the face check goes back now; the session stays for the next start to check', async () => {
  const s = new FakeSwitches();
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0;
  await bundle.restore('quit');
  assert.deepEqual(s.calls, ['face:off'], 'camera, microphone, screen and sound end with the run anyway');
  assert.deepEqual(s.saved.at(-1)?.attempted, ['face']);
});

test('the next start after the app died while she was out: what outlives a restart is put back, the user\'s own choice is not', async () => {
  const left: BundleSession = { signature: BUNDLE_SIGNATURE, attempted: ['camera', 'microphone', 'face'], baseline: { camera: true, microphone: true, face: true }, touched: [] };
  const s = new FakeSwitches({ face: true, microphone: true }); // the user already turned the microphone on in this new run
  await new PermissionBundle(s.ports(), left).recover();
  assert.deepEqual(s.calls, ['face:off'], 'only the face check; this run\'s microphone is the user\'s');
  assert.equal(s.saved.at(-1), null);
  const touched = new FakeSwitches({ face: true });
  await new PermissionBundle(touched.ports(), { ...left, touched: ['face'] }).recover();
  assert.deepEqual(touched.calls, [], 'the user turned it on by hand while she was out: kept');
  // A switch that cannot be read yet: nothing decided, tried again before the next apply.
  const early = new FakeSwitches({ face: true });
  const ports = early.ports();
  let readable = false;
  const bundle = new PermissionBundle({ ...ports, read: () => { if (!readable) throw new Error('not ready'); return ports.read(); } }, left);
  await bundle.recover();
  assert.deepEqual(early.calls, []);
  readable = true;
  await bundle.apply();
  assert.deepEqual(early.calls.slice(0, 1), ['face:off'], 'the stale stay is put back first');
});

test('apply and the way back are serialized: going back while still turning on waits, then puts back', async () => {
  const s = new FakeSwitches();
  const bundle = new PermissionBundle(s.ports());
  const applying = bundle.apply();
  const back = bundle.restore('exit');
  await Promise.all([applying, back]);
  assert.deepEqual(Object.values(s.facts), [false, false, false, false, false, false]);
  assert.equal(bundle.active, false);
});

test('a saved session is read strictly', () => {
  const good = { signature: BUNDLE_SIGNATURE, attempted: ['camera'], baseline: { camera: true }, touched: [] };
  assert.deepEqual(parseBundleSession(good), good);
  for (const bad of [null, [], { ...good, extra: 1 }, { ...good, attempted: ['keys'] }, { ...good, baseline: { camera: 'yes' } }, { ...good, baseline: { tts: true } }, { ...good, touched: 'face' }])
    assert.equal(parseBundleSession(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseUnboundEntryRecord({ version: 1, skipAsk: BUNDLE_SIGNATURE, session: good }), { version: 1, skipAsk: BUNDLE_SIGNATURE, session: good });
  assert.deepEqual(parseUnboundEntryRecord({ version: 2, skipAsk: 'x' }), { version: 1, skipAsk: null, session: null });
});

test('the profile file: one write at a time, the last state wins, a missing file is a fresh start', async () => {
  const files = new Map<string, string>();
  const store = new UnboundEntryStore('C:\\profile', { read: async file => { const text = files.get(file); if (text === undefined) throw new Error('ENOENT'); return text; },
    write: async (file, data) => { await tick(); files.set(file, data); } });
  assert.deepEqual(await store.ready, { version: 1, skipAsk: null, session: null });
  void store.setSkipAsk(BUNDLE_SIGNATURE);
  await store.setSession({ signature: BUNDLE_SIGNATURE, attempted: ['face'], baseline: { face: true }, touched: [] });
  const again = new UnboundEntryStore('C:\\profile', { read: async file => files.get(file)!, write: async () => {} });
  const record = await again.ready;
  assert.equal(record.skipAsk, BUNDLE_SIGNATURE);
  assert.deepEqual(record.session?.attempted, ['face']);
});

test('the shared switches go through the user\'s own handlers, as the pet window for its switches and the control window for the face check', async () => {
  const seen: string[] = [];
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send: () => {} } });
  const handler = (name: string): IpcHandler => (event, ...args) => { seen.push(`${name}@${event.sender.id}:${JSON.stringify(args)}`); return name === 'getRuntimeState' ? { cameraLocal: true, voiceInput: false } : name === 'getFaceCheck' ? { enabled: true } : { sources: { 'system-audio': { music: { intent: true } } } }; };
  const operations = new Map(['getRuntimeState', 'getAudioReadingView', 'getFaceCheck', 'setRuntimeState', 'setAudioReadingIntent', 'setFaceCheck'].map(name => [name, handler(name)]));
  const admitted: string[] = [];
  const switches = createPerceptionSwitches({ operations, controls: () => window(1), pet: () => window(2), admit: (_guard, run) => { admitted.push('admit'); return run(); } });
  const facts = bundleFactsFrom(switches.read() as never);
  assert.deepEqual(facts, { camera: true, images: false, microphone: false, screen: false, listen: true, face: true });
  seen.length = 0;
  for (const item of BUNDLE_ITEMS) { const { kind, purposes } = bundleSwitch(item, false); await switches.set(kind, false, purposes, () => {}); }
  assert.deepEqual(seen, [
    'setRuntimeState@2:[{"cameraLocal":false}]', 'setRuntimeState@2:[{"cameraImages":false}]', 'setRuntimeState@2:[{"voiceInput":false}]', 'setRuntimeState@2:[{"screenSharing":false}]',
    'setAudioReadingIntent@2:[{"source":"system-audio","purpose":"music","enabled":false}]', 'setAudioReadingIntent@2:[{"source":"system-audio","purpose":"movie","enabled":false}]',
    'setFaceCheck@1:[false]',
  ]);
  assert.equal(admitted.length, 7, 'every change through the host\'s mutation queue');
});

// ---- the entry ---------------------------------------------------------------------------------------------------------------

function entrySetup(options: { answer?: { confirmed: boolean; remember: boolean }; skip?: string | null } = {}) {
  const s = new FakeSwitches();
  const bundle = new PermissionBundle(s.ports());
  let state: UnboundState = 'normal', skip: string | null = options.skip ?? null;
  const log: string[] = [];
  let answer = options.answer ?? { confirmed: true, remember: false };
  let pending: ((value: { confirmed: boolean; remember: boolean }) => void) | null = null;
  let holdNext = false;
  const entry = new UnboundEntry({
    state: () => state, enter: () => { log.push('enter'); state = 'entering'; }, exit: () => { log.push('exit'); state = 'normal'; },
    ask: page => { log.push(`ask:${page.message}`); return holdNext ? new Promise(resolve => { pending = resolve; }) : Promise.resolve(answer); },
    skipAsk: () => skip, setSkipAsk: async value => { log.push(`remember:${value}`); skip = value; },
    bundle, read: () => ({ ...s.facts }), face: () => s.face, outcome: outcome => log.push(`outcome:${outcome.opened.length}`),
    failed: () => log.push('failed'),
  });
  return { s, bundle, entry, log, set state(value: UnboundState) { state = value; }, get state() { return state; },
    setAnswer: (value: typeof answer) => { answer = value; }, hold: () => { holdNext = true; }, release: (value: typeof answer) => { holdNext = false; pending?.(value); } };
}

test('entry: cancel on the page changes nothing at all', async () => {
  const t = entrySetup({ answer: { confirmed: false, remember: true } });
  assert.equal(await t.entry.toggle(), 'cancelled');
  assert.deepEqual(t.log, ['ask:让她出来，在你的电脑上生活'], 'no entering, nothing remembered');
  t.entry.modeChanged('unbound'); // even if something else took her out
  await settle();
  assert.deepEqual(t.s.calls, [], 'no sense turned on');
});

test('entry: confirm enters, the bundle turns on once she is out and goes back when she is back', async () => {
  const t = entrySetup();
  assert.equal(await t.entry.toggle(), 'entering');
  assert.deepEqual(t.log, ['ask:让她出来，在你的电脑上生活', 'enter']);
  t.entry.modeChanged('entering');
  await settle();
  assert.deepEqual(t.s.calls, [], 'nothing turns on before she is out');
  t.state = 'unbound'; t.entry.modeChanged('unbound');
  await settle();
  assert.deepEqual(t.s.calls, ['camera:on', 'images:on', 'microphone:on', 'screen:on', 'listen:on', 'face:on']);
  assert.ok(t.log.includes('outcome:6'));
  // Ctrl+Alt+U (or the tray, or the button) while she is out: straight back, no page.
  assert.equal(await t.entry.toggle(), 'back');
  t.entry.modeChanged('normal');
  await settle();
  assert.deepEqual(t.s.calls.slice(6), ['camera:off', 'images:off', 'microphone:off', 'screen:off', 'listen:off', 'face:off']);
  assert.equal(t.log.filter(line => line.startsWith('ask')).length, 1);
});

test('entry: 「以后直接进，不再问」 skips the page for this list only; a new list asks again', async () => {
  const t = entrySetup({ answer: { confirmed: true, remember: true } });
  await t.entry.toggle();
  assert.ok(t.log.includes(`remember:${BUNDLE_SIGNATURE}`));
  t.state = 'normal'; t.log.length = 0;
  await t.entry.toggle();
  assert.deepEqual(t.log, ['enter'], 'no page the second time');
  const older = entrySetup({ skip: 'unbound-bundle-0:camera' });
  await older.entry.toggle();
  assert.equal(older.log[0], 'ask:让她出来，在你的电脑上生活');
});

test('entry: the developer switch enters without the bundle; any return to normal still puts back a bundle that was on', async () => {
  const t = entrySetup();
  t.state = 'unbound'; t.entry.modeChanged('unbound'); // the developer panel's own switch
  await settle();
  assert.equal(t.s.calls.length, 0, 'no sense turned on');
  t.state = 'normal'; t.entry.modeChanged('normal');
  await t.entry.toggle(); t.state = 'unbound'; t.entry.modeChanged('unbound'); await settle();
  // Back by 显示/隐藏桌宠, a crash of her window or the developer switch: the mode is normal, the bundle goes back.
  t.state = 'normal'; t.entry.modeChanged('normal'); await settle();
  assert.equal(t.bundle.active, false);
  assert.ok(t.s.calls.includes('face:off'));
});

test('entry: a second press while the page is open does not open another; she can still be brought back', async () => {
  const t = entrySetup();
  t.hold();
  const first = t.entry.toggle();
  await tick();
  assert.equal(await t.entry.toggle(), 'busy');
  t.release({ confirmed: true, remember: false });
  assert.equal(await first, 'entering');
  assert.equal(await t.entry.toggle(), 'back', 'entering: the shortcut brings her back at once');
  t.entry.modeChanged('normal'); t.entry.modeChanged('unbound'); await settle();
  assert.deepEqual(t.s.calls, [], 'an entry that was called off does not turn senses on later');
});

test('entry: an entry that ends before she is out says so, turns nothing on; the user calling it off is not a failure', async () => {
  const t = entrySetup();
  await t.entry.toggle();
  t.entry.modeChanged('entering');
  t.state = 'normal'; t.entry.modeChanged('normal'); // the model did not load in time
  await settle();
  assert.deepEqual(t.log.slice(-1), ['failed']);
  assert.equal(t.s.calls.length, 0);
  const off = entrySetup();
  await off.entry.toggle();
  await off.entry.toggle(); // back while entering
  off.entry.modeChanged('normal');
  assert.ok(!off.log.includes('failed'));
});

test('the control window button follows the state, in Chinese and English', () => {
  setUiLanguage('zh-CN');
  assert.equal(unboundEntryLabel('normal').text, '让她出来');
  assert.equal(unboundEntryLabel('entering').text, '回到小窗', 'on her way out a press brings her back');
  assert.equal(unboundEntryLabel('unbound').text, '回到小窗');
  setUiLanguage('en');
  try {
    assert.equal(unboundEntryLabel('normal').text, 'Let her out');
    assert.equal(bundleDialog(OFF, READY_FACE, t).checkbox, 'Go straight in next time, do not ask again');
    for (const line of bundleDialog({ ...OFF, screen: true }, { supported: true, installed: false, enrolled: 0 }, t).detail.split('\n'))
      assert.ok(!/[一-鿿]/.test(line.replace('百炼', '')), `translated: ${line}`);
  } finally { setUiLanguage('zh-CN'); }
});

test('entry: quitting while out puts the face check back', async () => {
  const t = entrySetup();
  await t.entry.toggle(); t.state = 'unbound'; t.entry.modeChanged('unbound'); await settle();
  t.s.calls.length = 0;
  await t.entry.quit();
  assert.deepEqual(t.s.calls, ['face:off']);
});
