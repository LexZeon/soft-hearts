import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute, InterleavedBuffer, InterleavedBufferAttribute, type BufferAttribute } from 'three';
import { selectBlushChannel } from '../src/stage/blush-channel';

function fixture(relative = false, scale = 1) {
  const geometry = new BufferGeometry();
  const base = Array.from({ length: 40 }, (_, i) => [(i % 10) * scale, Math.floor(i / 10) * scale, 0]).flat();
  geometry.setAttribute('position', new Float32BufferAttribute(base, 3));
  geometry.morphTargetsRelative = relative;
  const target = relative ? Array(base.length).fill(0) : [...base];
  target[12 * 3 + 2] += 0.01 * scale;
  geometry.morphAttributes.position = [new Float32BufferAttribute(target, 3)];
  return geometry;
}

test('Gene chooses 赤み first and never adds its duplicate aliases', () => {
  const geometry = fixture();
  geometry.morphAttributes.position = Array.from({ length: 4 }, () => geometry.morphAttributes.position[0].clone());
  assert.deepEqual(selectBlushChannel({ '頬照り': 0, cheek_blush_geo_C: 1, '照れ': 2, '赤み': 3 }, geometry), { index: 3, name: '赤み' });
});

test('exact positive aliases accept normal spelling variants, not cheek movement or generic emotion names', () => {
  assert.deepEqual(selectBlushChannel({ 'Ｃｈｅｅｋ Ｂｌｕｓｈ': 0 }, fixture()), { index: 0, name: 'Ｃｈｅｅｋ Ｂｌｕｓｈ' });
  assert.deepEqual(selectBlushChannel({ '脸红': 0 }, fixture()), { index: 0, name: '脸红' });
  assert.equal(selectBlushChannel({ cheekPuff: 0, cheekSquint: 0, happy: 0, rednessUnknown: 0 }, fixture()), null);
});

test('removal and hiding aliases are excluded before positive discovery', () => {
  const removals = { '頬赤み消し': 0, '頬全消し': 0, '頬斜線消し': 0, blush_off: 0, hideBlush: 0, removeBlush: 0, '赤み隠し': 0, '脸红关闭': 0 };
  assert.equal(selectBlushChannel(removals, fixture()), null);
  assert.deepEqual(selectBlushChannel({ ...removals, blush: 0 }, fixture()), { index: 0, name: 'blush' });
});

test('absolute and relative positions require a real nonzero vertex delta', () => {
  assert.deepEqual(selectBlushChannel({ blush: 0 }, fixture(false)), { index: 0, name: 'blush' });
  assert.deepEqual(selectBlushChannel({ blush: 0 }, fixture(true)), { index: 0, name: 'blush' });
  const absolute = fixture();
  absolute.morphAttributes.position[0] = absolute.getAttribute('position').clone();
  assert.equal(selectBlushChannel({ blush: 0 }, absolute), null, 'UV/material MMD placeholder position targets do not become supported');
  const relative = fixture(true);
  relative.morphAttributes.position[0].array.fill(0);
  assert.equal(selectBlushChannel({ blush: 0 }, relative), null);
});

test('bad dictionary indices cannot select an unrelated or missing target, and valid fallbacks still work', () => {
  const geometry = fixture();
  for (const index of [-1, 1, 0.5, NaN, Infinity]) assert.equal(selectBlushChannel({ '赤み': index }, geometry), null);
  assert.deepEqual(selectBlushChannel({ '赤み': 9, '頬照り': 0 }, geometry), { index: 0, name: '頬照り' });
  assert.equal(selectBlushChannel(undefined, geometry), null);
  assert.equal(selectBlushChannel(null, geometry), null);
});

test('missing attributes and mismatched counts/item sizes downgrade without a channel', () => {
  const geometry = fixture();
  geometry.morphAttributes.position = [];
  assert.equal(selectBlushChannel({ blush: 0 }, geometry), null);
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, 0, 0], 3)];
  assert.equal(selectBlushChannel({ blush: 0 }, geometry), null);
  geometry.morphAttributes.position = [new Float32BufferAttribute(new Float32Array(40 * 2), 2)];
  assert.equal(selectBlushChannel({ blush: 0 }, geometry), null);
  assert.equal(selectBlushChannel({ blush: 0 }, new BufferGeometry()), null);
});

test('a named target must match its dictionary entry rather than another local expression', () => {
  const geometry = fixture();
  geometry.morphAttributes.position[0].name = 'smile';
  assert.equal(selectBlushChannel({ blush: 0 }, geometry), null);
  geometry.morphAttributes.position[0].name = 'Cheek_Blush';
  assert.deepEqual(selectBlushChannel({ cheekBlush: 0 }, geometry), { index: 0, name: 'cheekBlush' });
});

test('all target positions and base positions must be finite, even outside the changed region', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const badTarget = fixture();
    badTarget.morphAttributes.position[0].setX(39, value);
    assert.equal(selectBlushChannel({ blush: 0 }, badTarget), null);
    const badBase = fixture();
    badBase.getAttribute('position').setY(39, value);
    assert.equal(selectBlushChannel({ blush: 0 }, badBase), null);
  }
});

test('global model movement, distributed changes and excessive displacements are rejected', () => {
  const global = fixture(true);
  for (let i = 0; i < 40; i++) global.morphAttributes.position[0].setZ(i, 0.01);
  assert.equal(selectBlushChannel({ blush: 0 }, global), null);
  const distributed = fixture(true);
  distributed.morphAttributes.position[0].array.fill(0);
  distributed.morphAttributes.position[0].setZ(0, 0.01);
  distributed.morphAttributes.position[0].setZ(39, 0.01);
  assert.equal(selectBlushChannel({ blush: 0 }, distributed), null);
  const huge = fixture(true);
  huge.morphAttributes.position[0].setZ(12, 2);
  assert.equal(selectBlushChannel({ blush: 0 }, huge), null);
});

test('locality checks scale with the model and ignore float noise', () => {
  for (const scale of [0.001, 1, 1000]) assert.deepEqual(selectBlushChannel({ blush: 0 }, fixture(true, scale)), { index: 0, name: 'blush' });
  const noise = fixture(true);
  noise.morphAttributes.position[0].setZ(12, 1e-8);
  assert.equal(selectBlushChannel({ blush: 0 }, noise), null);
});

test('normal Three interleaved attributes are read through their public accessors', () => {
  const geometry = fixture();
  const interleave = (attribute: BufferAttribute | InterleavedBufferAttribute) => {
    const array = new Float32Array(attribute.count * 4);
    for (let i = 0; i < attribute.count; i++) array.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i), 99], i * 4);
    return new InterleavedBufferAttribute(new InterleavedBuffer(array, 4), 3, 0);
  };
  geometry.setAttribute('position', interleave(geometry.getAttribute('position')));
  geometry.morphAttributes.position[0] = interleave(geometry.morphAttributes.position[0]);
  assert.deepEqual(selectBlushChannel({ blush: 0 }, geometry), { index: 0, name: 'blush' });
});

test('discovery leaves dictionary, vertices and morph target weights untouched', () => {
  const geometry = fixture();
  const dictionary = Object.freeze({ blush: 0 });
  const base = [...geometry.getAttribute('position').array];
  const target = [...geometry.morphAttributes.position[0].array];
  selectBlushChannel(dictionary, geometry);
  assert.deepEqual([...geometry.getAttribute('position').array], base);
  assert.deepEqual([...geometry.morphAttributes.position[0].array], target);
  assert.deepEqual(dictionary, { blush: 0 });
});
