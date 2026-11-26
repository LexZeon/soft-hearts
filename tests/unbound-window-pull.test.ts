// I-154 batch 1, row 29「拉她」(docs/claude/2026-11-19-unbound-in-window.md): the companion's pull on Unbound's engine in the window
// (src/unbound/window-mode/window-pull.ts), on the real Gene frame loop (window body: figure, idle layer, mouth), at 60 and 30 fps.
//  - the old stage's cases (tests/pull-stage.test.ts: a light and a hard pull on the hand, the body, the head, the foot, held still, cancelled):
//    press and release stay within 1.25× of the same run without the pull (floor 0.15° at 60 fps, 0.6° at 30), she is back within 0.5° of
//    her own pose 2.5 s after the release, and the layer's caps hold;
//  - she never walks along: her root stays at the origin within a few millimetres and ends there; a pulled foot puts her on the other one;
//  - the gates: only a hit on her own body, shown; only a hit this window made for the figure shown now; not asleep; not the hand while it is held;
//  - the companion's own pull input (src/mood/) drives it end to end, with her attitude from her mood.
// `PULL_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Quaternion } from 'three';
import { WindowPull, type WindowPullFigure, type WindowPullMood } from '../src/unbound/window-mode/window-pull';
import { PetPull } from '../src/mood/pet-pull'; // no-pet-ok: the input class and its file keep their names
import type { PullReport } from '../shared/stage';
import { DEG, frameSteps, surprises, windowGene, type WindowGene } from './helpers/unbound-window';
import { TRACKED } from './helpers/unbound-gene';

const REPORT = process.env.PULL_REPORT === '1';
const LEGS = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => /足|ひざ/.test(name)).map(([, i]) => i);
const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
const BASE = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const awake = (phase = 'awake'): WindowPullMood => ({ snapshot: { values: { ...BASE } as never, intensity: { playful: 50 } }, parameters: { baseline: { ...BASE } as never }, fatigue: { phase, A: 0 } });

function rig(g: WindowGene) {
  const state = { shown: true, mood: null as WindowPullMood | null, handBusy: false, figure: g.figure as WindowPullFigure | null };
  const pull = new WindowPull({ figure: () => state.figure, view: g.view, shown: () => state.shown, mood: () => state.mood, handBusy: () => state.handBusy });
  return { pull, state };
}

interface PullCase { name: string; spot(g: WindowGene): { x: number; y: number }; part: string[]; drag: { x: number; y: number }; cancelAt?: number; after?: number; backS?: number }
/** The old stage's cases (tests/pull-stage.test.ts), drag in "her height on the window" units (x right, y down). */
const CASES: PullCase[] = [
  { name: 'light pull on the hand', spot: g => g.between('右ひじ', '右手首', 0.85), part: ['hand', 'arm'], drag: { x: -0.12, y: 0.02 } },
  { name: 'hard pull on the hand', spot: g => g.between('右ひじ', '右手首', 0.85), part: ['hand', 'arm'], drag: { x: -1.2, y: -0.1 } },
  { name: 'pull on the body', spot: g => g.between('上半身', '上半身2', 0.9), part: ['torso', 'shoulder'], drag: { x: 0.45, y: 0.05 } },
  { name: 'pull on the head', spot: g => g.between('頭', '頭先', 0.6), part: ['head', 'face', 'hair'], drag: { x: -0.4, y: 0 } },
  { name: 'pull on the foot', spot: g => g.between('左ひざ', '左足首', 0.5), part: ['leg', 'foot'], drag: { x: 0.35, y: 0 },
    // On one foot her learned idle rests (Unbound: it plays on both feet only) and comes back by its own slow fade (2.5 s rise): back later.
    after: 7, backS: 6.5 },
  { name: 'pressed and held still', spot: g => g.between('上半身', '上半身2', 0.9), part: ['torso', 'shoulder'], drag: { x: 0, y: 0 } },
  { name: 'cancelled half way', spot: g => g.between('右ひじ', '右手首', 0.85), part: ['hand', 'arm'], drag: { x: -0.8, y: 0 }, cancelAt: 0.25 },
];

const T0 = 2.2, AFTER = 4;
const afterOf = (pull: PullCase | null) => pull?.after ?? AFTER;
interface Shot { t: number; rotations: Quaternion[]; root: { x: number; z: number }; stance: string; layer: WindowGene['figure']['pullState']; engaged: boolean }

/** One run: the same seed with and without the pull, frame by frame. */
async function runCase(fps: number, pull: PullCase | null, after = afterOf(pull)) {
  const g = await windowGene(), { pull: input } = rig(g);
  const hold = pull?.cancelAt ?? 1.6, shots: Shot[] = [];
  let from = { x: 0, y: 0 }, heightPx = 0, started = false, ended = false;
  try {
    for (let frame = 0; frame <= Math.round(fps * (T0 + hold + after)); frame++) {
      const t = frame / fps;
      if (pull && !started && t >= T0 - 1e-9) {
        from = pull.spot(g);
        const hit = input.hit(from.x, from.y);
        assert.ok(hit, `${pull.name}: the press lands on her`);
        assert.ok(pull.part.includes(hit.part), `${pull.name}: part ${hit.part}`);
        heightPx = hit.heightPx;
        assert.equal(input.start(hit), true);
        started = true;
      }
      if (pull && started && !ended) {
        if (t < T0 + hold - 1e-9) { const k = smooth((t - T0) / 0.45); input.to(from.x + pull.drag.x * heightPx * k, from.y + pull.drag.y * heightPx * k); }
        else { input.end(); ended = true; }
      }
      g.frame(frame ? 1 / fps : 0);
      shots.push({ t, rotations: g.rotations(), root: { x: g.figure.placement.xM, z: g.figure.placement.depthM }, stance: g.figure.report?.stance ?? '',
        layer: g.figure.pullState, engaged: g.figure.pullEngaged });
    }
    return { shots, hold };
  } finally { g.close(); }
}

const span = (shots: readonly Shot[], from: number, to: number) => shots.filter(s => s.t >= from - 1e-9 && s.t <= to + 1e-9).map(s => s.rotations);

for (const fps of [60, 30]) {
  const floor = 0.15 * (60 / fps) ** 2, edge = 2 / fps;
  for (const pull of CASES) {
    test(`window pull, ${pull.name} (${fps} fps): hand-overs within 1.25× of the undisturbed run, back to her own pose, she stays where she stands`, async t => {
      const [control, event] = [await runCase(fps, null, afterOf(pull)), await runCase(fps, pull)];
      const hold = event.hold, c = control.shots, e = event.shots;
      const own = surprises(span(c, T0 - 1, T0 + hold + AFTER)).perBone, backLimit = pull.backS ?? 2.5;
      const press = surprises(span(e, T0 - edge, T0 + 0.6)).perBone, release = surprises(span(e, T0 + hold - edge, T0 + hold + 0.8)).perBone;
      const stepEvent = Math.max(...frameSteps(span(e, T0 - edge, T0 + hold + 1.5))), stepOwn = Math.max(...frameSteps(span(c, T0 - edge, T0 + hold + 1.5)));
      let back: number | null = null, off: number | null = null;
      for (let i = 0; i < e.length; i++) {
        if (e[i].t < T0 + hold) continue;
        const gap = Math.max(...e[i].rotations.map((q, b) => q.angleTo(c[i].rotations[b]) * DEG));
        if (back === null && gap < 0.5) back = e[i].t - (T0 + hold);
        if (off === null && !e[i].engaged) off = e[i].t - (T0 + hold);
      }
      const roots = e.map(s => Math.hypot(s.root.x, s.root.z) * 100), rootEnd = roots.at(-1)!;
      const worst = e.reduce((w, s) => s.layer ? { lean: Math.max(w.lean, s.layer.leanDeg), head: Math.max(w.head, s.layer.headDeg), arm: Math.max(w.arm, s.layer.armDeg), extend: Math.max(w.extend, s.layer.extend) } : w, { lean: 0, head: 0, arm: 0, extend: 0 });
      const numbers = { pressDeg: +Math.max(...press).toFixed(3), releaseDeg: +Math.max(...release).toFixed(3), ownDeg: +Math.max(...own).toFixed(3),
        stepDeg: +stepEvent.toFixed(3), ownStepDeg: +stepOwn.toFixed(3), backS: back, layerOffS: off, rootMaxCm: +Math.max(...roots).toFixed(3), rootEndCm: +rootEnd.toFixed(3), layer: worst };
      if (REPORT) console.log(`[window pull ${fps}] ${pull.name}: ${JSON.stringify(numbers)}`);
      t.diagnostic(JSON.stringify(numbers));
      // Her legs are the gait's: a pulled foot moves her weight and lifts that foot, held to the gait's own one-foot limit (tests/unbound-contact.test.ts).
      const limit = (b: number) => pull.name === 'pull on the foot' && LEGS.includes(b) ? (fps === 60 ? 0.6 : 1.6) : Math.max(floor, 1.25 * own[b]);
      press.forEach((v, b) => assert.ok(v <= limit(b), `press, ${TRACKED[b]}: ${v.toFixed(3)}° (own ${own[b].toFixed(3)}°)`));
      release.forEach((v, b) => assert.ok(v <= limit(b), `release, ${TRACKED[b]}: ${v.toFixed(3)}° (own ${own[b].toFixed(3)}°)`));
      assert.ok(back !== null && back <= backLimit, `within 0.5° of her own pose ${backLimit} s after the release (${back})`);
      assert.ok(off !== null && off <= 3.5, `the layer is off within 3.5 s of the release (${off})`);
      assert.ok(worst.lean <= 15 + 1e-6 && worst.head <= 10 + 1e-6 && worst.arm <= 40 + 1e-6 && worst.extend <= 1 + 1e-9, `the caps hold: ${JSON.stringify(worst)}`);
      assert.ok(Math.max(...roots) < 3, `she does not walk along (root ${Math.max(...roots).toFixed(3)} cm from her place)`);
      assert.ok(rootEnd < 0.5, `and ends at her place (${rootEnd.toFixed(3)} cm)`);
    });
  }

  test(`window pull (${fps} fps): a pulled foot puts her weight on the other one; both feet again after; her place stays the origin`, async () => {
    const r = await runCase(fps, CASES.find(c => c.name === 'pull on the foot')!);
    const during = r.shots.filter(s => s.t > T0 + 0.8 && s.t < T0 + r.hold), after = r.shots.at(-1)!;
    if (REPORT) console.log(`[window pull ${fps}] foot: stances during ${[...new Set(during.map(s => s.stance))].join(',')}, after ${after.stance}`);
    assert.ok(during.some(s => s.stance !== 'both'), `on one foot while it is pulled (${[...new Set(during.map(s => s.stance))]})`);
    assert.equal(after.stance, 'both');
  });
}

test('window pull gates: her own body only, shown, a hit this window made for the figure now, not asleep, not the hand while it is held', async () => {
  const g = await windowGene();
  try {
    for (let i = 0; i <= 60; i++) g.frame(i ? 1 / 60 : 0);
    const { pull, state } = rig(g);
    assert.equal(pull.mood(), null, 'no mood view yet: none');
    const hand = g.between('右ひじ', '右手首', 0.85), body = g.between('上半身', '上半身2', 0.9);
    assert.equal(pull.hit(5, 5), null, 'a press beside her is never a pull');
    const at = (a: string, b: string, k: number) => { const p = g.between(a, b, k); return pull.hit(p.x, p.y); };
    const right = at('右ひじ', '右手首', 0.85), leftLeg = at('左ひざ', '左足首', 0.5);
    assert.deepEqual([right?.group, right?.side], ['arm', 'right']);
    assert.deepEqual([leftLeg?.group, leftLeg?.side], ['leg', 'left']);
    assert.equal(at('頭', '頭先', 0.6)?.group, 'head');
    assert.equal(at('上半身', '上半身2', 0.9)?.group, 'torso');
    assert.ok(right!.heightPx > 200 && right!.heightPx < 700, `her height on the window ${right!.heightPx}`);
    // Hidden: no hit; a hit made while shown does not start once hidden.
    const shownHit = pull.hit(body.x, body.y)!;
    state.shown = false;
    assert.equal(pull.hit(body.x, body.y), null, 'hidden');
    assert.equal(pull.start(shownHit), false, 'hidden: no start');
    state.shown = true;
    // Only a hit this window made, for the figure shown now.
    assert.equal(pull.start({ ...shownHit }), false, 'a copy (made up) does not start');
    const stale = pull.hit(body.x, body.y)!;
    state.figure = { ...g.figure, pullEngaged: false } as unknown as WindowPullFigure; // another model now
    assert.equal(pull.start(stale), false, 'a hit from the model before does not start');
    state.figure = g.figure;
    assert.equal(pull.start(stale), true, 'the same hit on the same figure does');
    assert.equal(pull.stillAllowed('torso'), true);
    state.mood = awake('asleep');
    assert.equal(pull.stillAllowed('torso'), false, 'she fell asleep: the pull ends');
    assert.equal(pull.hit(body.x, body.y), null, 'asleep: no hit');
    state.mood = awake('micro-awake');
    assert.equal(pull.hit(body.x, body.y), null, 'micro-awake counts as asleep');
    pull.end();
    state.mood = awake();
    state.handBusy = true;
    assert.equal(pull.hit(hand.x, hand.y), null, 'her hand is in a hand-hold');
    assert.ok(pull.hit(body.x, body.y), 'the rest of her can still be pulled');
    state.handBusy = false;
    // Another figure now: a pull held on the old one may not go on (the companion's input cancels it).
    const held = pull.hit(body.x, body.y)!;
    assert.equal(pull.start(held), true);
    state.figure = { ...g.figure } as unknown as WindowPullFigure;
    assert.equal(pull.stillAllowed('torso'), false, 'the model changed under the pull');
    state.figure = g.figure; pull.end();
    state.mood = awake();
    assert.deepEqual(pull.mood(), { values: BASE, baseline: BASE, sleepy: 0, playful: 50 });
  } finally { g.close(); }
});

test('the companion\'s own pull input drives it end to end: a press on her body becomes a pull, she leans toward it, released she eases back, the host hears it', async () => {
  const g = await windowGene();
  try {
    const { pull, state } = rig(g);
    state.mood = awake();
    let clock = 0;
    const captured = new Set<number>();
    const surface = { setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
    const reports: PullReport[] = [];
    const stage = { pullHit: (x: number, y: number) => pull.hit(x, y), pullStart: (hit: never) => pull.start(hit), pullTo: (x: number, y: number) => pull.to(x, y),
      pullEnd: () => pull.end(), pullStillAllowed: (group: never) => pull.stillAllowed(group), pullMood: () => pull.mood(), setPullStance: (s: never) => pull.setStance(s) };
    // no-pet-ok: the input class keeps its name
    const input = new PetPull(surface as unknown as HTMLElement, { stage, send: report => reports.push(report) }, () => clock);
    const fps = 60;
    let from = { x: 0, y: 0 }, maxLean = 0, lastTick = 0;
    for (let frame = 0; frame <= fps * 7; frame++) {
      const t = frame / fps; clock = t * 1000;
      if (frame === fps * 2) { from = g.between('上半身', '上半身2', 0.9); assert.equal(input.press(1, from), true, 'the press is on her'); }
      if (t > 2 && t < 4) input.move({ x: from.x + 120 * smooth((t - 2) / 0.5), y: from.y });
      if (frame === fps * 4) input.release();
      if (clock - lastTick >= 100) { input.tick(); lastTick = clock; }
      g.frame(frame ? 1 / fps : 0);
      maxLean = Math.max(maxLean, g.figure.pullState?.leanDeg ?? 0);
    }
    const ended = reports.filter(r => r.ended).at(-1);
    assert.ok(maxLean > 2, `she leans toward the pull (${maxLean.toFixed(2)}°)`);
    assert.equal(ended?.ended, 'released');
    assert.equal(ended?.part, 'torso');
    assert.equal(g.figure.pullEngaged, false, 'eased back');
    assert.equal(captured.size, 0, 'the pointer is let go');
    assert.ok(Math.hypot(g.figure.placement.xM, g.figure.placement.depthM) < 0.005, 'she stays at her place');
  } finally { g.close(); }
});
