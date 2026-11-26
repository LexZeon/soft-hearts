// Full-screen Unbound: where her feet are (docs/claude/2026-11-21-unbound-floor-line.md). The user (2026-11-21, a screenshot of full-screen
// Unbound): "同样是unbound，gene站在比较下面". Two facts this pins, so a later change sees which one it moved:
//  1. Every model stands with her soles on her floor: the bundled Gene (as reviewed, and as another PMX through the motion fitting) and a
//     VRM on the standard skeleton, in her default stand, within a few millimetres. Nothing about the model puts Gene lower.
//  2. Where the floor shows on the screen depends on how far back she stands: the eye height is fitted so that at her home depth (8 m) her
//     feet are just above the work area's bottom (shared/unbound/world.ts eyeHeightFor); nearer, her feet go behind the taskbar; further,
//     they stand above it. This is what made Gene look lower: she stood nearer than home. This is the HOST's eye (the scene's); since the
//     user chose A (2026-11-21) the full-screen page moves its eye with her depth and her feet stay on the line: tests/unbound-floor-follow.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, type AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { UnboundFigure, UNITS_PER_M } from '../src/unbound/figure';
import { parseVmdWith, type VmdDataTransform } from '../src/foundation/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { StageMotionRetarget } from '../src/actions/motion-retarget';
import { StageModelProfile } from '../src/stage/model-profile';
import { DEFAULT_DEPTH_M, DEFAULT_VIEWER_DISTANCE_M, HOME_FEET_MARGIN_DIP, eyeHeightFor, projectToDip, resolvePhysicalScreen, type DisplayFacts } from '../shared/unbound/world';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { STAND_VMD } from './helpers/unbound-gene';
import { syntheticStandardBody } from './helpers/unbound-vrm';

async function stand(mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, transform);
  const clip = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(v: unknown, m: SkinnedMesh): AnimationClip } }).animationBuilder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 4); return clip;
}

test('every model stands with her soles on her floor in her default stand (Gene reviewed, Gene as another PMX, a VRM)', async () => {
  for (const kind of ['Gene (reviewed)', 'Gene as another PMX', 'a VRM (synthetic)'] as const) {
    let mesh: SkinnedMesh, transform: VmdDataTransform | undefined, drawn: { updateMatrixWorld(force: boolean): void }, close: () => void, present = () => {};
    if (kind === 'a VRM (synthetic)') { const b = await syntheticStandardBody('1.0'); mesh = b.mesh; transform = b.transform; drawn = b.model.object; close = () => b.dispose(); present = () => b.present(); }
    else {
      const fx = await loadPublicGeneForTargets(); mesh = fx.mesh; drawn = mesh; close = () => fx.close();
      if (kind === 'Gene as another PMX') transform = new StageMotionRetarget(mesh, new StageModelProfile(mesh, { reviewed: false }).profile, { reviewed: false }).transform;
    }
    try {
      const figure = new UnboundFigure(mesh, { xM: 0, depthM: DEFAULT_DEPTH_M });
      figure.setClips({ pose: await stand(mesh, transform), gesture: null, expression: null }, false);
      for (let i = 0; i < 180; i++) { figure.frame(i ? 1 / 60 : 0); present(); }
      drawn.updateMatrixWorld(true);
      const box = new Box3().setFromObject(drawn as never, true), soleCm = box.min.y / UNITS_PER_M * 100;
      console.log(`${kind}: lowest drawn point ${soleCm.toFixed(1)} cm from her floor, top ${(box.max.y / UNITS_PER_M).toFixed(3)} m`);
      assert.ok(Math.abs(soleCm) < 1, `${kind}: soles on the floor (${soleCm.toFixed(2)} cm)`);
      figure.dispose();
    } finally { close(); }
  }
});

test('the floor on the screen: her feet are at the work area line at her home depth, behind the taskbar nearer, above it further', () => {
  const display: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
  const screen = resolvePhysicalScreen(display, null), d = DEFAULT_VIEWER_DISTANCE_M;
  const view = { screen, display: display.bounds, viewerDistanceM: d, eyeHeightM: eyeHeightFor(screen, display, d) };
  const line = display.workArea.height - HOME_FEET_MARGIN_DIP;
  const feetAt = (depthM: number) => projectToDip(view as never, { x: 0, y: 0, z: -depthM })!.y;
  for (const depth of [5, 6.6, 7, 8, 10, 12.5]) {
    const feet = feetAt(depth), head = projectToDip(view as never, { x: 0, y: 1.6, z: -depth })!.y;
    console.log(`depth ${depth} m: feet ${(feet - line).toFixed(0)} DIP from the floor line (${feet > display.workArea.height ? `${((feet - display.workArea.height) / (feet - head) * 100).toFixed(0)}% of a 1.6 m figure behind the taskbar` : 'visible'})`);
  }
  assert.ok(Math.abs(feetAt(DEFAULT_DEPTH_M) - line) < 0.5, 'at home: on the line');
  assert.ok(feetAt(5) > display.workArea.height + 150 && feetAt(12.5) < line - 100, 'nearer below, further above (one eye height for the session)');
});
