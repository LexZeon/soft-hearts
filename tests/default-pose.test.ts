import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import catalog from '../shared/motion-catalog.json';
import bundled from '../shared/bundled-assets.json';
import { isReviewedDefaultPose } from '../src/stage/default-pose';

test('the exact reviewed local Stand bytes retain their background-pose exception', async () => {
  const pack = catalog.packs.find(pack => pack.id === 'gene')!;
  const stand = pack.motions.find(motion => motion.id === bundled.defaultMotionId)!;
  const bytes = await readFile(path.join('assets/bundled', pack.source, pack.id, pack.revision, stand.relativePath));
  const source = 'mmd-asset://host-registered/stand.vmd';
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(bytes)), true);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(changed)), false);
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(bytes.subarray(1))), false);
  let called = false;
  for (const value of ['https://example.test/stand.vmd', 'file:///stand.vmd', 'mmd-asset://registered/manual.vmd', `${source}?override=true`])
    assert.equal(await isReviewedDefaultPose(value, async () => { called = true; return new Response(bytes); }), false);
  assert.equal(called, false);
});

test('only exact pinned Neutral Idle bytes qualify for the additional background candidate', async () => {
  const pack = catalog.packs.find(pack => pack.id === '100style-idles')!;
  const neutral = pack.motions.find(motion => motion.id === 'neutral-idle')!;
  const bytes = await readFile(path.join('assets/bundled', pack.source, pack.id, pack.revision, neutral.relativePath));
  const source = 'mmd-asset://host-registered/neutral-idle.vmd';
  assert.equal(bytes.length, 935582, 'the candidate is the inspected pinned artifact');
  assert.equal(neutral.sha256, '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb');
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(bytes)), true);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(changed)), false);
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(bytes.subarray(1))), false);
  assert.equal(await isReviewedDefaultPose(source, async () => new Response(bytes, { status: 404 })), false);
});

test('swapping or relabelling the two reviewed resources does not qualify their bytes', async () => {
  const standPack = catalog.packs.find(pack => pack.id === 'gene')!;
  const stand = standPack.motions.find(motion => motion.id === bundled.defaultMotionId)!;
  const neutralPack = catalog.packs.find(pack => pack.id === '100style-idles')!;
  const neutral = neutralPack.motions.find(motion => motion.id === 'neutral-idle')!;
  const [standBytes, neutralBytes] = await Promise.all([
    readFile(path.join('assets/bundled', standPack.source, standPack.id, standPack.revision, stand.relativePath)),
    readFile(path.join('assets/bundled', neutralPack.source, neutralPack.id, neutralPack.revision, neutral.relativePath)),
  ]);
  assert.equal(await isReviewedDefaultPose('mmd-asset://registered/stand.vmd', async () => new Response(neutralBytes)), false);
  assert.equal(await isReviewedDefaultPose('mmd-asset://registered/neutral-idle.vmd', async () => new Response(standBytes)), false);
  let called = false;
  assert.equal(await isReviewedDefaultPose('mmd-asset://registered/manual.vmd', async () => { called = true; return new Response(neutralBytes); }), false);
  assert.equal(called, false);
});

test('unreviewed idle names and nonlocal, malformed or decorated URLs are rejected before fetching', async () => {
  let called = false;
  const request = async () => { called = true; return new Response(new Uint8Array()); };
  for (const source of [
    'https://example.test/neutral-idle.vmd',
    'file:///neutral-idle.vmd',
    'mmd-asset://registered/arms-folded-idle.vmd',
    'mmd-asset://registered/neutral-idle-copy.vmd',
    'mmd-asset://registered/NEUTRAL-IDLE.vmd',
    'mmd-asset://registered/neutral-idle.vmd?override=true',
    'mmd-asset://registered/neutral-idle.vmd#frame=1',
    'mmd-asset://registered/neutral-idle.vmd?',
    'mmd-asset://registered/neutral-idle.vmd#',
    'mmd-asset://registered/%zzneutral-idle.vmd',
  ]) assert.equal(await isReviewedDefaultPose(source, request), false, source);
  assert.equal(called, false, 'URL/name checks cannot trigger an arbitrary fetch');
});
