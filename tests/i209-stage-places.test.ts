// I-209 step 3: every character on stage has her own host and her own place keeper, but each place file is one book
// (electron/unbound/company/place-share.ts). Through the real PlaceKeeper: two keepers writing never undo each other's record; a file from
// before is the first one's (an extra never takes it as hers); clearing one's default leaves the other's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedPlaceBook } from '../electron/unbound/company/place-share';
import { PlaceKeeper } from '../electron/unbound/place-keeper';
import { resolvePhysicalScreen } from '../shared/unbound/world';

const DISPLAY = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const frame = { screen: resolvePhysicalScreen(DISPLAY, null), display: DISPLAY.bounds, workArea: DISPLAY.workArea, viewerDistanceM: 0.55 };
const file = (start: unknown = null) => { const f = { value: start, writes: 0, load: async () => f.value, save: (v: unknown) => { f.value = v; f.writes++; }, clear: () => { f.value = null; } }; return f; };
type Book = { version: number; places: Record<string, { across: number }> };

test('two keepers on one book: each write changes only her own record; nothing of the other is undone', async () => {
  const last = file(), book = new SharedPlaceBook(last, () => 'gene');
  const gene = new PlaceKeeper(() => ({ last: book.portFor(() => 'gene', true) }), () => null, () => 'gene');
  const a = new PlaceKeeper(() => ({ last: book.portFor(() => 'vrm-a', false) }), () => null, () => 'vrm-a');
  await gene.load(); await a.load();
  gene.walked(frame, { xM: -1, depthM: 8 }, 1.6);
  a.walked(frame, { xM: 1, depthM: 7 }, 1.5); // A's keeper never saw Gene's walk: its own book is stale
  gene.walked(frame, { xM: -0.5, depthM: 8 }, 1.6);
  const places = (last.value as Book).places;
  assert.deepEqual(Object.keys(places).sort(), ['gene', 'vrm-a'], 'both kept');
  assert.ok(places['vrm-a']!.across > 0.5 && places.gene!.across < 0.5);
  const again = new PlaceKeeper(() => ({ last: book.portFor(() => 'vrm-a', false) }), () => null, () => 'vrm-a');
  await again.load();
  assert.ok(again.startFor('vrm-a', frame, 1.5), 'a new host of hers (she came out again) reads her place');
});

test('a file from before is the first one\'s: an extra never takes it, and her write gives it to the first one first', async () => {
  const last = file({ version: 1, across: 0.3, depthM: 7 }), book = new SharedPlaceBook(last, () => 'gene');
  const a = new PlaceKeeper(() => ({ last: book.portFor(() => 'vrm-a', false) }), () => null, () => 'vrm-a');
  await a.load();
  assert.equal(a.startAt(frame, null, () => ({ across: 0.8, size: 0.5 })).look?.across, 0.8, 'not hers: she starts at the first appearance');
  a.walked(frame, { xM: 1, depthM: 7 }, 1.5);
  const places = (last.value as Book).places;
  assert.deepEqual(Object.keys(places).sort(), ['gene', 'vrm-a']);
  assert.equal(places.gene!.across, 0.3, 'the old record went to the first one, never lost');
});

test('the defaults: clearing hers leaves the other\'s', async () => {
  const fixed = file(), book = new SharedPlaceBook(fixed, () => 'gene');
  const here = (id: string, xM: number) => () => ({ frame, at: { xM, depthM: 8 }, heightM: 1.6 });
  const gene = new PlaceKeeper(() => ({ fixed: book.portFor(() => 'gene', true) }), here('gene', -1), () => 'gene');
  const a = new PlaceKeeper(() => ({ fixed: book.portFor(() => 'vrm-a', false) }), here('vrm-a', 1), () => 'vrm-a');
  await gene.load(); await a.load();
  assert.equal(gene.setHere(), true); assert.equal(a.setHere(), true);
  a.clear();
  assert.deepEqual(Object.keys((fixed.value as Book).places), ['gene']);
});
