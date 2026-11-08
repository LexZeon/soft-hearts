import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Euler, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { projectCheekRegions } from '../src/stage/cheek-pinch-region';
import { CheekPinchTracker, hitCheek } from '../src/ui/CheekPinch';
import { projectCheekRegions as legacyProjection } from './fixtures/r05-legacy-cheek-projection';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/blush';
import { loadPublicGene } from './helpers/r05-public-gene-fixture';

const gene = await loadPublicGene();
const originalQ = gene.head.quaternion.clone(), originalScale = gene.head.scale.clone();
const headWorld = gene.head.getWorldPosition(new Vector3());
const camera = (distance = 12, width = 400, height = 560) => {
  const view = new PerspectiveCamera(32, width / height, .1, 1000);
  view.position.set(headWorld.x, headWorld.y + .1, distance);
  view.lookAt(headWorld.x, headWorld.y + .1, 0); view.updateWorldMatrix(true, false); return view;
};
const reset = () => { gene.head.quaternion.copy(originalQ); gene.head.scale.copy(originalScale); gene.head.updateWorldMatrix(true, true); };
const screen = (local: Vector3, view: PerspectiveCamera, w = 400, h = 560) => {
  const point = local.clone().applyMatrix4(gene.head.matrixWorld).project(view);
  return { x: (point.x + 1) * w / 2, y: (1 - point.y) * h / 2 };
};
const witnessReport = JSON.parse(readFileSync(new URL('./fixtures/r05-front-witness.json', import.meta.url), 'utf8'));
const witness = witnessReport.witnesses.find((w: any) => w.confirmedNamedFace);
assert.ok(witness);
const face = gene.materialVertices.find((m) => m.name === '顔')!, eyes = gene.materialVertices.find((m) => m.name === '目')!;
const witnessPoint = face.points.find(p => p.index === witness.index)!.point;
const evidence: any = { scope: 'new actual production projection+hit/tracker CPU only; no native/GPU/normal/model identity claim', tests: [] };
const runId = process.env.R05_HIT_RUN ?? 'runtime-hit-01';
assert.match(runId, /^runtime-hit-\d+$/);
after(() => { reset(); gene.dispose(); if (process.env.R05_HIT_REPORT === '1') writeFileSync(path.join(tmpdir(), 'soft-hearts-r05-' + runId + '-' + process.pid + '.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' }); });

test('actual public Gene outer face witness is newly selectable; unverified/default-argument projection remains byte-shape equivalent', () => {
  reset(); const view = camera();
  const old = legacyProjection(gene.anchors, gene.head, view, 400, 560, 100);
  assert.deepEqual(projectCheekRegions(gene.anchors, gene.head, view, 400, 560, 100), old);
  assert.deepEqual(projectCheekRegions(gene.anchors, gene.head, view, 400, 560, 100, false), old);
  const regions = projectCheekRegions(gene.anchors, gene.head, view, 400, 560, 100, true);
  assert.equal(regions.length, 2); assert.ok(regions.every(r => r.exclusions?.length === 4 && r.referenceWidth === 100));
  const pixel = screen(witnessPoint, view);
  assert.equal(hitCheek(pixel.x, pixel.y, old), null);
  assert.ok(hitCheek(pixel.x, pixel.y, regions), 'A real newly covered face vertex, not only larger empty area.');
  const before = regions.map(r => [r.x, r.y, r.axisXX, r.axisXY, r.axisYX, r.axisYY]);
  assert.deepEqual(projectCheekRegions(gene.anchors, gene.head, view, 400, 560, 100, true).map(r => [r.x, r.y, r.axisXX, r.axisXY, r.axisYX, r.axisYY]), before);
  evidence.tests.push({ name: 'real outer face', witnessIndex: witness.index, actualModel: gene.identities[2], regions: before });
});

test('actual production hit excludes eye/nose/mouth across selected perspective, roll and nonuniform head transforms', () => {
  // Exact primary targets; e.g. えー also affects extraoral lower-cheek skin.
  // Protect their FULL support, without the old spatial sampling filter.
  const mouthIndices = new Set<number>(gene.data.morphs.filter((m: any) => m.type === 1 && ['あ', 'い', 'う', 'え', 'お', 'にやり'].includes(m.name)).flatMap((m: any) => m.elements.map((e: any) => e.index)));
  const features = [...eyes.points,
    ...face.points.filter(p => Math.abs(p.x) < .25 && p.y > -.68 && p.y < .2 && p.z > -.05),
    ...face.points.filter(p => mouthIndices.has(p.index))];
  const envelope = JSON.parse(readFileSync(new URL('./fixtures/r05-primary-mouth-envelope.json', import.meta.url), 'utf8')).independentPrimaryMixtures;
  const corners: Vector3[] = [];
  for (const x of [envelope.min[0], envelope.max[0]]) for (const y of [envelope.min[1], envelope.max[1]]) for (const z of [envelope.min[2], envelope.max[2]])
    corners.push(gene.eyeMidpoint.clone().addScaledVector(gene.right, x * gene.anchors.eyeDistance)
      .addScaledVector(gene.up, y * gene.anchors.eyeDistance).addScaledVector(gene.forward, z * gene.anchors.eyeDistance));
  let checked = 0; const observations = [];
  const cases = [[0, 0, 0, 1, 1, 1, 12, 400, 560], [0, .61, 0, 1, 1, 1, 12, 400, 560],
    [0, -.61, 0, 1, 1, 1, 12, 400, 560], [.12, .3, .24, .8, 1.2, .9, 12, 560, 400],
    [-.1, -.3, -.24, 1.2, .8, 1.1, 12, 560, 400], [0, 0, 0, 1, 1, 1, 40, 400, 560]];
  for (const [rx, ry, rz, sx, sy, sz, distance, w, h] of cases) {
    reset(); gene.head.quaternion.multiply(new (originalQ.constructor as any)().setFromEuler(new Euler(rx, ry, rz)));
    gene.head.scale.set(sx, sy, sz); gene.head.updateWorldMatrix(true, true);
    const view = camera(distance, w, h), regions = projectCheekRegions(gene.anchors, gene.head, view, w, h, 100, true);
    assert.ok(regions.length > 0, 'Selected visible scopes must not pass by rejecting every cheek.');
    for (const feature of features) {
      const pixel = screen(feature.point, view, w, h);
      assert.equal(hitCheek(pixel.x, pixel.y, regions), null, `Protected actual vertex ${feature.index} at yaw${ry}`); checked++;
    }
    for (const corner of corners) {
      const pixel = screen(corner, view, w, h);
      assert.equal(hitCheek(pixel.x, pixel.y, regions), null, 'The primary-mouth mixture envelope stays excluded.'); checked++;
    }
    observations.push({ rotation: [rx, ry, rz], scale: [sx, sy, sz], distance, size: [w, h], regionCount: regions.length });
  }
  evidence.tests.push({ name: 'production protected features', checks: checked, cases: observations });
});

test('new guarded admission keeps the actual held reference unit, drag cancellation and one release event', () => {
  reset(); const view = camera(), regions = projectCheekRegions(gene.anchors, gene.head, view, 400, 560, 100, true);
  const point = screen(witnessPoint, view), events: any[] = [];
  const tracker = new CheekPinchTracker({ onState() {}, onFeedback() {}, onEvent: e => events.push(e) }, 'new-region-only');
  const eye = screen(eyes.points[0].point, view);
  assert.equal(tracker.press(eye.x, eye.y, 0, regions), false);
  assert.equal(tracker.press(point.x, point.y, 0, regions), true);
  const id = tracker.state.sessionId, side = tracker.feedback.side;
  tracker.hover(eye.x, eye.y, []); assert.equal(tracker.state.sessionId, id);
  for (let i = 1; i <= 4; i++) tracker.move(point.x + i * 3, point.y, i * 50, 1);
  assert.equal(tracker.feedback.x, .12); assert.equal(tracker.feedback.side, side);
  tracker.release(200); tracker.release(201);
  assert.equal(events.length, 1); assert.equal(events[0].sessionId, id); assert.equal(events[0].activeMs, 200);
  assert.equal(tracker.press(point.x, point.y, 300, regions), true);
  tracker.move(point.x + 10, point.y, 400, 0); tracker.release(401);
  assert.equal(events.length, 1); assert.equal(tracker.state.phase, 'idle');
  for (const bad of [[], null, [{ points: [{ x: NaN, y: 0 }], padding: 1 }],
    regions[0].exclusions!.map((guard, i) => i ? guard : { ...guard, padding: 3 })]) {
    const broken = regions.map(r => ({ ...r, exclusions: bad as any }));
    assert.equal(hitCheek(point.x, point.y, broken), null, 'Malformed declared guards never restore an unguarded broad hit.');
  }
  evidence.tests.push({ name: 'tracker admission/hold', events: events.length, activeMs: events[0].activeMs, originalReferenceWidth: 100 });
});

test('the actual Stage interaction getter enables calibration only for verified Gene with default anchors', () => {
  reset(); const target = fileURLToPath(new URL('../src/stage/MmdStage.ts', import.meta.url));
  const text = readFileSync(target, 'utf8'), ast = ts.createSourceFile(target, text, ts.ScriptTarget.Latest, true);
  const subject = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MmdStage') as ts.ClassDeclaration;
  const method = subject.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'getInteractionRegion')!;
  const js = ts.transpileModule(`class Subject { ${method.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const Subject = new Function('Vector3', 'MathUtils', 'clamp', 'probeHeadContact', 'projectHeadContact', 'projectCheekRegions', 'DEFAULT_BLUSH_CALIBRATION', `${js}; return Subject;`)(Vector3, MathUtils,
    (n: number, low: number, high: number) => Math.max(low, Math.min(high, n)), () => ({}), () => ({ x: 200, y: 200 }), projectCheekRegions, DEFAULT_BLUSH_CALIBRATION);
  const s = new Subject(); Object.assign(s, { mesh: gene.mesh, head: gene.head, eyes: gene.eyes, camera: camera(), height: 20,
    hostVisible: true, controls: { interacting: false }, container: { clientWidth: 400, clientHeight: 560 },
    renderer: { domElement: { dataset: {} } }, cheekAnchors: gene.anchors, tearsVerifiedGene: false,
    modelUrl: 'synthetic-public-model', blushCalibrationModelUrl: 'synthetic-public-model', blushCalibration: { ...DEFAULT_BLUSH_CALIBRATION } });
  const unverified = s.getInteractionRegion(); assert.equal(unverified.cheeks.length, 2); assert.ok(unverified.cheeks.every((r: any) => r.exclusions === undefined));
  s.tearsVerifiedGene = true; const verified = s.getInteractionRegion(); assert.ok(verified.cheeks.every((r: any) => r.exclusions.length === 4));
  assert.equal(verified.referenceWidth, unverified.referenceWidth); assert.equal(verified.mouthRadius, unverified.mouthRadius);
  s.blushCalibration.eyeSpacingScale = 1.1; assert.ok(s.getInteractionRegion().cheeks.every((r: any) => r.exclusions === undefined));
  s.hostVisible = false; assert.equal(s.getInteractionRegion(), null);
  s.hostVisible = true; s.controls.interacting = true; assert.equal(s.getInteractionRegion(), null);
  evidence.tests.push({ name: 'actual Stage getter', trustedContentAndDefaultOnly: true, currentDailyModelIdentity: 'UNKNOWN' });
});
