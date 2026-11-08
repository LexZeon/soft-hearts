/**
 * Pretrial 2026-11-03 (docs/claude/2026-11-03-pretrial-fixes-motion.md, L2 问题 7 and L4 问题 5): on the real app "想事情" never
 * brought the hand to the chin, and her small feelings did not show in her head. Cause: the default Gene card's reviewed Stand
 * has a small authored head motion, so loadMotions sets `moodHeadBlocked` (the head is a selected layer's); procedural life read
 * that flag as "a picked motion owns the head" and yielded its whole head channel (tilt, her-life head, the need looks, the
 * music nod and listening look), and 她自己的生活 counted it as a higher body owner, so the held pose never came in. The body
 * motions already treat the reviewed Stand as a compatible background (bodyGates().manualHead); life and her-life now use the
 * same gate. The harness loads Stand without loadMotions, so these tests set the two flags exactly as loadMotions does for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HerLifeStage, herLifeStageLoader } from '../src/stage/her-life-stage';
import type { HerLifeActivity } from '../shared/her-life';
import { geneStage, type GeneStage } from './helpers/gene-stage-harness';

function setHerLife(h: GeneStage, activity: HerLifeActivity): void {
  const view = h.stage.moodView;
  h.stage.setMood({ ...view, revision: view.revision + 1, herLife: { activity, since: Date.now(), until: Date.now() + 600_000, source: 'rule', lookUp: null } });
}
async function stand({ picked }: { picked: boolean }) {
  const h = await geneStage({ herLife: true });
  const stage = h.stage;
  // What loadMotions sets for Gene's Stand: its head track moves (moodHeadBlocked); reviewed default, so not a picked pose.
  stage.moodHeadBlocked = true; stage.bodyManualPose = picked;
  stage.herLife = new HerLifeStage(herLifeStageLoader({ mesh: () => stage.mesh, token: () => stage.moodView?.token ?? null, transform: () => undefined, unfit: () => false }));
  setHerLife(h, 'company');
  return h;
}
const life = (h: GeneStage) => JSON.parse(h.stage.renderer.domElement.dataset.proceduralLife ?? 'null');

test('with the reviewed Stand her small head motions run (they yielded to it as if it were a picked head motion)', async () => {
  const h = await stand({ picked: false });
  try {
    h.run(3);
    const tilt = life(h).primitives.tilt;
    assert.deepEqual(tilt.yielding, [], 'the head channel does not yield to the default Stand');
    assert.ok(tilt.weight > 0.95, `tilt weight ${tilt.weight}`);
  } finally { h.close(); }
  const picked = await stand({ picked: true });
  try {
    picked.run(3);
    assert.ok(life(picked).primitives.tilt.yielding.includes('manual-head'), 'a picked motion that moves the head still owns it');
  } finally { picked.close(); }
});

test('"想事情" with the reviewed Stand: the hand comes to the chin (the held pose never came in)', async () => {
  const h = await stand({ picked: false });
  try {
    h.run(0.5); // binds her-life to this mesh (a new owner starts clean)
    // The host's grant and the bytes load asynchronously (the real stage asks when she starts thinking); the harness's run is synchronous.
    h.stage.herLife.request('thinking');
    for (let i = 0; i < 400 && h.stage.herLife.getState().clips.thinking !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(h.stage.herLife.getState().clips.thinking, 'ready');
    setHerLife(h, 'thinking');
    h.run(6);
    const state = h.stage.herLife.getState();
    assert.equal(state.activity, 'thinking');
    assert.ok(state.pose && state.pose.id === 'thinking' && state.pose.weight > 0.5, `thinking pose ${JSON.stringify(state.pose)}`);
    assert.equal(h.shown.at(-1)!.guardJumps - h.shown[0].guardJumps, 0, 'it comes in without a jump');
  } finally { h.close(); }
});
