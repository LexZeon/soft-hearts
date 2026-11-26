// Unbound v1 step 5c「拉她」: the page ↔ host message (shared/unbound/pull.ts), the follow range, the arbiter's 'pull', the day's history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampFollowX, parsePullAnswer, parseUnboundPull, pullReportMessage } from '../shared/unbound/pull';
import { arbitrate, interactionOf } from '../shared/unbound/life/arbiter';
import { dayAccount, noticedTurnLine } from '../shared/unbound/life/history';
import { placementAcross } from '../shared/unbound/world';

test('the message: a start, or a report with only the pull\'s fields and a finite place; anything else is null', () => {
  assert.deepEqual(parseUnboundPull({ phase: 'start', extra: 1 }), { phase: 'start' });
  assert.deepEqual(parseUnboundPull({ phase: 'report', report: { part: 'arm', ended: 'released', where: 'pet', kind: 'click', at: 3, steps: 2 }, place: { xM: 0.2, depthM: 8 } }),
    { phase: 'report', report: { part: 'arm', ended: 'released', steps: 2 }, place: { xM: 0.2, depthM: 8 } });
  assert.deepEqual(parseUnboundPull({ phase: 'report', report: { part: 'arm' }, place: { xM: NaN, depthM: 8 } }), { phase: 'report', report: { part: 'arm' } });
  for (const junk of [null, 'start', [], { phase: 'report' }, { phase: 'report', report: [] }, { phase: 'stop' }]) assert.equal(parseUnboundPull(junk), null);
  assert.deepEqual(pullReportMessage({ part: 'hand', side: 'left', strength: 0.4, heldMs: 900, ended: 'holding' }), { phase: 'report', report: { part: 'hand', side: 'left', strength: 0.4, heldMs: 900, ended: 'holding' } });
});

test('the host\'s answer as the page reads it: odd is no; numbers clamped', () => {
  assert.deepEqual(parsePullAnswer(undefined), { accepted: false, stance: null, sleepy: 0 });
  assert.deepEqual(parsePullAnswer({ accepted: 'yes' }).accepted, false);
  const answer = parsePullAnswer({ accepted: true, stance: { willing: 9, compliance: 3, pace: 99, hesitateMs: 1e9, resist: -1 }, sleepy: 4 });
  assert.deepEqual(answer, { accepted: true, stance: { willing: 1, compliance: 1, pace: 1.5, hesitateMs: 2000, resist: 0 }, sleepy: 1 });
});

test('she follows only inside her stand range (5%–95% of the screen across, at her depth)', () => {
  const view = { screen: { widthM: 0.34 }, viewerDistanceM: 0.55 } as Parameters<typeof clampFollowX>[0];
  const lo = placementAcross(view, 0.05, 8).xM, hi = placementAcross(view, 0.95, 8).xM;
  assert.equal(clampFollowX(view, 99, 8), hi);
  assert.equal(clampFollowX(view, -99, 8), lo);
  assert.equal(clampFollowX(view, 0.1, 8), 0.1);
});

test('the arbiter: a pull is you interacting (it outranks typing; only a call is above it); a running action of hers yields', () => {
  const none = { inCall: false, typing: false, waiting: false, clicked: false, replying: false, readingAloud: false };
  assert.equal(interactionOf({ ...none, pulled: true }), 'pull');
  assert.equal(interactionOf({ ...none, pulled: true, typing: true }), 'pull');
  assert.equal(interactionOf({ ...none, pulled: true, inCall: true }), 'call');
  assert.equal(interactionOf(none), null);
  assert.deepEqual(arbitrate({ now: 0, interaction: 'pull', quiet: null, running: { id: 'place', level: 'place', easing: false }, wants: [], lastNoticeableEndAt: null,
    interactionEndedAt: null, knobs: { gapSeconds: 60, afterUserSeconds: 30 } }), { kind: 'yield', id: 'place', reason: 'user' });
});

test('the day\'s history counts being pulled along, without claiming a sense (only the mouse)', () => {
  const at = new Date(2026, 10, 18, 15).getTime();
  assert.match(dayAccount([{ kind: 'pulled-along', band: 'sure', at }, { kind: 'wave', band: 'sure', at }]), /拉着你走过一次/);
  const line = noticedTurnLine([{ kind: 'pulled-along', band: 'sure', at }], '');
  assert.equal(line, '用户刚才拉着你走了一段。', 'no "摄像头开着" for a pull');
});
