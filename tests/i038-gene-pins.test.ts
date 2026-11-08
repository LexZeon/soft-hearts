/**
 * I-038 part A (docs/claude/2026-11-06-i038-universal-part-a.md): on the reviewed Gene, the three presentations it touches stay
 * the same frame by frame — the mood's body motions, the E1 shy/surprise shows (full strength, played once), the personal pose.
 * Each run's every rendered frame (all bones and morphs as displayed, rounded to 1e-5) is hashed; the pins were taken on the
 * code before this change (aad34cfe) with this very file, which uses only what that code already had.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { bodyPoseBinding } from '../shared/personalize-body-bindings';
import { VISUAL_GENE_SHA } from '../shared/personalize-visual';
import { geneStage, type GeneStage } from './helpers/gene-stage-harness';

const digest = (h: GeneStage) => {
  const hash = createHash('sha256');
  for (const frame of h.shown) hash.update(Array.from(frame.all!, value => Math.round(value * 1e5)).join(',') + ';');
  return hash.digest('hex').slice(0, 16);
};
const PINS: Record<string, string> = {
  'body idle.neutral': '35c50ccf95862b74',
  'body idle.proud': '755a275e2d091f1e',
  'show shy': '7d34216017b5e9ea',
  'show surprise': 'c74b92ec00d6c978',
  'pose left arm soft bend': '440ae232f7ad66c1',
};

test('Gene: body motions, shy/surprise shows and the personal pose are pinned frame by frame', async t => {
  const got: Record<string, string> = {};
  for (const recipe of ['idle.neutral', 'idle.proud'] as const) {
    const h = await geneStage({ fps: 60, recordAll: true, body: { recipe } });
    try { h.run(11); got[`body ${recipe}`] = digest(h); } finally { h.close(); }
  }
  for (const recipe of ['shy', 'surprise'] as const) {
    const h = await geneStage({ fps: 60, recordAll: true });
    try { h.run(1); h.stage.playExpression(recipe); h.run(3.5); got[`show ${recipe}`] = digest(h); } finally { h.close(); }
  }
  {
    const h = await geneStage({ fps: 60, recordAll: true, body: { recipe: 'idle.neutral' } });
    try {
      h.stage.cancelBodyMotion?.(true); // the pose waits for a body motion; this run is only about the pose
      h.run(0.5);
      const binding = bodyPoseBinding('body.gene-left-arm-soft-bend', VISUAL_GENE_SHA)!;
      const view = h.stage.moodView; h.stage.bodyPersonalizeConsumed ??= new Set(); // a real constructor field the harness does not set
      h.stage.setMood({ ...view, revision: view.revision + 1, bodyPose: { cueId: 'pose-pin', expiresAt: Date.now() + 60_000, strength: binding.qualifiedStrength, modelUrl: h.stage.modelUrl, binding } });
      h.run(2);
      got['pose left arm soft bend'] = digest(h) + (h.stage.bodyPersonalize ? '' : ':not-applied');
    } finally { h.close(); }
  }
  t.diagnostic(JSON.stringify(got, null, 1));
  assert.deepEqual(got, PINS);
});
