// 2026-11-23: a default place the user sets,
// apart from where she last stood. electron/unbound/place-keeper.ts, place-store.ts (unbound-default-place.json), the full-screen
// panel's 「设为默认位置」 (src/unbound/input-senses.ts) and the internal channel's set_setting unbound_default_place.
// docs/claude/2026-11-23-unbound-default-place.md. I-212 (2026-11-24): places are kept in screen terms (across, size); an old file (metres) is used
// as it is on the first entry and converted once, with the screen and her height, when the page reports her height (docs/claude/2026-11-24-i212-screen-terms.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { UnboundPlaceStore, UNBOUND_DEFAULT_PLACE_FILE, UNBOUND_PLACE_FILE } from '../electron/unbound/place-store';
import { PlaceKeeper } from '../electron/unbound/place-keeper';
import { createUnboundInputApi, UNBOUND_INPUT_CHANNELS } from '../electron/unbound/input-preload-api';
import { UNBOUND_REQUESTS, type UnboundScene } from '../shared/unbound/scene';
import { parseSavedPlace, spotOfPlacement, type SavedPlace, type DefaultPlaceLook } from '../shared/unbound/life/place-record';
import { lookOfPlacement, sizeAtDepth, type ScreenFrame } from '../shared/unbound/screen-terms';
import { herSeen } from '../shared/unbound/her-position';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { Rect } from '../shared/unbound/world';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { createSourceChoices, DeviceSources } from '../shared/senses';
import { localCallDeviceStorage } from '../shared/voice';

class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  visible = false; destroyed = false;
  private gone: (() => void)[] = [];
  readonly webContents = { id: 51, mainFrame: this.frame, send: () => {}, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds() {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: this.frame }; }
}

/** An in-memory stand-in for a place file: what the host reads, and every write it makes. */
function fakeFile(initial: unknown) {
  const file = { value: initial, writes: [] as unknown[], clears: 0 };
  return { file, port: {
    load: async () => file.value,
    save: (place: SavedPlace) => { file.value = place; file.writes.push(place); },
    clear: () => { file.value = null; file.clears++; },
  } };
}

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\her.pmx', url: 'mmd-asset://t/her.pmx', name: 'her.pmx' } };

function world(options: { last?: unknown; fixed?: unknown } = {}) {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  const small = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, getBounds: (): Rect => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds: () => {}, hide() { this.visible = false; }, show() { this.visible = true; }, showInactive() { this.visible = true; } };
  const last = fakeFile(options.last ?? null), fixed = fakeFile(options.fixed ?? null);
  const host = new UnboundHost({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    // no-pet-ok: UnboundHostPorts names (her small window)
    pet: () => small as never, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => false,
    display: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true }),
    measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {}, savedPlace: last.port, defaultPlace: fixed.port,
  });
  const call = async (channel: string, win: FakeWindow, value?: unknown) => handlers.get(channel)!(win.event(), value);
  /** She comes out (the page says it is ready) and the scene she is placed by is read back. */
  const enter = async () => {
    host.enter(); await flush();
    const win = windows.at(-1)!;
    await call(UNBOUND_REQUESTS.ready, win, { ok: true, modelHeightM: 1.6 }); await flush();
    assert.equal(host.state, 'unbound');
    return { win, scene: () => (handlers.get(UNBOUND_REQUESTS.getScene)!(win.event()) as UnboundScene).world.placement };
  };
  const leave = async () => { host.exit(); await flush(); };
  /** The user lets go of a pull where she walked to (the host takes that spot as her place, as a walk of hers). */
  const pullTo = async (win: FakeWindow, xM: number, depthM: number) => { await call(UNBOUND_REQUESTS.pull, win, { phase: 'report', report: { ended: 'released', steps: 4 }, place: { xM, depthM } }); };
  return { host, last, fixed, windows, enter, leave, pullTo, call };
}
const across = (place: { xM: number; depthM: number }, w: ReturnType<typeof world>) => spotOfPlacementOf(w, place);
/** The host's screen (its world) and how a placement looks there for her height (1.6 m, the ready report's). */
const frameOf = (w: ReturnType<typeof world>) => (w.host as unknown as { world: ScreenFrame }).world;
const lookOf = (place: { xM: number; depthM: number }, w: ReturnType<typeof world>) => lookOfPlacement(frameOf(w), 1.6, place)!;
const sizeOf = (depthM: number, w: ReturnType<typeof world>) => sizeAtDepth(frameOf(w), 1.6, depthM)!;
const kept = (value: unknown) => value as Extract<SavedPlace, { version: 2 }>;
function spotOfPlacementOf(w: ReturnType<typeof world>, place: { xM: number; depthM: number }) {
  // The test screen is the host's own measured fallback; read it from the world the host built.
  const scene = (w.host as unknown as { world: { screen: never; viewerDistanceM: number } }).world;
  return spotOfPlacement(scene, place)!;
}

const DEFAULT_SPOT: SavedPlace = { version: 1, across: 0.6624746300969407, depthM: 7.244114355000679 };

test('no default set: she comes out where she last stood (today\'s behaviour), and the first appearance (from the waist up, 2026-11-25) when nothing is kept', async () => {
  const fresh = world();
  const first = await fresh.enter();
  const look = lookOf(first.scene(), fresh);
  assert.ok(Math.abs(look.across - 0.78) < 1e-9 && look.size > 1 && herSeen(frameOf(fresh), { heightM: 1.6 }, first.scene().depthM)?.seen === 'waist-up', `the first appearance: ${JSON.stringify(look)}`);
  fresh.host.quit();
  const kept = world({ last: { version: 1, across: 0.8, depthM: 9 } });
  const out = await kept.enter();
  const spot = across(out.scene(), kept);
  assert.ok(Math.abs(spot.across - 0.8) < 1e-6 && Math.abs(spot.depthM - 9) < 1e-6, 'the last place');
  assert.equal(kept.fixed.file.writes.length, 0, 'nothing is written to the default place');
  // I-212: the old record (metres) was converted once with this screen and her height, and written in the new form.
  const now = kept.last.file.value as SavedPlace;
  assert.equal(now.version, 2); assert.ok(now.version === 2 && Math.abs(now.size - sizeOf(9, kept)) < 1e-9 && now.across === 0.8);
  assert.equal(kept.last.file.writes.filter(v => (v as SavedPlace).version === 2).length, 1, 'converted once');
  kept.host.quit();
});

test('a default set: every entry starts there, whatever her wandering and pulls did since; her own moves never change it', async () => {
  const w = world({ last: { version: 1, across: 0.3, depthM: 6 }, fixed: DEFAULT_SPOT });
  const first = await w.enter();
  let spot = across(first.scene(), w);
  assert.ok(Math.abs(spot.across - DEFAULT_SPOT.across) < 1e-6 && Math.abs(spot.depthM - (DEFAULT_SPOT as { depthM: number }).depthM) < 1e-6, 'the default, not the last place');
  await w.pullTo(first.win, 0.9, 10); // she is pulled somewhere else
  assert.ok(Math.abs(across(first.scene(), w).depthM - 10) < 1e-6, 'for now she stands where she was pulled');
  assert.ok(Math.abs(kept(w.last.file.value).size - sizeOf(10, w)) < 1e-9, 'the pull is her last place (as she looked)');
  // I-212: the default (an old record) was converted once to the new form when her height came; her own moves never write it.
  const converted = kept(w.fixed.file.value);
  assert.ok(converted.version === 2 && converted.across === DEFAULT_SPOT.across && Math.abs(converted.size - sizeOf((DEFAULT_SPOT as { depthM: number }).depthM, w)) < 1e-9, 'the same place, kept as she looked');
  assert.equal(w.fixed.file.writes.length, 1, 'written once, by the conversion; never by her own moves');
  await w.leave();
  const again = await w.enter();
  spot = across(again.scene(), w);
  assert.ok(Math.abs(spot.across - DEFAULT_SPOT.across) < 1e-6 && Math.abs(spot.depthM - (DEFAULT_SPOT as { depthM: number }).depthM) < 1e-6, 'out again: the default, not where she was pulled');
  assert.equal(w.fixed.file.writes.length, 1);
  w.host.quit();
});

test('the screen changing or the viewing distance moving keeps where she is (only an entry goes to the default)', async () => {
  const w = world({ fixed: DEFAULT_SPOT });
  const out = await w.enter();
  await w.pullTo(out.win, -0.4, 9);
  const moved = out.scene();
  w.host.displayChanged();
  const after = out.scene();
  assert.ok(Math.abs(after.xM - moved.xM) < 1e-9 && Math.abs(after.depthM - moved.depthM) < 1e-9, 'a rebuild is not an entry');
  w.host.quit();
});

test('setting it: not out gives false; out saves where she stands now; the next entry uses it; clearing goes back to the last place', async () => {
  const w = world({ last: { version: 1, across: 0.3, depthM: 6 } });
  assert.deepEqual(w.host.places.look(), { set: false, here: false });
  assert.equal(w.host.places.setHere(), false, 'she is not out: nothing to keep');
  assert.equal(w.fixed.file.writes.length, 0);
  const out = await w.enter();
  await flush();
  assert.deepEqual(w.host.places.look(), { set: false, here: true });
  await w.pullTo(out.win, 0.5, 9);
  const standing = across(out.scene(), w);
  assert.equal(w.host.places.setHere(), true);
  assert.deepEqual(w.host.places.look(), { set: true, here: true });
  const set = kept(w.fixed.file.value), seen = lookOf(out.scene(), w);
  assert.ok(Math.abs(set.across - standing.across) < 1e-9 && Math.abs(set.size - seen.size) < 1e-9, 'where she stood when you clicked, as she looked');
  assert.deepEqual(Object.keys(set), ['version', 'across', 'size']);
  await w.pullTo(out.win, -0.5, 11);
  await w.leave();
  const again = await w.enter();
  const spot = across(again.scene(), w);
  assert.ok(Math.abs(spot.across - standing.across) < 1e-6 && Math.abs(spot.depthM - standing.depthM) < 1e-6, 'the next entry: the place you set');
  w.host.places.clear();
  assert.equal(w.fixed.file.clears, 1);
  assert.equal(w.host.places.look().set, false);
  await w.pullTo(again.win, 0.2, 10); // I-212: inside the kept sizes on this screen (12 m would be smaller than the far end here)
  await w.leave();
  const third = await w.enter();
  const last = across(third.scene(), w);
  assert.ok(Math.abs(last.depthM - 10) < 1e-6 && Math.abs(last.across - across({ xM: 0.2, depthM: 10 }, w).across) < 1e-6, 'cleared: she comes out where she last stood (the pull to 10 m)');
  w.host.quit();
  // After a restart too: coming out at the default place counted as standing there, so a later clear leaves her there, not at an older walk.
  const restarted = world({ last: w.last.file.value, fixed: null });
  const next = await restarted.enter();
  assert.ok(Math.abs(across(next.scene(), restarted).depthM - 10) < 1e-6);
  restarted.host.quit();
});

test('a default file that is wrong is ignored (out of range, wrong version, junk): the last place or the corner', async () => {
  for (const bad of [{ version: 1, across: 1.4, depthM: 8 }, { version: 1, across: 0.5, depthM: 40 }, { version: 2, across: 0.5, depthM: 8 }, { version: 2, across: 0.5, size: 99 }, { version: 3, across: 0.5, size: 0.5 }, 'junk', [], { version: 1, across: 'x', depthM: 8 }]) {
    const w = world({ last: { version: 1, across: 0.8, depthM: 9 }, fixed: bad });
    const out = await w.enter();
    const spot = across(out.scene(), w);
    assert.ok(Math.abs(spot.across - 0.8) < 1e-6, `ignored: ${JSON.stringify(bad)}`);
    assert.equal(w.host.places.look().set, false);
    w.host.quit();
  }
});

test('the keeper alone: look needs her out and a place to keep; load is once and tolerates a failing store', async () => {
  let reads = 0;
  const keeper = new PlaceKeeper(() => ({ fixed: { load: async () => { reads++; throw new Error('disk'); }, save: () => {}, clear: () => {} } }));
  await keeper.load(); await keeper.load();
  assert.equal(reads, 1);
  assert.equal(keeper.hasDefault, false);
  assert.deepEqual(keeper.look(), { set: false, here: false });
  const frame: ScreenFrame = { screen: { widthM: 0.34, heightM: 0.21, source: 'measured', detail: '' }, viewerDistanceM: 0.55, display: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 } };
  const none = new PlaceKeeper(() => ({}), () => ({ frame, at: { xM: 0, depthM: 8 }, heightM: 1.6 }));
  assert.equal(none.setHere(), false, 'no default store: nothing can be set');
});

// ---- the files ------------------------------------------------------------------------------------------------------------------

test('the default place has its own file next to unbound-place.json: two numbers and a version; invalid ones are ignored; clear removes it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unbound-default-place-'));
  try {
    assert.equal(UNBOUND_DEFAULT_PLACE_FILE, 'unbound-default-place.json');
    const last = new UnboundPlaceStore(dir), fixed = new UnboundPlaceStore(dir, {}, UNBOUND_DEFAULT_PLACE_FILE);
    assert.equal(await fixed.load(), null, 'nothing yet');
    await fixed.save(DEFAULT_SPOT);
    assert.deepEqual(await fixed.load(), DEFAULT_SPOT);
    assert.equal(await last.load(), null, 'the last place is another file');
    await last.save({ version: 1, across: 0.2, depthM: 6 });
    assert.deepEqual(await fixed.load(), DEFAULT_SPOT, 'her walks never touch the default');
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, UNBOUND_DEFAULT_PLACE_FILE), 'utf8'))), ['version', 'across', 'depthM']);
    await assert.rejects(fixed.save({ version: 1, across: 3, depthM: 8 })); // out of range: not kept, and the writer is told (2026-11-25)
    assert.deepEqual(await fixed.load(), DEFAULT_SPOT);
    await writeFile(path.join(dir, UNBOUND_DEFAULT_PLACE_FILE), '{ not json');
    assert.equal(await fixed.load(), null, 'an unreadable file is ignored');
    await fixed.save(DEFAULT_SPOT);
    await fixed.clear();
    assert.equal(await fixed.load(), null);
    await assert.rejects(access(path.join(dir, UNBOUND_DEFAULT_PLACE_FILE)));
    await fixed.clear(); // already gone: fine
    await fixed.save({ version: 2, across: 0.7, size: 0.55 }); // I-212: the new form, two numbers and a version too
    assert.deepEqual(await fixed.load(), { version: 2, across: 0.7, size: 0.55 });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(dir, UNBOUND_DEFAULT_PLACE_FILE), 'utf8'))), ['version', 'across', 'size']);
    await fixed.clear();
    await access(path.join(dir, UNBOUND_PLACE_FILE)); // the last place stays
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- the panel -------------------------------------------------------------------------------------------------------------

test('the API: two plain requests; the second takes only a boolean', async () => {
  const calls: unknown[][] = [];
  const api = createUnboundInputApi({ invoke: async (...args) => { calls.push(args); return { set: false, here: true }; }, on: () => {}, removeListener: () => {} });
  assert.deepEqual(await api.defaultPlace(), { set: false, here: true });
  assert.deepEqual(await api.setDefaultPlace(true), { set: false, here: true });
  await assert.rejects(api.setDefaultPlace('yes' as never), TypeError);
  assert.deepEqual(calls, [[UNBOUND_INPUT_CHANNELS.place], [UNBOUND_INPUT_CHANNELS.setPlace, true]]);
});

test('the full-screen panel: 「设为默认位置」 saves where she stands now; a second button clears it; nothing when the host cannot say', async t => {
  const dom = installPetWindow(t); // no-pet-ok: the existing helper's name
  const { document } = dom;
  const root = document.createElement('section'); root.id = 'panel'; const button = document.createElement('button');
  document.body.append(button, root);
  let look: DefaultPlaceLook = { set: false, here: true };
  const sent: boolean[] = [];
  const api = { senses: async () => ({ camera: true, microphone: true, screen: true, audio: true }), panel: async () => {},
    screenSourceMenu: async () => ({ choice: null, entries: [] }), chooseScreenSource: async () => ({ choice: null }),
    defaultPlace: async () => look,
    setDefaultPlace: async (on: boolean) => { sent.push(on); look = { set: on, here: true }; return look; } };
  const storage = localCallDeviceStorage({ getItem: () => null, setItem() {} });
  const { SensesPanel } = await import('../src/unbound/input-senses');
  const choices = () => createSourceChoices(api, new DeviceSources({ enumerate: async () => [], storage, watch: () => () => {}, deviceChange: () => () => {} }));
  const panel = new SensesPanel(document as unknown as Document, root as unknown as HTMLElement, button as unknown as HTMLElement, api, choices());
  dom.beforeClose(() => panel.dispose());
  await panel.show(); await flush();
  const row = root.querySelector('.senses-row[data-sense="place"]')!;
  assert.ok(row, 'the row is there');
  assert.equal(row.dataset.set, 'false');
  assert.equal(row.querySelector('[data-action="set"]')?.textContent, '设为默认位置');
  assert.equal(root.querySelector('[data-action="clear"]'), null, 'nothing to clear yet');
  (row.querySelector('[data-action="set"]') as FakeElement).click(); await flush();
  assert.deepEqual(sent, [true]);
  assert.equal(root.querySelector('.senses-row[data-sense="place"]')?.dataset.set, 'true');
  const clear = root.querySelector('[data-action="clear"]') as FakeElement;
  assert.ok(clear, 'a clear button once one is set');
  clear.click(); await flush();
  assert.deepEqual(sent, [true, false]);
  assert.equal(root.querySelector('.senses-row[data-sense="place"]')?.dataset.set, 'false');
  // A host that cannot say (older host, no answer): no row.
  const quiet = document.createElement('section'); quiet.id = 'panel2';
  const other = new SensesPanel(document as unknown as Document, quiet as unknown as HTMLElement, document.createElement('button') as unknown as HTMLElement, { ...api, defaultPlace: async () => null }, choices());
  dom.beforeClose(() => other.dispose());
  await other.show(); await flush();
  assert.equal(quiet.querySelector('.senses-row[data-sense="place"]'), null);
});

test('the saved record helper keeps only its numbers', () => {
  assert.deepEqual(parseSavedPlace({ ...DEFAULT_SPOT, title: 'x' }), DEFAULT_SPOT);
  assert.deepEqual(parseSavedPlace({ version: 2, across: 0.6, size: 0.5, doing: 'busy' }), { version: 2, across: 0.6, size: 0.5 }, 'I-212: the new form too');
});
