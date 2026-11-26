// during rock-paper-scissors the stage's face point carries
// raisedHand (G1, the buttons keep clear of her arm). PetUI passed that object to the bubble, the host refused every update with
// an anchor ("回答气泡锚点不正确"), text included, and the bubble stayed empty. The bubble now gets only what the host accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReplyUpdate } from '../electron/brain/reply-input';
import { replyAnchorOf } from '../shared/brain/reply-anchor';

test('the stage point during the game (with raisedHand) is refused as it was, and accepted once passed through replyAnchorOf', () => {
  const stagePoint = { x: 240, y: 150, visible: true, radius: 90, raisedHand: { x: 300, y: 120, elbowX: 280, elbowY: 200 } };
  assert.throws(() => validateReplyUpdate({ text: '石头剪刀布！', state: 'streaming', anchor: stagePoint as never }), /锚点/,
    'this is what the user hit: the whole update, text included, was refused');
  const anchor = replyAnchorOf(stagePoint);
  assert.deepEqual(anchor, { x: 240, y: 150, visible: true, radius: 90 });
  assert.deepEqual(validateReplyUpdate({ text: '石头剪刀布！', state: 'streaming', anchor }), { text: '石头剪刀布！', state: 'streaming', anchor });
});

test('a point the bubble cannot use becomes "face not in sight", never a refused update', () => {
  for (const bad of [null, undefined, 'x', [], { x: NaN, y: 1, visible: true }, { x: 1, y: Infinity, visible: true }, { x: 1, y: 2 },
    { x: 200_000, y: 0, visible: true }, { x: 1, y: 2, visible: 'yes' }]) {
    const anchor = replyAnchorOf(bad);
    assert.deepEqual(anchor, { x: 0, y: 0, visible: false });
    assert.doesNotThrow(() => validateReplyUpdate({ anchor }));
  }
  // A bad radius is dropped, the point stays.
  assert.deepEqual(replyAnchorOf({ x: 10, y: 20, visible: true, radius: -5 }), { x: 10, y: 20, visible: true });
  assert.deepEqual(replyAnchorOf({ x: 10, y: 20, visible: true, radius: NaN }), { x: 10, y: 20, visible: true });
});

test('PetUI hands every face point through replyAnchorOf (so no stage-only key can reach the bubble again)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/stage/PetUI.ts', import.meta.url), 'utf8');
  const setter = /setFaceAnchor\(point: PetReplyAnchor\): void \{[\s\S]*?\n  \}/u.exec(source)?.[0] ?? '';
  assert.match(setter, /this\.anchor = replyAnchorOf\(point\);/u);
  assert.doesNotMatch(source, /this\.anchor = point;/u);
});
