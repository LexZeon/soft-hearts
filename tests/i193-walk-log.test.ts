// I-193 follow-ups → every go-word leaves one journal row (went / stayed with a closed reason, metres) and every
// walk of hers that ended leaves one (whose, where, metres); and "走了，但是不知道多近比较好" → "按默认位置": "come-near" walks her to the distance of the
// user's default place (else a chest-up framing for her height), never closer, one knob. I-212: spots and the target are sizes on the screen;
// `at(across, m)` is the old metres on the reference laptop (8 m = 0.5) and the link converts with the same reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GO_SIZE, GO_STAY_WHYS, GO_WORDS, HER_POSITION_KNOBS, PLACE_MOVE_BY, chestUpDepthM, comeNearSize, goDecide, goSpot, goStayWhyOfBlock, metresBetween, placeMovedRow,
  type GoWord, type LifeJournalRow } from '../shared/unbound/her-position';
import { framingBand, framingGeometry, type FramingWorld } from '../shared/unbound/framing/floor';
import { GO_JOURNAL_WORDS, GO_OUTCOMES, GO_STAY_JOURNAL_WHYS, PLACE_MOVED_BY, PLACE_RANGES, PLACE_SIDES } from '../shared/stage/journal-entries';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { LifeHost, type LifeLink, type LifePorts, type LifeReadings } from '../electron/unbound/life';
import { HerPlace } from '../electron/unbound/her-place';
import { referenceSize, sizeAtDepth } from '../shared/unbound/screen-terms';
import type { UnboundWorld } from '../shared/unbound/scene';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import type { LifeSpot } from '../shared/unbound/life/action';

const K = HER_POSITION_KNOBS;
const WORLD: FramingWorld = { screen: { widthM: 0.34, heightM: 0.21, source: 'measured', detail: 'test' }, display: { x: 0, y: 0, width: 1920, height: 1200 },
  workArea: { x: 0, y: 0, width: 1920, height: 1160 }, viewerDistanceM: 0.6 };
const at = (across: number, m: number): LifeSpot => ({ across, size: referenceSize(m) });
/** The reference laptop's conversion (8 m = 0.5): size = 4.275 / (0.55 + depth). */
const depthOf = (size: number) => 4.275 / size - 0.55, sizeOf = (depthM: number) => 4.275 / (depthM + 0.55);

function world(over: { here?: LifeSpot | null; near?: number | null; random?: number } = {}) {
  const state = {
    now: 1_000_000, asleep: false, inCall: false, waiting: false, typing: false, reading: false, shown: true, peekActive: false, playing: false,
    here: over.here === undefined ? at(0.78, 8) as LifeSpot | null : over.here, near: over.near === undefined ? null : over.near,
    sent: [] as LifeCommand[], rows: [] as LifeJournalRow[],
  };
  const ports: LifePorts = {
    clock: () => state.now, random: () => over.random ?? 0.5, readings: () => ({ idleSeconds: 120, state: 'pause', pose: null, activity: null, talkedAt: null, sound: null } as Partial<LifeReadings>),
    asleep: () => state.asleep, inCall: () => state.inCall, waiting: () => state.waiting, typing: () => state.typing, readingAloud: () => state.reading, playing: () => state.playing,
    mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => true, every: () => () => {}, journal: row => state.rows.push(row),
  };
  const link: LifeLink = {
    shown: () => state.shown, fullscreen: () => false, out: () => true, send: command => state.sent.push(command), here: () => state.here, toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: depthOf(spot.size) }),
    arrived: to => { state.here = { across: to.xM / 3 + 0.5, size: sizeOf(to.depthM) }; }, peekActive: () => state.peekActive, interruptPeek: () => {}, changed: () => {}, taskbar: () => true,
    nearSize: () => state.near,
  };
  const host = new LifeHost(ports, link);
  const starts = () => state.sent.filter((c): c is Extract<LifeCommand, { type: 'start' }> => c.type === 'start');
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) { state.now += 1_000; host.tick(); } };
  return { state, host, starts, run };
}
const goRows = (rows: LifeJournalRow[]) => rows.filter((r): r is Extract<LifeJournalRow, { type: 'go-beat' }> => r.type === 'go-beat');

// ---- come-near: to the default place's distance, else chest-up, never closer ------------------------------------------------------

test('chest-up depth: inside the band between her whole body fitting and the face close-up, farther for a taller model, nothing known gives null', () => {
  const g = framingGeometry(WORLD)!;
  for (const heightM of [1.2, 1.5, 1.7, 2.1]) {
    const band = framingBand(g, heightM)!, depth = chestUpDepthM(WORLD, heightM)!;
    assert.ok(band && depth < band.fitDepthM && depth > band.closeDepthM, `${heightM} m: ${depth} between ${band.closeDepthM} and ${band.fitDepthM}`);
  }
  assert.ok(chestUpDepthM(WORLD, 2.1)! > chestUpDepthM(WORLD, 1.5)!, 'a taller model needs more room');
  for (const bad of [null, undefined, 0, -1, Number.NaN]) assert.equal(chestUpDepthM(WORLD, bad as never), null);
  assert.equal(chestUpDepthM(null, 1.6), null);
});

test('come-near size: the default place wins; else chest-up for her height (as a size on this screen); else nothing', () => {
  assert.deepEqual(comeNearSize({ defaultPlace: { size: 0.6 }, world: WORLD, heightM: 1.6 }), { size: 0.6, from: 'default' });
  const chest = comeNearSize({ defaultPlace: null, world: WORLD, heightM: 1.6 })!;
  assert.equal(chest.from, 'chest-up'); assert.equal(chest.size, sizeAtDepth(WORLD, 1.6, chestUpDepthM(WORLD, 1.6)!));
  assert.ok(chest.size > 1, 'chest-up: she no longer fits whole');
  assert.equal(comeNearSize({ world: WORLD }), null);
  assert.equal(comeNearSize({ defaultPlace: { size: Number.NaN }, heightM: null }), null);
});

test('the host side (her-place.ts): her height comes from the ready report; a bad height is not taken; the default place is read each time', () => {
  let place: { across: number; size: number } | null = null;
  const keeper = { get defaultLook() { return place; }, adopt: () => {} };
  const her = new HerPlace(keeper as never, () => ({ ...WORLD, window: WORLD.display, mapping: 'physical', eyeHeightM: 1, placement: { xM: 0, depthM: 8 } }) as UnboundWorld);
  assert.equal(her.nearSize(), null, 'no height, no default place');
  her.ready(1.6);
  assert.equal(her.nearSize(), sizeAtDepth(WORLD, 1.6, chestUpDepthM(WORLD, 1.6)!));
  place = { across: 0.6, size: 0.55 };
  assert.equal(her.nearSize(), 0.55, 'the default place wins as soon as it is set');
  place = null; her.ready('tall' as never); assert.equal(her.heightM, 1.6, 'a bad height is not taken');
  assert.equal(new HerPlace({ get defaultLook(): never { throw new Error('boom'); } } as never, () => null).nearSize(), null, 'a failing read is not a size');
});

test('come-near lands exactly at the place distance, keeps her across, and is never nearer than it', () => {
  const place = referenceSize(6.2);
  for (const across of [0.2, 0.5, 0.8]) for (const depthM of [6.8, 8, 10.5, 12]) for (const random of [0, 0.5, 1]) {
    const go = goSpot({ word: 'come-near', here: at(across, depthM), random: () => random, nearSize: place });
    assert.ok(go, `from ${across}/${depthM}`);
    assert.equal(go.spot.size, place); assert.equal(go.spot.across, across);
  }
  // A walk all the way, not a small step: from 11 m it is far more than the old step (at most nearStepMax bigger).
  const far = goSpot({ word: 'come-near', here: at(0.5, 11), random: () => 1, nearSize: place })!;
  assert.ok(far.spot.size / referenceSize(11) > K.nearStepMax);
  // Already that near or nearer: she stays, and never walks back out.
  for (const depthM of [6.2, 6.4, 5, 3]) {
    assert.deepEqual(goDecide({ word: 'come-near', here: at(0.5, depthM), random: () => 0.5, nearSize: place }), { why: 'already-there' }, `at ${depthM}`);
  }
  // The place is clamped onto her floor (never past the glass), and out of reach spots are not invented.
  assert.ok(goSpot({ word: 'come-near', here: at(0.5, 8), random: () => 0.5, nearSize: referenceSize(0.1) })!.spot.size <= GO_SIZE[1]);
});

test('the one knob: off, come-near is the old small step; no depth known, also the old step', () => {
  const here = at(0.5, 11), step = K.nearStepMax ** 1.4;
  const off = goSpot({ word: 'come-near', here, random: () => 0.5, nearSize: referenceSize(6.2), knobs: { ...K, comeNearToPlace: false } })!;
  assert.ok(off.spot.size / here.size <= step + 1e-9 && off.spot.size !== referenceSize(6.2), 'a small step');
  const unknown = goSpot({ word: 'come-near', here, random: () => 0.5, nearSize: null })!;
  assert.ok(unknown.spot.size / here.size <= step + 1e-9);
  assert.equal(K.comeNearToPlace, true, 'on by default');
});

test('the host walks come-near to the link\'s distance as one plan.walk, never nearer, and stays when already that near', () => {
  const far = world({ here: at(0.5, 11), near: referenceSize(6.2) });
  assert.equal(far.host.goAsk({ goBeat: 'come-near' }), 'go');
  const start = far.starts().at(-1)!;
  assert.ok(start.plan.walk && Math.abs(start.plan.walk.depthM - 6.2) < 1e-9, 'to the place\'s size (6.2 m on the reference laptop)');
  const near = world({ here: at(0.5, 5.4), near: referenceSize(6.2) });
  assert.equal(near.host.goAsk({ goBeat: 'come-near' }), 'stay', 'nearer than the place already: she does not walk out');
  assert.equal(near.starts().length, 0);
  const none = world({ here: at(0.5, 11), near: null });
  assert.equal(none.host.goAsk({ goBeat: 'come-near' }), 'go');
  assert.ok(sizeOf(none.starts().at(-1)!.plan.walk!.depthM) / referenceSize(11) <= K.nearStepMax ** 1.4 + 1e-9, 'nothing known: the old small step');
});

// ---- the journal: every go-word leaves one row ------------------------------------------------------------------------------------

test('every go-word leaves one row: went with the metres, or stayed with a closed reason (each gate, an unknown place, being there, a stale pointer)', () => {
  const ask = (change: (w: ReturnType<typeof world>) => void, word: GoWord = 'go-left') => { const w = world(); change(w); const answer = w.host.goAsk({ goBeat: word }); return { answer, rows: goRows(w.state.rows), w }; };
  const went = ask(() => {});
  assert.equal(went.answer, 'go'); assert.equal(went.rows.length, 1);
  assert.equal(went.rows[0].word, 'go-left'); assert.equal(went.rows[0].outcome, 'went'); assert.equal(went.rows[0].why, null);
  const start = went.w.starts().at(-1)!.plan.walk!;
  assert.equal(went.rows[0].metres, metresBetween({ xM: 0.84, depthM: 8 }, start), 'the metres the walk is for');
  assert.ok(went.rows[0].metres! > 0.5);
  const stays: [string, (w: ReturnType<typeof world>) => void, string, GoWord?][] = [
    ['asleep', w => { w.state.asleep = true; }, 'asleep'], ['not shown', w => { w.state.shown = false; }, 'not-shown'], ['the box', w => { w.state.typing = true; }, 'typing'],
    ['a close moment', w => { w.state.peekActive = true; }, 'close-moment'], ['a pull', w => w.host.pulled('start'), 'pulled'], ['a game', w => { w.state.playing = true; }, 'playing'],
    ['her place unknown', w => { w.state.here = null; }, 'no-place'], ['already there', w => { w.state.here = at(0.2, 8); }, 'already-there'],
    ['no pointer', () => {}, 'cursor-stale', 'go-cursor'],
  ];
  for (const [name, change, why, word] of stays) {
    const r = ask(change, word);
    assert.equal(r.answer, 'stay', name); assert.equal(r.rows.length, 1, `${name}: one row`);
    assert.deepEqual({ ...r.rows[0] }, { type: 'go-beat', word: word ?? 'go-left', outcome: 'stayed', why, metres: null }, name);
  }
  // A closed word for every reason the code can give, nothing else.
  for (const r of [...stays.map(s => ask(s[1], s[3]).rows[0]), went.rows[0]]) assert.ok(r.why === null || (GO_STAY_WHYS as readonly string[]).includes(r.why));
});

test('a go-word during a call is honoured (a call is not a gate); right after a pull ends it is honoured; during the kiss or hug that is on it stays and says so', () => {
  const call = world(); call.state.inCall = true;
  assert.equal(call.host.goAsk({ goBeat: 'go-left' }), 'go'); assert.equal(goRows(call.state.rows)[0].outcome, 'went');
  const afterPull = world(); afterPull.host.pulled('start'); afterPull.host.pulled('end', false);
  assert.equal(afterPull.host.goAsk({ goBeat: 'go-left' }), 'go', 'the pull is over: she may walk');
  const hug = world(); hug.state.peekActive = true;
  assert.equal(hug.host.goAsk({ goBeat: 'go-left' }), 'stay');
  assert.equal(goRows(hug.state.rows)[0].why, 'close-moment');
  hug.state.peekActive = false; // the hug is over (a pull ended it, then it let go): the next word walks
  assert.equal(hug.host.goAsk({ goBeat: 'go-left' }), 'go');
  assert.deepEqual(goRows(hug.state.rows).map(r => r.outcome), ['stayed', 'went']);
});

test('a go-word that waits behind a small move leaves its row when it starts, or "dropped" when it never does; a second one meanwhile is "queued"', () => {
  const w = world();
  w.host.trial('shift');
  const small = w.starts().at(-1)!;
  assert.equal(w.host.goAsk({ goBeat: 'go-left' }), 'go');
  assert.equal(goRows(w.state.rows).length, 0, 'no row yet: it has not started');
  assert.equal(w.host.goAsk({ goBeat: 'go-middle' }), 'stay');
  assert.deepEqual(goRows(w.state.rows).map(r => [r.word, r.why]), [['go-middle', 'queued']]);
  w.host.report({ id: small.id, phase: 'done' }); w.run(1);
  assert.deepEqual(goRows(w.state.rows).map(r => [r.word, r.outcome]), [['go-middle', 'stayed'], ['go-left', 'went']]);
  const dropped = world();
  dropped.host.trial('shift'); dropped.host.goAsk({ goBeat: 'go-left' });
  dropped.state.typing = true; dropped.host.report({ id: dropped.starts().at(-1)!.id, phase: 'done' }); dropped.run(2);
  assert.deepEqual(goRows(dropped.state.rows).map(r => [r.word, r.outcome, r.why]), [['go-left', 'stayed', 'dropped']]);
  const left = world(); left.host.trial('shift'); left.host.goAsk({ goBeat: 'go-left' }); left.host.stop();
  assert.deepEqual(goRows(left.state.rows).map(r => r.why), ['dropped'], 'she went in before it started');
});

test('across words, places and moods: one row per question, and only go questions write', () => {
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 60; i++) {
    const w = world({ here: at(0.1 + random() * 0.8, 5 + random() * 7), near: random() < 0.5 ? referenceSize(6 + random() * 3) : null, random: random() });
    if (random() < 0.3) w.state.typing = true;
    if (random() < 0.2) w.state.asleep = true;
    const word = GO_WORDS[Math.floor(random() * GO_WORDS.length)];
    const before = w.state.rows.length;
    // I-193 numbers: `go` always carries at least one number (the filter makes no bare ⟦go⟧).
    w.host.goAsk(word === 'go' ? { goBeat: word, percent: Math.round(random() * 100), metres: Math.round(random() * 60) / 10 } : random() < 0.5 && word === 'go-cursor' ? { goBeat: word, cursorAcross: random() } : { goBeat: word });
    assert.equal(w.state.rows.length - before, 1, `${word}: exactly one row`);
  }
  const w = world();
  assert.equal(w.host.goAsk({ goBeat: 'teleport' }), undefined); assert.equal(w.host.goAsk({ closeBeat: 'kiss' }), undefined); assert.equal(w.state.rows.length, 0);
  assert.equal(w.host.goAsk({ goBeat: 'go' }), undefined, 'a bare go is no question'); assert.equal(w.host.goAsk({ goBeat: 'go-left', metres: 1.2 }), undefined, 'numbers ride only on go');
  assert.equal(w.state.rows.length, 0);
});

test('a journal port that throws never stops the walk', () => {
  const w = world();
  const host = new LifeHost({ clock: () => w.state.now, random: () => 0.5, readings: () => ({}), asleep: () => false, inCall: () => false, waiting: () => false, typing: () => false, readingAloud: () => false,
    mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => true, every: () => () => {}, journal: () => { throw new Error('disk'); } },
  { shown: () => true, fullscreen: () => false, out: () => true, send: c => w.state.sent.push(c), here: () => at(0.78, 8), toWorld: s => ({ xM: (s.across - 0.5) * 3, depthM: depthOf(s.size) }),
    arrived: () => {}, peekActive: () => false, interruptPeek: () => {}, changed: () => {} });
  assert.equal(host.goAsk({ goBeat: 'go-left' }), 'go');
});

// ---- the journal: every walk that ends leaves one row ----------------------------------------------------------------------------

test('a walk that ended leaves one place-moved row: whose, where she stands now, the metres; her own walk too; a cut-short walk writes what she covered; never twice', () => {
  const w = world();
  w.host.goAsk({ goBeat: 'go-left' });
  const start = w.starts().at(-1)!;
  const at = { xM: start.plan.walk!.xM, depthM: start.plan.walk!.depthM };
  w.host.report({ id: start.id, phase: 'done', at });
  w.host.report({ id: start.id, phase: 'done', at });
  const moved = w.state.rows.filter(r => r.type === 'place-moved');
  assert.equal(moved.length, 1, 'one row, however many reports');
  assert.deepEqual({ ...moved[0] }, { type: 'place-moved', by: 'go-word', side: 'left', range: 'middle', metres: metresBetween({ xM: 0.84, depthM: 8 }, at) });
  // Her own "换个地方站".
  const own = world(); assert.equal(own.host.trial('place'), true);
  const ownStart = own.starts().at(-1)!;
  assert.ok(ownStart.plan.walk);
  own.host.report({ id: ownStart.id, phase: 'done', at: { xM: ownStart.plan.walk!.xM, depthM: ownStart.plan.walk!.depthM } });
  assert.equal(own.state.rows.filter(r => r.type === 'place-moved').length, 0, 'a trial from the developer panel writes nothing');
  // Cut short: the page reports where she really stopped.
  const cut = world(); cut.host.goAsk({ goBeat: 'go-left' });
  const cutStart = cut.starts().at(-1)!;
  cut.host.report({ id: cutStart.id, phase: 'done', at: { xM: 0.74, depthM: 8 } });
  const row = cut.state.rows.find(r => r.type === 'place-moved') as Extract<LifeJournalRow, { type: 'place-moved' }>;
  assert.equal(row.metres, 0.1); assert.equal(row.by, 'go-word');
  // A walk that never reports where she is writes none (she did not move as far as anyone knows).
  const none = world(); none.host.goAsk({ goBeat: 'go-left' }); none.host.report({ id: none.starts().at(-1)!.id, phase: 'done', skipped: true });
  assert.equal(none.state.rows.filter(r => r.type === 'place-moved').length, 0);
});

test('the rows are built from closed words: place-moved needs a known spot and metres', () => {
  assert.equal(placeMovedRow('own', null, 1), null);
  assert.equal(placeMovedRow('own', at(0.5, 8), null), null);
  assert.deepEqual(placeMovedRow('go-word', at(0.9, 2), 3.2), { type: 'place-moved', by: 'go-word', side: 'right', range: 'very-near', metres: 3.2 });
  assert.equal(goStayWhyOfBlock('busy'), 'close-moment'); assert.equal(goStayWhyOfBlock('pulled'), 'pulled');
});

// ---- the journal entries (shared/stage/journal-entries.ts) ------------------------------------------------------------------------

test('the journal keeps the same closed lists as the code that writes the rows', () => {
  assert.deepEqual([...GO_JOURNAL_WORDS], [...GO_WORDS]);
  assert.deepEqual([...GO_STAY_JOURNAL_WHYS], [...GO_STAY_WHYS]);
  assert.deepEqual([...PLACE_MOVED_BY], [...PLACE_MOVE_BY]);
  assert.deepEqual([...GO_OUTCOMES], ['went', 'stayed']);
  assert.deepEqual([...PLACE_SIDES], ['left', 'middle', 'right']);
  assert.deepEqual([...PLACE_RANGES], ['very-near', 'near', 'middle', 'far']);
});

test('the journal writes go-beat and place-moved rows from closed words and numbers only, and refuses anything else', () => {
  const at = 1_794_865_327_123;
  const went = buildJournalEntry({ type: 'go-beat', characterId: 'gene', word: 'come-near', outcome: 'went', why: null, metres: 4.26 }, at) as { metres: number; reason: string };
  assert.ok(went); assert.equal(went.metres, 4.3);
  const stayed = buildJournalEntry({ type: 'go-beat', characterId: 'gene', word: 'go-cursor', outcome: 'stayed', why: 'cursor-stale', metres: null }, at);
  assert.ok(stayed);
  const moved = buildJournalEntry({ type: 'place-moved', characterId: 'gene', by: 'own', side: 'middle', range: 'far', metres: 2.55 }, at);
  assert.ok(moved);
  for (const bad of [
    { type: 'go-beat', characterId: 'gene', word: 'teleport', outcome: 'went', why: null, metres: 1 },
    { type: 'go-beat', characterId: 'gene', word: 'go-left', outcome: 'went', why: 'asleep', metres: 1 },
    { type: 'go-beat', characterId: 'gene', word: 'go-left', outcome: 'stayed', why: '她说去左边', metres: null },
    { type: 'go-beat', characterId: 'gene', word: 'go-left', outcome: 'stayed', why: null, metres: null },
    { type: 'go-beat', characterId: 'gene', word: 'go-left', outcome: 'stayed', why: 'asleep', metres: 3 },
    { type: 'place-moved', characterId: 'gene', by: 'pulled', side: 'left', range: 'far', metres: 1 },
    { type: 'place-moved', characterId: 'gene', by: 'own', side: 'north', range: 'far', metres: 1 },
    { type: 'place-moved', characterId: 'gene', by: 'own', side: 'left', range: 'far', metres: 1e6 },
    { type: 'place-moved', characterId: 'gene', by: 'own', side: 'left', range: 'far', metres: -1 },
    { type: 'place-moved', characterId: 'gene', by: 'own', side: 'left', range: 'far', metres: 'far' },
  ]) assert.equal(buildJournalEntry(bad as never, at), null, JSON.stringify(bad));
  // A metres value that does not fit on a went row is not written as a number.
  const unknownMetres = buildJournalEntry({ type: 'go-beat', characterId: 'gene', word: 'go-left', outcome: 'went', why: null, metres: 1e6 }, at) as { metres: number | null };
  assert.equal(unknownMetres.metres, null);
  // The panel line says it in plain words.
  const tr = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
  assert.match(describeJournalEntry(went as never, tr), /走近.*4\.3 米/u);
  assert.match(describeJournalEntry(stayed as never, tr), /鼠标/u);
  assert.match(describeJournalEntry(moved as never, tr), /屏幕中间.*离用户比较远.*2\.6 米/u);
});
