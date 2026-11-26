// 「发图片」 in Unbound's permission bundle. Through the real bundle (electron/unbound/permission-bundle.ts), the real shared
// switches (agent-channel/bridge.ts createPerceptionSwitches) and the real media switches (electron/senses/media-runtime.ts); only the
// windows and the other senses are fake. Plus fake switches for refusals, the page, the entry and a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_SIGNATURE, PERSISTENT_ITEMS, PermissionBundle, REOPEN_TRIES, bundleDialog, bundleFactsFrom, bundleSwitch, notOpenedNotice, openedNote,
  type BundleFacts, type BundleItem, type BundlePorts, type BundleSession,
} from '../electron/unbound/permission-bundle';
import { UnboundEntry } from '../electron/unbound/entry';
import { createPerceptionSwitches, type IpcHandler } from '../electron/safety/agent-channel/bridge';
import { MediaRuntime } from '../electron/senses/media-runtime';
import type { MediaOwner } from '../shared/foundation/runtime-state';
import type { UnboundState } from '../shared/unbound/scene';
import { setUiLanguage, t } from '../shared/foundation/ui-language';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const READY_FACE = { supported: true, installed: true, enrolled: 3 };

/**
 * The host as the bundle sees it: the companion window (id 2) and the control window (id 1), the real MediaRuntime behind
 * setRuntimeState / getRuntimeState, and a small stand-in for 和她一起听 and the face check.
 */
function realHost(options: { pose?: 'local' | 'blocked' } = {}) {
  const runtime = new MediaRuntime(undefined, { mode: () => options.pose ?? 'local', blocked: () => 'needs-component' as const });
  const audio = { music: false, movie: false };
  let face = false;
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send: () => {} } });
  const owner = (id: number): MediaOwner => id === 2 ? 'pet' : 'controls'; // no-pet-ok: MediaOwner's own name for the companion window
  const handlers: Record<string, IpcHandler> = {
    getRuntimeState: () => ({ ...runtime.state }),
    setRuntimeState: (event, patch) => runtime.update(patch, owner(event.sender.id)),
    getAudioReadingView: () => ({ sources: { 'system-audio': { music: { intent: audio.music }, movie: { intent: audio.movie } } } }),
    setAudioReadingIntent: (_event, value) => { const v = value as { purpose: 'music' | 'movie'; enabled: boolean }; audio[v.purpose] = v.enabled; },
    getFaceCheck: () => ({ enabled: face, phase: 'ready' }),
    setFaceCheck: (_event, value) => { face = value === true; },
  };
  // no-pet-ok: the shared switches' port name for the companion window
  const switches = createPerceptionSwitches({ operations: new Map(Object.entries(handlers)), controls: () => window(1), pet: () => window(2), admit: (_guard, run) => run() });
  const calls: string[] = [];
  let ticker: (() => void) | null = null;
  const saved: (BundleSession | null)[] = [];
  // The same ports electron/unbound/entry-wiring.ts gives the bundle.
  const ports: BundlePorts = {
    read: () => bundleFactsFrom(switches.read()),
    face: () => READY_FACE,
    set: async (item, on) => { calls.push(`${item}:${on ? 'on' : 'off'}`); const { kind, purposes } = bundleSwitch(item, on); await switches.set(kind, on, purposes, () => {}); },
    save: async session => { saved.push(session ? structuredClone(session) : null); },
    replyRunning: () => false,
    every: (_ms, run) => { ticker = run; return () => { ticker = null; }; },
    wait: async () => {},
  };
  return { runtime, switches, ports, calls, saved, tick: () => ticker?.(), get watching() { return !!ticker; } };
}

test('entry turns 「发图片」 on when it was off, through the user\'s own switch (the companion window owns the camera, as when she clicks)', async () => {
  const host = realHost();
  const bundle = new PermissionBundle(host.ports);
  const outcome = await bundle.apply();
  assert.ok(host.calls.includes('images:on'));
  assert.equal(host.runtime.state.cameraImages, true, 'the real 「发图片」 switch is on');
  assert.equal(host.runtime.state.cameraLocal, true, '「姿势识别」 too: two items, two switches');
  assert.equal(host.runtime.state.cameraOwner, 'pet', 'the camera it needs: the companion window, like the other items'); // no-pet-ok: MediaOwner value
  assert.ok(outcome.opened.includes('images'));
  assert.match(openedNote(outcome) ?? '', /摄像头（发图片）/, 'the line beside her names it');
});

test('entry leaves 「发图片」 alone when it was already on, and the way back keeps it on (it was the user\'s)', async () => {
  const host = realHost();
  host.runtime.update({ cameraImages: true }, 'controls');
  const bundle = new PermissionBundle(host.ports);
  const outcome = await bundle.apply();
  assert.ok(!host.calls.includes('images:on'), 'not switched again');
  assert.ok(outcome.alreadyOn.includes('images'));
  await bundle.restore('exit');
  assert.ok(!host.calls.includes('images:off'));
  assert.equal(host.runtime.state.cameraImages, true, 'on before she went out: still on');
});

test('「姿势识别」 on before entering does not count as 「发图片」: it is still turned on', async () => {
  const host = realHost();
  host.runtime.update({ cameraLocal: true }, 'controls');
  const bundle = new PermissionBundle(host.ports);
  const outcome = await bundle.apply();
  assert.deepEqual(outcome.alreadyOn, ['camera']);
  assert.ok(host.calls.includes('images:on'));
  assert.equal(host.runtime.state.cameraImages, true);
  await bundle.restore('exit');
  assert.equal(host.runtime.state.cameraImages, undefined, 'back: 发图片 off again');
  assert.equal(host.runtime.state.cameraLocal, true, 'the user\'s 姿势识别 stays');
});

test('kept on while she is out: 「发图片」 switched off (by hand or anything else) is turned on again', async () => {
  const host = realHost();
  const bundle = new PermissionBundle(host.ports);
  await bundle.apply();
  host.calls.length = 0;
  host.runtime.update({ cameraImages: false }, 'controls');
  assert.equal(host.runtime.state.cameraImages, undefined);
  host.tick(); await settle();
  assert.deepEqual(host.calls, ['images:on']);
  assert.equal(host.runtime.state.cameraImages, true);
  // The old single switch off (both camera switches): both come back.
  host.calls.length = 0;
  host.runtime.update({ cameraSharing: false }, 'controls');
  host.tick(); await settle();
  assert.deepEqual(host.calls.sort(), ['camera:on', 'images:on']);
  assert.equal(host.runtime.state.cameraImages, true);
  assert.equal(host.runtime.state.cameraLocal, true);
});

test('a "别看" is never undone: it holds the pictures without turning 「发图片」 off, so the bundle leaves it', async () => {
  const host = realHost();
  const bundle = new PermissionBundle(host.ports);
  await bundle.apply();
  assert.equal(host.runtime.holdCamera(true), true, 'the user said 别看');
  host.calls.length = 0;
  for (let i = 0; i < 3; i++) { host.tick(); await settle(); }
  assert.deepEqual(host.calls, [], 'nothing switched');
  assert.equal(host.runtime.state.cameraHeld, true, 'still held');
  assert.equal(host.runtime.cameraAttachment(), null, 'and no picture is handed out while held');
});

test('the way back puts 「发图片」 back off (its frames go with it), and nothing turns it on again afterwards', async () => {
  const host = realHost();
  const bundle = new PermissionBundle(host.ports);
  await bundle.apply();
  host.runtime.publishCamera('pet', 'data:image/jpeg;base64,AAAA'); // no-pet-ok: MediaOwner value
  assert.ok(host.runtime.cameraAttachment(), 'a small picture is ready while she is out');
  await bundle.restore('exit');
  assert.ok(host.calls.includes('images:off'));
  assert.equal(host.runtime.state.cameraImages, undefined);
  assert.equal(host.runtime.state.cameraSharing, false, 'the camera is off: nothing was on before she went out');
  assert.equal(host.runtime.cameraAttachment(), null, 'no picture left');
  assert.equal(host.watching, false);
  host.calls.length = 0;
  host.tick(); await settle();
  assert.deepEqual(host.calls, []);
});

test('a refused 「姿势识别」 (missing component) neither stops nor stands in for 「发图片」', async () => {
  const host = realHost({ pose: 'blocked' });
  const outcome = await new PermissionBundle(host.ports).apply();
  assert.deepEqual(outcome.notOpened, ['camera']);
  assert.ok(outcome.opened.includes('images'));
  assert.equal(host.runtime.state.cameraLocal, undefined);
  assert.equal(host.runtime.state.cameraImages, true);
});

// ---- fake switches: refusals, crash, the entry ------------------------------------------------------------------------------

const OFF: BundleFacts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false };
class FakeSwitches {
  facts: BundleFacts;
  calls: string[] = [];
  refuse = new Set<BundleItem>();
  ticker: (() => void) | null = null;
  constructor(initial: Partial<BundleFacts> = {}) { this.facts = { ...OFF, ...initial }; }
  ports(): BundlePorts {
    return {
      read: () => ({ ...this.facts }), face: () => READY_FACE,
      set: async (item, on) => { this.calls.push(`${item}:${on ? 'on' : 'off'}`); await tick(); if (!(on && this.refuse.has(item))) this.facts[item] = on; },
      save: async () => {}, replyRunning: () => false,
      every: (_ms, run) => { this.ticker = run; return () => { this.ticker = null; }; }, wait: async () => {},
    };
  }
}

test('a refused 「发图片」 behaves like the other refusals: told, tried a few times, then left for the stay; seen on again it is kept again', async () => {
  const s = new FakeSwitches();
  s.refuse.add('images');
  const bundle = new PermissionBundle(s.ports());
  const outcome = await bundle.apply();
  assert.deepEqual(outcome.notOpened, ['images']);
  assert.match(notOpenedNotice(outcome)?.detail ?? '', /这几样没打开：摄像头（发图片）。/);
  s.calls.length = 0;
  for (let i = 0; i < 8; i++) { s.ticker!(); await settle(); }
  assert.equal(s.calls.filter(c => c === 'images:on').length, REOPEN_TRIES, 'no loop');
  s.refuse.delete('images'); s.facts.images = true; s.ticker!(); s.facts.images = false; s.calls.length = 0; s.ticker!(); await settle();
  assert.deepEqual(s.calls, ['images:on']);
});

test('「发图片」 does not outlive a restart (its own switch starts off with every run): quitting and the next start leave it to the run', async () => {
  assert.ok(!PERSISTENT_ITEMS.includes('images'));
  const s = new FakeSwitches();
  const bundle = new PermissionBundle(s.ports());
  await bundle.apply();
  s.calls.length = 0;
  await bundle.restore('quit');
  assert.deepEqual(s.calls, ['face:off'], 'the camera ends with the run anyway');
  const left: BundleSession = { signature: BUNDLE_SIGNATURE, attempted: ['images', 'face'], baseline: { images: true, face: true }, touched: [] };
  const next = new FakeSwitches({ images: true, face: true }); // the user turned 发图片 on in the new run
  await new PermissionBundle(next.ports(), left).recover();
  assert.deepEqual(next.calls, ['face:off'], 'this run\'s 发图片 is the user\'s');
});

test('the page lists 「发图片」 with what she uses it for, in Chinese and English, and marks it when already on', () => {
  const line = (detail: string) => detail.split('\n').find(text => text.includes('发图片')) ?? '';
  const zh = line(bundleDialog(OFF, READY_FACE).detail);
  assert.match(zh, /^· 摄像头（发图片）：/);
  for (const words of ['通过摄像头看到你', '发给 Claude', '只在她出来时开着', '回到小窗就恢复']) assert.ok(zh.includes(words), `${words}: ${zh}`);
  assert.match(line(bundleDialog({ ...OFF, images: true }, READY_FACE).detail), /（已经开着）$/);
  assert.doesNotMatch(bundleDialog(OFF, READY_FACE).detail, /不会因为这里打开[^\n]*发图片/, 'no longer listed as untouched');
  setUiLanguage('en');
  try {
    const en = bundleDialog(OFF, READY_FACE, t).detail.split('\n').find(text => text.startsWith('· Camera (send pictures)')) ?? '';
    assert.match(en, /see you through the camera/);
    assert.match(en, /sent to Claude/);
    assert.match(en, /only while she is out/i);
    assert.match(en, /returns to how it was/);
    assert.equal(t('摄像头（发图片）'), 'Camera (send pictures)');
  } finally { setUiLanguage('zh-CN'); }
});

test('the list changed: a 「以后直接进，不再问」 saved for the old list shows the page again', async () => {
  assert.notEqual(BUNDLE_SIGNATURE, 'unbound-bundle-1:camera-pose,microphone,screen,listen-music,face-check');
  assert.match(BUNDLE_SIGNATURE, /camera-images/);
  const s = new FakeSwitches();
  const asked: string[] = [];
  let state: UnboundState = 'normal';
  const entry = new UnboundEntry({
    state: () => state, enter: () => { state = 'entering'; }, exit: () => { state = 'normal'; },
    ask: async page => { asked.push(page.detail); return { confirmed: true, remember: false }; },
    skipAsk: () => 'unbound-bundle-1:camera-pose,microphone,screen,listen-music,face-check', setSkipAsk: async () => {},
    bundle: new PermissionBundle(s.ports()), read: () => ({ ...s.facts }), face: () => READY_FACE,
  });
  assert.equal(await entry.toggle(), 'entering');
  assert.equal(asked.length, 1, 'asked again');
  assert.match(asked[0], /摄像头（发图片）/);
  state = 'unbound'; entry.modeChanged('unbound'); await settle();
  assert.ok(s.calls.includes('images:on'), 'and once she is out it turns on');
});
