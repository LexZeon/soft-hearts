// Unbound v1 step 2: which part of her a click landed on, from bone names (shared/mood/touch-part.ts). Side is HER left or right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partOfBoneName, sideOfBoneName, touchOfBoneChain } from '../shared/mood/touch-part';
import { TOUCH_PARTS } from '../shared/mood/touch';

const one = (name: string) => touchOfBoneChain([name]);

test('MMD bone names map to the plain parts, with her own left and right', () => {
  const table: [string, string, 'left' | 'right' | null][] = [
    ['頭', 'head', null], ['首', 'other', null],
    ['左肩', 'shoulder', 'left'], ['右肩', 'shoulder', 'right'], ['右肩P', 'shoulder', 'right'],
    ['左腕', 'arm', 'left'], ['右腕', 'arm', 'right'], ['左ひじ', 'arm', 'left'], ['右ひじ', 'arm', 'right'], ['左腕捩', 'arm', 'left'], ['右手捩', 'arm', 'right'],
    ['左手首', 'hand', 'left'], ['右手首', 'hand', 'right'], ['左人指１', 'hand', 'left'], ['右親指０', 'hand', 'right'], ['左小指３', 'hand', 'left'],
    ['上半身', 'torso', null], ['上半身2', 'torso', null], ['下半身', 'torso', null], ['センター', 'torso', null], ['グルーブ', 'torso', null],
    ['左足', 'leg', 'left'], ['右足', 'leg', 'right'], ['左ひざ', 'leg', 'left'], ['右ひざ', 'leg', 'right'],
    ['左足首', 'foot', 'left'], ['右足首', 'foot', 'right'], ['左足ＩＫ', 'foot', 'left'], ['左つま先ＩＫ', 'foot', 'left'], ['右足先EX', 'foot', 'right'],
    ['左目', 'face', 'left'], ['右目', 'face', 'right'], ['両目', 'face', null],
    ['髪_前', 'hair', null], ['左ツインテ１', 'hair', 'left'], ['右ポニー', 'hair', 'right'], ['アホ毛', 'hair', null],
    ['スカート_前', 'torso', null], ['左スカート_横', 'torso', null],
  ];
  for (const [name, part, side] of table) assert.deepEqual(one(name), { part, side }, name);
});

test('other spellings of the side: _L / .R / Left / Right', () => {
  assert.equal(sideOfBoneName('Arm_L'), 'left');
  assert.equal(sideOfBoneName('Arm.R'), 'right');
  assert.equal(sideOfBoneName('LeftHand'), 'left');
  assert.equal(sideOfBoneName('RightFoot'), 'right');
  assert.equal(sideOfBoneName('upper_arm.l'), 'left');
  assert.equal(sideOfBoneName('頭'), null);
  assert.equal(sideOfBoneName('両目'), null);
  assert.deepEqual(one('Hand_R'), { part: 'hand', side: 'right' });
  assert.deepEqual(one('LeftLeg'), { part: 'leg', side: 'left' });
  assert.deepEqual(one('Spine'), { part: 'torso', side: null });
});

test('a bone that tells nothing lends its parent: a loose strand under the head is hair or head, a helper under the wrist is the hand', () => {
  assert.deepEqual(touchOfBoneChain(['Bone123', '右手首', '右ひじ', '右腕', '右肩', '上半身2', '上半身', 'センター']), { part: 'hand', side: 'right' });
  assert.deepEqual(touchOfBoneChain(['Bone9', '髪1', '頭', '首']), { part: 'hair', side: null }, 'the hair name comes before the head it hangs from');
  assert.deepEqual(touchOfBoneChain(['Bone9', '頭', '首']), { part: 'head', side: null });
  assert.deepEqual(touchOfBoneChain(['x1', 'x2']), { part: 'other', side: null });
  assert.deepEqual(touchOfBoneChain([]), { part: 'other', side: null });
});

test('a side belongs only to parts that have one; the chest, belly and hips never carry one', () => {
  assert.deepEqual(one('左胸'), { part: 'torso', side: null });
  assert.deepEqual(one('左腰'), { part: 'torso', side: null });
  assert.deepEqual(touchOfBoneChain(['Bone1', '左上半身']), { part: 'torso', side: null });
});

test('every result is one of the touch parts', () => {
  for (const name of ['頭', '左腕', 'foo', '左足首', '髪', '']) assert.ok((TOUCH_PARTS as readonly string[]).includes(one(name).part), name);
  assert.equal(partOfBoneName('Bone12'), null);
});
