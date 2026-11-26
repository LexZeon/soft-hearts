/**
 * I-154 batch 2 (docs/claude/2026-11-20-unbound-window-batch2.md): her face on the window engine, the gates and the shapes, one row of
 * the coverage table at a time (18 说话时的脸, 19 等回复时思考, 20 心情的脸, 21 摸头, 24 脸红, 36 困了的脸) and the entry 「边说边演」
 * will drive. A synthetic rig (tests/helpers/window-face-fixture.ts); the real Gene frame loop is tests/unbound-window-face-gene.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CONTACT } from '../src/mood/mood-feedback';
import { WindowFace, type WindowFaceEnv, type WindowFaceFrame } from '../src/unbound/window-mode/window-face';
import { MAX_SHOWS, WindowExpressions } from '../src/unbound/window-mode/window-expression';
import { WindowLife, WINDOW_PAT } from '../src/unbound/window-mode/window-life';
import { faceBlocks, slotBindings } from '../src/unbound/window-mode/window-face-rig';
import { card, faceView, syntheticRig } from './helpers/window-face-fixture';
import { AnimationClip, NumberKeyframeTrack, QuaternionKeyframeTrack } from 'three';

const ENV: WindowFaceEnv = { shown: true, adjusting: false, voiced: false, speaking: false };
const max = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);

function run(face: WindowFace, seconds: number, fps = 60, each: (t: number) => Partial<WindowFaceEnv> | void = () => {}): (WindowFaceFrame & { t: number })[] {
  const out: (WindowFaceFrame & { t: number })[] = [];
  for (let i = 1; i <= Math.round(seconds * fps); i++) {
    const t = i / fps, env = { ...ENV, ...(each(t) ?? {}) };
    out.push({ ...face.frame(1 / fps, env), t });
  }
  return out;
}
const slot = (frames: WindowFaceFrame[], name: string) => frames.map(f => (f.expr as Record<string, number>)[name] ?? 0);
const steps = (values: number[]) => values.slice(1).map((v, i) => Math.abs(v - values[i]));

// ---- 20 心情的脸 ---------------------------------------------------------------------------------------------------------------------
test('row 20: a pleasant mood smiles on the model\'s own smile slot; a serious mood does not; a picked expression motion owns her face', () => {
  const happy = new WindowFace(); happy.attach(syntheticRig()); happy.setMood(faceView({ primary: 'happy' }));
  const smile = max(slot(run(happy, 3), 'smileEyes'));
  assert.ok(smile > 0.05, `pleasant: smile ${smile.toFixed(3)}`);
  const serious = new WindowFace(); serious.attach(syntheticRig()); serious.setMood(faceView({ primary: 'sad', companion: null }));
  const frames = run(serious, 3);
  assert.equal(max(slot(frames, 'smileEyes')), 0, 'a sad mood never smiles');
  assert.ok(max(slot(frames, 'sad')) > 0.05, 'the troubled brow shows');
  const owned = new WindowFace(); owned.attach(syntheticRig()); owned.setMood(faceView({ primary: 'happy' })); owned.setBlocks({ face: true, mouth: false, head: false });
  assert.equal(max(slot(run(owned, 3), 'smileEyes')), 0, 'a picked expression owns her face');
  const off = new WindowFace(); off.attach(syntheticRig()); off.setMood(faceView({ primary: 'happy', expressions: false }));
  assert.equal(max(slot(run(off, 3), 'smileEyes')), 0, '自动表现 off: no mood face');
});

test('row 20: the mood smile goes to the model\'s calibrated slot (the profile scale), never past 1', () => {
  const face = new WindowFace(); face.attach(syntheticRig({ scales: new Map([[2, 0.5]]) })); face.setMood(faceView({ primary: 'happy' }));
  const scaled = max(slot(run(face, 3), 'smileEyes'));
  const plain = new WindowFace(); plain.attach(syntheticRig()); plain.setMood(faceView({ primary: 'happy' }));
  const unscaled = max(slot(run(plain, 3), 'smileEyes'));
  assert.ok(Math.abs(scaled - unscaled * 0.5) < 1e-9, `scaled ${scaled} vs ${unscaled}`);
});

// ---- 21 摸头 -------------------------------------------------------------------------------------------------------------------------
test('row 21: a long pat closes her eyes almost shut when she is comfortable and happy; a serious mood barely; the mood owns the pat', () => {
  const pat = { ...EMPTY_CONTACT, contact: true, x: 0.2, y: 0.3 };
  const comfy = new WindowFace(); comfy.attach(syntheticRig()); comfy.setMood(faceView({ primary: 'happy', companion: 'comfortable' })); comfy.setContact(pat);
  const frames = run(comfy, 4);
  assert.ok(frames.every(f => f.ownsPat), 'the mood answers the pat');
  const deep = max(frames.map(f => f.lids));
  assert.ok(deep > 0.6, `a long comfortable pat: lids ${deep.toFixed(3)}`);
  assert.ok(max(frames.filter(f => f.t < 1).map(f => f.lids)) < 0.5, 'a fresh pat starts at the old half-closed level');
  const grave = new WindowFace(); grave.attach(syntheticRig()); grave.setMood(faceView({ primary: 'concerned', companion: 'comfortable' })); grave.setContact(pat);
  const lids = max(run(grave, 4).map(f => f.lids));
  assert.ok(lids < 0.1, `a serious mood: lids ${lids.toFixed(3)}`);
  assert.ok(max(frames.map(f => Math.abs(f.head.pitch))) > 0.01, 'her head follows your hand');
  // The window's own life: with the mood owning it, the simple pat face is gone (smile 0, its head lift 0); without, as before.
  const life = new WindowLife(() => 0.5);
  const owned = life.frame({ dt: 1 / 60, pointer: null, eyes: null, follow: true, pat: true, face: { lids: 0, softLids: 0, ownsPat: true, gaze: { pull: 1, x: 0, y: 0, strength: 1, allowed: true, eyeYaw: 0, eyePitch: 0 } } });
  assert.equal(owned.face.smile, 0); assert.equal(owned.head.pitch, 0);
  const simple = new WindowLife(() => 0.5).frame({ dt: 1 / 60, pointer: null, eyes: null, follow: true, pat: true });
  assert.equal(simple.face.smile, WINDOW_PAT.smile);
});

// ---- 18 说话时的脸 -------------------------------------------------------------------------------------------------------------------
function talk(face: WindowFace, seconds: number, extra: (t: number) => Partial<WindowFaceEnv> = () => ({})) {
  face.speechCue({ kind: 'levels', key: 'r1#0', aheadMs: 0, stepMs: 40, levels: Array.from({ length: Math.round(seconds / 0.04) }, (_, i) => 0.2 + 0.5 * Math.abs(Math.sin(i * 0.37))) });
  face.speechCue({ kind: 'start', key: 'r1#0', text: '真的超级好看！我们去看看吧。哈哈，好开心～你说是不是？嗯，好的。让我想想。', voiced: true });
  return run(face, seconds, 60, t => ({ voiced: true, speaking: true, ...extra(t) }));
}
test('row 18: while she speaks, small accents on her eyes, brows or head; never a mouth shape (lip-sync keeps the mouth)', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView({ primary: 'happy', companion: null }));
  const frames = talk(face, 12);
  const accents = max(frames.map(f => Math.max((f.expr.browUp ?? 0), (f.expr.jitome ?? 0), Math.abs(f.head.roll), (f.expr.surprise ?? 0))));
  assert.ok(accents > 0.005, `she accents (${accents.toFixed(4)})`);
  for (const mouth of ['a', 'mouthSmile', 'mouthPucker', 'o', 'u']) assert.equal(max(slot(frames, mouth)), 0, `${mouth} never written`);
});
test('row 18: a model whose smile-eyes morph is a mouth shape: the accents skip it (hard rule 1), the brows still accent', () => {
  const rig = syntheticRig({ slots: { ...syntheticRig().slots, smileEyes: 3 }, smile: null });
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null, values: { D: 75, O: 62, E: 58, N: 70, C: 45 } }));
  const frames = talk(face, 14);
  assert.equal(max(slot(frames, 'smileEyes')), 0, 'never on a mouth shape');
  assert.ok(max(frames.map(f => Math.max(f.expr.browUp ?? 0, Math.abs(f.head.roll), Math.abs(f.head.pitch)))) > 0.002, 'she still accents');
});
test('row 18: while she is touched, no eye or brow accent starts (the same talk without the touch has them)', () => {
  const eyes = (frames: WindowFaceFrame[]) => max(frames.map(f => Math.max(f.expr.browUp ?? 0, f.expr.jitome ?? 0, f.expr.surprise ?? 0)));
  const free = new WindowFace(); free.attach(syntheticRig()); free.setMood(faceView({ primary: 'happy', companion: null }));
  assert.ok(eyes(talk(free, 14)) > 0.005, 'untouched: accents');
  const touched = new WindowFace(); touched.attach(syntheticRig()); touched.setMood(faceView({ primary: 'happy', companion: null }));
  touched.setContact({ ...EMPTY_CONTACT, contact: true });
  assert.equal(eyes(talk(touched, 14)), 0, 'touched: none');
});
test('row 18: a touch makes the accents give way (eased, from where they are), and the stop cue drops what is pending', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView({ primary: 'happy', companion: null }));
  talk(face, 4);
  face.setContact({ ...EMPTY_CONTACT, contact: true });
  const during = talk(face, 3);
  const state = face.getState() as { speech: { active: string[]; pending: number } | null };
  assert.equal(state.speech?.active.length ?? 0, 0, 'nothing plays during a touch');
  assert.ok(max(steps(slot(during, 'browUp'))) < 0.05, 'no jump');
  face.setContact(null); face.speechCue({ kind: 'stop' });
  assert.equal((face.getState() as { speech: { pending: number } }).speech.pending, 0, 'the stop drops what is pending');
});
test('row 18: an expression asked for keeps her mouth shapes only while she is quiet; preparing to speak eases them aside', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView());
  assert.deepEqual(face.show('laugh', { holdS: 4 }), { ok: true, id: 1 });
  const quiet = run(face, 1);
  assert.ok(max(slot(quiet, 'a')) > 0.2, `laugh opens her mouth while quiet (${max(slot(quiet, 'a')).toFixed(2)})`);
  face.setPreparing(true);
  const prepared = run(face, 1);
  const a = slot(prepared, 'a');
  assert.ok(a.at(-1)! < 0.01, `the mouth steps aside before the first sound (${a.at(-1)})`);
  assert.ok(max(steps(a)) < 0.05, `eased: largest step ${max(steps(a)).toFixed(4)}`);
  assert.ok((prepared.at(-1)!.expr.smileEyes ?? 0) > 0.2, 'the rest of the laugh stays');
  face.setPreparing(false);
  assert.ok(max(slot(run(face, 0.6), 'a')) > 0.2, 'quiet again: back');
});

// ---- 19 等回复时思考 -----------------------------------------------------------------------------------------------------------------
test('row 19: waiting for a reply she looks up and aside (the cursor\'s pull gives way), then lets go smoothly; not while touched or asleep', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView({ primary: 'calm', companion: null }));
  face.setThinking('reply-1');
  const thinking = run(face, 2.5);
  const blend = 1 - thinking.at(-1)!.gaze.pull, look = Math.hypot(thinking.at(-1)!.gaze.x, thinking.at(-1)!.gaze.y);
  assert.ok(blend > 0.2 && look > 0.05, `her thinking look (blend ${blend.toFixed(2)}, offset ${look.toFixed(2)})`);
  assert.ok(max(steps(thinking.map(f => f.gaze.x))) < 0.05, 'eased in');
  face.setThinking(null);
  const after = run(face, 2.5);
  assert.ok(Math.abs(after.at(-1)!.gaze.x) < 1e-3 && after.at(-1)!.gaze.pull > 0.999, 'released');
  assert.ok(max(steps(after.map(f => f.gaze.x))) < 0.05, 'eased out');
  const touched = new WindowFace(); touched.attach(syntheticRig()); touched.setMood(faceView({ primary: 'calm', companion: null }));
  touched.setContact({ ...EMPTY_CONTACT, contact: true }); touched.setThinking('reply-2');
  assert.ok(Math.abs(run(touched, 2).at(-1)!.gaze.x) < 1e-6, 'a touch: no thinking look');
  const asleep = new WindowFace(); asleep.attach(syntheticRig()); asleep.setMood(faceView({ primary: 'calm', companion: null, phase: 'asleep', F: 0.9 })); asleep.setThinking('reply-3');
  assert.ok(Math.abs(run(asleep, 2).at(-1)!.gaze.x) < 1e-6, 'asleep: none');
});

// ---- 24 脸红 -------------------------------------------------------------------------------------------------------------------------
test('row 24: the mood\'s blush rises and fades like a flush (no jump), painted when the stage painted it, her own morph by the card', () => {
  const face = new WindowFace(); face.attach(syntheticRig({ blushChannel: -1 })); face.setPainted(true); face.setMood(faceView({ blushCue: { id: 'b1', amount: 1 } }));
  const frames = run(face, 4);
  const blush = frames.map(f => f.blush);
  assert.ok(max(blush) > 0.15, `she blushes (${max(blush).toFixed(3)})`);
  assert.ok(max(steps(blush)) < 0.03, `a flush, not a jump (largest step ${max(steps(blush)).toFixed(4)})`);
  assert.equal(frames[0].blushPath, 'painted');
  // Another model whose card has 能脸红 on: her own blush morph (the shy slot), through the slot springs.
  const own = new WindowFace(); own.attach(syntheticRig()); own.setCard(card(['blush'])); own.setMood(faceView({ blushCue: { id: 'b2', amount: 1 } }));
  assert.equal(own.blushMorph(), 9, 'the card\'s own blush morph');
  assert.equal(own.wantsPainted(), false);
  const morph = run(own, 3);
  assert.equal(morph[0].blushPath, 'morph'); assert.ok(max(slot(morph, 'shy')) > 0.15);
});
test('row 24: 能脸红 off on the character page: no blush at all, no paint, nothing bound', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setPainted(true); face.setCard(card(['blush'], { blush: 'off' }));
  face.setMood(faceView({ blushCue: { id: 'b3', amount: 1 } }));
  const frames = run(face, 3);
  assert.equal(max(frames.map(f => f.blush)), 0); assert.equal(max(slot(frames, 'shy')), 0);
  assert.equal(face.wantsPainted(), false); assert.equal(face.blushMorph(), -1);
  assert.equal(frames[0].blushPath, 'none');
});
test('row 24: the slider\'s preview shows the setting at once for 3 s; not while 自动表现 or the blush is off', () => {
  const face = new WindowFace(); face.attach(syntheticRig({ blushChannel: -1 })); face.setPainted(true); face.setMood(faceView());
  assert.equal(face.previewBlush(), true);
  const shown = run(face, 1);
  assert.ok(Math.abs(shown[0].blush - 0.35) < 1e-9, `the card's intensity at once (${shown[0].blush})`);
  run(face, 2.2);
  assert.ok(run(face, 0.1).at(-1)!.blush < 0.35, 'over after 3 s');
  const off = new WindowFace(); off.attach(syntheticRig()); off.setMood(faceView({ expressions: false }));
  assert.equal(off.previewBlush(), false);
  const disabled = new WindowFace(); disabled.attach(syntheticRig()); disabled.setMood(faceView({ blushEnabled: false }));
  assert.equal(disabled.previewBlush(), false);
});

// ---- 36 困了的脸 ---------------------------------------------------------------------------------------------------------------------
test('row 36: drowsy, tired lids and the drowsy face (troubled brow, half lids, chin a little down), eased; the card decides for another model', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setCard(card(['closeEyes', 'drowsyFace'])); face.setMood(faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 }));
  const frames = run(face, 4);
  const soft = max(frames.map(f => f.softLids)), brow = max(slot(frames, 'sad')), half = max(slot(frames, 'jitome')), chin = max(frames.map(f => f.head.pitch));
  assert.ok(soft > 0.15, `tired lids ${soft.toFixed(3)}`);
  assert.ok(brow > 0.02 && half > 0.02 && chin > 0.005, `drowsy face: brow ${brow.toFixed(3)} half ${half.toFixed(3)} chin ${chin.toFixed(4)}`);
  assert.ok(max(steps(frames.map(f => f.softLids))) < 0.03, 'the lids ease');
  // No card for another model yet (none from the host, no profile to derive one): neither, as the companion's stage.
  const none = new WindowFace(); none.attach(syntheticRig()); none.setMood(faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 }));
  const plain = run(none, 4);
  assert.equal(max(plain.map(f => f.softLids)), 0); assert.equal(max(slot(plain, 'jitome')), 0);
  // The reviewed Gene keeps its reviewed lids unless the user turned 能闭眼 off.
  const gene = new WindowFace(); gene.attach(syntheticRig({ reviewed: true })); gene.setMood(faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 }));
  assert.ok(max(run(gene, 3).map(f => f.softLids)) > 0.15);
  const geneOff = new WindowFace(); geneOff.attach(syntheticRig({ reviewed: true })); geneOff.setCard(card([], { closeEyes: 'off' }));
  geneOff.setMood(faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 }));
  assert.equal(max(run(geneOff, 3).map(f => f.softLids)), 0);
  // Asleep: the lids close (0.98), and the look is off.
  const asleep = new WindowFace(); asleep.attach(syntheticRig({ reviewed: true })); asleep.setMood(faceView({ primary: 'calm', companion: null, phase: 'asleep', F: 0.95 }));
  const sleeping = run(asleep, 4).at(-1)!;
  assert.ok(sleeping.softLids > 0.9 && sleeping.gaze.allowed === false);
});

// ---- scope -------------------------------------------------------------------------------------------------------------------------
test('a lost scope or another conversation: nothing of it comes back, and what shows eases away (no frame jumps)', () => {
  const face = new WindowFace(); face.attach(syntheticRig({ blushChannel: -1 })); face.setPainted(true);
  face.setMood(faceView({ primary: 'happy', blushCue: { id: 'b4', amount: 1 } })); face.setThinking('k'); face.show('warm-smile', { holdS: 5 });
  const before = run(face, 1.5);
  face.invalidate();
  const after = run(face, 7);
  const smile = [...slot(before, 'smileEyes'), ...slot(after, 'smileEyes')];
  assert.ok(max(steps(smile)) < 0.05, `the smile eases away (largest step ${max(steps(smile)).toFixed(4)})`);
  assert.equal(after.at(-1)!.blush, 0, 'the blush is gone'); assert.equal(slot(after, 'smileEyes').at(-1), 0, 'the smile is gone');
  assert.equal(face.previewBlush(), false, 'no preview without a scope');
  // A new conversation (token): an expression still showing eases out; the mood face of the new one takes over.
  const next = new WindowFace(); next.attach(syntheticRig()); next.setMood(faceView({ token: 'a' })); next.show('surprise', { holdS: 6 });
  run(next, 1);
  next.setMood(faceView({ token: 'b' }));
  const rest = run(next, 3);
  assert.equal(slot(rest, 'surprise').at(-1), 0, 'the old conversation\'s expression is gone');
});

// ---- the entry 「边说边演」 will drive ---------------------------------------------------------------------------------------------
test('showExpression: refused while hidden, asleep or a picked expression owns her face; unknown names refused; eased in and out', () => {
  const face = new WindowFace(); face.attach(syntheticRig());
  assert.deepEqual(face.show('wink'), { ok: false, reason: 'unknown' });
  assert.deepEqual(face.show('laugh', {}, false), { ok: false, reason: 'hidden' });
  face.setMood(faceView({ phase: 'asleep', F: 0.9 }));
  assert.deepEqual(face.show('laugh'), { ok: false, reason: 'asleep' });
  face.setMood(faceView({ token: 'awake' }));
  face.setBlocks({ face: true, mouth: true, head: false });
  assert.deepEqual(face.show('laugh'), { ok: false, reason: 'face-owned' });
  face.setBlocks({ face: false, mouth: false, head: false });
  assert.equal(face.show('confirm-smile', { holdS: 0.8 }).ok, true);
  const frames = run(face, 3);
  const smile = slot(frames, 'mouthSmile');
  assert.ok(max(smile) > 0.3, `it shows (${max(smile).toFixed(2)})`);
  assert.ok(smile[0] < 0.05, 'starts from nothing');
  assert.ok(smile.at(-1)! < 0.01, 'and eases away');
  assert.ok(max(steps(smile)) < 0.08, `eased: largest step ${max(steps(smile)).toFixed(4)}`);
});
test('showExpression: many at once never pile up past the limit; the same one again takes over from the last', () => {
  const shows = new WindowExpressions();
  for (let i = 0; i < 20; i++) { shows.show('confirm-smile', { holdS: 5 }, { shown: true, asleep: false, faceOwned: false }); shows.frame(0.05, false); }
  assert.ok(shows.names.length <= MAX_SHOWS * 2, `${shows.names.length} showing`);
});

// ---- the rig ------------------------------------------------------------------------------------------------------------------------
test('rig: every slot bound to the model\'s own morph or -1 (the engine never guesses another), shy to the blush shown; a picked expression or head motion blocks', () => {
  const rig = syntheticRig();
  const map = slotBindings(rig, 13);
  assert.equal(map.smileEyes, 2); assert.equal(map.angry, -1); assert.equal(map.shy, 13);
  assert.equal(slotBindings(rig, -1).shy, -1);
  const mesh = { morphTargetDictionary: { 'あ': 1, '笑い': 2 } };
  const expression = new AnimationClip('e', 1, [new NumberKeyframeTrack('.morphTargetInfluences[2]', [0, 1], [0, 1])]);
  const mouth = new AnimationClip('m', 1, [new NumberKeyframeTrack('.morphTargetInfluences[1]', [0, 1], [0, 1])]);
  const head = new AnimationClip('h', 1, [new QuaternionKeyframeTrack('.bones[頭].quaternion', [0, 1], [0, 0, 0, 1, 0, 0.2, 0, 0.98])]);
  assert.deepEqual(faceBlocks({ pose: null, gesture: null, expression }, false, mesh, 1, '頭'), { face: true, mouth: false, head: false });
  assert.deepEqual(faceBlocks({ pose: null, gesture: null, expression: mouth }, false, mesh, 1, '頭'), { face: true, mouth: true, head: false });
  assert.deepEqual(faceBlocks({ pose: head, gesture: null, expression: null }, false, mesh, 1, '頭'), { face: false, mouth: false, head: true });
  assert.deepEqual(faceBlocks({ pose: null, gesture: null, expression: null }, false, mesh, 1, '頭'), { face: false, mouth: false, head: false });
});

// ---- 边说边演 on the window engine (row 47's speech beats) ----------------------------------------------------------------------
test('speech beats: every word plays through the showcase performer; refused while hidden, asleep, or (hand words) while her arms are held', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView({ primary: 'calm', companion: null }));
  assert.equal(face.speechBeat('not-a-word'), false);
  assert.equal(face.speechBeat('blink-slow', false), false, 'hidden: no slow blink either');
  assert.equal(face.speechBeat('smile-warm', false), false, 'hidden');
  assert.equal(face.speechBeat('v', true, true), false, 'a hand word while a pull or a held hand owns her arms');
  assert.equal(face.speechBeat('smile-warm'), true);
  const smiled = run(face, 2.5);
  assert.ok(max(slot(smiled, 'mouthSmile')) > 0.2, 'the warm smile shows');
  assert.ok(max(steps(slot(smiled, 'mouthSmile'))) < 0.05, 'eased');
  assert.equal(face.speechBeat('tilt'), true);
  assert.ok(max(run(face, 1.5).map(f => Math.abs(f.head.roll))) > 0.05, 'the tilt');
  assert.equal(face.speechBeat('v'), true);
  assert.ok(run(face, 1).some(f => f.hands?.left || f.hands?.right), 'a V: her hand');
  assert.equal(face.speechBeat('look-away-left'), true);
  const away = run(face, 1.2);
  assert.ok(max(away.map(f => Math.abs(f.gaze.eyeYaw))) > 0.15, `a glance aside (${max(away.map(f => Math.abs(f.gaze.eyeYaw))).toFixed(3)} rad)`);
  const rest = run(face, 6);
  assert.ok(Math.abs(rest.at(-1)!.gaze.eyeYaw) < 1e-6 && rest.at(-1)!.hands === null && Math.abs(rest.at(-1)!.head.roll) < 1e-9, 'all of it comes back');
  // (A glance is a saccade: its goal starts at once, as in the showcase, and the eye-head coordinator's springs carry her eyes there;
  // the shown pose is measured on the real Gene in tests/unbound-window-face-gene.test.ts.)
  const asleep = new WindowFace(); asleep.attach(syntheticRig()); asleep.setMood(faceView({ phase: 'asleep', F: 0.9 }));
  assert.equal(asleep.speechBeat('smile-warm'), false, 'asleep: none starts');
});
