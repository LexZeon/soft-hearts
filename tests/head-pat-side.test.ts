// 2026-11-24: a pat on the top and sides of Gene's head counted on one half only. Her right side hair is named hair (右横髪) while her
// left side hangs on the head bone, so the same press gave 'head' on one half and 'hair' (a pull) or 'face' on the other
// (docs/claude/2026-11-24-head-pat-side.md). A hit on hair or face above the eye line, on the head, is the head, whichever bone owns the pixel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { headTopTouch, isEyeBoneName, touchOfBoneChain, HEAD_TOP_FROM_EYES } from '../shared/mood/touch-part';
import { StagePull } from '../src/stage/pull/stage-pull';
import { geneFigure } from './helpers/unbound-gene';

const top = 2, below = -1;

test('hair or face above the eye line, on the head, is the head; a twin-tail and a cheek keep their parts', () => {
  const side = (chain: string[]) => touchOfBoneChain(chain);
  assert.deepEqual(headTopTouch(side(['右横髪1_1', '頭', '首']), ['右横髪1_1', '頭', '首'], top), { part: 'head', side: null });
  assert.deepEqual(headTopTouch(side(['前髪1_1', '頭']), ['前髪1_1', '頭'], top), { part: 'head', side: null });
  assert.deepEqual(headTopTouch(side(['左ツインテ１', '頭']), ['左ツインテ１', '頭'], below), { part: 'hair', side: 'left' }, 'a twin-tail hangs below the eye line');
  assert.deepEqual(headTopTouch(side(['右ポニー', '頭']), ['右ポニー', '頭'], below), { part: 'hair', side: 'right' });
  assert.deepEqual(headTopTouch(side(['左目', '頭']), ['左目', '頭'], 0), { part: 'face', side: 'left' }, 'the eye itself and a cheek stay face');
  assert.deepEqual(headTopTouch(side(['顎', '頭']), ['顎', '頭'], -2), { part: 'face', side: null });
  assert.deepEqual(headTopTouch(side(['右手首', '右ひじ']), ['右手首', '右ひじ'], top), { part: 'hand', side: 'right' }, 'a hand is a hand wherever it is');
  assert.deepEqual(headTopTouch(side(['左肩', '上半身']), ['左肩', '上半身'], top), { part: 'shoulder', side: 'left' });
  assert.deepEqual(headTopTouch(side(['髪_後ろ', '上半身2']), ['髪_後ろ', '上半身2'], top), { part: 'hair', side: null }, 'hair that is not on the head bone stays hair');
  assert.deepEqual(headTopTouch(side(['右横髪1_1', '頭']), ['右横髪1_1', '頭'], null), { part: 'hair', side: 'right' }, 'no eye line known: unchanged');
  assert.ok(headTopTouch(side(['右横髪1_1', '頭']), ['右横髪1_1', '頭'], HEAD_TOP_FROM_EYES - 0.01).part === 'hair');
  assert.ok(isEyeBoneName('左目') && isEyeBoneName('RightEye') && !isEyeBoneName('両目') && !isEyeBoneName('左目先'));
});

test('on the bundled Gene a press on hair or face above her eyes is the head, on both halves, with the head turned and a side lock swung', async () => {
  const { fixture } = await geneFigure();
  const mesh = fixture.mesh;
  const bones = mesh.skeleton.bones;
  const find = (name: string) => bones.find(bone => bone.name === name)!;
  const head = find('頭'), eyes = [find('左目'), find('右目')];
  mesh.updateWorldMatrix(true, true); mesh.skeleton.update();
  const origin = head.getWorldPosition(new Vector3()), rest = head.quaternion.clone();
  const lock = find('右横髪1_1'), lockRest = lock.quaternion.clone();
  const pull = new StagePull(); pull.bind(mesh);
  const camera = new PerspectiveCamera(30, 0.75, 0.1, 5000);
  const W = 300, H = 400;
  const cases: [string, number, number][] = [['front', 0, 0], ['turned right', 30, 0], ['turned left', -30, 0], ['side lock swung', 0, 40]];
  for (const [label, yaw, swing] of cases) {
    head.quaternion.copy(rest); head.rotateY(yaw * Math.PI / 180);
    lock.quaternion.copy(lockRest); lock.rotateZ(swing * Math.PI / 180);
    head.updateWorldMatrix(true, true); mesh.skeleton.update();
    camera.position.set(origin.x, origin.y + 0.5, origin.z + 18); camera.lookAt(origin.x, origin.y + 0.5, origin.z); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    const centre = origin.clone().project(camera), cx = (centre.x * 0.5 + 0.5) * W, cy = (-centre.y * 0.5 + 0.5) * H;
    const unit = (origin.clone().add(new Vector3(1, 0, 0)).project(camera).x - centre.x) * 0.5 * W;
    const eyeAt = () => { const [a, b] = eyes.map(eye => head.worldToLocal(eye.getWorldPosition(new Vector3()))); return { y: (a.y + b.y) / 2, spacing: a.distanceTo(b) }; };
    const eye = eyeAt();
    const seen = { left: 0, right: 0 }; let wrong = 0, above = 0;
    for (let dy = -3.2; dy <= 0; dy += 0.2) for (let dx = -2.8; dx <= 2.8; dx += 0.2) {
      const hit = pull.hit({ camera, width: W, height: H }, cx + dx * unit, cy + dy * unit, 19.4);
      if (!hit) continue;
      const aboveEyes = (head.worldToLocal(hit.point.clone()).y - eye.y) / eye.spacing;
      if (aboveEyes < HEAD_TOP_FROM_EYES + 0.3) continue;
      above++;
      if (hit.part === 'head') seen[dx < 0 ? 'left' : 'right']++;
      else if (hit.part === 'hair' || hit.part === 'face') wrong++;
    }
    assert.ok(above > 40, `${label}: the grid reaches the top of the head`);
    assert.equal(wrong, 0, `${label}: nothing above her eyes reads as hair or face`);
    assert.ok(seen.left > 10 && seen.right > 10, `${label}: both halves give the head (${seen.left} / ${seen.right})`);
  }
});
