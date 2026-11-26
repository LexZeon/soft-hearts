// I-174 item 4 (docs/claude/2026-11-21-i174-parity-fixes.md): one isRestPose for the window and full-screen. Before, full-screen counted
// only "no pose picked" as rest (a hand-picked reviewed stand.vmd held her own motions back there), the window also counted the reviewed
// stand. Both now ask src/unbound/rest-pose.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRestPose } from '../src/unbound/rest-pose';

const STAND = 'mmd-asset://bundled/stand.vmd', MINE = 'mmd-asset://lib/mine.vmd';

test('isRestPose: nothing picked or the injected default stand is rest; a picked pose is rest only when it is the reviewed stand', async () => {
  const asked: string[] = [];
  const reviewed = async (url: string) => { asked.push(url); return url === STAND; };
  assert.equal(await isRestPose({ picked: null, injected: false }, reviewed), true, 'no pose picked (the full-screen rule before)');
  assert.equal(await isRestPose({ picked: null, injected: true }, reviewed), true, 'the default stand the host or window put in');
  assert.equal(await isRestPose({ picked: STAND, injected: false }, reviewed), true, 'a hand-picked reviewed stand (the window rule before; full-screen said "picked")');
  assert.equal(await isRestPose({ picked: MINE, injected: false }, reviewed), false, 'any other pose is picked');
  assert.deepEqual(asked, [STAND], 'the byte check runs only for a stand-like file name');
  assert.equal(await isRestPose({ picked: 'mmd-asset://x/stand.vmd', injected: false }, async () => false), false, 'a stand.vmd whose bytes differ is picked');
  assert.equal(await isRestPose({ picked: STAND, injected: false }, async () => { throw new Error('offline'); }), false, 'a failed check reads as picked');
  assert.equal(await isRestPose({ picked: 'not a url', injected: false }, reviewed), false);
});

test('isRestPose: both stages get the same answer for the same motion (the window passes injected for its default stand, full-screen the picked URL)', async () => {
  const reviewed = async (url: string) => url === STAND;
  // The window: windowMotionClips says rest when it put the default stand in; full-screen: the scene's motion.pose is null then.
  const cases: [{ picked: string | null; injected: boolean }, string | null][] = [[{ picked: null, injected: true }, null], [{ picked: STAND, injected: false }, STAND], [{ picked: MINE, injected: false }, MINE]];
  for (const [windowInput, fullPicked] of cases) {
    assert.equal(await isRestPose(windowInput, reviewed), await isRestPose({ picked: fullPicked, injected: false }, reviewed));
  }
});
