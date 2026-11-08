/**
 * T-215 嘴和眼睑的短暂独占 on the real stage frame loop (bundled Gene, Stand, procedural life, mood feedback, the display
 * guard), through the stage's own playHerAction (resolve, the pinned bytes, the VMD parser, the morph check):
 *  - with no face shape asked for, the stage shows exactly what it showed without the module (every morph and bone, every
 *    frame), through speech, a prepare signal, a pat and natural blinks;
 *  - each of the four shows on Gene, owns its whole conflict group while it holds, moves smoothly, leaves the guard nothing,
 *    and afterwards she is exactly where a stage that did nothing is;
 *  - speech starting in the middle: the shape hands the mouth back from the prepare signal (or the first sound), onto the live
 *    lip-sync; the calls are synchronous and cheap (the sound never waits);
 *  - blinks: a blink due during the wink is not shown during it, and comes once, a while after (no double blink); a wink asked
 *    for during a blink starts when the blink has opened;
 *  - X-321 (Codex): a shape still waiting on its resource or its VMD when setMood alone switches the character or the
 *    conversation never starts in the new one; a mood update within the same conversation keeps it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { HER_ACTION_SPECS, HER_FACE_ACTIONS } from '../shared/her-actions';
import { FACE_EXCLUSIVE_BLINK_GAP_S, FACE_EXCLUSIVE_TIMING } from '../src/stage/face-exclusive';
import { geneStage, patContact, type GeneStage, type ShownFrame } from './helpers/gene-stage-harness';

const morphCount = (h: GeneStage) => h.mesh.morphTargetInfluences!.length;
const index = (h: GeneStage, name: string) => h.mesh.morphTargetDictionary![name];
/** The displayed weight of one morph per frame. */
const series = (frames: readonly ShownFrame[], i: number) => frames.map(frame => frame.all![i]);
/** Largest one-frame change of any morph over the frames (the displayed face). */
function maxMorphStep(frames: readonly ShownFrame[], count: number, only?: readonly number[]) {
  let best = 0, at = -1, which = -1;
  for (let k = 1; k < frames.length; k++) for (const i of only ?? Array.from({ length: count }, (_, n) => n)) {
    const step = Math.abs(frames[k].all![i] - frames[k - 1].all![i]);
    if (step > best) { best = step; at = k; which = i; }
  }
  return { best, at, which };
}
async function pair(options: { faceExclusive?: boolean } = {}) {
  const a = await geneStage({ herActions: true, fps: 60, recordAll: true }), b = await geneStage({ herActions: true, fps: 60, recordAll: true, ...options });
  return { a, b, close: () => { b.close(); a.close(); } };
}
function lockstep(a: GeneStage, b: GeneStage, seconds: number, each?: (time: number) => void) {
  for (let i = 0, n = Math.round(seconds * a.rate); i < n; i++) { each?.(a.time()); a.tick(); b.tick(); }
}
function both(a: GeneStage, b: GeneStage, act: (h: GeneStage) => void) { act(a); act(b); }

test('idle: with no face shape asked for, every displayed morph and bone is exactly what the stage showed without the module', async () => {
  const { a, b, close } = await pair({ faceExclusive: false });
  try {
    assert.ok(a.stage.faceExclusive && b.stage.faceExclusive === null);
    lockstep(a, b, 1.0);
    // Speech with its prepare signal, a pat, natural blinks (the first is due at 2.5 s), speech without a prepare.
    both(a, b, h => h.stage.setSpeechPreparing(true));
    lockstep(a, b, 0.08);
    both(a, b, h => h.stage.setSpeaking(true));
    lockstep(a, b, 1.2);
    both(a, b, h => { h.stage.setSpeaking(false); h.stage.setSpeechPreparing(false); });
    lockstep(a, b, 0.6, time => both(a, b, h => h.stage.setMoodContact(patContact(time))));
    both(a, b, h => h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0 }));
    lockstep(a, b, 1.5);
    both(a, b, h => h.stage.setSpeaking(true, 'remote'));
    lockstep(a, b, 0.7);
    both(a, b, h => h.stage.setSpeaking(false, 'remote'));
    lockstep(a, b, 1.0);
    assert.equal(a.shown.length, b.shown.length);
    let blinks = 0;
    for (let k = 0; k < a.shown.length; k++) {
      assert.deepEqual(a.shown[k].all, b.shown[k].all, `frame ${k} (t = ${a.shown[k].t.toFixed(3)} s) differs`);
      if (k && a.shown[k].blink > 0.5 && a.shown[k - 1].blink <= 0.5) blinks++;
    }
    assert.ok(blinks >= 1, 'natural blinks ran through it');
    assert.equal(a.stage.faceExclusive.owned(), null);
    assert.equal(a.stage.renderer.domElement.dataset.faceExclusive, undefined, 'no diagnostics written while idle');
  } finally { close(); }
});

const TARGET: Record<string, string> = { 'cheek-puff': 'cheekPuff', pout: 'mouthPucker', wink: 'ウィンク', 'tongue-out': 'tongueOut' };

test('the four on Gene: each shows, owns its conflict group while it holds, moves smoothly, the guard has nothing, and afterwards she is where an idle stage is', async t => {
  const lines: string[] = [];
  for (const id of HER_FACE_ACTIONS) {
    const { a, b, close } = await pair();
    try {
      lockstep(a, b, 0.7);
      const jumps = a.shown.at(-1)!.guardJumps, start = a.shown.length;
      const report = await a.playAction(id);
      assert.deepEqual(report && { status: report.status, missing: report.missing }, { status: 'played', missing: [] }, id);
      const state = a.stage.faceExclusive.getState()[HER_ACTION_SPECS[id].face!.scope];
      const group: number[] = a.stage.faceExclusive.conflictGroup(state.targets);
      const seconds = HER_ACTION_SPECS[id].durationFrames / 30;
      lockstep(a, b, seconds + 0.6);
      const frames = a.shown.slice(start - 1), idle = b.shown.slice(start - 1), target = index(a, TARGET[id]);
      const peak = Math.max(...series(frames, target));
      // While it holds (the middle of its own hold keys), the clip owns the group completely.
      const hold = id === 'wink' ? [0.21, 0.29] : id === 'tongue-out' ? [0.5, 0.7] : id === 'pout' ? [0.8, 1.3] : [0.65, 1.1];
      const held = frames.filter(frame => frame.t - frames[0].t >= hold[0] && frame.t - frames[0].t <= hold[1]);
      assert.ok(held.length > 2, `${id}: frames in the hold`);
      const clip = new Map<number, number>(id === 'wink' ? [[target, 0.9]] : id === 'cheek-puff' ? [[target, 0.9]]
        : id === 'tongue-out' ? [[target, 0.9], [index(a, 'あ'), 0.45]]
        : [[target, 0.9], [index(a, 'う'), 0.42], [index(a, 'mouthFrownLeft'), 0.35], [index(a, 'mouthFrownRight'), 0.35]]);
      for (const frame of held) for (const i of group) {
        const expected = clip.get(i) ?? 0;
        assert.ok(Math.abs(frame.all![i] - expected) < 0.02, `${id}: morph #${i} shows ${frame.all![i].toFixed(4)} in the hold (clip ${expected})`);
      }
      // Over the morphs it writes (a natural blink elsewhere moves 0.3 a frame on its own, in both stages).
      const step = maxMorphStep(frames, morphCount(a), group), idleStep = maxMorphStep(idle, morphCount(b), group);
      const guard = a.shown.at(-1)!.guardJumps - jumps;
      // It never touches a bone: the gaze (eye bones), head and body are the idle stage's exactly, every frame it plays.
      const bonesFrom = morphCount(a);
      for (let k = start; k < start + Math.round(seconds * 60); k++)
        assert.deepEqual(a.shown[k].all!.subarray(bonesFrom), b.shown[k].all!.subarray(bonesFrom), `${id}: frame ${k - start}: a bone differs`);
      // Afterwards: the module wrote nothing more, and every morph and bone is the idle stage's.
      let apart = 0;
      for (const frame of a.shown.slice(-6)) {
        const other = b.shown[a.shown.indexOf(frame)];
        for (let i = 0; i < frame.all!.length; i++) apart = Math.max(apart, Math.abs(frame.all![i] - other.all![i]));
      }
      lines.push(`${id}: group ${group.length} morphs, peak ${peak.toFixed(3)}, largest one-frame morph step ${step.best.toFixed(4)} (#${step.which}; idle stage ${idleStep.best.toFixed(4)}), guard ${guard}, afterwards ${apart.toExponential(2)} from idle`);
      assert.ok(peak > 0.85, `${id}: shows (${peak})`);
      assert.ok(step.best < (id === 'wink' ? 0.2 : 0.12), `${id}: no frame moves a morph more than that (${step.best} at frame ${step.at}, #${step.which})`);
      assert.equal(guard, 0, `${id}: the display guard caught ${guard} (${a.shown.at(-1)!.guardLast})`);
      assert.equal(a.stage.faceExclusive.owned(), null, `${id}: over`);
      // The wink postpones her next blink (no double blink), so her blink schedule differs from the idle stage after it.
      if (id !== 'wink') assert.ok(apart < 1e-9, `${id}: afterwards exactly where the idle stage is (${apart})`);
      else assert.equal(a.shown.at(-1)!.all![target], 0, 'the wink is closed again');
    } finally { close(); }
  }
  t.diagnostic(lines.join('\n'));
});

test('speech starting in the middle: the mouth shape hands back from the prepare signal (or the first sound) onto the live lip-sync, smoothly; the calls are cheap', async t => {
  const lines: string[] = [];
  for (const [id, lead] of [['pout', 0.3], ['tongue-out', 0.06], ['cheek-puff', 0]] as const) {
    const { a, b, close } = await pair();
    try {
      lockstep(a, b, 0.7);
      assert.equal((await a.playAction(id))?.status, 'played');
      lockstep(a, b, 0.6); // in its hold
      const start = a.shown.length, jumps = a.shown.at(-1)!.guardJumps;
      if (lead > 0) {
        both(a, b, h => h.stage.setSpeechPreparing(true));
        assert.equal(a.stage.faceExclusive.getState().mouth.phase, 'releasing', `${id}: handing back from the prepare signal`);
        lockstep(a, b, lead);
      }
      const weightAtSound = a.stage.faceExclusive.getState().mouth?.weight ?? 0;
      both(a, b, h => h.stage.setSpeaking(true));
      assert.ok(!a.stage.faceExclusive.active('mouth') || a.stage.faceExclusive.getState().mouth.phase === 'releasing', `${id}: never past the first sound`);
      const soundAt = a.shown.length;
      lockstep(a, b, 0.8);
      const releasedAt = a.stage.faceExclusive.getState().ended;
      // The diagnostics the real-window check reads: who started the hand-back, the ownership at the first sound, when clear.
      const record = a.stage.faceSpeech;
      assert.equal(record.releasedBy, lead > 0 ? 'prepare' : 'speaking');
      assert.ok(Math.abs(record.weightAtSound - weightAtSound) < 1e-9 && record.speakingAt !== null && record.clearAt !== null, JSON.stringify(record));
      assert.equal(record.prepareAt !== null, lead > 0);
      // A new mouth shape while she speaks: refused, and it says why.
      const refused = await a.playAction('pout');
      assert.equal(refused?.status, 'busy'); assert.match(refused!.detail, /说话/u);
      both(a, b, h => { h.stage.setSpeaking(false); h.stage.setSpeechPreparing(false); });
      lockstep(a, b, 0.3);
      const frames = a.shown.slice(start - 1), mouth = index(a, 'あ');
      const group: number[] = a.stage.faceExclusive.conflictGroup([index(a, TARGET[id])]);
      const step = maxMorphStep(frames, morphCount(a), group);
      // Within the cancel time after the first hand-back signal, she shows exactly the stage that never made the shape.
      const handBack = Math.round(FACE_EXCLUSIVE_TIMING.mouth.cancel * 60) + 2;
      let apart = 0;
      for (let k = start + handBack; k < a.shown.length; k++) for (let i = 0; i < a.shown[k].all!.length; i++) apart = Math.max(apart, Math.abs(a.shown[k].all![i] - b.shown[k].all![i]));
      const firstLip = a.shown[soundAt].all![mouth], idleLip = b.shown[soundAt].all![mouth];
      lines.push(`${id}: prepare lead ${(lead * 1000).toFixed(0)} ms → ownership at the first sound ${weightAtSound.toFixed(3)}; first lip-sync frame あ ${firstLip.toFixed(4)} (no shape: ${idleLip.toFixed(4)}); largest group step ${step.best.toFixed(4)}; ended ${releasedAt?.how}/${releasedAt?.reason}; afterwards ${apart.toExponential(2)} from the stage without it`);
      assert.equal(a.shown.at(-1)!.guardJumps, jumps, `${id}: nothing for the guard (${a.shown.at(-1)!.guardLast})`);
      assert.ok(step.best < 0.12, `${id}: the hand-back moves no mouth morph more than 0.12 a frame (${step.best})`);
      assert.equal(releasedAt?.reason, 'speech');
      assert.ok(apart < 1e-9, `${id}: after the hand-back, exactly the live lip-sync (${apart})`);
      if (lead >= FACE_EXCLUSIVE_TIMING.mouth.cancel) assert.equal(weightAtSound, 0, 'a lead longer than the hand-back: the mouth is clear before the first sound');
    } finally { close(); }
  }
  // The calls on the speech path are synchronous and cheap (the sound is never held for the face).
  const h = await geneStage({ herActions: true, fps: 60 });
  try {
    h.run(0.5);
    assert.equal((await h.playAction('pout'))?.status, 'played');
    h.run(0.4);
    const n = 2000, began = performance.now();
    for (let i = 0; i < n; i++) { h.stage.setSpeechPreparing(i % 2 === 0); h.stage.setSpeaking(i % 2 === 0); }
    const perCall = (performance.now() - began) / (n * 2) * 1000;
    lines.push(`setSpeechPreparing / setSpeaking with a mouth shape up: ${perCall.toFixed(2)} µs per call`);
    assert.ok(perCall < 200, `${perCall} µs`);
  } finally { h.close(); }
  t.diagnostic(lines.join('\n'));
});

test('blinks and the wink: a blink due during the wink waits and comes once, a while after (no double blink); a wink asked for during a blink starts when it has opened', async t => {
  const lines: string[] = [];
  const h = await geneStage({ herActions: true, fps: 60, recordAll: true });
  try {
    const blink = index(h, 'まばたき'), wink = index(h, 'ウィンク');
    h.run(0.6);
    h.stage.nextBlink = h.stage.elapsed + 30; // no natural blink in the way of the first case
    h.run(0.1);
    const start = h.shown.length;
    assert.equal((await h.playAction('wink'))?.status, 'played');
    h.stage.nextBlink = h.stage.elapsed + 0.1; // a blink falls due in the middle of the wink
    h.run(2.2);
    const frames = h.shown.slice(start - 1), lid = series(frames, blink), one = series(frames, wink);
    const end = frames.findIndex((frame, k) => k > 3 && one[k] === 0 && one[k - 1] > 0);
    const pulses: number[] = [];
    for (let k = 1; k < frames.length; k++) if (lid[k] > 0.5 && lid[k - 1] <= 0.5) pulses.push(k);
    const together = frames.filter((_, k) => lid[k] > 0.05 && one[k] > 0.05).length;
    lines.push(`blink due 0.1 s into the wink: wink ended at frame ${end}, blink pulses at frames ${pulses.join(', ')} (gap ${((pulses[0] - end) / 60).toFixed(2)} s), frames with both lids moving: ${together}`);
    assert.ok(end > 0, 'the wink ran and ended');
    assert.equal(pulses.length, 1, `exactly one blink after the wink (frames ${pulses})`);
    assert.ok(pulses[0] >= end + Math.floor(FACE_EXCLUSIVE_BLINK_GAP_S * 60) - 1, `the blink waits ${FACE_EXCLUSIVE_BLINK_GAP_S} s after the wink`);
    assert.equal(together, 0, 'no frame with the blink and the wink both closing the lids');
    // A wink asked for while a natural blink is closing: it starts once the blink has opened.
    h.run(1.0);
    h.stage.nextBlink = h.stage.elapsed; // a blink starts on the next frame
    h.run(2 / 60);
    assert.ok(h.stage.naturalBlink > 0, 'blinking now');
    const second = h.shown.length;
    assert.equal((await h.playAction('wink'))?.status, 'played');
    const delay = h.stage.faceExclusive.getState().eyelids.delayMs;
    h.run(1.0);
    const after = h.shown.slice(second - 1), lid2 = series(after, blink), one2 = series(after, wink);
    const opened = lid2.findIndex(value => value === 0), rises = one2.findIndex(value => value > 0);
    lines.push(`wink asked for mid-blink: waited ${delay.toFixed(0)} ms; the blink opened at frame ${opened}, the wink began at frame ${rises}`);
    assert.ok(delay > 0 && delay < 450, `${delay}`);
    assert.ok(rises >= opened && opened >= 0, `the wink starts after the blink has opened (${opened}, ${rises})`);
    assert.equal(after.filter((_, k) => lid2[k] > 0.05 && one2[k] > 0.05).length, 0);
    assert.equal(h.shown.at(-1)!.guardJumps, 0);
  } finally { h.close(); }
  t.diagnostic(lines.join('\n'));
});

test('a higher owner in the middle: feeding hands the mouth back, a pat hands the wink back (closure); smooth, the guard has nothing', async () => {
  const h = await geneStage({ herActions: true, fps: 60, recordAll: true });
  try {
    h.run(0.7);
    h.stage.nextBlink = h.stage.elapsed + 30;
    assert.equal((await h.playAction('cheek-puff'))?.status, 'played');
    h.run(0.6);
    const start = h.shown.length;
    h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0, feeding: true });
    h.run(0.4);
    assert.equal(h.stage.faceExclusive.active('mouth'), false, 'handed back to feeding');
    assert.equal(h.stage.faceExclusive.getState().ended.reason, 'feeding');
    h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0, feeding: false });
    h.run(0.5);
    assert.equal((await h.playAction('wink'))?.status, 'played');
    h.run(0.15);
    h.run(0.6, time => h.stage.setMoodContact(patContact(time)));
    assert.equal(h.stage.faceExclusive.active('eyelids'), false);
    assert.match(h.stage.faceExclusive.getState().ended.reason, /closure/u);
    const refused = await h.playAction('wink');
    assert.equal(refused?.status, 'busy'); assert.match(refused!.detail, /摸她|闭着眼/u);
    const frames = h.shown.slice(start - 1);
    assert.ok(maxMorphStep(frames, morphCount(h)).best < 0.2);
    assert.equal(h.shown.at(-1)!.guardJumps, 0, `${h.shown.at(-1)!.guardLast}`);
  } finally { h.close(); }
});

test('X-321: a face shape still loading when the conversation changes never starts in the new one (setMood alone, as after an explicit invalidation); a mood update in the same conversation keeps it', async t => {
  const lines: string[] = [];
  type Path = 'setMood token' | 'setMood character' | 'setMood away and back' | 'invalidate, then setMood' | 'same conversation';
  const paths: Path[] = ['setMood token', 'setMood character', 'setMood away and back', 'invalidate, then setMood', 'same conversation'];
  for (const where of ['resolver', 'vmd'] as const) for (const path of paths) {
    const h = await geneStage({ herActions: true, fps: 60, recordAll: true });
    // Hold the cue at one of its two awaits: the host's resource grant, or the stage's own VMD load (the bytes, then the parser).
    const desktop = (globalThis as { window: { desktop: { resolveHerAction(id: string): Promise<unknown> } } }).window.desktop, resolve = desktop.resolveHerAction;
    const loader = MMDLoader.prototype as unknown as { loadVMD(...args: unknown[]): void }, loadVMD = loader.loadVMD;
    let release!: () => void, reached = false;
    const gate = new Promise<void>(done => { release = done; });
    if (where === 'resolver') desktop.resolveHerAction = async id => { reached = true; await gate; return resolve(id); };
    else loader.loadVMD = function (this: unknown, ...args: unknown[]) { reached = true; void gate.then(() => loadVMD.apply(this, args)); };
    try {
      h.run(0.5);
      h.stage.nextBlink = h.stage.elapsed + 30;
      const pending = h.playAction('cheek-puff');
      for (let i = 0; i < 100 && !reached; i++) await new Promise(done => setTimeout(done, 0));
      assert.ok(reached, `${where}: the cue is waiting there`);
      const view = h.stage.moodView;
      if (path === 'invalidate, then setMood') h.stage.invalidateMoodScope();
      h.stage.setMood({ ...view, revision: view.revision + 1, ...(path === 'setMood character' ? { characterId: 'another' }
        : path === 'same conversation' ? {} : { token: 'gene_token_next' }) });
      // Another conversation in between, then the first one's token again: the cue's own conversation was left meanwhile.
      if (path === 'setMood away and back') h.stage.setMood({ ...view, revision: view.revision + 2 });
      const start = h.shown.length;
      release();
      const report = await pending;
      h.run(0.5);
      const puff = index(h, 'cheekPuff'), shown = Math.max(...h.shown.slice(start).map(frame => frame.all![puff]));
      lines.push(`${where} / ${path}: ${report?.status ?? 'no start (stale)'}, mouth lease ${h.stage.faceExclusive.active('mouth')}, cheekPuff up to ${shown.toFixed(3)}`);
      if (path === 'same conversation') {
        assert.equal(report?.status, 'played', `${where}: a mood update in the same conversation does not drop it`);
        assert.ok(h.stage.faceExclusive.active('mouth') && shown > 0.3, `${where}: it shows (${shown})`);
      } else {
        assert.equal(report, undefined, `${where} / ${path}: the old conversation's cue does not start (${JSON.stringify(report)})`);
        assert.equal(h.stage.faceExclusive.owned(), null, `${where} / ${path}: no lease in the new conversation`);
        assert.equal(shown, 0, `${where} / ${path}: nothing written`);
        // The new conversation's own cue is not held back by the old one.
        loader.loadVMD = loadVMD; desktop.resolveHerAction = resolve;
        assert.equal((await h.playAction('cheek-puff'))?.status, 'played', `${where} / ${path}: a new cue plays`);
      }
    } finally { loader.loadVMD = loadVMD; desktop.resolveHerAction = resolve; h.close(); }
  }
  t.diagnostic(lines.join('\n'));
});

test('the face shapes are refused, with the reason, while a picked expression owns the face or the card turned the part off', async () => {
  const h = await geneStage({ herActions: true, fps: 60 });
  try {
    h.run(0.5);
    h.stage.moodFaceBlocked = true;
    const picked = await h.playAction('pout');
    assert.equal(picked?.status, 'busy'); assert.match(picked!.detail, /手选/u);
    h.stage.moodFaceBlocked = false;
    h.stage.modelCapabilities = { closeEyes: { detected: true, choice: 'off' }, mouth: { detected: true, choice: 'on' } };
    const off = await h.playAction('wink');
    assert.equal(off?.status, 'failed'); assert.match(off!.detail, /能闭眼/u);
    assert.equal(h.stage.faceExclusive.active('eyelids'), false);
    assert.equal((await h.playAction('pout'))?.status, 'played', 'the mouth is still on');
  } finally { h.close(); }
});
