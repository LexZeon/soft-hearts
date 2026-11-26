// 2026-11-24. The panel's 「设为默认位置」 kept only
// a look inside the old saved sizes (0.327-0.771, the old 5-12.5 m); a pull or her own "走近" can put her nearer (as near as "only the face"), so the click
// silently kept nothing. Now: any place she can stand at by walking can be the default (its own range: DEFAULT_PLACE_RANGES), the click always answers
// (已设, or one plain line why), the buttons' in-flight flags are separate and time-limited, and the click writes a 'default-place' journal row.
// electron/unbound/place-keeper.ts keepHere, place-panel.ts, src/unbound/input-senses.ts; docs/claude/2026-11-24-default-place-near.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlaceKeeper, type PlaceHere } from '../electron/unbound/place-keeper';
import { panelPlace, type PanelPlaceRow } from '../electron/unbound/place-panel';
import { applyPlaceMark } from '../electron/unbound/place-marks';
import { UnboundPlaceStore, UNBOUND_DEFAULT_PLACE_FILE, UNBOUND_PLACE_FILE } from '../electron/unbound/place-store';
import { SharedPlaceBook } from '../electron/unbound/company/place-share';
import { DEFAULT_PLACE_RANGES, SAVED_PLACE_RANGES, parseSavedPlace, type DefaultPlaceLook, type SavedPlace } from '../shared/unbound/life/place-record';
import { parsePlaceBook, placeBookFile } from '../shared/unbound/company/place-book';
import { GO_SIZE, chestUpDepthM, nearestWalkSize } from '../shared/unbound/her-position';
import { depthForSize, placementOfLook, sizeAtDepth, type ScreenFrame } from '../shared/unbound/screen-terms';
import { followDepthRange } from '../shared/unbound/pull';
import { buildStageJournalEntry } from '../shared/stage/journal-entries';
import { createSourceChoices, DeviceSources } from '../shared/senses';
import { localCallDeviceStorage } from '../shared/voice';
import { installPetWindow, type FakeElement } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names

function screen(widthM: number, heightM: number, w: number, h: number): ScreenFrame {
  return { screen: { widthM, heightM, source: 'measured', detail: 'test' }, display: { x: 0, y: 0, width: w, height: h }, workArea: { x: 0, y: 0, width: w, height: h - 48 }, viewerDistanceM: 0.55 };
}
const FRAME = screen(0.345, 0.194, 1920, 1080), H = 1.6;
const NEAREST = nearestWalkSize(FRAME, H)!;
const CHEST = sizeAtDepth(FRAME, H, chestUpDepthM(FRAME, H)!)!;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const close = (a: number, b: number, tolerance: number, label: string) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);

/** A stand-in for a place file: what is kept, and every write. */
function fakeFile(initial: unknown = null) {
  const file = { value: initial, writes: [] as unknown[] };
  return { file, port: { load: async () => file.value, save: (v: unknown) => { file.value = v; file.writes.push(v); }, clear: () => { file.value = null; file.writes.push(null); } } };
}
/** `size` past the near walk limit is built by depth (placementOfLook would stop her at the glass, as a real pull does; a place nearer than the glass is what keepHere guards against anyway). */
function keeperAt(size: number | null, extra: { heightM?: number | null; out?: boolean; fixed?: unknown; last?: unknown } = {}) {
  const fixed = fakeFile(extra.fixed), last = fakeFile(extra.last);
  let here: PlaceHere | null = extra.out === false ? null : { frame: FRAME, at: size !== null && size > NEAREST ? { xM: 0.05, depthM: depthForSize(FRAME, H, size)! } : placementOfLook(FRAME, H, { across: 0.62, size: size ?? 0.5 })!, heightM: extra.heightM === undefined ? H : extra.heightM };
  const keeper = new PlaceKeeper(() => ({ fixed: fixed.port, last: last.port }), () => here);
  return { keeper, fixed, last, set: (value: PlaceHere | null) => { here = value; } };
}

// ---- keeping a near place ------------------------------------------------------------------------------------------------------

test('the reference numbers: the near walk limit is far past the old saved sizes (so the old range really could not keep a near place)', () => {
  assert.ok(NEAREST > SAVED_PLACE_RANGES.size[1] * 1.5, `nearest ${NEAREST}`);
  assert.ok(CHEST > SAVED_PLACE_RANGES.size[1], `chest-up ${CHEST}`);
  assert.ok(CHEST < NEAREST);
});

test('a chest-up and an only-the-face place are kept, written, and come back as the start (also after a restart)', async () => {
  for (const [name, size] of [['chest-up', CHEST], ['only the face', NEAREST]] as const) {
    const w = keeperAt(size);
    await w.keeper.load();
    assert.equal(w.keeper.keepHere(), 'kept', name);
    assert.equal(w.keeper.hasDefault, true);
    const record = w.fixed.file.value as { version: number; across: number; size: number };
    assert.equal(record.version, 2); close(record.size, size, 1e-9, `${name} kept as she looks`); close(record.across, 0.62, 1e-9, 'across');
    const start = w.keeper.startAt(FRAME, null, () => ({ across: 0.5, size: 0.5 }));
    assert.ok(start.look, 'a look'); close(start.look!.size, size, 1e-9, `${name} comes back as the start`);
    // After a restart the same file gives the same place (the file layer does not drop it).
    const again = new PlaceKeeper(() => ({ fixed: w.fixed.port, last: w.last.port }));
    await again.load();
    close(again.defaultLook!.size, size, 1e-9, `${name} after a restart`);
    // The last place (old range) holds her at its edge, not a dropped record.
    const lastRecord = w.last.file.value as { size: number };
    assert.ok(lastRecord.size <= SAVED_PLACE_RANGES.size[1] + 1e-12, 'the last place keeps its own range');
  }
});

test('a place past the nearest walk limit is refused with its reason and nothing is written; a place at the limit is kept', async () => {
  const past = keeperAt(NEAREST * 1.05);
  await past.keeper.load();
  assert.equal(past.keeper.keepHere(), 'out-of-reach');
  assert.equal(past.keeper.setHere(), false);
  assert.deepEqual(past.fixed.file.writes, [], 'nothing saved');
  assert.equal(past.keeper.hasDefault, false);
  const atLimit = keeperAt(NEAREST);
  assert.equal(atLimit.keeper.keepHere(), 'kept');
  const tooFar = keeperAt(DEFAULT_PLACE_RANGES.size[0] * 0.9);
  assert.equal(tooFar.keeper.keepHere(), 'out-of-reach');
});

test('the other reasons: not out, height not known yet, mid-walk; none of them writes', async () => {
  const away = keeperAt(0.5, { out: false });
  assert.equal(away.keeper.keepHere(), 'not-out');
  const noHeight = keeperAt(0.5, { heightM: null });
  assert.equal(noHeight.keeper.keepHere(), 'no-height');
  const walking = keeperAt(0.5);
  assert.equal(walking.keeper.keepHere(true), 'moving');
  const noPort = new PlaceKeeper(() => ({}), () => ({ frame: FRAME, at: placementOfLook(FRAME, H, { across: 0.5, size: 0.5 })!, heightM: H }));
  assert.equal(noPort.keepHere(), 'not-out', 'no default store: nothing can be set');
  for (const w of [away, noHeight, walking]) assert.deepEqual(w.fixed.file.writes, []);
});

test('across is kept inside 5-95% (a pull to the very edge is kept at the edge)', () => {
  const w = keeperAt(0.5);
  w.set({ frame: FRAME, at: placementOfLook(FRAME, H, { across: 0.99, size: 0.5 })!, heightM: H });
  assert.equal(w.keeper.keepHere(), 'kept');
  close((w.fixed.file.value as { across: number }).across, DEFAULT_PLACE_RANGES.across[1], 1e-12, 'across at the edge');
});

test('her own ⟪keep-place⟫ follows the same rule: a near place is kept, one past the limit is not', async () => {
  const ports = (w: ReturnType<typeof keeperAt>) => ({ out: () => true, setHere: () => w.keeper.setHere(), clear: () => w.keeper.clear() });
  const near = keeperAt(NEAREST * 0.98);
  assert.equal(applyPlaceMark(['keep-place'], 'user', ports(near))!.outcome, 'done');
  assert.equal(near.keeper.hasDefault, true);
  const past = keeperAt(NEAREST * 1.2);
  assert.equal(applyPlaceMark(['keep-place'], 'user', ports(past))!.outcome, 'refused');
  assert.equal(past.keeper.hasDefault, false);
});

// ---- the ranges that stay -----------------------------------------------------------------------------------------------------

test('the pull and last-place ranges did not move; the default place has its own', () => {
  assert.deepEqual([...SAVED_PLACE_RANGES.size], [0.327, 0.771]);
  assert.deepEqual([...SAVED_PLACE_RANGES.across], [0.05, 0.95]);
  assert.equal(DEFAULT_PLACE_RANGES.size[0], GO_SIZE[0]); assert.ok(DEFAULT_PLACE_RANGES.size[1] >= GO_SIZE[1] && DEFAULT_PLACE_RANGES.size[1] >= NEAREST, 'the default place may be anywhere her walks may go (the near end is the keeper checks, not the file)');
  assert.equal(parseSavedPlace({ version: 2, across: 0.5, size: 1.4 }), null, 'a plain saved place (last place, pull) still refuses a near size');
  assert.deepEqual(parseSavedPlace({ version: 2, across: 0.5, size: 1.4 }, DEFAULT_PLACE_RANGES.size), { version: 2, across: 0.5, size: 1.4 });
  close(sizeAtDepth(FRAME, H, followDepthRange(FRAME, H)[0])!, SAVED_PLACE_RANGES.size[1], 1e-9, 'pull near end');
});

test('the place files: the default place file keeps a near place; the last place file keeps its old range', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'default-place-near-'));
  try {
    const fixed = new UnboundPlaceStore(dir, {}, UNBOUND_DEFAULT_PLACE_FILE), last = new UnboundPlaceStore(dir, {}, UNBOUND_PLACE_FILE);
    const near: SavedPlace = { version: 2, across: 0.4, size: 1.3 };
    await fixed.save(near);
    assert.deepEqual(await fixed.load(), near);
    const book = placeBookFile(new Map([['gene', near]]));
    assert.deepEqual(Object.keys(book.places), ['gene'], 'a book keeps a near record');
    await fixed.save(book);
    assert.deepEqual(parsePlaceBook(await fixed.load()).places.get('gene'), near);
    // Through the shared book (the company's ports) and a keeper: a restart gives the near place back, and the last place is held to its range.
    const share = new SharedPlaceBook(fixed, () => 'gene');
    const keeper = new PlaceKeeper(() => ({ fixed: share.portFor(() => 'gene', true) }), () => null, () => 'gene');
    await keeper.load();
    close(keeper.defaultLook!.size, 1.3, 1e-12, 'near default place after a restart');
    await last.save({ version: 2, across: 0.4, size: 1.3 });
    const lastKeeper = new PlaceKeeper(() => ({ last: { load: () => last.load(), save: () => {} } }));
    await lastKeeper.load();
    const start = lastKeeper.startAt(FRAME, null, () => ({ across: 0.5, size: 0.5 }));
    close(start.look!.size, SAVED_PLACE_RANGES.size[1], 1e-12, 'a last place stays inside its own range');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- the panel's host side: always an answer, always a row --------------------------------------------------------------------

test('the panel click: kept or the reason, and one journal row for each outcome (closed words)', async () => {
  const rows: PanelPlaceRow[] = [];
  const cases: Array<[string, ReturnType<typeof keeperAt>, boolean, string, string | null]> = [
    ['kept', keeperAt(CHEST), false, 'done', null],
    ['out-of-reach', keeperAt(NEAREST * 1.3), false, 'out-of-reach', 'out-of-reach'],
    ['not-out', keeperAt(0.5, { out: false }), false, 'not-out', 'not-out'],
    ['no-height', keeperAt(0.5, { heightM: null }), false, 'no-height', 'no-height'],
    ['moving', keeperAt(0.5), true, 'moving', 'moving'],
  ];
  for (const [name, w, walking, outcome, refused] of cases) {
    const panel = panelPlace({ places: () => w.keeper, walking: () => walking, journal: row => rows.push(row) });
    const look = await panel.set(true);
    assert.equal(look.refused ?? null, refused, name);
    assert.equal(look.set, refused === null, `${name}: set only when kept`);
    assert.deepEqual(rows.at(-1), { type: 'default-place', action: 'keep', outcome }, name);
    // The row is one the journal accepts.
    assert.ok(buildStageJournalEntry('default-place', { ...rows.at(-1)! }, 'gene'), `${name}: the journal takes the row`);
  }
  const w = keeperAt(CHEST), panel = panelPlace({ places: () => w.keeper, journal: row => rows.push(row) });
  await panel.set(true);
  const cleared = await panel.set(false);
  assert.deepEqual(rows.at(-1), { type: 'default-place', action: 'clear', outcome: 'done' });
  assert.equal(cleared.set, false);
  const none = panelPlace({ places: () => null, journal: row => rows.push(row) });
  assert.equal((await none.set(true)).refused, 'not-out');
  assert.deepEqual(rows.at(-1), { type: 'default-place', action: 'keep', outcome: 'not-out' });
  assert.deepEqual(none.look(), { set: false, here: false });
  // A journal that throws never stops the click.
  const sturdy = panelPlace({ places: () => keeperAt(CHEST).keeper, journal: () => { throw new Error('disk'); } });
  assert.equal((await sturdy.set(true)).set, true);
});

// ---- the panel itself ---------------------------------------------------------------------------------------------------------

async function panelWorld(t: Parameters<typeof installPetWindow>[0], api: Record<string, unknown>) { // no-pet-ok: the existing helper's name
  const dom = installPetWindow(t); // no-pet-ok: the existing helper's name
  const { document } = dom;
  const root = document.createElement('section'); root.id = 'panel'; const button = document.createElement('button');
  document.body.append(button, root);
  const full = { senses: async () => ({ camera: true, microphone: true, screen: true, audio: true }), panel: async () => {},
    screenSourceMenu: async () => ({ choice: null, entries: [] }), chooseScreenSource: async () => ({ choice: null }), ...api };
  const storage = localCallDeviceStorage({ getItem: () => null, setItem() {} });
  const { SensesPanel } = await import('../src/unbound/input-senses');
  const choices = createSourceChoices(full as never, new DeviceSources({ enumerate: async () => [], storage, watch: () => () => {}, deviceChange: () => () => {} }));
  const panel = new SensesPanel(document as unknown as Document, root as unknown as HTMLElement, button as unknown as HTMLElement, full as never, choices);
  dom.beforeClose(() => panel.dispose());
  await panel.show(); await flush();
  return { root, panel };
}

test('the panel: a kept click says 已设 at once and a line; a refused click says why in Chinese, and nothing shows as set', async t => {
  let look: DefaultPlaceLook = { set: false, here: true };
  let answer: DefaultPlaceLook | null = null;
  const sent: boolean[] = [];
  const { root } = await panelWorld(t, { defaultPlace: async () => look, setDefaultPlace: async (on: boolean) => { sent.push(on); look = answer ?? { set: on, here: true }; return look; } });
  const row = () => root.querySelector('.senses-row[data-sense="place"]')!;
  answer = { set: false, here: true, refused: 'out-of-reach' };
  (row().querySelector('[data-action="set"]') as FakeElement).click(); await flush();
  assert.deepEqual(sent, [true]);
  assert.equal(row().dataset.set, 'false', 'nothing saved: not set');
  const why = root.querySelector('.place-line');
  assert.ok(why, 'a line says why'); assert.equal(why!.dataset.place, 'refused');
  assert.match(why!.textContent, /只有脸/); assert.match(why!.textContent, /记不了/);
  answer = { set: true, here: true };
  (row().querySelector('[data-action="set"]') as FakeElement).click(); await flush();
  assert.equal(row().dataset.set, 'true', '已设 at once');
  assert.equal(root.querySelector('.senses-row[data-sense="place"] .senses-state')?.textContent, '已设');
  assert.equal(root.querySelector('.place-line')?.dataset.place, 'kept');
  // Every reason has a line of its own.
  for (const reason of ['not-out', 'no-height', 'moving'] as const) {
    answer = { set: false, here: true, refused: reason };
    (row().querySelector('[data-action="set"]') as FakeElement).click(); await flush();
    assert.ok(root.querySelector('.place-line')?.textContent, reason);
  }
});

test('a company call that never answers does not freeze the place button; a place call that never answers is given up on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: boolean[] = [];
  let hang = false;
  const { root, panel } = await panelWorld(t, { defaultPlace: async () => ({ set: false, here: true }), setCompany: () => new Promise(() => {}),
    setDefaultPlace: (on: boolean) => { sent.push(on); return hang ? new Promise<never>(() => {}) : Promise.resolve({ set: on, here: true }); } });
  void (panel as unknown as { setCompany(id: string, on: boolean): Promise<void> }).setCompany('gene', true); // never settles
  await flush();
  (root.querySelector('.senses-row[data-sense="place"] [data-action="set"]') as FakeElement).click(); await flush();
  assert.deepEqual(sent, [true], 'the place click went out although a company call is hanging');
  assert.equal(root.querySelector('.senses-row[data-sense="place"]')?.dataset.set, 'true');
  // A place call that hangs: the second click is ignored while it waits, and the button works again after the limit.
  hang = true;
  (root.querySelector('.senses-row[data-sense="place"] [data-action="set"]') as FakeElement).click(); await flush();
  (root.querySelector('.senses-row[data-sense="place"] [data-action="set"]') as FakeElement).click(); await flush();
  assert.deepEqual(sent, [true, true], 'one call in flight at a time');
  const { PANEL_CALL_LIMIT_MS } = await import('../src/unbound/input-senses');
  t.mock.timers.tick(PANEL_CALL_LIMIT_MS + 1); await flush();
  assert.match(root.querySelector('.place-line')?.textContent ?? '', /再点一次/, 'the click that got no answer says so');
  hang = false;
  (root.querySelector('.senses-row[data-sense="place"] [data-action="set"]') as FakeElement).click(); await flush();
  assert.deepEqual(sent, [true, true, true], 'the button works again');
  assert.equal(root.querySelector('.place-line')?.dataset.place, 'kept');
});
