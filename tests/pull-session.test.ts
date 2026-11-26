// I-136 Unbound v1 step 5a「拉她」: the session (shared/behaviors/pull/session.ts), the knobs' hard bounds, the gates, the companion window's
// input adapter (src/mood/pet-pull.ts) and the host's check of its report (electron/mood/touch/pet-touch.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PullSession, type PullReport } from '../shared/behaviors/pull/session';
import { PULL_BOUNDS, PULL_KNOBS, normalizePullKnobs } from '../shared/behaviors/pull/knobs';
import { pullRefusal } from '../shared/behaviors/pull/gates';
import { PetPull } from '../src/mood/pet-pull';
import { acceptPetTouch, petPullEvent } from '../electron/mood/touch/pet-touch';
import { parseTouchEvent } from '../shared/mood/touch';

const session = () => { const reports: PullReport[] = []; return { reports, s: new PullSession({ report: r => reports.push(r) }) }; };
const grab = { part: 'hand' as const, side: 'right' as const };

test('a press becomes a pull after 8 px or 0.45 s; a quick small press is not a pull and reports nothing', () => {
  const { reports, s } = session();
  s.down(100, 100, 0, grab, 500);
  assert.equal(s.move(105, 103, 100), 'pressed', '5.8 px: still a press');
  assert.equal(s.up(200), false);
  assert.deepEqual(reports, []);
  s.down(100, 100, 1000, grab, 500);
  assert.equal(s.move(109, 100, 1050), 'started', '9 px: a pull');
  assert.equal(s.move(120, 100, 1100), 'pulling');
  s.down(100, 100, 2000, grab, 500);
  assert.equal(s.tick(2400), null);
  assert.equal(s.tick(2460), 'started', 'held 0.46 s without moving: a pull (strength 0, "拉着不放")');
  assert.equal(s.strength, 0);
});

test('strength is the farthest drag over 60% of her height, capped at 1; one "holding" report at 1.5 s, then one end', () => {
  const { reports, s } = session();
  s.down(0, 0, 0, grab, 500);
  s.move(-150, 0, 100); // 150 / (0.6 × 500) = 0.5
  s.move(-60, 0, 200);
  assert.equal(s.tick(1499), null);
  assert.equal(s.tick(1500), 'holding');
  assert.equal(s.tick(1600), null, 'only once');
  s.move(-900, 0, 1700);
  assert.equal(s.strength, 1, 'never past 1');
  assert.equal(s.up(2000), true);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], { part: 'hand', side: 'right', strength: 0.5, heldMs: 1500, ended: 'holding', direction: { x: -1, y: 0 } });
  assert.equal(reports[1].ended, 'released');
  assert.equal(reports[1].strength, 1);
  assert.equal(reports[1].heldMs, 2000);
  for (const report of reports) assert.ok(parseTouchEvent({ ...report, kind: 'pull', where: 'pet', at: 1 }), 'every report is a valid touch');
});

test('cancel and break free end a pull once; nothing after', () => {
  const { reports, s } = session();
  s.down(0, 0, 0, grab, 500); s.move(30, 0, 50);
  assert.equal(s.cancel(80), true);
  assert.equal(s.cancel(90), false);
  assert.equal(s.up(100), false);
  s.down(0, 0, 200, grab, 500); s.move(30, 0, 250);
  assert.equal(s.breakFree(300), true);
  assert.deepEqual(reports.map(r => r.ended), ['cancelled', 'broke-free']);
  assert.equal(s.down(0, 0, 0, null, 500), false, 'a press not on her');
  assert.equal(s.down(0, 0, 0, grab, 0), false, 'no height: no pull');
});

test('the knobs: every value is held inside its hard bound, whatever is asked', () => {
  const wild = normalizePullKnobs({ leanMaxDeg: 90, headMaxDeg: 1e9, armSwingMaxDeg: 180, armExtend: 3, kneeMaxDeg: -5, followSpeedShare: 4, footLiftShare: 1, fullPull: NaN });
  assert.equal(wild.leanMaxDeg, PULL_BOUNDS.leanMaxDeg[1]);
  assert.equal(wild.headMaxDeg, PULL_BOUNDS.headMaxDeg[1]);
  assert.equal(wild.armSwingMaxDeg, PULL_BOUNDS.armSwingMaxDeg[1]);
  assert.equal(wild.armExtend, 1);
  assert.equal(wild.kneeMaxDeg, 0);
  assert.equal(wild.followSpeedShare, 1, 'never faster than her walk');
  assert.equal(wild.footLiftShare, PULL_BOUNDS.footLiftShare[1]);
  assert.equal(wild.fullPull, PULL_KNOBS.fullPull);
  assert.ok(PULL_BOUNDS.leanMaxDeg[1] <= 20 && PULL_BOUNDS.headMaxDeg[1] <= 15 && PULL_BOUNDS.followSpeedShare[1] <= 1);
  for (const [key, [min, max]] of Object.entries(PULL_BOUNDS)) {
    const value = PULL_KNOBS[key as keyof typeof PULL_KNOBS];
    assert.ok(value >= min && value <= max, `${key} starts inside its bound`);
  }
});

test('the gates: asleep or peeking, no pull; her hand busy, no pull on the arm but the rest of her can', () => {
  const open = { asleep: false, peeking: false, handBusy: false };
  assert.equal(pullRefusal(open, 'torso'), null);
  assert.equal(pullRefusal({ ...open, asleep: true }, 'torso'), 'asleep');
  assert.equal(pullRefusal({ ...open, peeking: true }, 'head'), 'peeking');
  assert.equal(pullRefusal({ ...open, handBusy: true }, 'arm'), 'hand-busy');
  assert.equal(pullRefusal({ ...open, handBusy: true }, 'torso'), null);
});

test('the host takes only the shown pet window\'s own pull report, with only the pull\'s fields and fixed words', () => {
  const pet = { webContents: { id: 7 }, isVisible: () => true, isMinimized: () => false };
  const got: unknown[] = [];
  const report = (event: unknown) => { got.push(event); return true; };
  const value = { part: 'arm', side: 'left', strength: 0.4, direction: { x: 3, y: 4 }, heldMs: 900, ended: 'released', text: 'hi', where: 'unbound', kind: 'click', at: 5 };
  assert.equal(acceptPetTouch(7, pet, value, report, () => 1234), true);
  assert.deepEqual(got[0], { kind: 'pull', part: 'arm', side: 'left', where: 'pet', at: 1234, strength: 0.4, direction: { x: 0.6, y: 0.8 }, heldMs: 900, ended: 'released' });
  assert.equal(acceptPetTouch(8, pet, value, report), false, 'another window');
  assert.equal(acceptPetTouch(7, { ...pet, isVisible: () => false }, value, report), false, 'hidden');
  assert.equal(acceptPetTouch(7, { ...pet, isMinimized: () => true }, value, report), false, 'minimized');
  assert.equal(petPullEvent({ ...value, part: 'nose' }, 1), null, 'a part that is not one of the fixed words');
  assert.equal(petPullEvent({ ...value, ended: 'exploded' }, 1), null, 'an end that is not one of the fixed words');
  assert.equal(petPullEvent({ part: 'arm', side: 'left' }, 1), null, 'no end: not a report');
  assert.equal(petPullEvent({ ...value, strength: 9 }, 1)?.strength, 1, 'clamped');
  assert.equal(got.length, 1);
});

/** A surface that captures pointers like a browser does. */
function fakeSurface() {
  const captured = new Set<number>();
  return { captured, setPointerCapture: (id: number) => { captured.add(id); }, hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => { captured.delete(id); } };
}

test('the pet input: press on her → capture; it becomes a pull, the stage follows, the release reports and lets go; a cancel eases back', () => {
  let now = 0;
  const calls: string[] = [], sent: PullReport[] = [];
  let allowed = true;
  const stage = {
    pullHit: (x: number, y: number) => (x > 50 ? { part: 'torso' as const, side: null, group: 'torso' as const, heightPx: 400 } : null),
    pullStart: () => { calls.push('start'); return true; },
    pullTo: (x: number, y: number) => { calls.push(`to ${x},${y}`); },
    pullEnd: () => { calls.push('end'); },
    pullStillAllowed: () => allowed,
  };
  const surface = fakeSurface();
  const pull = new PetPull(surface as unknown as HTMLElement, { stage, send: r => sent.push(r) }, () => now);
  assert.equal(pull.press(1, { x: 10, y: 10 }), false, 'beside her: not ours');
  assert.equal(pull.press(1, { x: 100, y: 100 }), true);
  assert.ok(surface.captured.has(1) && pull.owns(1));
  now = 30; pull.move({ x: 104, y: 100 });
  assert.deepEqual(calls, [], 'still a press: the body does not move yet');
  now = 60; pull.move({ x: 140, y: 100 });
  assert.deepEqual(calls, ['start', 'to 140,100']);
  now = 1600; pull.tick();
  assert.equal(sent.at(-1)?.ended, 'holding');
  now = 1700; pull.release();
  assert.deepEqual(calls.slice(-1), ['end']);
  assert.equal(sent.at(-1)?.ended, 'released');
  assert.equal(surface.captured.size, 0, 'the pointer is let go');
  // Held still: after 0.45 s it is a pull; she falls asleep: it ends as cancelled and eases back.
  assert.equal(pull.press(2, { x: 100, y: 100 }), true);
  now = 2200; pull.tick();
  assert.equal(calls.at(-2), 'start');
  allowed = false; now = 2300; pull.tick();
  assert.equal(sent.at(-1)?.ended, 'cancelled');
  assert.equal(calls.at(-1), 'end');
  assert.equal(pull.active, false);
});
