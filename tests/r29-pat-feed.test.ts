import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT, FEED_OPEN, MoodFeedback, PAT_HOLD, type MoodContact, type StageMoodState } from '../src/stage/mood-feedback';
import { EyelidCompositor, composeMouth } from '../src/stage/channel-compositors';

// B05/B06 through the same chain the stage runs per frame:
// MoodFeedback (pat envelope, feeding mouth) -> eyelid / mouth compositors.
const pleased: StageMoodState = { mood: '满足', phase: 'rua', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
const dt = 1 / 30;
/** A pat stroke sweeping left-right over the crown, as PetInteraction reports it. */
const stroke = (t: number): MoodContact => {
  const x = Math.sin(t * Math.PI * 2 * 1.6) * 0.5;
  return { ...EMPTY_CONTACT, contact: true, hover: 1, x, y: -0.2, velocityX: Math.cos(t * Math.PI * 2 * 1.6) * 0.5 * Math.PI * 2 * 1.6, velocityY: 0, speed: 1.5 };
};

test('B05: a stroke that keeps overshooting the scalp edge does not tremble the eyelids', () => {
  const feedback = new MoodFeedback(), lids = new EyelidCompositor();
  const raw: number[] = [], shown: number[] = [];
  for (let frame = 0; frame < 6 * 30; frame++) {
    const t = frame * dt;
    // Every 0.5 s the stroke leaves the hit ellipse for ~130 ms (hit-test exit: contact and position cleared).
    const outside = t > 1.5 && (t % 0.5) > 0.37;
    const out = feedback.frame(dt, outside ? EMPTY_CONTACT : stroke(t), pleased);
    raw.push(out.eyelids);
    shown.push(lids.frame(dt, { contact: out.eyelids, cheek: 0, fatigue: 0, naturalBlink: 0 }).blink);
  }
  const settled = (values: number[]) => values.slice(2 * 30);
  const swing = (values: number[]) => Math.max(...settled(values)) - Math.min(...settled(values));
  // Before R29 the enjoyed closure dropped to zero on each exit and the lids swung by ~0.2 every half second.
  assert.ok(swing(raw) < 0.01, `enjoy envelope is stable (${swing(raw).toFixed(4)})`);
  assert.ok(swing(shown) < 0.01, `shown lids are stable (${swing(shown).toFixed(4)})`);
  assert.ok(Math.min(...settled(shown)) > 0.35, 'and they stay gently closed');
});

test('B05: the pat eases in and out; leaving does not snap eyes, lids or head', () => {
  const feedback = new MoodFeedback(), rows: ReturnType<MoodFeedback['frame']>[] = [];
  for (let frame = 0; frame < 30; frame++) rows.push(feedback.frame(dt, EMPTY_CONTACT, pleased));
  const enter = rows.length;
  for (let frame = 0; frame < 60; frame++) rows.push(feedback.frame(dt, stroke(frame * dt), pleased));
  const leave = rows.length;
  for (let frame = 0; frame < 90; frame++) rows.push(feedback.frame(dt, EMPTY_CONTACT, pleased));
  const step = (key: 'headX' | 'headY' | 'headZ' | 'eyelids' | 'eyeYaw', i: number) => Math.abs(rows[i][key] - rows[i - 1][key]);
  // Ease in: the first frames of a pat carry only a small share of its weight (S-curve, not a jump).
  assert.ok(rows[enter].eyelids < 0.02 && rows[enter + 2].eyelids < rows[enter + 8].eyelids, 'closure starts gently');
  // Ease out after a real exit: every channel declines in small steps.
  for (let i = leave; i < rows.length; i++) {
    assert.ok(step('eyeYaw', i) < 0.004, `eye yaw does not snap to centre (frame ${i - leave}: ${step('eyeYaw', i).toFixed(4)})`);
    assert.ok(step('eyelids', i) < 0.03, `lids reopen gradually (frame ${i - leave})`);
    assert.ok(step('headY', i) < 0.012, `head returns gradually (frame ${i - leave})`);
  }
  // A brief exit keeps the pat (hold), a real exit releases it.
  const holdFrames = Math.floor(PAT_HOLD / dt);
  assert.ok(Math.abs(rows[leave + holdFrames - 1].eyelids - rows[leave - 1].eyelids) < 0.02, 'held through the grace period');
  assert.ok(rows.at(-1)!.eyelids < 0.05 && Math.abs(rows.at(-1)!.eyeYaw) < 0.002, 'released afterwards');
});

test('B06: the mouth anticipates the approaching snack, opens clearly when prepared and wins over speech', () => {
  const feedback = new MoodFeedback();
  let mouth = 0, lipSync = 0;
  const shown: { t: number; value: number; feed: number }[] = [];
  for (let frame = 0; frame < 5 * 30; frame++) {
    const t = frame * dt;
    // The pet is reading a reply aloud the whole time (read-aloud is on by default).
    lipSync += ((0.23 + Math.abs(Math.sin(t * 12)) * 0.45) - lipSync) * (1 - Math.exp(-16 * dt));
    const near = Math.min(1, Math.max(0, (t - 0.5) / 1)); // snack dragged toward the mouth over 1 s
    const input: MoodContact = t < 3.2 ? { ...EMPTY_CONTACT, feeding: true, prepared: t > 2.15, near, x: 0, y: 0.3 }
      : t < 4.1 ? { ...EMPTY_CONTACT, feeding: true, prepared: true } : EMPTY_CONTACT;
    const out = feedback.frame(dt, input, { ...pleased, phase: t >= 3.3 ? 'food-eating' : 'food-ready' });
    mouth = composeMouth(lipSync, out.mouth, out.mouthOwner);
    shown.push({ t, value: mouth, feed: out.mouth });
  }
  const at = (time: number) => shown[Math.round(time * 30)];
  assert.ok(at(1.0).feed > 0.05 && at(1.0).feed < at(1.5).feed, 'opening starts while the snack approaches');
  assert.ok(at(2.1).feed > FEED_OPEN * 0.45, `clearly open before the dwell completes (${at(2.1).feed.toFixed(2)})`);
  assert.ok(at(3.0).feed > 0.8, `fully open once prepared (${at(3.0).feed.toFixed(2)})`);
  const fed = shown.filter(row => row.t > 2.6 && row.t < 3.2).map(row => row.value);
  assert.ok(Math.min(...fed) > 0.8 && Math.max(...fed) - Math.min(...fed) < 0.06, 'speech does not chatter over the waiting mouth');
  const later = shown.filter(row => row.t > 4.6).map(row => row.value);
  assert.ok(Math.max(...later) - Math.min(...later) > 0.15, 'speech returns after the bite');
  for (let i = 1; i < shown.length; i++) assert.ok(Math.abs(shown[i].value - shown[i - 1].value) < 0.2, `no snap (a bite closes in ~150 ms) at ${shown[i].t.toFixed(2)} s`);
  // The hand-off never dips below both owners (no 'mouth closes, then opens' glitch).
  const approach = shown.filter(row => row.t > 0.6 && row.t < 2).map(row => row.value);
  assert.ok(Math.min(...approach) > 0.3, `speech hands over to the waiting mouth without closing (${Math.min(...approach).toFixed(2)})`);
});

test('B06: proximity is display-only and a blocked mouth stays with its manual owner', () => {
  const feedback = new MoodFeedback();
  let out = feedback.frame(dt, EMPTY_CONTACT, pleased);
  for (let frame = 0; frame < 40; frame++) out = feedback.frame(dt, { ...EMPTY_CONTACT, feeding: true, near: 1 }, pleased, false, true, true);
  assert.equal(out.mouth, 0); assert.equal(out.mouthOwner, 0);
  for (let frame = 0; frame < 40; frame++) out = feedback.frame(dt, { ...EMPTY_CONTACT, feeding: true, near: NaN }, pleased);
  assert.equal(out.mouth, 0, 'malformed proximity opens nothing');
});
