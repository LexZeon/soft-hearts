// I-136 step 5e「拉她」: her body attitude from her mood (shared/behaviors/pull/attitude.ts). Same numbers, same stance; different numbers,
// a different stance; slipping free only when hard + long + unwilling (and not sleepy); the give never goes above 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULL_ATTITUDE_KNOBS, pullAttitudeNow, pullGiveNow, pullStanceOf } from '../shared/behaviors/pull/attitude';
import type { PullReport } from '../shared/behaviors/pull/session';
import { touchWords } from '../shared/behaviors/touch-response/words';
import { parseTouchEvent } from '../shared/mood/touch';
import { PetPull } from '../src/mood/pet-pull';

const base = { D: 50, O: 50, E: 50, N: 50, C: 50 };
const reading = (delta: Partial<typeof base>, sleepy = 0, extra = {}) => ({ values: { ...base, ...delta }, baseline: base, sleepy, ...extra });

test('the mood decides: close follows loosely, tense stands firm and pulls back, sleepy follows softly and slowly, new pauses first', () => {
  const plain = pullStanceOf(reading({}));
  const close = pullStanceOf(reading({ O: 75 }));
  const tense = pullStanceOf(reading({ N: 75, C: 70, O: 40 }));
  const sleepy = pullStanceOf(reading({ N: 75, C: 70, O: 40 }, 0.9));
  const happy = pullStanceOf(reading({ D: 75 }));
  const fresh = pullStanceOf(reading({}, 0, { newness: 1 }));
  assert.deepEqual(pullStanceOf(reading({ O: 75 })), close, 'deterministic');
  assert.ok(close.willing > plain.willing && close.compliance > plain.compliance);
  assert.ok(tense.willing < plain.willing && tense.compliance < plain.compliance && tense.resist > 0.2);
  assert.ok(sleepy.pace < 0.7 && sleepy.resist < 0.05, 'sleepy: slow, never pulls back');
  assert.ok(happy.pace > plain.pace, 'happy: quicker');
  assert.ok(fresh.hesitateMs > 0 && plain.hesitateMs === 0, 'new to each other: a pause first');
  for (const stance of [plain, close, tense, sleepy, happy, fresh]) assert.ok(stance.compliance <= 1 && stance.compliance >= PULL_ATTITUDE_KNOBS.minCompliance);
});

test('slipping free needs a hard pull, a long one and her unwilling (not sleepy); otherwise follow, firm or pull back', () => {
  const tense = pullStanceOf(reading({ N: 90, C: 90, O: 30 }));
  const close = pullStanceOf(reading({ O: 80 }));
  assert.equal(pullAttitudeNow(tense, 0.9, 6000), 'slip');
  assert.equal(pullAttitudeNow(tense, 0.9, 2000), 'pull-back', 'not long yet');
  assert.equal(pullAttitudeNow(tense, 0.3, 9000), 'firm', 'not hard');
  assert.equal(pullAttitudeNow(close, 1, 9000), 'follow', 'willing');
  assert.equal(pullAttitudeNow(tense, 0.9, 6000, 0.8), 'pull-back', 'sleepy: she does not slip free');
  assert.ok(pullGiveNow(tense, 1) < pullGiveNow(tense, 0.5), 'she gives less on a hard pull she resists');
  assert.equal(pullGiveNow(close, 1), close.compliance, 'willing: no less give');
  assert.ok(pullGiveNow(close, 1) <= 1);
});

test('what Claude is told: the facts of what her body did (walked along, pulled back, slipped free), no instruction', () => {
  assert.equal(touchWords([{ kind: 'pull', part: 'hand', strength: 0.3, steps: 3, face: 'smile' }]), '用户刚才轻轻拉了拉你的手，你跟着走了几步、抿嘴笑了一下。');
  assert.equal(touchWords([{ kind: 'pull', part: 'arm', strength: 0.9, response: 'pulled-back', face: 'wince' }]), '用户刚才用力拉了拉你的胳膊，你往回拽了一下、皱着眼躲了一下。');
  assert.equal(touchWords([{ kind: 'pull', part: 'hand', strength: 0.9, heldMs: 6000, response: 'pulled-back', ended: 'broke-free', face: 'wince' }]),
    '用户刚才用力拉着你的手不放，你往回拽了一下、皱着眼躲了一下、挣开了。');
  assert.equal(parseTouchEvent({ kind: 'pull', part: 'hand', side: null, where: 'unbound', at: 1, response: 'ran-away', steps: 999 })?.response, undefined, 'only the fixed words');
  assert.equal(parseTouchEvent({ kind: 'pull', part: 'hand', side: null, where: 'unbound', at: 1, steps: 999 })?.steps, 50, 'steps clamped');
  assert.equal(parseTouchEvent({ kind: 'click', part: 'hand', side: null, where: 'unbound', at: 1, steps: 3, response: 'followed' })?.steps, undefined, 'a click carries none');
});

test('the pet input (5e): a tense her pulls back on a hard pull, and slips free when it is hard and long; a close her just follows', () => {
  const run = (mood: ReturnType<typeof reading>) => {
    let now = 0, ended = 0;
    const sent: PullReport[] = [], stances: { compliance: number; pace: number }[] = [];
    const captured = new Set<number>();
    const surface = { setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
    const stage = { pullHit: () => ({ part: 'hand' as const, side: 'right' as const, group: 'arm' as const, heightPx: 400 }), pullStart: () => true, pullTo() {}, pullEnd: () => { ended++; },
      pullStillAllowed: () => true, pullMood: () => mood, setPullStance: (s: { compliance: number; pace: number } | null) => { if (s) stances.push(s); } };
    const pull = new PetPull(surface as unknown as HTMLElement, { stage, send: r => sent.push(r) }, () => now);
    pull.press(1, { x: 100, y: 100 });
    now = 50; pull.move({ x: 400, y: 100 }); // 300 px of 0.6 × 400: a full pull
    for (now = 100; now <= 8000 && pull.active; now += 100) pull.tick();
    if (pull.active) pull.release();
    return { sent, stances, ended };
  };
  const tense = run(reading({ N: 90, C: 90, O: 30 }));
  assert.equal(tense.sent.at(-1)?.ended, 'broke-free');
  assert.equal(tense.sent.at(-1)?.response, 'pulled-back');
  assert.ok(tense.stances.some(s => s.pace < 0.6), 'slipping free eases back slowly');
  assert.equal(tense.ended, 1);
  const close = run(reading({ O: 85 }));
  assert.equal(close.sent.at(-1)?.ended, 'released');
  assert.equal(close.sent.at(-1)?.response, undefined);
  assert.ok(close.stances.every(s => s.compliance <= 1));
});
