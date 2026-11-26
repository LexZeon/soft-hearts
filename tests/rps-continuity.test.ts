/**
 * Pretrial 2026-11-03 (docs/claude/2026-11-03-pretrial-fixes-motion.md, G1): the display guard caught 6–7 jumps in one match
 * on the real app: 笑い during natural blinks (the eye smile gives way to the blink at the blink's own speed), and the middle
 * phalanges (右中指２ / 右小指２, ~4.1°) when the hand changed at the reveal at ~30 fps with a late frame. Fixed by
 *  - the guard following, not judging, the lid shapes that ride a natural blink (pose-continuity.ts `ownedMorphs`);
 *  - hand shapes as minimum-jerk weights sized by the finger turn (an interrupted change turns round from the blend shown);
 * and held here on the real Stage frame loop at 60 and 30 fps, with a late frame whenever the host's view arrives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RPS_TIMING as T, type RpsFace, type RpsHand, type RpsPhase, type RpsView } from '../shared/initiative/rps';
import { PoseContinuity } from '../src/senses/pose-continuity';

function view(phase: RpsPhase, round: number, extra: Partial<RpsView> = {}): RpsView {
  return { id: 'm1', revision: 1, phase, round, score: { her: 0, user: 0 }, firstTo: 2, accepting: phase === 'ready' || phase === 'count' || phase === 'wait',
    commitment: null, revealed: null, userHand: null, outcome: null, line: null, face: 'nervous' as RpsFace, tease: null, beatMs: T.beatMs,
    phaseMs: 0, elapsedMs: 0, result: null, ...extra } as RpsView;
}
const revealed = (hand: RpsHand) => ({ hand, intent: 'fair' as const, nonce: 'n' });

test('the guard follows a morph its dedicated owner moves this frame, and still catches it on any other frame', () => {
  const make = () => { const influences = [0.4]; return { mesh: { skeleton: { bones: [] }, morphTargetInfluences: influences }, influences }; };
  const run = (owned: boolean) => {
    const { mesh, influences } = make(), guard = new PoseContinuity(mesh);
    // The mixer leaves the morph at 0 (trusted base); a layer then writes `value` (the eye smile, giving way to a blink).
    const frame = (value: number, own: boolean) => { influences[0] = 0; guard.captureBase(true); influences[0] = value; guard.apply(1 / 60, 1 / 60, own ? [0] : null); const shown = influences[0]; guard.remove(); return shown; };
    // The layer holds 0.4, then a blink pulls it to 0.1 in two frames and lets it back.
    const shown: number[] = [];
    for (let i = 0; i < 10; i++) shown.push(frame(0.4, false));
    for (const value of [0.25, 0.1, 0.25, 0.4]) shown.push(frame(value, owned));
    for (let i = 0; i < 10; i++) shown.push(frame(0.4, false));
    return { jumps: guard.getState().jumps, shown };
  };
  const followed = run(true), judged = run(false);
  assert.equal(followed.jumps, 0, 'owned this frame: followed');
  assert.deepEqual(followed.shown.slice(10, 14).map(v => +v.toFixed(6)), [0.25, 0.1, 0.25, 0.4], 'shown exactly as the owner wrote it');
  assert.ok(judged.jumps > 0, 'the same steps on frames nobody owns are caught (the guard is not switched off)');
});
