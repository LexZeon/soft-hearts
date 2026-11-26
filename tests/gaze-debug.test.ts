/**
 * I-169 (docs/claude/2026-11-21-i169-gaze-debug.md): developer mode shows where she looks. The readout's text (target, weights, reason,
 * angles), the dot's place and easing, the gate (nothing created or computed with developer mode off, on the real stage frame loop
 * too), and that reading it changes nothing about how she looks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StageGazeAttention } from '../src/senses/gaze-attention-stage';
import { GazeDebugView, GazeDot, blendSpot, fallbackReadout, gazeDebug, gazeLines, lineOfSight, turnDeg, unitsToPx } from '../src/senses/gaze-debug-view';
import { flatGazeFrame, legacyGazeFrame } from '../src/senses/gaze-debug-flat';
import { sightOnScreenM } from '../src/unbound/her/gaze-debug';
import { setUiLanguage } from '../src/foundation/ui-language';
import type { UserGazeReading } from '../shared/behaviors/gaze-attention/interface';

interface FakeEl { dataset: Record<string, string>; style: Record<string, string>; textContent: string; offsetWidth: number; offsetHeight: number; removed: boolean; remove(): void }
function fakeDoc() {
  const made: FakeEl[] = [], appended: FakeEl[] = [];
  const doc = { createElement: () => { const e: FakeEl = { dataset: {}, style: {}, textContent: '', offsetWidth: 190, offsetHeight: 54, removed: false, remove() { this.removed = true; } }; made.push(e); return e as unknown as HTMLElement; },
    body: { append: (...nodes: unknown[]) => { appended.push(...(nodes as FakeEl[])); } } };
  return { made, appended, doc: doc as unknown as ConstructorParameters<typeof GazeDebugView>[0] };
}
const DEG = Math.PI / 180;
const seeded = (seed = 7) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };

test('the label: who she looks at, the three weights, the last reason, how far eyes and head are turned', () => {
  const lines = gazeLines({ target: 'user', user: 0.8, mouse: 0.2, away: 0, why: '亲近、想你', eyeDeg: 8.04, headDeg: 3.01 });
  assert.equal(lines[0], '在看：你');
  assert.equal(lines[1], '你 0.8 · 鼠标 0.2 · 别处 0.0 · 刚换的原因：亲近、想你');
  assert.equal(lines[2], '眼 8.0° · 头 3.0°');
  assert.equal(gazeLines({ target: 'mouse', user: 0, mouse: 1, away: 0, why: '', eyeDeg: 0, headDeg: 0 })[1], '你 0.0 · 鼠标 1.0 · 别处 0.0');
  assert.equal(gazeLines({ target: 'away', user: 0, mouse: 0, away: 1, why: '', eyeDeg: 0, headDeg: 0 })[0], '在看：别处');
  assert.ok(Math.abs(turnDeg({ yaw: 6 * DEG, pitch: 8 * DEG }) - 10) < 1e-9, 'yaw and pitch together');
  assert.equal(turnDeg({ yaw: NaN, pitch: 0 }), 0);
});

test('the label in English: the interface language also carries the reasons', () => {
  setUiLanguage('en');
  try {
    const lines = gazeLines({ target: 'mouse', user: 0.1, mouse: 0.9, away: 0, why: '好奇、有点无聊', eyeDeg: 2, headDeg: 0 });
    assert.equal(lines[0], 'Looking at: mouse');
    assert.match(lines[1], /you 0\.1 · mouse 0\.9 · elsewhere 0\.0 · why she just switched: curious, a little bored/i);
    assert.equal(lines[2], 'eyes 2.0° · head 0.0°');
  } finally { setUiLanguage('zh-CN'); }
});

test('without the chooser: the mouse while 「跟着鼠标看」 is on, else neither', () => {
  assert.equal(fallbackReadout(true).target, 'mouse');
  assert.equal(fallbackReadout(false).target, 'away');
  assert.equal(fallbackReadout(false).why, '没开「跟着鼠标看」');
});

test('where the dot goes: the cursor, your head, the line of sight, by the chooser weights; unknown places hand their share to the others', () => {
  const places = { mouse: { x: 100, y: 100 }, user: { x: 300, y: 50 }, sight: { x: 500, y: 400 } };
  assert.deepEqual(blendSpot({ user: 0, mouse: 1, away: 0 }, places), places.mouse);
  assert.deepEqual(blendSpot({ user: 1, mouse: 0, away: 0 }, places), places.user);
  assert.deepEqual(blendSpot({ user: 0, mouse: 0, away: 1 }, places), places.sight);
  assert.deepEqual(blendSpot({ user: 0.5, mouse: 0.5, away: 0 }, places), { x: 200, y: 75 });
  assert.deepEqual(blendSpot({ user: 0.5, mouse: 0.5, away: 0 }, { ...places, user: null }), places.mouse, 'your head is not known: the mouse takes its share');
  assert.equal(blendSpot({ user: 1, mouse: 0, away: 0 }, { mouse: places.mouse, user: null, sight: null }), null);
  assert.deepEqual(unitsToPx(-1, 1, 400, 600), { x: 0, y: 0 });
  assert.deepEqual(unitsToPx(1, -1, 400, 600), { x: 400, y: 600 });
  const sight = lineOfSight({ x: 200, y: 300 }, 45 * DEG, 0, 100)!;
  assert.ok(Math.abs(sight.x - 300) < 1e-9 && sight.y === 300, 'yaw to the right moves the spot right');
  assert.ok(lineOfSight({ x: 0, y: 0 }, 0, 45 * DEG, 100)!.y < 0, 'pitch up moves the spot up the screen');
  assert.equal(lineOfSight({ x: 0, y: 0 }, 0, 0, 0), null);
});

test('her line of sight meets the screen plane (full-screen): straight ahead, to her left, and not when she looks away from it', () => {
  const head = { x: 0, y: 1.2, z: -0.3 };
  assert.deepEqual(sightOnScreenM(head, 0, 0, 0), { x: 0, y: 1.2, z: 0 });
  const left = sightOnScreenM(head, 0, 45 * DEG, 0)!;
  assert.ok(Math.abs(left.x - 0.3) < 1e-9 && Math.abs(left.y - 1.2) < 1e-9, 'her left is the screen\'s right as you see it');
  const up = sightOnScreenM(head, 0, 0, 30 * DEG)!;
  assert.ok(up.y > 1.2, 'a look up meets the screen higher');
  assert.equal(sightOnScreenM(head, Math.PI, 0, 0), null, 'turned away from the screen');
  assert.equal(sightOnScreenM(head, 0, 90 * DEG, 0), null);
  const turned = sightOnScreenM(head, 0.5, 0.5, 0)!;
  assert.ok(Number.isFinite(turned.x) && turned.z === 0, 'a turned body still gives a point');
});

/** Per-frame step of the dot while the goal switches back and forth between two far spots. */
function steps(fps: number): { first: number; most: number; at1s: number } {
  const dot = new GazeDot(), dt = 1 / fps, trail: Array<{ x: number; y: number }> = [];
  dot.frame(dt, { x: 100, y: 100 });
  let first = -1, most = 0, at1s = 0;
  for (let i = 0; i < fps * 6; i++) {
    const t = i * dt, goal = Math.floor(t / 1.5) % 2 === 0 ? { x: 100, y: 100 } : { x: 1700, y: 900 };
    const before = { x: dot.x, y: dot.y };
    dot.frame(dt, goal);
    const step = Math.hypot(dot.x - before.x, dot.y - before.y);
    if (first < 0 && t >= 1.5) first = step;
    most = Math.max(most, step);
    trail.push({ x: dot.x, y: dot.y });
    if (i === Math.round(fps * 2.5) - 1) at1s = dot.x;
  }
  return { first, most, at1s };
}

for (const fps of [60, 30]) {
  test(`the dot eases at ${fps} fps: starts from rest, never faster than its cap, never overshoots, same path at either frame rate`, () => {
    const s = steps(fps), cap = 1800 / fps;
    assert.ok(s.first < 10, `it starts gently when the goal switches (${s.first.toFixed(2)} px in the first frame)`);
    assert.ok(s.most <= cap + 1e-6, `no frame moves more than ${cap.toFixed(0)} px (${s.most.toFixed(1)})`);
    const other = steps(fps === 60 ? 30 : 60);
    assert.ok(Math.abs(s.at1s - other.at1s) < 25, `one second after the switch both frame rates are in about the same place (${s.at1s.toFixed(0)} vs ${other.at1s.toFixed(0)} px)`);
    const dot = new GazeDot();
    dot.frame(1 / fps, { x: 0, y: 0 });
    for (let i = 0; i < fps * 3; i++) { dot.frame(1 / fps, { x: 500, y: 0 }); assert.ok(dot.x <= 500 + 1e-6, 'no overshoot'); }
    assert.ok(dot.x > 495, 'and it gets there');
  });
}

test('the gate: with developer mode off nothing is created and no frame is built; on creates the label and the dot; off again takes them away', () => {
  const { made, appended, doc } = fakeDoc(), owner = {};
  let built = 0;
  for (let i = 0; i < 10; i++) gazeDebug(owner, false, doc)?.frame((built++, {} as never));
  assert.equal(made.length, 0, 'no DOM node with developer mode off');
  assert.equal(built, 0, 'the frame is not even built');
  const view = gazeDebug(owner, true, doc)!;
  assert.equal(made.length, 2); assert.equal(appended.length, 2);
  assert.equal(gazeDebug(owner, true, doc), view, 'one view per owner');
  assert.equal(made.length, 2);
  assert.equal(gazeDebug(owner, false, doc), null);
  assert.ok(made.every(node => node.removed), 'both nodes are taken away');
  assert.equal(gazeDebug(owner, false, doc), null);
  assert.equal(made.length, 2, 'off again creates nothing');
});

test('a readout never breaks her: no usable document, or a frame that cannot be built, is dropped quietly', () => {
  assert.equal(gazeDebug({}, true, { body: { append() {} } } as never), null, 'a document without createElement: no readout');
  assert.equal(gazeDebug({}, true, { createElement() { throw Error('no'); }, body: { append() {} } } as never), null, 'a document that throws: no readout');
  const { doc } = fakeDoc(), view = new GazeDebugView(doc);
  assert.doesNotThrow(() => view.frame(null));
  assert.doesNotThrow(() => view.frame({ chosen: null } as never));
  assert.equal(legacyGazeFrame({} as never, 0.016, 0, 0, true), null);
});

const toward = (x: number, y = 0): UserGazeReading => ({ present: true, facing: 'toward', energy: 0.2, screen: null, turn: { x: 0, y: 0 }, point: { x, y, dx: 3, dy: 3 } });

test('driven by the real chooser: label text and dot follow the switches, and the dot never jumps at 60 or 30 fps', () => {
  for (const fps of [60, 30]) {
    const { doc, made } = fakeDoc(), view = new GazeDebugView(doc), attention = new StageGazeAttention(seeded());
    const dt = 1 / fps, targets = new Set<string>();
    let last: { x: number; y: number } | null = null, most = 0;
    for (let i = 0; i < fps * 40; i++) {
      attention.frame({ delta: dt, follow: true, allowed: true, mouseX: 0.6, mouseY: 0.1, originX: 0, originY: 0, reading: toward(-0.5, 0.3), mood: null });
      const r = attention.readout();
      targets.add(r.chosen.target);
      const turn = { yaw: 0.1, pitch: 0.02 };
      view.frame(flatGazeFrame({ dt, width: 400, height: 560, attention: r, follow: true, pointer: { x: 0.6, y: 0.1 }, eyes: { x: 0, y: 0.4 }, head: turn, eyesTurn: turn }));
      const at = view.dotAt;
      if (at && last) most = Math.max(most, Math.hypot(at.x - last.x, at.y - last.y));
      last = at;
    }
    assert.ok(targets.has('user') && targets.has('mouse'), `${fps} fps: she looked at you and at the mouse (${[...targets].join(', ')})`);
    assert.ok(most <= 1800 / fps + 1e-6, `${fps} fps: the dot's biggest step ${most.toFixed(1)} px`);
    assert.match(made[0].textContent, /^在看：.+\n.+\n眼 \d+\.\d° · 头 \d+\.\d°$/);
  }
});

test('reading the chooser changes nothing about how she looks', () => {
  const plain = new StageGazeAttention(seeded(3)), watched = new StageGazeAttention(seeded(3));
  for (let i = 0; i < 600; i++) {
    const input = { delta: 1 / 60, follow: true, allowed: true, mouseX: 0.3, mouseY: 0, originX: 0, originY: 0, reading: toward(-0.4), mood: null };
    const a = plain.frame(input), b = watched.frame(input);
    watched.readout();
    assert.deepEqual({ ...a, targets: 0 }, { ...b, targets: 0 });
    assert.deepEqual(plain.diagnostics(i * 16.7), watched.diagnostics(i * 16.7));
  }
});

test('flat hosts: the label sits beside her eyes, your head and the cursor are where they are, a missing chooser still shows the mouse', () => {
  const frame = flatGazeFrame({ dt: 0.016, width: 400, height: 600, attention: { chosen: { target: 'user', user: 1, mouse: 0, away: 0, why: '' }, user: { x: -0.5, y: 0.5, dx: 3, dy: 3 } },
    follow: true, pointer: { x: 0.5, y: -0.5 }, eyes: { x: 0, y: 0.5 }, head: { yaw: 0.2, pitch: 0 }, eyesTurn: { yaw: 0.1, pitch: 0 } });
  assert.deepEqual(frame.anchor, { x: 200, y: 150 });
  assert.deepEqual(frame.user, { x: 100, y: 150 });
  assert.deepEqual(frame.mouse, { x: 300, y: 450 });
  assert.ok(frame.sight && frame.sight.x > 200 && frame.sight.y === 150);
  const none = flatGazeFrame({ dt: 0.016, width: 400, height: 600, attention: null, follow: true, pointer: { x: 0, y: 0 }, eyes: null, head: { yaw: 0, pitch: 0 }, eyesTurn: { yaw: 0, pitch: 0 } });
  assert.equal(none.chosen, null); assert.equal(none.anchor, null); assert.equal(none.user, null);
  const { doc, made } = fakeDoc(), view = new GazeDebugView(doc);
  view.frame(none);
  assert.match(made[0].textContent, /^在看：鼠标\n/);
  const stage = { pointer: { x: 0.2, y: 0 }, gaze: { x: 0.1, y: 0.05 }, eyeGaze: { x: 0.02, y: 0 }, moodFeedback: { attentionWeight: 0.5 }, renderer: { domElement: { clientWidth: 400, clientHeight: 600 } } };
  const legacy = legacyGazeFrame(stage, 0.016, 0, 0, true)!;
  assert.ok(Math.abs(legacy.head.yaw - 0.05) < 1e-9, 'the head turn is scaled the way the stage applies it');
  assert.equal(legacy.width, 400);
});
