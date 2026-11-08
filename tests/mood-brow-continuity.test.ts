/**
 * R29: the mood face's troubled brow (困る; Gene's morph 68) eases in and out instead of stepping
 * (docs/claude/2026-11-06-reunion-brow-jump.md). Before, MoodFeedback returned the brow as its raw target: a reunion
 * (relieved + wistful) put 0.1 on the brow in one frame, a sad or disappointed mood 0.19-0.21, and the display guard had to
 * catch it (30 fps: 0.038 shown on the first frame). The other mood-face channels (smile, eyelids) were already eased.
 *
 * Unit checks on MoodFeedback itself, then the real Stage frame loop (gene-stage-harness) at 60 and 30 fps.
 * R29_REPORT=1 prints the per-switch numbers for the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/stage/mood-feedback';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot, type MoodSnapshot } from '../shared/mood';
import { geneStage, type ShownFrame } from './helpers/gene-stage-harness';

const REPORT = !!process.env.R29_REPORT;
const reunionFace: StageMoodState = { mood: 'relieved', companion: 'wistful', phase: 'idle', expressive: true, face: 50, posture: 50, playful: 50, responding: false };

/** Seconds until `values` first covers 90% of the way from its first to its last value. */
const t90 = (values: readonly number[], dt: number) => {
  const from = values[0], to = values.at(-1)!;
  return values.findIndex(value => Math.abs(value - from) >= 0.9 * Math.abs(to - from)) * dt;
};

for (const fps of [60, 30]) {
  test(`at ${fps} fps the reunion brow eases in from 0 to its unchanged 0.1: a small first step, ~0.25 s to 90%, no overshoot`, () => {
    const layer = new MoodFeedback(), dt = 1 / fps, quiet = { ...reunionFace, mood: 'calm', companion: null };
    for (let i = 0; i < fps; i++) assert.equal(layer.frame(dt, EMPTY_CONTACT, quiet).sadness, 0);
    const brow = [0];
    for (let i = 0; i < 2 * fps; i++) brow.push(layer.frame(dt, EMPTY_CONTACT, reunionFace).sadness);
    assert.equal(brow.at(-1), 0.1, 'the same expression as before: exactly 0.1 once settled');
    assert.ok(brow.every(value => value <= 0.1), 'never overshoots');
    // Critically damped (frame-rate independent): the first frame at 30 fps is ~10% of the way, at 60 fps ~3%.
    assert.ok(brow[1] > 0 && brow[1] <= 0.011, `first frame ${brow[1]}`);
    const steps = brow.slice(1).map((value, i) => value - brow[i]);
    assert.ok(steps.every(step => step >= 0), 'rises monotonically');
    // Speed builds up from rest instead of starting at full speed.
    assert.ok(steps[1] > steps[0], 'the first frame is the gentlest of the start');
    const arrive = t90(brow, dt);
    assert.ok(arrive >= 0.2 && arrive <= 0.3, `90% after ${arrive} s`);
    if (REPORT) console.log(`mood brow unit ${fps} fps: first ${brow[1].toFixed(4)}, max step ${Math.max(...steps).toFixed(4)}, t90 ${arrive.toFixed(3)} s`);
  });

  test(`at ${fps} fps the brow eases out to exactly 0 when the mood or the expressions switch leaves (the drowsy brow waits for exactly 0)`, () => {
    for (const leave of [{ ...reunionFace, mood: 'happy', companion: null }, { ...reunionFace, expressive: false }, { ...reunionFace, mood: 'sad', companion: null, face: 0 }]) {
      const layer = new MoodFeedback(), dt = 1 / fps;
      for (let i = 0; i < 2 * fps; i++) layer.frame(dt, EMPTY_CONTACT, { ...reunionFace, mood: 'sad', companion: null });
      const brow = [layer.frame(0, EMPTY_CONTACT, { ...reunionFace, mood: 'sad', companion: null }).sadness];
      assert.ok(Math.abs(brow[0] - 0.18) < 1e-12, 'a frame with no elapsed time holds the shown value');
      for (let i = 0; i < 2 * fps; i++) brow.push(layer.frame(dt, EMPTY_CONTACT, leave).sadness);
      assert.equal(brow.at(-1), 0, 'ends at exactly 0');
      assert.ok(brow[0] - brow[1] <= 0.105 * 0.18, `first frame ${brow[0] - brow[1]}`);
      assert.ok(brow.slice(1).every((value, i) => value <= brow[i] && value >= 0), 'falls monotonically, never below 0');
    }
  });
}

test('a face block and a reset still clear the brow target (the stage stops writing the brow while blocked)', () => {
  const layer = new MoodFeedback();
  for (let i = 0; i < 60; i++) layer.frame(1 / 30, EMPTY_CONTACT, reunionFace);
  let blocked = 0;
  for (let i = 0; i < 60; i++) blocked = layer.frame(1 / 30, EMPTY_CONTACT, reunionFace, true).sadness;
  assert.equal(blocked, 0);
  const back = layer.frame(1 / 30, EMPTY_CONTACT, reunionFace).sadness;
  assert.ok(back > 0 && back <= 0.011, 'back from a block it eases in again, from 0');
  layer.reset();
  assert.ok(layer.frame(1 / 30, EMPTY_CONTACT, reunionFace).sadness <= 0.011, 'reset forgets the shown brow and its speed');
});

/** The brow on the real frame loop from one mood to another, and what the display guard caught. */
async function moodSwitch(fps: number, from: Partial<MoodSnapshot> | null, to: (now: number) => MoodSnapshot) {
  const h = await geneStage({ fps });
  try {
    const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS), base = getMoodSnapshot(createMoodState(0));
    if (from) h.stage.setMood({ characterId: 'gene', token: 'gene_token', revision: 2, developerMode: false, expressions: true, parameters, snapshot: { ...base, ...from } });
    h.run(2);
    const start = h.shown.length - 1;
    h.stage.setMood({ characterId: 'gene', token: 'gene_token', revision: 3, developerMode: false, expressions: true, parameters, snapshot: to(Date.now()) });
    h.run(2);
    const frames: ShownFrame[] = h.shown.slice(start), brow = frames.map(frame => frame.brow);
    const steps = brow.slice(1).map((value, i) => value - brow[i]);
    // R29d's "unexpected step": how far this frame's change differs from the last frame's (a cut or a full-speed start is large).
    const unexpected = steps.map((step, i) => Math.abs(step - (i ? steps[i - 1] : 0)));
    const catches = frames.filter((frame, i) => i && frame.guardJumps !== frames[i - 1].guardJumps).map(frame => frame.guardLast);
    return { brow, travel: brow.at(-1)! - brow[0], first: steps[0], unexpected: Math.max(...unexpected), arrive: t90(brow, 1 / fps), catches };
  } finally { h.close(); }
}

const reunionSnapshot = (now: number) => {
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS), initial = createMoodState(now, parameters);
  initial.lastInteractionAt = now - parameters.longing.graceMs - 86 / parameters.longing.perHour * 3_600_000;
  const snapshot = getMoodSnapshot(applyMoodEvent(initial, { type: 'chat', id: 'brow-reunion', context: 'neutral' }, now, parameters), now, parameters);
  assert.equal(snapshot.cryingCandidate, true); assert.equal(snapshot.primary, 'relieved'); assert.equal(snapshot.companion, 'wistful');
  return snapshot;
};
const plain = (primary: MoodSnapshot['primary'], companion: MoodSnapshot['companion'] = null) => (): MoodSnapshot => ({ ...getMoodSnapshot(createMoodState(0)), primary, companion });
const SWITCHES = [
  { name: 'reunion after a long absence', from: null, to: reunionSnapshot },
  { name: 'calm -> sad', from: { primary: 'calm' }, to: plain('sad') },
  { name: 'calm -> disappointed', from: { primary: 'calm' }, to: plain('disappointed') },
  { name: 'relieved -> relieved + wistful', from: { primary: 'relieved', companion: null }, to: plain('relieved', 'wistful') },
] as const;

for (const fps of [60, 30]) {
  test(`R29: at ${fps} fps on the real frame loop a mood face's brow never needs the display guard and starts gently`, async () => {
    for (const { name, from, to } of SWITCHES) {
      const result = await moodSwitch(fps, from, to);
      if (REPORT) console.log(`mood brow ${fps} fps ${name}: ${result.brow[0].toFixed(4)} -> ${result.brow.at(-1)!.toFixed(4)}, first step ${result.first.toFixed(4)}, ` +
        `max unexpected step ${result.unexpected.toFixed(4)}, 90% after ${result.arrive.toFixed(3)} s, guard ${JSON.stringify(result.catches)}`);
      assert.deepEqual(result.catches, [], `${name}: nothing for the display guard to catch`);
      assert.ok(result.travel > 0.05, `${name}: the brow still shows (${result.travel})`);
      assert.ok(result.first <= 0.12 * result.travel, `${name}: the first frame is a small part of the way (${result.first} of ${result.travel})`);
      assert.ok(result.unexpected <= 0.2 * result.travel, `${name}: no one-frame kick (${result.unexpected} of ${result.travel})`);
    }
  });
}
