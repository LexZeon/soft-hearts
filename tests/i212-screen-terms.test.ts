// I-212 and I-211 step 1
// ("这个也是以用户显示的电脑为准。最好是有一个换算m的公式，或者距离单位。"): every place decision is in screen terms (across, size: her height as a share
// of the usable height) and converted to metres in one module (shared/unbound/screen-terms); the turn's position line tells her the distance by one
// screen formula, what the user sees of her, the share across and the default place; her hidden ⟪keep-place⟫ / ⟪clear-place⟫ set or clear the default
// place only in her reply to the user's message while she is out. docs/claude/2026-11-24-i212-screen-terms.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Mesh } from 'three';
import { FALLBACK_HEIGHT_M, REFERENCE, SCREEN_TERMS_KNOBS, depthForSize, lookOfPlacement, placementOfLook, referenceSize, screenDistanceM, sizeAtDepth, toldDistanceM, usableHeightM,
  type ScreenFrame } from '../shared/unbound/screen-terms';
import { HER_POSITION_KNOBS, GO_SIZE, PLACE_MARK_WORDS, firstWaistUpSize, herSeen, herPositionLine, placeMarkOf, placeMarkWordsLine } from '../shared/unbound/her-position';
import { PLACE_MOOD, PLACE_ZONES } from '../shared/unbound/life/actions/place';
import { SAVED_PLACE_RANGES } from '../shared/unbound/life/place-record';
import { followDepthRange } from '../shared/unbound/pull';
import { DEFAULT_ACROSS, HOME_FEET_MARGIN_DIP, apparentHeightM, eyeHeightFor, projectToDip, type WorldView } from '../shared/unbound/world';
import { INSTRUCTION_WORDS } from '../shared/unbound/life/history';
import { SpeechBeatFilter } from '../shared/behaviors/speech-beats/choose';
import { PlaceKeeper } from '../electron/unbound/place-keeper';
import { HerPlace } from '../electron/unbound/her-place';
import { applyPlaceMark, type PlaceMarkRow } from '../electron/unbound/place-marks';
import { startPlacement } from '../src/unbound/her-spot';
import type { UnboundScene, UnboundWorld } from '../shared/unbound/scene';
import type { SavedPlace } from '../shared/unbound/life/place-record';

/** Fake screens (physical size, DIP, a taskbar of 48 DIP). */
const SCREENS: Record<string, ScreenFrame> = {
  '13.3"': screen(0.294, 0.165, 1536, 864),
  '15.6"': screen(0.345, 0.194, 1920, 1080),
  '27"': screen(0.598, 0.336, 2560, 1440),
  '32"': screen(0.708, 0.398, 2048, 1152),
};
function screen(widthM: number, heightM: number, w: number, h: number): ScreenFrame {
  return { screen: { widthM, heightM, source: 'measured', detail: 'test' }, display: { x: 0, y: 0, width: w, height: h }, workArea: { x: 0, y: 0, width: w, height: h - 48 }, viewerDistanceM: 0.55 };
}
const HEIGHTS = [1.35, 1.6, 1.85]; // a short, a usual and a tall model
const worldOf = (frame: ScreenFrame, placement = { xM: 0, depthM: 8 }): UnboundWorld => ({ ...frame, window: frame.workArea, mapping: 'physical', eyeHeightM: 1, placement });
const close = (a: number, b: number, tolerance: number, label: string) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);

// ---- the conversion ------------------------------------------------------------------------------------------------------------

test('the same size is the same share of the usable height on every screen and for every model (projected through her world)', () => {
  for (const [name, frame] of Object.entries(SCREENS)) for (const heightM of HEIGHTS) for (const size of [0.35, 0.5, 0.77, 0.95]) {
    const depth = depthForSize(frame, heightM, size)!;
    close(sizeAtDepth(frame, heightM, depth)!, size, 1e-12, `${name} ${heightM} m round trip`);
    // Through the camera: her feet and crown on the screen, in DIP, against the usable height in DIP.
    const view: WorldView = { screen: frame.screen, display: frame.display, viewerDistanceM: frame.viewerDistanceM, eyeHeightM: eyeHeightFor(frame.screen, { bounds: frame.display, workArea: frame.workArea, scaleFactor: 1, internal: true }, frame.viewerDistanceM, depth) };
    const feet = projectToDip(view, { x: 0, y: 0, z: -depth })!, crown = projectToDip(view, { x: 0, y: heightM, z: -depth })!;
    const usableDip = frame.workArea.height - HOME_FEET_MARGIN_DIP;
    close((feet.y - crown.y) / usableDip, size, 1e-9, `${name} ${heightM} m at ${size}`);
    close(feet.y, frame.workArea.y + frame.workArea.height - HOME_FEET_MARGIN_DIP, 1e-6, `${name}: her feet on the floor line`);
    close(apparentHeightM(heightM, depth, frame.viewerDistanceM) / usableHeightM(frame)!, size, 1e-12, `${name} apparent height`);
  }
});

test('placements and looks convert both ways; across stays a share of the width; nothing known gives null', () => {
  for (const frame of Object.values(SCREENS)) for (const across of [0.1, 0.5, 0.78, 0.9]) {
    const at = placementOfLook(frame, 1.6, { across, size: 0.5 })!;
    const look = lookOfPlacement(frame, 1.6, at)!;
    close(look.across, across, 1e-12, 'across'); close(look.size, 0.5, 1e-12, 'size');
  }
  const frame = SCREENS['15.6"'];
  assert.equal(placementOfLook(frame, null, { across: 0.5, size: 0.5 }), null);
  assert.equal(placementOfLook(null, 1.6, { across: 0.5, size: 0.5 }), null);
  assert.equal(depthForSize(frame, 1.6, 0), null);
  assert.equal(sizeAtDepth({ ...frame, workArea: { ...frame.workArea, height: 0 } }, 1.6, 8), null);
  // Inside her world's depth range: a size bigger than the glass allows is kept at the glass (0.6 m), never through it.
  assert.ok(placementOfLook(frame, 1.6, { across: 0.5, size: 50 })!.depthM >= 0.6);
});

test('the spots of her life (her walks, her go-words) go through the one conversion on every screen and for every model', () => {
  for (const frame of Object.values(SCREENS)) for (const heightM of HEIGHTS) {
    const her = new HerPlace(new PlaceKeeper(() => ({})), () => worldOf(frame));
    her.heightM = heightM;
    for (const spot of [{ across: 0.2, size: 0.4 }, { across: 0.78, size: 0.5 }, { across: 0.6, size: 0.8 }]) {
      const at = her.toWorld(spot)!;
      const look = lookOfPlacement(frame, heightM, at)!;
      close(look.size, spot.size, 1e-9, 'size'); close(look.across, spot.across, 1e-9, 'across');
      her.placement = at;
      close(her.here()!.size, spot.size, 1e-9, 'here');
    }
  }
});

// ---- the first appearance ------------------------------------------------------------------------------------------------------

test('the first appearance is half the usable height on every screen, for every model, and the host places her exactly as the page did (no jump)', () => {
  const depths: number[] = [];
  for (const [name, frame] of Object.entries(SCREENS)) for (const heightM of HEIGHTS) {
    const world = worldOf(frame);
    const her = new HerPlace(new PlaceKeeper(() => ({})), () => world);
    const guess = her.place(frame, true);
    assert.deepEqual(her.start, { across: DEFAULT_ACROSS, size: firstWaistUpSize(world, FALLBACK_HEIGHT_M)! }, `${name}: the start is a look (waist-up for the guessed height until her real one is known)`);
    // The page: her model measured, the start placed with it (src/unbound/her-spot.ts).
    const mesh = new Mesh(new BoxGeometry(1, heightM / 0.08, 1)); mesh.position.y = heightM / 0.08 / 2;
    const scene = { world: { ...world, placement: guess }, start: her.start } as unknown as UnboundScene;
    const page = startPlacement(scene, mesh as never);
    // The ready report: the host works out the same placement.
    assert.equal(her.ready(heightM), true);
    if (heightM === FALLBACK_HEIGHT_M) assert.deepEqual(her.placement, page, `${name} ${heightM} m: the host and the page agree to the last digit`); // another height: the host fixes the size with her real height and sends the scene again (she is not drawn before)
    assert.equal(her.start, null, 'the start is spent');
    assert.equal(herSeen(world, { heightM }, her.placement!.depthM)?.seen, 'waist-up', `${name} ${heightM} m: from the waist up`);
    close(lookOfPlacement(frame, heightM, her.placement!)!.across, DEFAULT_ACROSS, 1e-9, `${name}: across`);
    if (heightM === 1.6) depths.push(her.placement!.depthM);
  }
  // The point: a taller screen brings her nearer to be half of it (the old 8 m everywhere made her about a quarter of a 27" screen), a small one further back.
  assert.ok(depths[0] > depths[1] && depths[1] > depths[2] && depths[2] > depths[3], `13.3" > 15.6" > 27" > 32": ${depths.map(d => d.toFixed(2)).join(', ')}`);
});

// ---- the knobs keep today's look on the reference laptop ------------------------------------------------------------------------

test('every converted knob keeps today\'s look on the reference laptop (8 m = 0.5) within 2%', () => {
  close(referenceSize(REFERENCE.depthM), REFERENCE.size, 1e-12, 'the anchor');
  const within = (size: number, metres: number, label: string) => assert.ok(Math.abs(size / referenceSize(metres) - 1) <= 0.02, `${label}: ${size} vs ${referenceSize(metres).toFixed(4)} (${metres} m)`);
  const K = HER_POSITION_KNOBS;
  within(K.veryNearSize, 3, 'veryNear'); within(K.nearSize, 6.6, 'near'); within(K.farSize, 9.4, 'far'); within(K.floorSize, 5, 'floor');
  within(K.cornerSizeMin, 11.6, 'corner far'); within(K.cornerSizeMax, 10.4, 'corner near');
  within(K.nearestSize, 4.6, 'nearest'); within(K.farthestSize, 12, 'farthest');
  // Steps from 8 m: 1.2-2.4 m nearer / further, as a change of size.
  within(referenceSize(8) * K.nearStepMin, 8 - 1.2, 'a short step nearer'); within(referenceSize(8) * K.nearStepMax, 8 - 2.4, 'a long step nearer');
  within(referenceSize(8) * K.farStepMin, 8 + 1.2, 'a short step further'); within(referenceSize(8) * K.farStepMax, 8 + 2.4, 'a long step further');
  const zones: Record<string, [number, number]> = { busy: [9.2, 10.2], paused: [7.0, 7.6], sleepy: [10.0, 10.8], home: [7.8, 8.6], wander: [7.6, 10.4] };
  for (const [zone, [near, far]] of Object.entries(zones)) {
    const box = PLACE_ZONES[zone as keyof typeof PLACE_ZONES].size;
    within(box[1], near, `${zone} near`); within(box[0], far, `${zone} far`);
  }
  within(PLACE_MOOD.size[1], 6.6, 'mood near'); within(PLACE_MOOD.size[0], 11.2, 'mood far');
  within(referenceSize(8.2) * PLACE_MOOD.tenseSmaller, 9.2, 'tense: about 1 m back'); within(referenceSize(8.2) * PLACE_MOOD.warmBigger, 7.7, 'warm: about 0.5 m in');
  within(SAVED_PLACE_RANGES.size[1], 5, 'saved near'); within(SAVED_PLACE_RANGES.size[0], 12.5, 'saved far'); within(GO_SIZE[0], 12.5, 'walk far');
});

test('the pull\'s bounds are the saved sizes on any screen; unknown: the old metres', () => {
  for (const frame of Object.values(SCREENS)) for (const heightM of HEIGHTS) {
    const [near, far] = followDepthRange(frame, heightM);
    close(sizeAtDepth(frame, heightM, near)!, SAVED_PLACE_RANGES.size[1], 1e-9, 'near end'); close(sizeAtDepth(frame, heightM, far)!, SAVED_PLACE_RANGES.size[0], 1e-9, 'far end');
  }
  assert.deepEqual(followDepthRange(null, 1.6), SAVED_PLACE_RANGES.depthM);
});

// ---- saved places ---------------------------------------------------------------------------------------------------------------

test('an old place file (metres) is converted once with this screen and her height, and written in the new form', async () => {
  const frame = SCREENS['27"'], writes: unknown[] = [];
  let value: unknown = { version: 1, across: 0.7, depthM: 9 };
  const keeper = new PlaceKeeper(() => ({ last: { load: async () => value, save: v => { writes.push(v); value = v; } } }));
  await keeper.load();
  const start = keeper.startAt(frame, null, () => ({ across: 0.78, size: 0.5 }));
  assert.ok(start.placement && Math.abs(start.placement.depthM - 9) < 1e-12, 'the first entry stands where the old file says (metres), until her height is known');
  keeper.adopt(frame, 1.6);
  assert.equal(writes.length, 1);
  const kept = writes[0] as SavedPlace;
  assert.ok(kept.version === 2 && kept.across === 0.7, JSON.stringify(kept));
  close((kept as { size: number }).size, Math.max(SAVED_PLACE_RANGES.size[0], sizeAtDepth(frame, 1.6, 9)!), 1e-12, 'as she looked on this screen (kept inside the saved sizes)');
  keeper.adopt(frame, 1.6); keeper.adopt(SCREENS['13.3"'], 1.35);
  assert.equal(writes.length, 1, 'once');
  assert.ok(keeper.startAt(frame, null, () => ({ across: 0.78, size: 0.5 })).look, 'from then on a look');
});

test('a saved look shows at the same share of the screen on another screen and for each extra\'s own height', async () => {
  const keeper = new PlaceKeeper(() => ({ last: { load: async () => ({ version: 2, places: { a: { version: 2, across: 0.3, size: 0.6 } } }), save: () => {} } }), () => null, () => 'main');
  await keeper.load();
  for (const frame of Object.values(SCREENS)) for (const heightM of HEIGHTS) {
    const at = keeper.startFor('a', frame, heightM)!;
    const look = lookOfPlacement(frame, heightM, at)!;
    close(look.size, 0.6, 1e-9, 'size'); close(look.across, 0.3, 1e-9, 'across');
  }
});

// ---- the position line ----------------------------------------------------------------------------------------------------------

test('the told distance: one screen formula, the same look the same number on every computer; the table', () => {
  close(screenDistanceM(1.6, 0.5)!, 3.86, 0.01, 'half the usable height');
  close(screenDistanceM(1.6, 1)!, 1.93, 0.01, 'the whole body just fits');
  close(screenDistanceM(1.6, 2.4)!, 0.80, 0.01, 'chest-up');
  close(screenDistanceM(1.6, 6.4)!, 0.30, 0.01, 'the face fills');
  assert.deepEqual([toldDistanceM(1.6, 0.5), toldDistanceM(1.6, 1), toldDistanceM(1.6, 2.4), toldDistanceM(1.6, 6.4), toldDistanceM(1.6, 0.33)], [4, 1.9, 0.8, 0.3, 6]);
  for (const size of [0.4, 0.5, 0.9, 1.3]) {
    // The host side (her-place.ts): she stands at this look on each screen; the line it makes.
    const lines = Object.values(SCREENS).map(frame => {
      const her = new HerPlace({ defaultLook: { across: 0.78, size: 0.5 }, adopt: () => {} } as never, () => worldOf(frame));
      her.heightM = 1.6; her.placement = placementOfLook(frame, 1.6, { across: 0.7, size })!;
      const now = her.facts()!;
      return herPositionLine(now.spot, { ...now.facts, table: null }); // I-193: the near-far table is for THIS screen (a big one's glass comes sooner): tests/i193-walk-by-screen.test.ts
    });
    assert.equal(new Set(lines).size, 1, `the same look, the same line on every screen: ${lines[0]}`);
    // Not the world's metres: those differ from screen to screen for the same look.
    const worldMetres = Object.values(SCREENS).map(frame => (frame.viewerDistanceM + depthForSize(frame, 1.6, size)!).toFixed(1));
    assert.ok(new Set(worldMetres).size > 1, 'the world metres would not be the same');
    assert.ok(lines[0].includes(`约 ${toldDistanceM(1.6, size)! < 2 ? toldDistanceM(1.6, size)!.toFixed(1) : String(toldDistanceM(1.6, size))} 米`), lines[0]);
  }
});

test('what the user sees: from the real framing (whole, knees up, waist up, chest up, the face), the crown out of the picture', () => {
  const frame = SCREENS['15.6"'], body = { heightM: 1.6 };
  const seenAt = (size: number) => herSeen(frame as never, body, depthForSize(frame, 1.6, size)!)!;
  assert.deepEqual(seenAt(0.5), { seen: 'whole', crownCut: false, feetOnFloor: true });
  assert.equal(seenAt(0.9).seen, 'whole');
  const order = ['whole', 'knees-up', 'waist-up', 'chest-up', 'face', 'face-close'];
  let last = 0;
  const met = new Set<string>();
  for (let size = 0.5; size < 40; size *= 1.05) {
    const seen = seenAt(size);
    met.add(seen.seen);
    const rank = order.indexOf(seen.seen);
    assert.ok(rank >= last, `nearer never shows more of her: ${seen.seen} at ${size.toFixed(2)}`);
    last = rank;
  }
  for (const word of order) assert.ok(met.has(word), `${word} happens on the way in`);
  assert.equal(herSeen(null, body, 3), null);
  // The line says it.
  const line = herPositionLine({ across: 0.5, size: 2 }, { distanceM: toldDistanceM(1.6, 2), seen: seenAt(2) });
  assert.ok(line.includes('用户看到的你：'), line);
});

test('the position line: numbers, the framing words, the share across, the default place when set and only then; facts, never an instruction', () => {
  const seen = { seen: 'waist-up' as const, crownCut: true, feetOnFloor: false };
  const zh = herPositionLine({ across: 0.72, size: 1.6 }, { distanceM: toldDistanceM(1.6, 1.6), taskbar: true, seen, defaultPlace: { across: 0.78, size: 0.5, distanceM: toldDistanceM(1.6, 0.5) } });
  assert.equal(zh, '你现在离用户约 1.2 米，站在屏幕偏右（横向约 70% 处）；用户看到的你：半身（腰以上），头顶出画了。用户给你定的出场位置：屏幕偏右（横向约 80% 处），离用户约 4 米。');
  const none = herPositionLine({ across: 0.72, size: 1.6 }, { distanceM: toldDistanceM(1.6, 1.6), taskbar: true, seen });
  assert.ok(!none.includes('出场位置'), 'no default place set: nothing said');
  const en = herPositionLine({ across: 0.2, size: 0.5 }, { distanceM: toldDistanceM(1.6, 0.5), taskbar: true, language: 'en', seen: { seen: 'whole', crownCut: false, feetOnFloor: true }, defaultPlace: { across: 0.78, size: 0.5, distanceM: 4 } });
  assert.equal(en, 'You are about 4 m from the user, at the left of the screen (about 20% across); the user sees your whole body, the taskbar is by your feet. The place the user set for you to appear at: the right of the screen (about 80% across), about 4 m from the user.');
  for (const line of [zh, none, en, placeMarkWordsLine('zh-CN'), placeMarkWordsLine('en')]) {
    for (const word of INSTRUCTION_WORDS) assert.ok(!line.includes(word), `${word} in ${line}`);
    assert.doesNotMatch(line, /走|去|移|过来|窗口|\b(should|must|please|go|move|walk|try)\b/iu, line);
  }
});

// ---- "以后就从这儿出来": her hidden place markers ---------------------------------------------------------------------------------

function marks(out = true) {
  const state = { out, kept: 0, cleared: 0, rows: [] as PlaceMarkRow[] };
  const ports = { out: () => state.out, setHere: () => { state.kept++; return true; }, clear: () => { state.cleared++; }, journal: (row: PlaceMarkRow) => state.rows.push(row) };
  return { state, ports };
}

test('her reply to your message sets or clears the default place with a hidden marker; her own replies never do; not while she is not out; once per reply', () => {
  const a = marks();
  assert.deepEqual(applyPlaceMark(['keep-place'], 'user', a.ports), { type: 'default-place', action: 'keep', outcome: 'done' });
  assert.equal(a.state.kept, 1);
  const own = marks();
  assert.equal(applyPlaceMark(['keep-place'], 'own', own.ports), null, 'an opening of her own, a topic she brings up: never');
  assert.equal(applyPlaceMark(['clear-place'], 'own', own.ports), null);
  assert.deepEqual([own.state.kept, own.state.cleared, own.state.rows.length], [0, 0, 0]);
  const away = marks(false);
  assert.deepEqual(applyPlaceMark(['keep-place'], 'user', away.ports), { type: 'default-place', action: 'keep', outcome: 'not-out' });
  assert.equal(away.state.kept, 0, 'not in full screen: nothing kept');
  const clear = marks();
  assert.deepEqual(applyPlaceMark([' Clear-Place '], 'user', clear.ports), { type: 'default-place', action: 'clear', outcome: 'done' });
  assert.equal(clear.state.cleared, 1);
  const twice = marks();
  applyPlaceMark(['milestone', 'keep-place', 'clear-place', 'keep-place'], 'user', twice.ports);
  assert.deepEqual([twice.state.kept, twice.state.cleared, twice.state.rows.length], [1, 0, 1], 'the first place marker only');
  const none = marks();
  assert.equal(applyPlaceMark(['milestone', 'alarm 10:00 x', 'keep place', 'keep-placement'], 'user', none.ports), null, 'only the two closed words');
  const refused = marks();
  refused.ports.setHere = () => false;
  assert.equal(applyPlaceMark(['keep-place'], 'user', refused.ports)!.outcome, 'refused');
  assert.equal(placeMarkOf(undefined), null);
});

test('the markers never show and are never read aloud (the filter takes them out of the text); her word list names them in Chinese and English', () => {
  for (const word of PLACE_MARK_WORDS) {
    const f = new SpeechBeatFilter();
    const chunk = f.push(`好，记住了。⟪${word}⟫以后我就从这儿出来。`);
    f.end();
    const summary = f.summary();
    assert.ok(!chunk.text.includes(word) && !summary.text.includes(word) && !summary.text.includes('⟪'), summary.text);
    assert.equal(summary.text, '好，记住了。以后我就从这儿出来。');
    assert.equal(placeMarkOf(summary.alarms), word);
  }
  const zh = placeMarkWordsLine('zh-CN'), en = placeMarkWordsLine('en');
  for (const word of PLACE_MARK_WORDS) { assert.ok(zh.includes(`⟪${word}⟫`), zh); assert.ok(en.includes(`⟪${word}⟫`), en); }
  assert.ok(/[㐀-鿿]/u.test(zh) && !/[㐀-鿿]/u.test(en));
  assert.doesNotMatch(zh + en, /以后就从这儿出来|from here on/u, 'the list never says when to use them');
});

test('the host keeps the marker inside her place: setHere needs her out and her height; the panel look follows', async () => {
  const frame = SCREENS['15.6"'], saved: unknown[] = [];
  let here: { frame: ScreenFrame; at: { xM: number; depthM: number }; heightM: number | null } | null = null;
  const keeper = new PlaceKeeper(() => ({ fixed: { load: async () => null, save: v => { saved.push(v); }, clear: () => { saved.push(null); } } }), () => here);
  await keeper.load();
  const ports = { out: () => here !== null, setHere: () => keeper.setHere(), clear: () => keeper.clear() };
  assert.equal(applyPlaceMark(['keep-place'], 'user', ports)!.outcome, 'not-out');
  here = { frame, at: placementOfLook(frame, 1.6, { across: 0.6, size: 0.55 })!, heightM: null };
  assert.equal(applyPlaceMark(['keep-place'], 'user', ports)!.outcome, 'refused', 'her height not known yet: nothing kept');
  here.heightM = 1.6;
  assert.equal(applyPlaceMark(['keep-place'], 'user', ports)!.outcome, 'done');
  assert.deepEqual(keeper.look(), { set: true, here: true });
  close((saved.at(-1) as { size: number }).size, 0.55, 1e-9, 'kept as she looks');
  assert.equal(applyPlaceMark(['clear-place'], 'user', ports)!.outcome, 'done');
  assert.deepEqual(keeper.look(), { set: false, here: true });
});
