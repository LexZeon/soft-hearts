// 2026-11-25 night:
//  (1) the default place is saved through the real chain (panel button, her ⟪keep-place⟫ marker, the stores and the shared book on a real folder), read
//      back after a restart and a character switch, one journal row; a write that fails is told (not-saved), never a quiet 已设;
//  (2) a character with no default place and no last place comes out from about the waist up (the seen band 'waist-up') for her own height on
//      this screen; the extras in three on stage the same, standing clear of each other; a saved place still wins.
// electron/unbound/place-keeper.ts, place-panel.ts, her-place.ts, shared/unbound/her-position/first.ts; docs/claude/2026-11-25-default-place-near.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { UnboundPlaceStore, UNBOUND_DEFAULT_PLACE_FILE, UNBOUND_PLACE_FILE } from '../electron/unbound/place-store';
import { SharedPlaceBook } from '../electron/unbound/company/place-share';
import { PlaceKeeper } from '../electron/unbound/place-keeper';
import { HerPlace } from '../electron/unbound/her-place';
import { applyPlaceMark } from '../electron/unbound/place-marks';
import { panelPlace, type PanelPlaceRow } from '../electron/unbound/place-panel';
import { clearStartX, type StartBody } from '../shared/unbound/company/start-clear';
import { HER_POSITION_KNOBS, firstWaistUpSize, herPosition, herSeen, nearestWalkSize } from '../shared/unbound/her-position';
import { lookOfPlacement, placementOfLook, SCREEN_TERMS_KNOBS, type ScreenFrame } from '../shared/unbound/screen-terms';
import { buildStageJournalEntry } from '../shared/stage/journal-entries';
import { placementAcross } from '../shared/unbound/world';
import { UNBOUND_REQUESTS, type UnboundScene } from '../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';

class FakeWindow implements UnboundWindowLike {
  readonly frame = {}; visible = false; destroyed = false; private gone: (() => void)[] = [];
  readonly webContents = { id: 51, mainFrame: this.frame, send: () => {}, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible && !this.destroyed; } showInactive() { this.visible = true; } hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {} setBounds() {} onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: this.frame }; }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\her.pmx', url: 'mmd-asset://t/her.pmx', name: 'her.pmx' } };
const LAPTOP = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const MONITOR = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, scaleFactor: 1, internal: false };
const wrap = (store: UnboundPlaceStore) => ({ load: () => store.load(), save: (p: Parameters<UnboundPlaceStore['save']>[0]) => store.save(p), clear: () => store.clear() });

/** One host on a real folder, the way the app builds it (shared books over the real stores, the card id from the company port). */
function world(dir: string, options: { id?: () => string; display?: typeof LAPTOP; failWrites?: boolean } = {}) {
  const id = options.id ?? (() => 'card-a');
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>(), windows: FakeWindow[] = [];
  const small = { visible: true, isDestroyed: () => false, isVisible() { return true; }, isMinimized: () => false, getBounds: () => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds() {}, hide() {}, show() {}, showInactive() {} };
  const deps = options.failWrites ? { write: async () => { throw new Error('EPERM'); } } : {};
  const lastBook = new SharedPlaceBook(wrap(new UnboundPlaceStore(dir, deps)), id), fixedBook = new SharedPlaceBook(wrap(new UnboundPlaceStore(dir, deps, UNBOUND_DEFAULT_PLACE_FILE)), id);
  const host = new UnboundHost({
    ipcMain: { handle: (channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, listener); }, removeHandler: (channel: string) => { handlers.delete(channel); } },
    // no-pet-ok: UnboundHostPorts names (her small window)
    pet: () => small as never, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => false,
    display: () => options.display ?? LAPTOP, measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {}, savedPlace: lastBook.portFor(id, true), defaultPlace: fixedBook.portFor(id, true),
    company: { current: id, present: () => {}, look: async () => null, set: async () => null },
  } as never);
  const enter = async (modelHeightM = 1.6) => {
    const before = windows.length; host.enter();
    for (let i = 0; i < 200 && windows.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10)); // the keeper reads the real files first
    await flush();
    const win = windows.at(-1)!;
    await handlers.get(UNBOUND_REQUESTS.ready)!(win.event(), { ok: true, modelHeightM }); await flush();
    assert.equal(host.state, 'unbound');
    const scene = () => (handlers.get(UNBOUND_REQUESTS.getScene)!(win.event()) as UnboundScene).world.placement;
    return { win, scene, frame: (host as unknown as { world: ScreenFrame }).world };
  };
  const pullTo = async (win: FakeWindow, xM: number, depthM: number) => { await handlers.get(UNBOUND_REQUESTS.pull)!(win.event(), { phase: 'report', report: { ended: 'released', steps: 4 }, place: { xM, depthM } }); await flush(); };
  const leave = async () => { host.exit(); await flush(); };
  const rows: PanelPlaceRow[] = [];
  const panel = panelPlace({ places: () => host.places, walking: () => host.life?.view().running?.action === 'place', journal: row => rows.push(row) });
  return { host, enter, pullTo, leave, panel, rows };
}
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'dp-near-'));
const read = async (dir: string, file: string) => JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { version: number; places: Record<string, { across: number; size: number }> };

// ---- (1) the default place is saved ---------------------------------------------------------------------------------------------

test('the panel button: the place is on the disk before 已设 is said, one journal row, and it comes back after a restart', async () => {
  const dir = await tmp();
  try {
    const w = world(dir), out = await w.enter();
    await w.pullTo(out.win, 0.3, 4); // near, past the old saved sizes
    const look = await w.panel.set(true);
    assert.equal(look.refused ?? null, null); assert.equal(look.set, true);
    const book = await read(dir, UNBOUND_DEFAULT_PLACE_FILE); // no waiting: the answer came after the write
    const kept = book.places['card-a']!;
    assert.ok(kept && kept.size > 0.77, `a near place was kept: ${JSON.stringify(kept)}`);
    assert.deepEqual(w.rows, [{ type: 'default-place', action: 'keep', outcome: 'done' }]);
    assert.ok(buildStageJournalEntry('default-place', { ...w.rows[0]! }, 'card-a'));
    await w.leave(); w.host.quit();
    // A restart: new host, same folder.
    const again = world(dir), back = await again.enter();
    const spot = lookOfPlacement(back.frame, 1.6, back.scene())!;
    assert.ok(Math.abs(spot.size - kept.size) < 1e-6 && Math.abs(spot.across - kept.across) < 1e-6, `the same place after a restart: ${JSON.stringify(spot)} vs ${JSON.stringify(kept)}`);
    again.host.quit();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('her ⟪keep-place⟫ marker saves the same way; another character has her own place and the first one keeps hers', async () => {
  const dir = await tmp();
  try {
    let current = 'card-a';
    const w = world(dir, { id: () => current }), out = await w.enter();
    await w.pullTo(out.win, -0.4, 5);
    const row = applyPlaceMark(['keep-place'], 'user', { out: () => w.host.state === 'unbound', setHere: () => w.host.places.setHere(), clear: () => w.host.places.clear() });
    assert.equal(row?.outcome, 'done');
    assert.equal(await w.host.places.persisted(), true);
    const a = (await read(dir, UNBOUND_DEFAULT_PLACE_FILE)).places['card-a']!;
    assert.ok(a, 'on the disk');
    // The user switches the character: hers is not A's; A's stays on the disk.
    current = 'card-b';
    assert.equal(w.host.places.hasDefault, false, 'B has none of her own');
    await w.pullTo(out.win, 0.4, 6);
    assert.equal(w.host.places.setHere(), true); assert.equal(await w.host.places.persisted(), true);
    const both = (await read(dir, UNBOUND_DEFAULT_PLACE_FILE)).places;
    assert.deepEqual(Object.keys(both).sort(), ['card-a', 'card-b']);
    assert.deepEqual(both['card-a'], a, 'A is untouched');
    current = 'card-a';
    assert.equal(w.host.places.hasDefault, true); assert.ok(Math.abs(w.host.places.defaultLook!.size - a.size) < 1e-9);
    w.host.quit();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a write that fails is told: not-saved in the answer and in the journal row, never a quiet 已设', async () => {
  const dir = await tmp();
  try {
    const w = world(dir, { failWrites: true }), out = await w.enter();
    await w.pullTo(out.win, 0.3, 4);
    const look = await w.panel.set(true);
    assert.equal(look.refused, 'not-saved');
    assert.deepEqual(w.rows.at(-1), { type: 'default-place', action: 'keep', outcome: 'not-saved' });
    assert.ok(buildStageJournalEntry('default-place', { ...w.rows.at(-1)! }, 'card-a'), 'the journal takes the word');
    w.host.quit();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the place book refuses (and says so) a record the file may not hold, instead of dropping it and resolving', async () => {
  const dir = await tmp();
  try {
    const store = new UnboundPlaceStore(dir, {}, UNBOUND_DEFAULT_PLACE_FILE);
    await assert.rejects(store.save({ version: 2, places: { 'card a!': { version: 2, across: 0.5, size: 1 } } } as never));
    await assert.rejects(store.save({ version: 2, across: 0.5, size: 99 }));
    await store.save({ version: 2, places: { 'card-a': { version: 2, across: 0.5, size: 1 } } } as never);
    assert.equal((await read(dir, UNBOUND_DEFAULT_PLACE_FILE)).places['card-a']!.size, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- (2) the first appearance: from the waist up ----------------------------------------------------------------------------------

const SCREENS: Record<string, typeof LAPTOP> = { laptop: LAPTOP, monitor: MONITOR };
const HEIGHTS = [1.1, 1.6, 1.95];

test('no default place and no last place: she comes out from the waist up, for any height and screen (the near-far table agrees)', async () => {
  for (const [name, display] of Object.entries(SCREENS)) for (const heightM of HEIGHTS) {
    const dir = await tmp();
    try {
      const w = world(dir, { display }), out = await w.enter(heightM);
      const at = out.scene(), look = lookOfPlacement(out.frame, heightM, at)!;
      const seen = herSeen(out.frame, { heightM }, at.depthM);
      assert.equal(seen?.seen, 'waist-up', `${name} ${heightM} m: ${JSON.stringify(look)} sees ${seen?.seen}`);
      assert.ok(look.size > 1, `${name} ${heightM} m: fairly near (size ${look.size.toFixed(2)}), not the old half-height`);
      assert.ok(Math.abs(look.across - 0.78) < 1e-6, 'across as before');
      // Her per-turn position line is consistent: she is near, never "far".
      assert.equal(herPosition(look)?.range, 'very-near');
      w.host.quit();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('the size is worked out with her own height: a short and a tall model get different sizes that show the same part of her', () => {
  const frame = { screen: { widthM: 0.345, heightM: 0.194, source: 'measured' as const, detail: 'test' }, display: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, viewerDistanceM: 0.55 };
  const sizes = HEIGHTS.map(h => firstWaistUpSize(frame, h)!);
  for (const [i, h] of HEIGHTS.entries()) {
    assert.ok(sizes[i]! > 1 && sizes[i]! <= nearestWalkSize(frame, h)!, `${h}: ${sizes[i]}`);
    const depth = placementOfLook(frame, h, { across: 0.78, size: sizes[i]! })!.depthM;
    assert.equal(herSeen(frame, { heightM: h }, depth)?.seen, 'waist-up');
  }
  assert.equal(firstWaistUpSize(null, 1.6), null); assert.equal(firstWaistUpSize(frame, null), null);
  // The knob moves it inside the band, never out of it.
  for (const position of [0, 1]) {
    const size = firstWaistUpSize(frame, 1.6, { ...HER_POSITION_KNOBS, firstBandPosition: position })!;
    assert.equal(herSeen(frame, { heightM: 1.6 }, placementOfLook(frame, 1.6, { across: 0.5, size })!.depthM)?.seen, 'waist-up', `band position ${position}`);
  }
});


test('a last place wins over the first appearance, and a default place wins over the last place', async () => {
  const dir = await tmp();
  try {
    const first = world(dir), out = await first.enter();
    await first.pullTo(out.win, 0.2, 9);
    assert.equal(await first.host.places.persisted(), true);
    const lastBook = await read(dir, UNBOUND_PLACE_FILE);
    await first.leave(); first.host.quit();
    const second = world(dir), back = await second.enter(), look = lookOfPlacement(back.frame, 1.6, back.scene())!;
    assert.ok(Math.abs(look.size - lastBook.places['card-a']!.size) < 1e-6 && look.size < 1, `the last place (not the near first appearance): ${JSON.stringify(look)}`);
    await second.pullTo(back.win, -0.3, 2);
    assert.equal((await second.panel.set(true)).set, true);
    await second.pullTo(back.win, 0.5, 9); // she is moved on; her last place changes, the default does not
    await second.leave(); second.host.quit();
    const third = world(dir), again = await third.enter(), now = lookOfPlacement(again.frame, 1.6, again.scene())!;
    const fixed = (await read(dir, UNBOUND_DEFAULT_PLACE_FILE)).places['card-a']!;
    assert.ok(Math.abs(now.size - fixed.size) < 1e-6 && now.size > 1, `the default place: ${JSON.stringify(now)}`);
    third.host.quit();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the old fixed first size is only the fallback when the framing cannot be worked out', () => {
  const keeper = new PlaceKeeper(() => ({}), () => null);
  const her = new HerPlace(keeper, () => null);
  assert.equal(her.firstLook(null).size, SCREEN_TERMS_KNOBS.firstSize);
});

test('three on stage: each comes out from the waist up and they stand clear of each other (faces do not overlap), inside the screen', () => {
  for (const display of Object.values(SCREENS)) for (const heightM of [1.1, 1.6, 1.95]) {
    const frame = { screen: { widthM: display === LAPTOP ? 0.345 : 0.598, heightM: display === LAPTOP ? 0.194 : 0.336, source: 'measured' as const, detail: 'test' }, display: display.bounds, workArea: display.workArea, viewerDistanceM: 0.55 };
    const bodies = new Map<string, StartBody>();
    const standing: Array<{ xM: number; depthM: number }> = [], seenAll: string[] = [];
    for (const [i, key] of ['main', 'x', 'y'].entries()) {
      const her = new HerPlace(new PlaceKeeper(() => ({}), () => null, () => key), () => frame as never);
      her.heightM = heightM;
      her.clearStart = (at, f) => clearStartX(bodies.values(), at, { minX: placementAcross(f, 0.07, at.depthM).xM, maxX: placementAcross(f, 0.93, at.depthM).xM });
      const at = her.place(frame, true);
      bodies.set(key, { xM: at.xM, depthM: at.depthM, radiusM: 0.25 });
      standing.push(at);
      const seen = herSeen(frame, { heightM }, at.depthM)?.seen;
      seenAll.push(seen!);
      assert.ok(i === 0 ? seen === "waist-up" : ["waist-up", "knees-up", "whole"].includes(seen!), `${key} #${i} sees ${seen}`);
    }
    assert.ok(seenAll.filter(s => s === "waist-up").length >= (heightM >= 1.6 ? 3 : 2), `${heightM} m: ${seenAll.join(",")}`); // a narrow screen near the glass may send the third one a row back, never on top of someone
    for (let i = 0; i < standing.length; i++) for (let j = i + 1; j < standing.length; j++) {
      const gap = Math.hypot(standing[i]!.xM - standing[j]!.xM, standing[i]!.depthM - standing[j]!.depthM);
      assert.ok(gap >= 0.65 - 1e-9, `${heightM} m: two of them ${gap.toFixed(2)} m apart (faces overlap below 0.65)`);
    }
    for (const at of standing) {
      const across = lookOfPlacement(frame, heightM, at)!.across;
      assert.ok(across >= 0.06 && across <= 0.94, `inside the screen: ${across}`);
    }
  }
});
