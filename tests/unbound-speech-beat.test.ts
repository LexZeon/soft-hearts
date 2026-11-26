// Unbound night experiment E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md), the opening beat as logic: its timeline (eyes,
// then head, then shoulders; the turn by angle; the 450 ms pause; the nod's three parts), the bubble gate (off: untouched; on: held
// only during the turn and the pause, in order), clean interruptions (input, hidden window, another reply, a peek), when it does
// not start at all, and that its targets never carry a blink. The body side is tests/unbound-speech-body.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOD_S, SPEECH_BEAT, SpeechBeat, SpeechBubbleGate, nodCurve, turnSecondsFor } from '../src/unbound/director/speech-beat';
import { Director, type DirectorBody } from '../src/unbound/director/director';
import { PEEK_LENS } from '../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { REST_TARGETS, type BodySense, type MotionIntent, type PoseTargets } from '../src/unbound/motion/generator';
import { planPeek, QUIET_CUE } from '../shared/unbound/director';
import { parseUnboundControlPatch, type UnboundBubble } from '../shared/unbound/scene';
import { CURIOUS, laptopLens } from './helpers/unbound-peek';

const lens = laptopLens();
const DT = 1 / 60;
type Address = Extract<MotionIntent, { kind: 'address' }>;
/** Her head, standing 1.2 m behind the screen, facing `deg` away from the lens (her frame: + = toward her left). */
function senseFacing(deg: number): BodySense {
  const head = { x: 0.25, y: 1.45, z: -1.2 };
  const toward = Math.atan2(lens.camera.x - head.x, lens.camera.z - head.z);
  return { root: { x: head.x, z: head.z, heading: toward + deg * Math.PI / 180 }, moving: false, eyes: { left: head, right: head }, head, frame: null,
    offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0.05 };
}
/** Runs the beat frame by frame; `speakS`: how long her reply streams. Returns each frame's intent and the phase log. */
function play(beat: SpeechBeat, seconds: number, speakS: number, sense: BodySense | null, at?: { t: number; run: () => void }) {
  const frames: { t: number; phase: string | null; intent: Address | null }[] = [];
  let done = false;
  for (let i = 0; i <= Math.round(seconds / DT); i++) {
    const t = i * DT;
    if (at && !done && t >= at.t) { done = true; at.run(); }
    const intent = beat.next(i ? DT : 0, t < speakS, lens, sense) as Address | null;
    frames.push({ t, phase: beat.phase, intent });
  }
  return frames;
}
const began = (beat: SpeechBeat) => { beat.enabled = true; assert.ok(beat.begin('r1', { ready: true, moving: false }, false)); };

test('the nod: down on a quintic in 180 ms, held 120 ms, back in 350 ms (zero speed at each key)', () => {
  const { downS, holdS, upS } = SPEECH_BEAT.nod;
  assert.equal(NOD_S, downS + holdS + upS);
  assert.equal(nodCurve(0), 0); assert.equal(nodCurve(downS), 1); assert.equal(nodCurve(downS + holdS / 2), 1); assert.equal(nodCurve(NOD_S), 0);
  assert.ok(Math.abs(nodCurve(downS / 2) - 0.5) < 1e-9 && Math.abs(nodCurve(downS + holdS + upS / 2) - 0.5) < 1e-9);
  const h = 1e-5;
  for (const key of [0, downS, downS + holdS, NOD_S]) assert.ok(Math.abs(nodCurve(key + h) - nodCurve(Math.max(0, key - h))) < 1e-6, `smooth at ${key}`);
  assert.equal(SPEECH_BEAT.nod.head, 10 * Math.PI / 180); assert.equal(SPEECH_BEAT.nod.neck, 2 * Math.PI / 180); assert.equal(SPEECH_BEAT.nod.torso, 2 * Math.PI / 180);
});

test('timeline: eyes at once, the head after, the shoulders last; the turn by angle; the 450 ms pause; then the nod, the talk and the release', () => {
  for (const deg of [0, 35]) {
    const beat = new SpeechBeat(); began(beat);
    const sense = senseFacing(deg), turnS = turnSecondsFor(lens, sense);
    const frames = play(beat, 4, 1.0, sense);
    const first = (pick: (i: Address) => number) => frames.find(f => f.intent && pick(f.intent) > 1e-6)?.t ?? Infinity;
    const eyes = first(i => i.look.eyes), head = first(i => i.look.head), torso = first(i => i.look.torso);
    assert.equal(eyes, 0, 'eyes on the first frame');
    assert.ok(head > eyes && head <= SPEECH_BEAT.headLagS + DT + 1e-9, `head after (${head})`);
    assert.ok(torso > head && torso <= SPEECH_BEAT.shoulderLagS + DT + 1e-9, `shoulders last (${torso})`);
    const at = (phase: string) => beat.phases.find(p => p.phase === phase)!.at;
    if (deg === 35) assert.ok(turnS > 0.3 && turnS <= SPEECH_BEAT.turnMaxS, `a real turn (${turnS})`); else assert.ok(turnS < 0.06, `already facing you (${turnS})`);
    assert.ok(Math.abs(at('pause') - turnS) <= DT, 'the pause after the turn');
    assert.ok(Math.abs(at('nod') - at('pause') - SPEECH_BEAT.pauseS) <= DT, 'the pause is 450 ms');
    assert.equal(beat.bubbleTime, at('nod'), 'the bubble comes out as the nod begins');
    assert.ok(Math.abs(at('talk') - at('nod') - NOD_S) <= DT, 'the nod lasts its three parts');
    // The nod's targets follow the curve (head 10°, neck 2°, upper body 2° at the bottom).
    const nodFrames = frames.filter(f => f.phase === 'nod');
    const deepest = Math.max(...nodFrames.map(f => f.intent!.nod.head));
    assert.ok(Math.abs(deepest - SPEECH_BEAT.nod.head) < 1e-9);
    // During the pause nothing new starts: the targets hold still.
    const pause = frames.filter(f => f.phase === 'pause' && f.t > SPEECH_BEAT.shoulderLagS + SPEECH_BEAT.onsetS + DT);
    for (const f of pause) assert.deepEqual([f.intent!.look, f.intent!.nod], [{ eyes: 1, head: 1, torso: 1 }, { head: 0, neck: 0, torso: 0 }]);
    // She spoke for 1 s: the talk lasts at least talkMinS after the bubble, then the release eases every weight to nothing.
    assert.ok(at('release') - beat.bubbleTime! >= SPEECH_BEAT.talkMinS - 1e-9);
    assert.ok(Math.abs(at('done') - at('release') - SPEECH_BEAT.afterglowS) <= DT);
    const release = frames.filter(f => f.phase === 'release');
    for (let i = 1; i < release.length; i++) assert.ok(release[i].intent!.look.head <= release[i - 1].intent!.look.head + 1e-12, 'monotone down');
    assert.equal(frames.at(-1)!.intent, null, 'over');
    assert.equal(release[0].intent!.tempo, 'calm'); assert.equal(nodFrames[0].intent!.tempo, SPEECH_BEAT.tempo);
  }
});

test('a long reply: she keeps her eyes on you while it streams, at most talkMaxS; a short one still gets talkMinS', () => {
  const long = new SpeechBeat(); began(long); play(long, 12, 30, null);
  const at = (b: SpeechBeat, phase: string) => b.phases.find(p => p.phase === phase)!.at;
  assert.ok(Math.abs(at(long, 'release') - long.bubbleTime! - SPEECH_BEAT.talkMaxS) <= DT);
  const short = new SpeechBeat(); began(short); play(short, 4, 0.1, null);
  assert.ok(Math.abs(at(short, 'release') - short.bubbleTime! - SPEECH_BEAT.talkMinS) <= DT);
});

test('interruptions at every beat: the bubble goes out at once, every weight eases from where it was (no jump) to nothing, quickly', () => {
  for (const reason of ['input', 'hidden', 'reply', 'peek'] as const) for (const when of [0.1, 0.5, 1.0, 1.6]) { // turn, pause, nod, talk (35°: the turn is 0.35 s, the bubble at 0.8 s)
    const beat = new SpeechBeat(); began(beat);
    const frames = play(beat, 3, 3, senseFacing(35), { t: when, run: () => beat.interrupt(reason) });
    const i = frames.findIndex(f => f.t >= when);
    assert.equal(beat.interrupted, reason);
    assert.ok(beat.bubbleTime !== null && beat.bubbleTime <= when + 1e-9, `${reason}@${when}: bubble out by then`);
    const before = frames[i - 1].intent!, after = frames[i].intent!;
    for (const key of ['eyes', 'head', 'torso'] as const) assert.ok(Math.abs(after.look[key] - before.look[key]) < 0.06, `${reason}@${when}: ${key} continues (${before.look[key]} → ${after.look[key]})`);
    assert.ok(Math.abs(after.nod.head - before.nod.head) < 0.03, 'the nod continues');
    const end = beat.phases.find(p => p.phase === 'done')!.at;
    assert.ok(Math.abs(end - frames[i].t - SPEECH_BEAT.interruptS) <= 2 * DT, `${reason}@${when}: wound down in ${SPEECH_BEAT.interruptS} s`);
  }
});

test('the bubble gate: off it passes every event straight on (same objects, same order); on it holds only the beat\'s own reply during turn and pause', () => {
  const events: UnboundBubble[] = [{ id: 'r1', type: 'delta', text: '嗯' }, { id: 'r1', type: 'delta', text: '，好' }, { id: 'r1', type: 'done', text: '' }];
  // Off.
  const off = new SpeechBeat(), out: UnboundBubble[] = [];
  const gateOff = new SpeechBubbleGate(off, b => out.push(b), { set: () => assert.fail('no timer when off'), clear: () => {} });
  assert.equal(off.begin('r1', { ready: true, moving: false }, false), false);
  assert.equal(off.lastSkip, 'off');
  for (const e of events) gateOff.receive(e);
  gateOff.poll();
  assert.deepEqual(out, events); assert.ok(out.every((b, i) => b === events[i]), 'the same objects');
  // On: held through the turn and the pause, then out in order as the nod begins.
  const on = new SpeechBeat(), shown: { t: number; b: UnboundBubble }[] = [];
  let t = 0;
  const gate = new SpeechBubbleGate(on, b => shown.push({ t, b }), { set: () => 1, clear: () => {} });
  began(on);
  for (const e of events) gate.receive(e);
  assert.equal(shown.length, 0, 'held');
  assert.equal(gate.holding, 3);
  for (let i = 0; i < 120; i++) { t = i * DT; on.next(i ? DT : 0, true, lens, senseFacing(35)); gate.poll(); }
  assert.deepEqual(shown.map(s => s.b), events, 'all out, in order');
  assert.ok(Math.abs(shown[0].t - on.bubbleTime!) < 1e-9);
  // Another reply while the first is held: the first goes out first, then the new one, and the beat winds down.
  const two = new SpeechBeat(), seen: string[] = [];
  const gate2 = new SpeechBubbleGate(two, b => seen.push(`${b.id}:${b.type}`), { set: () => 1, clear: () => {} });
  began(two);
  gate2.receive({ id: 'r1', type: 'delta', text: 'a' });
  gate2.receive({ id: 'r2', type: 'delta', text: 'b' });
  assert.deepEqual(seen, ['r1:delta', 'r2:delta']);
  assert.equal(two.interrupted, 'reply');
});

test('the bubble is never held past the safety cap, even when frames stop (a hidden window)', () => {
  const beat = new SpeechBeat(), out: UnboundBubble[] = [];
  let fire: (() => void) | null = null, ms = 0, cleared = 0;
  const gate = new SpeechBubbleGate(beat, b => out.push(b), { set: (run, delay) => { fire = run; ms = delay; return 7; }, clear: () => { cleared++; } });
  began(beat);
  gate.receive({ id: 'r1', type: 'delta', text: '嗯' });
  assert.equal(out.length, 0);
  assert.equal(ms, SPEECH_BEAT.bubbleCapMs);
  assert.ok(SPEECH_BEAT.bubbleCapMs >= (SPEECH_BEAT.turnMaxS + SPEECH_BEAT.pauseS) * 1000 + 100, 'the cap leaves room for the longest turn and the pause');
  fire!();
  assert.equal(out.length, 1, 'out at the cap');
  assert.equal(beat.interrupted, 'hidden');
  // Released normally: the timer is cleared.
  const b2 = new SpeechBeat(); let cleared2 = 0;
  const g2 = new SpeechBubbleGate(b2, () => {}, { set: () => 9, clear: () => { cleared2++; } });
  began(b2); g2.receive({ id: 'r1', type: 'delta', text: 'x' });
  for (let i = 0; i < 80; i++) { b2.next(i ? DT : 0, true, lens, null); g2.poll(); }
  assert.equal(cleared2, 1);
  assert.equal(cleared, 0);
});

/** A body for the director: records the targets it is handed. */
function fakeBody(sense: BodySense | null): DirectorBody & { targets: PoseTargets[] } {
  const targets: PoseTargets[] = [];
  return { targets, get sense() { return sense; }, setPoseTargets: t => { targets.push(t); }, get intentIdle() { return true; } };
}

test('the director: off, a reply changes nothing; on, the first words start it and her mouse moves, a peek or another start wind it down', () => {
  const world = { lens, home: { x: 0.25, z: -1.2 } };
  // Off (the switch) and none (no beat at all): the same targets, frame for frame.
  const runs = [null, false].map(enabled => {
    const speech = enabled === null ? null : new SpeechBeat();
    const director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {}, speech);
    const body = fakeBody(senseFacing(35));
    for (let i = 0; i < 90; i++) {
      if (i === 10) director.setCue({ ...QUIET_CUE, speaking: true, replyId: 'r1' });
      if (i === 70) director.setCue({ ...QUIET_CUE, speaking: false });
      director.frame(DT, world, body);
    }
    return body.targets;
  });
  assert.deepEqual(runs[0], runs[1]);
  assert.equal(runs[0].length, 0, 'no targets at all: her idle is untouched');
  // On.
  const speech = new SpeechBeat(); speech.enabled = true;
  const director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {}, speech);
  const body = fakeBody(senseFacing(35));
  director.frame(DT, world, body); // her body measured once
  director.setCue({ ...QUIET_CUE, speaking: true, replyId: 'r1' });
  assert.equal(speech.phase, 'turn');
  for (let i = 0; i < 10; i++) director.frame(DT, world, body);
  assert.ok(body.targets.length === 10 && body.targets.every(t => t.blink === 0), 'targets every frame, never a blink');
  assert.ok(body.targets.at(-1)!.eyes.yaw !== 0, 'her eyes toward you');
  // 2026-11-23: the director takes no pointer input at all; only a large pull winds the beat down.
  assert.equal((director as unknown as { input?: unknown }).input, undefined, 'no pointer input on the director');
  assert.equal(speech.phase === 'turn' || speech.phase === 'pause', true);
  speech.interrupt('pull');
  assert.equal(speech.interrupted, 'pull');
  for (let i = 0; i < 40; i++) director.frame(DT, world, body);
  assert.equal(speech.active, false);
  assert.deepEqual(body.targets.at(-1), { ...REST_TARGETS }, 'back to rest');
  // A peek starting takes over and winds the beat down; a reply during a peek gets no beat.
  director.setCue({ ...QUIET_CUE, speaking: false });
  director.setCue({ ...QUIET_CUE, speaking: true, replyId: 'r2' });
  assert.equal(speech.phase, 'turn');
  director.command({ type: 'start', id: 'p1', plan: planPeek(CURIOUS, () => 0.4), trial: true, armAfterMs: 0 }, world);
  assert.equal(speech.interrupted, 'peek');
  director.setCue({ ...QUIET_CUE, speaking: false });
  director.setCue({ ...QUIET_CUE, speaking: true, replyId: 'r3' });
  assert.equal(speech.lastSkip, 'peek');
});

test('it does not start while she walks, before her body is measured, or while one is playing', () => {
  const beat = new SpeechBeat(); beat.enabled = true;
  assert.equal(beat.begin('a', { ready: true, moving: true }, false), false); assert.equal(beat.lastSkip, 'moving');
  assert.equal(beat.begin('a', { ready: false, moving: false }, false), false); assert.equal(beat.lastSkip, 'moving');
  assert.equal(beat.begin('a', { ready: true, moving: false }, false), true);
  assert.equal(beat.begin('b', { ready: true, moving: false }, false), false); assert.equal(beat.lastSkip, 'busy');
  assert.equal(beat.replyId, 'a');
});

test('the panel switch: a boolean only', () => {
  assert.deepEqual(parseUnboundControlPatch({ speechBeat: true }), { speechBeat: true });
  assert.deepEqual(parseUnboundControlPatch({ speechBeat: false }), { speechBeat: false });
  assert.throws(() => parseUnboundControlPatch({ speechBeat: 1 }));
});
