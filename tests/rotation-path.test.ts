import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { RotationPath } from '../src/stage/rotation-path';

// R29e: the module contract; the bridge / chat-gesture scenarios are in tests/r29e-half-turn.test.ts.
const DEG = 180 / Math.PI;
const about = (axis: Vector3, degrees: number) => new Quaternion().setFromAxisAngle(axis.clone().normalize(), degrees / DEG);
const distance = (a: Quaternion, b: Quaternion) => a.clone().normalize().angleTo(b.clone().normalize()) * DEG;
const gap = (a: Quaternion, b: Quaternion) => Math.min(...[1, -1].map(sign =>
  Math.max(Math.abs(a.x - sign * b.x), Math.abs(a.y - sign * b.y), Math.abs(a.z - sign * b.z), Math.abs(a.w - sign * b.w))));
const negated = (value: Quaternion) => new Quaternion(-value.x, -value.y, -value.z, -value.w);
let seed = 11;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const randomAxis = () => new Vector3(random() - 0.5, random() - 0.5, random() - 0.5);

test('the first blend (and every blend after reset) is the shortest slerp, ends included', () => {
  const path = new RotationPath();
  let worst = 0;
  for (let run = 0; run < 500; run++) {
    const from = about(randomAxis(), random() * 360), to = about(randomAxis(), random() * 360);
    if (random() < 0.5) to.set(-to.x, -to.y, -to.z, -to.w);
    for (const weight of [0, random(), 1]) {
      path.reset();
      const blended = path.blend(from, to, weight, new Quaternion());
      worst = Math.max(worst, gap(blended, from.clone().slerp(to, weight)));
    }
  }
  assert.ok(worst < 1e-12, `differs from the shortest slerp by ${worst}`);
});

test('inputs may be unnormalized, either sign, and the output may alias an input', () => {
  const from = about(new Vector3(1, 2, 3), 40), to = about(new Vector3(-1, 0.5, 2), 150);
  const expected = new RotationPath().blend(from, to, 0.3, new Quaternion());
  const scaledFrom = from.clone(); scaledFrom.set(from.x * 3, from.y * 3, from.z * 3, from.w * 3);
  assert.ok(gap(new RotationPath().blend(scaledFrom, negated(to), 0.3, new Quaternion()), expected) < 1e-12);
  const alias = from.clone();
  assert.ok(gap(new RotationPath().blend(alias, to, 0.3, alias), expected) < 1e-12, 'out === from');
  const aliasTo = to.clone();
  assert.ok(gap(new RotationPath().blend(from, aliasTo, 0.3, aliasTo), expected) < 1e-12, 'out === to');
});

test('a relative rotation that keeps turning is followed through a half turn and through whole turns, whatever the float noise', () => {
  for (let run = 0; run < 50; run++) {
    const from = about(randomAxis(), random() * 360), axis = randomAxis(), weight = 0.2 + 0.6 * random();
    const path = new RotationPath();
    let worst = 0;
    // Steps that land exactly on 180 and 360 deg (where the shortest choice is undecided and the axis is float noise).
    for (let angle = 0; angle <= 900; angle += 22.5) {
      const to = from.clone().multiply(about(axis, angle)); // composed numerically, as the Stage's targets are
      if (angle % 45 === 0) to.set(-to.x, -to.y, -to.z, -to.w);
      const blended = path.blend(from, to, weight, new Quaternion());
      worst = Math.max(worst, distance(blended, from.clone().multiply(about(axis, weight * angle))));
    }
    assert.ok(worst < 1e-4, `run ${run}: off the unwrapped curve by ${worst} deg`);
  }
});

test('reset forgets the way round: the next blend takes the short way again', () => {
  const from = new Quaternion(), path = new RotationPath(), z = new Vector3(0, 0, 1);
  for (const angle of [150, 170, 190]) path.blend(from, about(z, angle), 0.5, new Quaternion());
  assert.ok(distance(path.blend(from, about(z, 190), 0.5, new Quaternion()), about(z, 95)) < 1e-9, 'kept: the long way');
  path.reset();
  assert.ok(distance(path.blend(from, about(z, 190), 0.5, new Quaternion()), about(z, -85)) < 1e-9, 'after reset: the short way');
});
