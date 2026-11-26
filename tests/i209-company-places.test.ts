// I-209 step 1: each character's own places (electron/unbound/place-keeper.ts, place-store.ts, shared/unbound/company/place-book.ts).
// The one-record files from before go to the character you talk with; every other character keeps her own last place and her own default;
// nothing of one character is ever read as another's; the file is the real store on disk (a book, version 2) and stays readable after a restart.
// I-212: records are kept in screen terms (version 2: across, size); an old record (version 1, metres) is read as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlaceKeeper } from '../electron/unbound/place-keeper';
import { UnboundPlaceStore, UNBOUND_DEFAULT_PLACE_FILE } from '../electron/unbound/place-store';
import { PLACE_BOOK_MAX, parsePlaceBook, placeBookFile } from '../shared/unbound/company/place-book';
import { spotOfPlacement, type SavedPlace } from '../shared/unbound/life/place-record';
import { sizeAtDepth, type ScreenFrame } from '../shared/unbound/screen-terms';
import type { PhysicalScreen } from '../shared/unbound/world';

const view: ScreenFrame = { screen: { widthM: 0.34, heightM: 0.2125, source: 'measured', detail: '' } as unknown as PhysicalScreen, viewerDistanceM: 0.55,
  display: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 } };
const H = 1.6;
const FIRST = { across: 0.78, size: 0.5 };
const across = (at: { xM: number; depthM: number }) => spotOfPlacement(view, at)!.across;

function keeperOn(dir: string, who: { id: string | null }, here: { at: { xM: number; depthM: number } | null } = { at: null }) {
  const last = new UnboundPlaceStore(dir), fixed = new UnboundPlaceStore(dir, {}, UNBOUND_DEFAULT_PLACE_FILE);
  // The keeper fires its writes and forgets them (as in the app); the test keeps them so settle() waits for the disk, not a timer.
  const track = (write: Promise<unknown>) => { pendingWrites.push(write.catch(() => {})); };
  const port = (store: UnboundPlaceStore) => ({ load: () => store.load(), save: (v: Parameters<UnboundPlaceStore['save']>[0]) => { track(store.save(v)); }, clear: () => { track(store.clear()); } });
  return new PlaceKeeper(() => ({ last: port(last), fixed: port(fixed) }), () => (here.at ? { frame: view, at: here.at, heightM: H } : null), () => who.id);
}
const pendingWrites: Promise<unknown>[] = [];
/** Every write the keepers started so far has reached the disk (a fixed 60 ms wait read the file too early on a loaded machine). */
const settle = async () => { while (pendingWrites.length) await Promise.all(pendingWrites.splice(0)); };

test('a file from before is the current character\'s; each character then keeps her own last place and default on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i209-places-'));
  try {
    await new UnboundPlaceStore(dir).save({ version: 1, across: 0.25, depthM: 7 }); // what an older version wrote
    const who = { id: 'gene' as string | null }, here = { at: null as { xM: number; depthM: number } | null };
    const keeper = keeperOn(dir, who, here);
    await keeper.load();
    const start = keeper.startAt(view, null, () => FIRST);
    assert.ok(start.placement && Math.abs(across(start.placement) - 0.25) < 1e-9, 'Gene comes out where she last stood (the old record is hers, in metres until her height is known)');
    assert.equal(keeper.startFor('vrm-a', view, H), null, 'A has nothing kept yet: the old record is not hers');
    keeper.walkedFor('vrm-a', view, { xM: 1.2, depthM: 9 }, H);
    await settle();
    const onDisk = JSON.parse(await readFile(path.join(dir, 'unbound-place.json'), 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.deepEqual(Object.keys(onDisk.places).sort(), ['gene', 'vrm-a']);
    assert.equal(onDisk.places.gene.across, 0.25, 'migrated, not lost');
    assert.deepEqual(Object.keys(onDisk.places['vrm-a']), ['version', 'across', 'size'], 'a new record is kept as she looked on the screen');
    // A default for Gene; then you talk with A: her default is not Gene's.
    here.at = { xM: -0.8, depthM: 6 };
    assert.equal(keeper.setHere(), true);
    assert.equal(keeper.hasDefault, true);
    who.id = 'vrm-a';
    assert.equal(keeper.hasDefault, false, 'A has no default of her own');
    const aStart = keeper.startAt(view, null, () => FIRST);
    assert.ok(aStart.look && Math.abs(aStart.look.size - sizeAtDepth(view, H, 9)!) < 1e-9, 'A comes out at her own last place (as she looked)');
    assert.ok(Math.abs(across(keeper.startFor('gene', view, H)!) - across({ xM: -0.8, depthM: 6 })) < 1e-9, 'Gene as an extra starts at her own default');
    keeper.clear(); // clears A's (none): Gene's stays
    who.id = 'gene';
    assert.equal(keeper.hasDefault, true);
    await settle();
    // After a restart: the same records.
    const again = keeperOn(dir, { id: 'gene' });
    await again.load();
    assert.equal(again.hasDefault, true);
    assert.ok(Math.abs(again.startFor('vrm-a', view, H)!.depthM - 9) < 1e-9);
    again.clear(); await settle();
    await assert.rejects(readFile(path.join(dir, UNBOUND_DEFAULT_PLACE_FILE), 'utf8'), 'the last default gone: the file goes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the book reads only valid ids and records, at most PLACE_BOOK_MAX; one record reads as the legacy one', () => {
  const ok = { version: 1, across: 0.5, depthM: 8 } satisfies SavedPlace, look = { version: 2, across: 0.5, size: 0.5 } satisfies SavedPlace;
  assert.deepEqual(parsePlaceBook(ok).legacy, ok);
  assert.deepEqual(parsePlaceBook(look).legacy, look, 'a one-record file in the new form');
  assert.deepEqual([...parsePlaceBook({ version: 2, places: { a: look, b: ok, c: { version: 2, across: 0.5, size: 99 } } }).places.keys()], ['a', 'b'], 'both forms in a book; a size out of range is left out');
  const book = parsePlaceBook({ version: 2, places: { good: ok, '../bad': ok, far: { version: 1, across: 3, depthM: 8 }, nope: 'x' } });
  assert.deepEqual([...book.places.keys()], ['good']);
  assert.equal(parsePlaceBook({ version: 3, places: { good: ok } }).places.size, 0);
  assert.equal(parsePlaceBook(null).places.size, 0);
  const many = Object.fromEntries(Array.from({ length: PLACE_BOOK_MAX + 10 }, (_, i) => [`c${i}`, ok]));
  assert.equal(parsePlaceBook({ version: 2, places: many }).places.size, PLACE_BOOK_MAX);
  assert.deepEqual(Object.keys(placeBookFile(new Map([['a', ok], ['b/../', ok]])).places), ['a']);
});

test('without a known character the keeper is exactly the one-record keeper it was', async () => {
  const writes: unknown[] = [];
  const keeper = new PlaceKeeper(() => ({ last: { load: async () => ({ version: 1, across: 0.4, depthM: 8 }), save: v => { writes.push(v); } } }));
  await keeper.load();
  keeper.walked(view, { xM: 0.5, depthM: 9 }, H);
  assert.equal((writes[0] as SavedPlace).version, 2, 'one record, as before I-209 (I-212: in the new form)');
  assert.ok(!('places' in (writes[0] as object)));
});
