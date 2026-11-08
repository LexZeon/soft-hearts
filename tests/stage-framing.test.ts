import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { CameraConfig } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { cameraBasis } from '../src/stage/CameraController';
import { projectHeadContact, type HeadContactProfile } from '../src/stage/head-contact';
import { FRAMING_TOP_BAND, framingCamera, framingTopBand, isUnframedCamera, type FramingModel } from '../src/stage/stage-framing';
import { isPetControlPoint } from '../src/ui/MoodCompanion';
import { HOVER_REVEAL_MARGIN, nearHoverZone } from '../src/ui/HoverVisibility';

// The bundled Gene as the real pet measured it (scripts/crown-reach-probe.mjs, 2026-11-02): the old recovered camera
// (width-limited: her bind pose is 16.2 wide) and a band-framed one give her bounds; the fresh and recovered
// cameras give the crown centre (19.29, z 0.43) and its half size.
const GENE: FramingModel = { height: 19.9603, width: 16.2018, baseY: -0.0026, centerX: 0 };
const CROWN = { center: new Vector3(0, 19.29, 0.43), halfWidth: 1.23, halfHeight: 0.6 };
const PET = { width: 400, height: 560 };
// The expanded toolbar in the default window: layout 8..392 x 7..97.2; while faded it is lifted 4 px (3..93.2).
// It reveals itself 24 px outside its box (HoverVisibility), so the pet reports a reach of 121.2 px.
const TOOLBAR = { left: 8, right: 392, top: 7, bottom: 97.2, fadedTop: 3, fadedBottom: 93.2, reach: 97.2 + HOVER_REVEAL_MARGIN };

function camera(config: CameraConfig, width = PET.width, height = PET.height) {
  const value = new PerspectiveCamera(config.fov, width / height, 0.1, 1000);
  const { forward } = cameraBasis(config);
  value.position.set(config.targetX - forward.x * config.distance, config.targetY - forward.y * config.distance, (config.targetZ ?? 0) - forward.z * config.distance);
  value.lookAt(config.targetX, config.targetY, config.targetZ ?? 0);
  value.updateProjectionMatrix(); value.updateMatrixWorld(true);
  return value;
}
function crown(config: CameraConfig) {
  const head = new Bone(); head.position.copy(CROWN.center); head.updateMatrixWorld(true);
  const profile: HeadContactProfile = { center: new Vector3(), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0),
    halfWidth: CROWN.halfWidth, halfHeight: CROWN.halfHeight, source: 'eyes-and-scalp' };
  const region = projectHeadContact(profile, head, camera(config), PET.width, PET.height);
  assert.ok(region);
  const halfHeight = Math.hypot(region.axisYX, region.axisYY);
  return { x: region.x, y: region.y, top: region.y - halfHeight, bottom: region.y + halfHeight };
}
const screenY = (config: CameraConfig, worldY: number, height = PET.height, width = PET.width) =>
  (-new Vector3(0, worldY, 0).project(camera(config, width, height)).y * 0.5 + 0.5) * height;
// The original MmdStage.frame() body, kept verbatim as the no-band reference.
function legacy(preset: 'full' | 'portrait', model: FramingModel, aspect: number, fov = 32): CameraConfig {
  const visibleHeight = model.height * (preset === 'portrait' ? 0.57 : 1.12);
  const visibleWidth = preset === 'portrait' ? model.height * 0.46 : model.width * 1.12;
  const distance = Math.max(visibleHeight, visibleWidth / aspect) / (2 * Math.tan(MathUtils.degToRad(fov / 2)));
  return { yaw: 0, pitch: 0, distance, targetY: model.baseY + model.height * (preset === 'portrait' ? 0.75 : 0.5), targetX: model.centerX, targetZ: 0, fov };
}
type Box = { left: number; top: number; right: number; bottom: number };
const toolbarDocument = (box: Box) => ({
  querySelectorAll: () => [{ getBoundingClientRect: () => ({ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }) }],
}) as unknown as Pick<Document, 'querySelectorAll'>;
const FADED: Box = { left: TOOLBAR.left, top: TOOLBAR.fadedTop, right: TOOLBAR.right, bottom: TOOLBAR.fadedBottom };
const SHOWN: Box = { left: TOOLBAR.left, top: TOOLBAR.top, right: TOOLBAR.right, bottom: TOOLBAR.bottom };

test('without a top band framing is exactly the original rule for both presets', () => {
  for (const preset of ['full', 'portrait'] as const)
    for (const aspect of [400 / 560, 16 / 9, 0.2])
      for (const topBand of [undefined, 0, Number.NaN])
        assert.deepEqual(framingCamera(preset, GENE, { aspect, fov: 32, topBand }), legacy(preset, GENE, aspect), `${preset} ${aspect} ${topBand}`);
});

test('P4 reproduced: the old full framing puts Gene\'s crown inside the expanded toolbar of the default pet window', () => {
  const point = crown(legacy('full', GENE, PET.width / PET.height));
  assert.ok(point.y > TOOLBAR.fadedTop && point.y < TOOLBAR.fadedBottom, `crown centre ${point.y}`);
  // The faded toolbar keeps its reservation, so a real hover there never becomes a pat.
  assert.equal(isPetControlPoint(toolbarDocument(FADED), point.x, point.y), true);
});

test('the new full framing keeps Gene whole and below the toolbar, and her crown outside its reveal zone', () => {
  const band = framingTopBand(PET.height, TOOLBAR.reach);
  assert.equal(band, FRAMING_TOP_BAND, 'in the default window the shared band already clears the measured toolbar reach');
  const framed = framingCamera('full', GENE, { aspect: PET.width / PET.height, fov: 32, topBand: band });
  const top = screenY(framed, GENE.baseY + GENE.height), feet = screenY(framed, GENE.baseY);
  assert.ok(top >= TOOLBAR.reach, `model top ${top} below the expanded toolbar and its reveal margin`);
  assert.ok(Math.abs(top - band * PET.height) < 0.5, 'the band is used, not exceeded');
  assert.ok(feet <= PET.height - 20, `feet ${feet} stay inside the window with the original bottom margin`);
  const point = crown(framed);
  for (const box of [FADED, SHOWN]) {
    for (const y of [point.top, point.y, point.bottom]) assert.equal(isPetControlPoint(toolbarDocument(box), point.x, y), false, `crown ${y}`);
    // Reaching for the crown does not summon the toolbar over her head either.
    assert.equal(nearHoverZone({ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }, point.x, point.top), false);
  }
  assert.ok(point.bottom < PET.height / 3, `crown ${point.y} stays at the head`);
  // The old framing was width-limited with room to spare above and below: she is about 6% smaller and stands lower.
  const scale = legacy('full', GENE, PET.width / PET.height).distance / framed.distance;
  assert.ok(scale > 0.9 && scale < 0.97, `scale ${scale}`);
});

test('a fresh profile\'s default camera puts the crown above the window and is recognised as never framed', () => {
  const point = crown(DEFAULT_SETTINGS.camera);
  assert.ok(point.bottom < 0, `crown ${point.y} is above the pet window`);
  assert.equal(isUnframedCamera(DEFAULT_SETTINGS.camera), true);
  assert.equal(isUnframedCamera({ ...DEFAULT_SETTINGS.camera, targetZ: undefined }), true, 'an omitted targetZ is 0');
  assert.equal(isUnframedCamera(framingCamera('full', GENE, { aspect: PET.width / PET.height, fov: 32, topBand: FRAMING_TOP_BAND })), false);
  assert.equal(isUnframedCamera({ ...DEFAULT_SETTINGS.camera, distance: 30.0001 }), false, 'a user camera near the default is kept');
  assert.equal(isUnframedCamera({ ...DEFAULT_SETTINGS.camera, yaw: 5 }), false);
});

test('the pet and the controls preview frame to the same camera while both are height-limited', () => {
  for (const preset of ['full', 'portrait'] as const) {
    const pet = framingCamera(preset, GENE, { aspect: PET.width / PET.height, fov: 32, topBand: framingTopBand(PET.height, TOOLBAR.reach) });
    const controls = framingCamera(preset, GENE, { aspect: 16 / 9, fov: 32, topBand: framingTopBand(480) });
    assert.deepEqual(controls, pet, preset);
  }
});

test('a toolbar that reaches lower than the band wins, and the band is capped', () => {
  assert.equal(framingTopBand(560, 140), 0.25);
  assert.equal(framingTopBand(560, 400), 0.35);
  for (const [height, reserved] of [[0, 97], [560, Number.NaN], [560, -4], [560, 0]] as const) assert.equal(framingTopBand(height, reserved), FRAMING_TOP_BAND);
  // A narrow 250 px window wraps the toolbar into more rows; framing follows the measured reach even width-limited.
  const framed = framingCamera('full', GENE, { aspect: 250 / 560, fov: 32, topBand: framingTopBand(560, 140) });
  const top = screenY(framed, GENE.baseY + GENE.height, 560, 250);
  assert.ok(top >= 140 - 0.5, `model top ${top}`);
});

test('a width-limited model and the portrait preset also stay below the band', () => {
  const wide: FramingModel = { ...GENE, width: 40 };
  const framed = framingCamera('full', wide, { aspect: PET.width / PET.height, fov: 32, topBand: FRAMING_TOP_BAND });
  assert.ok(framed.distance > legacy('full', wide, PET.width / PET.height).distance - 1e-9, 'never closer than the width needs');
  assert.ok(screenY(framed, wide.baseY + wide.height) >= FRAMING_TOP_BAND * PET.height - 0.5);
  const portrait = framingCamera('portrait', GENE, { aspect: PET.width / PET.height, fov: 32, topBand: FRAMING_TOP_BAND });
  assert.ok(screenY(portrait, GENE.baseY + GENE.height) >= FRAMING_TOP_BAND * PET.height - 0.5, 'portrait head below the band');
  assert.ok(Math.abs(screenY(portrait, GENE.baseY + GENE.height * 0.465) - PET.height) < 0.5, 'portrait keeps its lower cut at the window bottom');
  assert.ok(crown(portrait).top > TOOLBAR.reach, 'portrait crown below the toolbar reach');
});
