/**
 * I-169 (docs/claude/2026-11-21-i169-gaze-debug.md) on Unbound's engine: the window (WindowLiveliness, the code its stage runs) and the
 * full-screen page's developer overlay. Developer mode off: no node; on: the label and the dot, the turn they show is what the figure shows;
 * hiding the overlay takes them away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from 'three';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { DebugOverlay } from '../src/unbound/overlay';
import { gazeDebug } from '../src/senses';
import type { UserGazeReading } from '../shared/behaviors/gaze-attention/interface';
import { card, faceView } from './helpers/window-face-fixture';
import { windowGene, WINDOW } from './helpers/unbound-window';

const YOU: UserGazeReading = { present: true, facing: 'toward', energy: 0.1, point: { x: -0.6, y: 0.4, dx: 3, dy: 3 }, screen: null };
const seeded = (seed = 5) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
interface Fake { dataset: Record<string, string>; style: Record<string, string>; textContent: string; offsetWidth: number; offsetHeight: number; gone?: boolean; remove(): void }

async function run(developerMode: boolean) {
  const made: Fake[] = [];
  Object.assign(globalThis, { document: { createElement: () => { const e: Fake = { dataset: {}, style: {}, textContent: '', offsetWidth: 190, offsetHeight: 54, remove() { this.gone = true; } }; made.push(e); return e; }, body: { append() {} } } });
  const g = await windowGene();
  try {
    const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true }), rig = windowFaceRig(mesh, profile, true, g.figure.head);
    const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
    face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace']));
    const lively = new WindowLiveliness(() => {}, seeded(9)), scene = new Scene();
    scene.add(mesh);
    lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
    const view = { ...faceView({ primary: 'calm', companion: null }), developerMode };
    for (let i = 0; i < 60 * 8; i++) {
      if (i % 6 === 0) lively.gaze.set(YOU);
      lively.frame(i ? 1 / 60 : 0, g.body, face, { view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: false }, pointer: { x: 0.4, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false,
        breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false, camera: g.camera, lift: g.figure.floorUnits, width: WINDOW.width, height: WINDOW.height, scene });
    }
    return { made, shown: g.figure.gazeShown, text: made[0]?.textContent ?? null };
  } finally { g.close(); }
}

test('the window on Unbound\'s engine: developer mode off creates nothing; on shows the label and dot with the turn the figure shows', async () => {
  const off = await run(false);
  assert.equal(off.made.length, 0, 'no DOM node with developer mode off');
  const on = await run(true);
  assert.equal(on.made.length, 2);
  assert.match(on.text!, /^在看：.+\n.+\n眼 \d+\.\d° · 头 \d+\.\d°$/);
  const head = Math.hypot(on.shown.head.yaw, on.shown.head.pitch) * 180 / Math.PI, eyes = Math.hypot(on.shown.eyes.yaw, on.shown.eyes.pitch) * 180 / Math.PI;
  assert.ok(head + eyes > 1, `she is turned toward you (head ${head.toFixed(1)}°, eyes ${eyes.toFixed(1)}°)`);
});

test('the full-screen page\'s developer overlay: hiding it takes the gaze label and dot away', () => {
  const made: Fake[] = [];
  const doc = { createElement: (tag: string) => { const e = { dataset: {}, style: {}, textContent: '', offsetWidth: 190, offsetHeight: 54, hidden: false, className: '', remove() { this.gone = true; }, getContext: () => null } as Fake & { hidden: boolean; className: string; getContext(): null }; made.push(e); void tag; return e; }, body: { append() {} } };
  Object.assign(globalThis, { document: doc });
  const overlay = new DebugOverlay(new Scene(), { ownerDocument: doc, append() {} } as unknown as HTMLElement);
  const before = made.length;
  overlay.setVisible(true);
  const view = gazeDebug(overlay, true);
  assert.ok(view, 'the page shows the view while the overlay shows');
  assert.equal(made.length, before + 2);
  overlay.setVisible(false);
  assert.ok(made.slice(before).every(node => node.gone), 'both nodes go with the overlay');
  assert.equal(gazeDebug(overlay, false), null);
});

