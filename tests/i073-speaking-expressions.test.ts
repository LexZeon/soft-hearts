/**
 * I-073 part 3 "她说话时脸也在演" (docs/claude/2026-11-11-i073-speaking-expressions.md): the speaking-accent layer
 * (src/voice/speech-face/) on synthetic text and synthetic voice levels. No model, no TTS call.
 *
 * Codex T-236's five scenes, as behaviour:
 *  1. a calm long narration with many loud points: the spacing and count limits hold, per clause at most one eye/brow and one
 *     head accent, the caps hold (the mouth byte for byte: tests/i073-speaking-expressions-gene.test.ts on Gene);
 *  2. clear emphasis / a rhetorical question / runs of question marks: only clear intent moves her, punctuation never chains;
 *  3. a short dip, a real pause, a network underrun: a closing nod only in the real pause; nothing that fell in the underrun
 *     is played after it resumes;
 *  4. a drag during a nod, an interrupted reply: what shows eases back with continuous value and speed, nothing of the old
 *     turn starts afterwards (the blink during smile eyes: on Gene);
 *  5. a model without raised brows or blush, and a "smile" morph that is a mouth shape: skipped, the rest still works.
 * Plus: her pick reads the hormones relative to her baseline; text-only mode; the perform() entry point; mutation hooks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clauseIntent, splitClauses } from '../src/voice/speech-face/intent';
import { SpeechFace, type AccentGates, type AccentRecord } from '../src/voice/speech-face/layer';
import { SPEECH_FACE_KNOBS } from '../src/voice/speech-face/knobs';
import { arousalEffect, choose, hormoneTemper, NEUTRAL_DISPOSITIONS, temperGains } from '../src/voice/speech-face/choose';
import { LevelTrack, rmsLevels } from '../src/voice/speech-face/timing';
import { RECIPES, envelope } from '../src/voice/speech-face/recipes';
import { sanitizeSpeechFaceCue } from '../src/voice/speech-face/cues';
import { accentAvailability } from '../src/stage/procedural-life';

const HARD = SPEECH_FACE_KNOBS.hard;
const DEG = Math.PI / 180;
const ALL: AccentGates['available'] = { smileEyes: true, browUp: true, jitome: true, blush: true, head: true };
const free = (speaking = true, available = ALL): AccentGates => ({ face: true, head: true, speaking, available });
/** A lively card well above her baseline in N and D: she accents as often as she ever would (the limits must still hold). */
const eager = (face: SpeechFace) => face.setContext({ values: { D: 80, N: 85, O: 70, E: 50, C: 50 }, baseline: { D: 50, N: 50, O: 50, E: 50, C: 50 },
  dispositions: { lively: 100, restrained: 0, volatile: 100, shy: 100, clingy: 100 } });

/** Syllable-like voice levels: `rate` syllables per second with peaks, quiet `pauses` ([from, to] s), from t = 0 for `seconds`. */
function voice(seconds: number, options: { rate?: number; pauses?: readonly [number, number][]; step?: number; seed?: number } = {}): number[] {
  const step = options.step ?? 0.04, rate = options.rate ?? 4.6, out: number[] = [];
  let s = options.seed ?? 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let t = 0; t < seconds - 1e-9; t += step) {
    const quiet = options.pauses?.some(([a, b]) => t >= a && t < b);
    const syllable = Math.abs(Math.sin(Math.PI * rate * t));
    out.push(quiet ? 0.01 : Math.round((0.15 + 0.55 * syllable * (0.6 + 0.4 * rnd())) * 1e4) / 1e4);
  }
  return out;
}
/** Runs `face` for `seconds` at `fps`, calling `each(t)` before every frame; returns the per-frame outputs. */
function run(face: SpeechFace, seconds: number, fps = 60, each?: (t: number, frame: number) => AccentGates | void) {
  const frames: { t: number; out: Record<string, number> }[] = [];
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    const gates = each?.(face.clock, i) ?? free();
    const out = face.frame(1 / fps, gates);
    frames.push({ t: face.clock, out: { ...out } });
  }
  return frames;
}
const started = (ledger: readonly AccentRecord[], family?: string) => ledger.filter(r => r.outcome === 'started' && (!family || r.family === family));

/** Spacing and rolling-count rules over the started accents (hard rule 2). */
function assertLimits(ledger: readonly AccentRecord[]) {
  const check = (family: 'face' | 'head' | 'blush', gap: number, count: number) => {
    const times = started(ledger, family).map(r => r.at);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= gap - 1e-6, `${family}: starts ${times[i - 1].toFixed(3)} and ${times[i].toFixed(3)} closer than ${gap} s`);
    for (const t of times) assert.ok(times.filter(x => x > t - 10 && x <= t).length <= count, `${family}: more than ${count} in the 10 s before ${t.toFixed(2)}`);
  };
  check('face', HARD.faceGap, HARD.faceWindowCount);
  check('head', HARD.headGap, HARD.headWindowCount);
  check('blush', HARD.blushGap, Infinity);
}
function assertCaps(frames: readonly { out: Record<string, number> }[]) {
  const c = HARD.caps;
  for (const { out } of frames) {
    assert.ok(out.smileEyes <= c.smileEyes + 1e-12 && out.browUp <= c.browUp + 1e-12 && out.jitome <= c.jitome + 1e-12 && out.blush <= c.blush + 1e-12, JSON.stringify(out));
    assert.ok(Math.abs(out.headX) <= c.nodDeg * DEG + 1e-12 && Math.abs(out.headZ) <= c.tiltDeg * DEG + 1e-12, JSON.stringify(out));
  }
}
/** Largest frame-to-frame change of the per-frame step of one channel (the "unexpected step"). */
const kink = (frames: readonly { out: Record<string, number> }[], key: string) => {
  let worst = 0;
  for (let i = 2; i < frames.length; i++) worst = Math.max(worst, Math.abs(frames[i].out[key] - 2 * frames[i - 1].out[key] + frames[i - 2].out[key]));
  return worst;
};
/** Speaks `segments` one after the other from now: levels ahead, then the start cue at each segment's start. */
function narrate(face: SpeechFace, reply: string, segments: readonly string[], seconds: (text: string) => number, pauses: (text: string, length: number) => [number, number][] = () => []) {
  const plan: { at: number; index: number; text: string; length: number }[] = [];
  let at = face.clock + 0.05;
  segments.forEach((text, index) => { const length = seconds(text); plan.push({ at, index, text, length }); at += length; });
  return { plan, end: at, tick(t: number) {
    for (const item of plan) if (t >= item.at - 1e-9 && !(item as { sent?: boolean }).sent) {
      (item as { sent?: boolean }).sent = true;
      face.cue({ kind: 'levels', key: `${reply}#${item.index}`, aheadMs: 0, stepMs: 40, levels: voice(item.length, { pauses: pauses(item.text, item.length), seed: item.index + 3 }) });
      face.cue({ kind: 'start', key: `${reply}#${item.index}`, text: item.text, voiced: true });
    }
  } };
}

test('intent tables: only clear meaning counts; a run of marks is no stronger than one', () => {
  assert.equal(clauseIntent('你吃饭了吗？').intent, 'question');
  assert.ok(clauseIntent('你吃饭了吗？').weight >= SPEECH_FACE_KNOBS.choice.minWeight);
  assert.ok(clauseIntent('这样？').weight < SPEECH_FACE_KNOBS.choice.minWeight, 'a bare question mark is not clear');
  assert.equal(clauseIntent('这样？？？？').weight, clauseIntent('这样？').weight, 'punctuation never chains');
  assert.equal(clauseIntent('真的！！！').weight, clauseIntent('真的！').weight);
  assert.equal(clauseIntent('真的！').intent, 'emphasis');
  assert.equal(clauseIntent('哈哈，').intent, 'happy');
  assert.equal(clauseIntent('嗯，').intent, 'affirm');
  assert.equal(clauseIntent('好的。').intent, 'affirm');
  assert.equal(clauseIntent('让我想想……').intent, 'thinking');
  assert.equal(clauseIntent('人家才不是害羞呢').intent, 'shy');
  assert.equal(clauseIntent('今天天气不错。').intent, 'calm');
  assert.equal(clauseIntent('Why not?').intent, 'question');
  assert.equal(clauseIntent('Haha, that was fun!').intent, 'happy');
  assert.equal(clauseIntent('Yes, of course.').intent, 'affirm');
  const parts = splitClauses('嗯，好的。我知道了！价格是3,000元。Really?');
  assert.deepEqual(parts.map(c => c.text), ['嗯，', '好的。', '我知道了！', '价格是3,000元。', 'Really?']);
  assert.equal(parts.at(-1)!.lang, 'en');
});

// Mumi writes her hesitations with full stops ("嗯。。。") and stutters ("我、我、我");
// neither moved her face while she spoke.
test('intent tables: a hesitation written with full stops and a stutter are clear enough to move her', () => {
  const clear = (text: string) => clauseIntent(text).weight >= SPEECH_FACE_KNOBS.choice.minWeight;
  for (const text of ['嗯。。。', '啊。。。', '嗯……']) { assert.equal(clauseIntent(text).intent, 'thinking', text); assert.ok(clear(text), text); }
  assert.equal(clauseIntent('你说。。。').intent, 'thinking', 'a trailing run of full stops trails off like an ellipsis');
  assert.equal(clauseIntent('嗯。').intent, 'affirm', 'one full stop is still a plain "yes"');
  assert.equal(clauseIntent('啊！').intent, 'emphasis', 'an exclamation is not a hesitation');
  for (const text of ['我、我、我没有。。。', '还、还行。', '给、给、给我的？！']) { assert.equal(clauseIntent(text).intent, 'shy', text); assert.ok(clear(text), text); }
  assert.equal(clauseIntent('苹果、香蕉和梨。').intent, 'calm', 'a list is not a stutter');
  assert.equal(clauseIntent("I-I didn't mean it.").intent, 'shy');
  for (const text of ['Mm... okay.', 'Ah... sorry.']) { assert.equal(clauseIntent(text).intent, 'thinking', text); assert.ok(clear(text), text); }
  assert.equal(clauseIntent('Ah, there you are.').intent, 'calm', 'an "ah" without an ellipsis is not a hesitation');
  assert.equal(clauseIntent('A well-known fact.').intent, 'calm');
  assert.deepEqual(splitClauses('嗯。。。还、还行。').map(c => c.intent), ['thinking', 'shy']);
});

test('scene 1: a long narration with many loud points: spacing, counts, one per clause and the caps hold', () => {
  for (const fps of [60, 30]) {
    const face = new SpeechFace(undefined, 7); eager(face);
    // Every clause is a clear one, so she would accent each if no rule held her back.
    const segments = Array.from({ length: 16 }, (_, i) => ['真的超级好看！', '哈哈，好开心～', '你说是不是？', '嗯，好的。', '让我想想……', '人家才不是害羞呢！'][i % 6] + '我们再说一点点吧，好不好？');
    const n = narrate(face, 'r1', segments, text => text.length / 4.6);
    const frames = run(face, n.end + 2, fps, t => { n.tick(t); });
    assertLimits(face.ledger); assertCaps(frames);
    const s = started(face.ledger);
    assert.ok(started(face.ledger, 'face').length >= 8 && started(face.ledger, 'head').length >= 4, `she still accents (${started(face.ledger, 'face').length} eye/brow, ${started(face.ledger, 'head').length} head)`);
    assert.ok(face.ledger.some(r => r.outcome === 'dropped' && r.reason === 'spacing'), 'the spacing rule actually held something back');
    // Per segment at most one blush; per clause at most one per family (the planner places one per family per clause).
    const blushes = started(face.ledger, 'blush');
    assert.ok(blushes.length >= 1 && blushes.length <= segments.length);
    // Every accent tied to the voice sits on a loud point or a real pause, never "onset" when levels exist.
    assert.ok(s.every(r => r.timing === 'peak' || r.timing === 'boundary'), JSON.stringify(s.map(r => r.timing)));
    // Smooth: the change of speed per frame stays within the face-twitch round 3 limit for the eyes (0.004 per 60 fps frame), read
    // as an acceleration like the R29 bound (×4 at 30 fps: the same curve sampled half as often; round 3's own idle table used ×2).
    assert.ok(kink(frames, 'smileEyes') <= 0.004 * (60 / fps) ** 2 + 1e-9, `smile eyes kink ${kink(frames, 'smileEyes')}`);
    if (process.env.FACE_TWITCH_REPORT === '1') console.log(`scene 1, ${fps} fps: ${started(face.ledger, 'face').length} eye/brow, ${started(face.ledger, 'head').length} head, ${started(face.ledger, 'blush').length} blush over ${n.end.toFixed(1)} s; held back by spacing ${face.ledger.filter(r => r.reason === 'spacing').length}; kinks smile ${kink(frames, 'smileEyes').toFixed(5)} brow ${kink(frames, 'browUp').toFixed(5)} nod ${(kink(frames, 'headX') / DEG).toFixed(4)}° tilt ${(kink(frames, 'headZ') / DEG).toFixed(4)}°`);
    assert.ok(kink(frames, 'headX') <= 0.15 * DEG * (60 / fps) ** 2 + 1e-9, `nod kink ${(kink(frames, 'headX') / DEG).toFixed(4)}°`);
  }
});

test('scene 2: emphasis, a rhetorical question and runs of question marks: only clear intent moves her, marks never chain', () => {
  const face = new SpeechFace(undefined, 11); eager(face);
  const segments = ['啊？？？啊？？？啊？？？', '嗯？？？？？？', '难道你不知道吗？', '真的！！！！！'];
  const n = narrate(face, 'r2', segments, text => Math.max(1.6, text.length / 4.6));
  run(face, n.end + 1, 60, t => { n.tick(t); });
  const s = started(face.ledger);
  // The bare marks never trigger; the rhetorical question and the emphasis can.
  const bySegment = (index: number) => { const p = n.plan[index]; return s.filter(r => r.at >= p.at - 0.3 && r.at < p.at + p.length); };
  assert.equal(bySegment(0).length + bySegment(1).length, 0, 'bare question marks never move her');
  assert.ok(face.ledger.filter(r => r.reason === 'unclear').length >= 3, 'they were seen and judged unclear');
  assert.ok(bySegment(2).length + bySegment(3).length >= 1, 'the clear ones do');
  assertLimits(face.ledger);
});

test('scene 3: a word gap, a real pause, a network underrun: the closing nod only in the real pause; nothing replays after the underrun', () => {
  const face = new SpeechFace(undefined, 3); eager(face);
  const pauseFrom = 1.5, pauseTo = 1.9;
  // Segment 0 "好的，我知道了。": voice 0..1.5 s with 80 ms gaps between words, a real 0.4 s pause, then the next segment's PCM
  // arrives late: no samples from 2.6 s to 3.6 s (underrun; the speaking flag drops after its 0.4 s hold).
  const levels = voice(1.9, { pauses: [[0.48, 0.56], [0.96, 1.04], [pauseFrom, pauseTo]] });
  let underrun = false;
  const frames = run(face, 6, 60, (t, i) => {
    if (i === 0) {
      face.cue({ kind: 'levels', key: 'r3#0', aheadMs: 0, stepMs: 40, levels });
      face.cue({ kind: 'start', key: 'r3#0', text: '好的，我知道了。', voiced: true });
    }
    if (Math.abs(t - 1.9) < 0.009) {
      face.cue({ kind: 'levels', key: 'r3#1', aheadMs: 0, stepMs: 40, levels: voice(0.7, { seed: 9 }) });
      face.cue({ kind: 'start', key: 'r3#1', text: '你说对不对？真的！', voiced: true });
    }
    underrun = t >= 2.6 && t < 3.6;
    // The held flag: speaking except during the underrun (beyond its 0.4 s hold).
    return free(!(t >= 3.0 && t < 3.6));
  });
  void frames; void underrun;
  const nods = started(face.ledger).filter(r => r.timing === 'boundary');
  for (const nod of nods) assert.ok(nod.peakAt! >= pauseFrom - 1e-6 && nod.peakAt! <= pauseTo + 1e-6, `a closing nod peaks in the real pause (${nod.peakAt})`);
  assert.ok(!started(face.ledger).some(r => r.timing === 'boundary' && (r.peakAt! < 0.5 || (r.peakAt! > 0.5 && r.peakAt! < 0.6) || (r.peakAt! > 0.95 && r.peakAt! < 1.05))), 'word gaps are not pauses');
  // Nothing started while the voice was gone, and nothing planned for that time started later.
  const inGap = started(face.ledger).filter(r => r.at >= 3.0 && r.at < 3.6);
  assert.equal(inGap.length, 0);
  const late = face.ledger.filter(r => r.outcome === 'started' && r.at >= 3.6 && r.startAt! < 3.5);
  assert.equal(late.length, 0, 'no replay after the underrun');
});

test('scene 3b: the closing nod finds a real pause, and an underrun alone is not one', () => {
  const track = new LevelTrack();
  // Speech, a 0.08 s dip, speech, a 1 s gap with no samples at all (underrun), speech, a real 0.3 s quiet.
  track.add('k', 0, 0.04, [...Array(10).fill(0.5), 0.01, 0.01, ...Array(10).fill(0.5)]);
  track.add('k', 1.88, 0.04, [...Array(10).fill(0.5), ...Array(8).fill(0.01), 0.5]);
  assert.equal(track.pause('k', 0, 1.8, 0.075, 0.18), null, 'a dip and an underrun are not pauses');
  const p = track.pause('k', 0, 3, 0.075, 0.18)!;
  assert.ok(Math.abs(p - 2.28) < 1e-9, `the real pause starts at 2.28 (${p})`);
  assert.deepEqual(rmsLevels([1, -1, 1, -1, 0, 0, 0, 0], 4), [1, 0]);
});

test('scene 4: a drag during a nod, an interrupted reply: it eases back smoothly; nothing of the old turn starts again', () => {
  for (const fps of [60, 30]) {
    const face = new SpeechFace(undefined, 5); eager(face);
    // A nod right now (the entry point), then a drag 0.25 s into it.
    face.perform('affirm', 1, { at: 'now' }, { always: true, families: ['head'] });
    let dragFrom = -1;
    const frames = run(face, 1.5, fps, t => {
      if (t >= 0.25 && dragFrom < 0) dragFrom = t;
      return { ...free(), head: !(t >= 0.25) };
    });
    const at = frames.findIndex(f => f.t >= dragFrom);
    assert.ok(Math.abs(frames[at - 1].out.headX) > 0.5 * DEG, 'the nod was showing');
    // Value continuous and speed continuous: no frame's step differs from the previous one by more than the R29 bound.
    assert.ok(kink(frames, 'headX') <= 0.15 * DEG * (60 / fps) ** 2 + 1e-9, `kink ${(kink(frames, 'headX') / DEG).toFixed(4)}° at ${fps} fps`);
    assert.ok(frames.at(-1)!.out.headX === 0, 'back to rest');
    assert.ok(face.ledger.some(r => r.outcome === 'released'), 'released');
  }
  // An interrupted reply: the stop drops everything pending; nothing of that turn starts afterwards.
  const face = new SpeechFace(undefined, 9); eager(face);
  const n = narrate(face, 'old', ['真的超级好看！你说是不是？', '哈哈，好开心～嗯，好的。', '让我想想……真的！'], text => text.length / 4.6);
  let stopAt = Infinity;
  run(face, 6, 60, t => { n.tick(t); if (t >= 2.4 && stopAt === Infinity) { stopAt = t; face.cue({ kind: 'stop' }); n.plan.forEach(p => { (p as { sent?: boolean }).sent = true; }); } });
  assert.ok(face.ledger.some(r => r.turn === 'old' && r.outcome === 'dropped' && r.reason === 'stop') || started(face.ledger).some(r => r.turn === 'old'), 'the old turn was live');
  assert.equal(face.ledger.filter(r => r.turn === 'old' && r.outcome === 'started' && r.at > stopAt).length, 0, 'zero events from the old turn after the stop');
  // Deterministic: stop exactly while an accent of the turn is planned but not started yet, and while one shows.
  for (const when of ['pending', 'active'] as const) {
    const f2 = new SpeechFace(undefined, 9); eager(f2);
    const m2 = narrate(f2, 'cut', Array.from({ length: 4 }, () => '真的超级好看！你说是不是？哈哈，好开心～'), text => text.length / 4.6);
    let cutAt = Infinity;
    run(f2, 10, 60, t => {
      m2.tick(t);
      const state = f2.getState();
      if (cutAt === Infinity && (when === 'pending' ? state.pending > 0 : state.active.length > 0)) {
        cutAt = t; f2.cue({ kind: 'stop' }); m2.plan.forEach(p => { (p as { sent?: boolean }).sent = true; });
      }
    });
    assert.ok(cutAt < Infinity, `there was something ${when} to cut`);
    assert.ok(f2.ledger.some(r => r.turn === 'cut' && r.reason === 'stop' && (when === 'pending' ? r.outcome === 'dropped' : r.outcome === 'released')), `the ${when} accent was cancelled`);
    assert.equal(f2.ledger.filter(r => r.turn === 'cut' && r.outcome === 'started' && r.at > cutAt).length, 0, `nothing of the cut turn starts after the stop (${when})`);
  }
  // A new reply's first cue also cancels the old one.
  const other = new SpeechFace(undefined, 9); eager(other);
  const m = narrate(other, 'a', ['真的超级好看！你说是不是？哈哈，好开心～'], text => text.length / 4.6);
  run(other, 1.2, 60, t => { m.tick(t); });
  other.cue({ kind: 'start', key: 'b#0', text: '嗯，好的。', voiced: true });
  const switched = other.clock;
  run(other, 4, 60);
  assert.equal(other.ledger.filter(r => r.turn === 'a' && r.outcome === 'started' && r.at > switched).length, 0);
});

test('scene 5: a model without raised brows or blush, and a smile morph that is a mouth shape: skipped, the rest works', () => {
  const noBrowNoBlush = { ...ALL, browUp: false, blush: false };
  const face = new SpeechFace(undefined, 13); eager(face);
  const n = narrate(face, 'r5', Array.from({ length: 8 }, (_, i) => ['真的超级好看！', '人家才不是害羞呢！', '你说是不是？', '哈哈，好开心～'][i % 4]), text => Math.max(1.8, text.length / 4.6));
  const frames = run(face, n.end + 1, 60, t => { n.tick(t); return free(true, noBrowNoBlush); });
  assert.ok(frames.every(f => f.out.browUp === 0 && f.out.blush === 0), 'nothing written to sliders the model lacks');
  assert.ok(started(face.ledger).length > 0, 'the rest still accents (head, smile eyes)');
  assert.ok(face.ledger.some(r => r.reason === 'unavailable'), 'the missing ones were skipped before she picked');
  // Hard rule 1: a face slot whose morph is a mouth shape (a composite "smile" with the mouth, or the lip-sync morph) is unavailable.
  const slots = { smileEyes: 7, mouthSmile: 7, sad: -1, angry: -1, jitome: 4, mouthOpen: -1, browUp: 12 };
  assert.deepEqual(accentAvailability(slots, [3, 12], true, true, true), { smileEyes: false, browUp: false, jitome: true, blush: true, head: true });
  assert.deepEqual(accentAvailability({ ...slots, smileEyes: 8, browUp: 9 }, [3], false, true, false), { smileEyes: true, browUp: true, jitome: false, blush: false, head: true });
  // And the layer has no mouth channel at all (I-077 added the music reactions' wide eyes and soft lids; still no mouth).
  assert.deepEqual(Object.keys(face.out).sort(), ['blush', 'browUp', 'eyeWide', 'headX', 'headZ', 'jitome', 'lidSoft', 'smileEyes']);
  for (const variants of Object.values(RECIPES)) for (const v of variants) assert.ok(!/mouth|jaw/i.test(String(v.slider)), v.id);
});

test('her pick reads the six hormones relative to her own baseline (N read with D, C and E; A through fatigue)', () => {
  const base = { D: 60, O: 55, E: 50, N: 60, C: 40 };
  // Her baseline itself is neutral, whatever its absolute numbers.
  assert.deepEqual(hormoneTemper(base, base, null), { D: 0, O: 0, E: 0, N: 0, C: 0, sleepy: 0 });
  const neutral = temperGains(hormoneTemper(base, base, null), NEUTRAL_DISPOSITIONS);
  assert.deepEqual(neutral, { often: 1, size: 1 });
  // N up with D up: livelier, more and bigger; N up with C up (E not): tense: fewer warm/playful flourishes, tenser brows.
  const withD = arousalEffect(hormoneTemper({ ...base, N: 85, D: 85 }, base, null));
  const withC = arousalEffect(hormoneTemper({ ...base, N: 85, C: 75 }, base, null));
  const alone = arousalEffect(hormoneTemper({ ...base, N: 85 }, base, null));
  assert.ok(withD.often > alone.often && alone.often > withC.often, JSON.stringify({ withD, alone, withC }));
  assert.ok(withD.size > 0 && withC.warm < -0.3 && withC.playful < -0.3 && withC.tense > 0 && withD.warm === 0);
  // Sleepy (fatigue F in a drowsy phase) → fewer and smaller; asleep → none.
  const sleepy = temperGains(hormoneTemper(base, base, { phase: 'drowsy', F: 0.8 }), NEUTRAL_DISPOSITIONS);
  assert.ok(sleepy.often < 0.6 && sleepy.size < 0.8, JSON.stringify(sleepy));
  assert.equal(choose('happy', 1, 'face', hormoneTemper(base, base, { phase: 'asleep' }), NEUTRAL_DISPOSITIONS, () => 0, () => true, null), 'asleep');
  // A restrained, quiet card skips more than a lively one (same mood, same rolls).
  const rate = (dispositions: typeof NEUTRAL_DISPOSITIONS, temper = hormoneTemper(base, base, null)) => {
    let s = 1, hits = 0; const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 2000; i++) if (typeof choose('emphasis', 0.8, 'face', temper, dispositions, rnd, () => true, null) !== 'string') hits++;
    return hits / 2000;
  };
  assert.ok(rate({ ...NEUTRAL_DISPOSITIONS, restrained: 90 }) < rate(NEUTRAL_DISPOSITIONS) && rate(NEUTRAL_DISPOSITIONS) < rate({ ...NEUTRAL_DISPOSITIONS, lively: 90 }));
  // Tense (N with C): the happy smile-eye flourish gives way; with D it is more likely.
  const happyRate = (values: Record<string, number>) => {
    let s = 7, hits = 0; const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 2000; i++) if (typeof choose('happy', 0.8, 'face', hormoneTemper(values, base, null), NEUTRAL_DISPOSITIONS, rnd, () => true, null) !== 'string') hits++;
    return hits / 2000;
  };
  assert.ok(happyRate({ ...base, N: 85, C: 80 }) < 0.6 * happyRate(base) && happyRate({ ...base, N: 85, D: 85 }) > happyRate(base));
  // Never the same variant twice in a row in a family when another exists.
  let s = 3; const rnd = () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
  let last: string | null = null;
  for (let i = 0; i < 200; i++) {
    const pick = choose('affirm', 1, 'head', hormoneTemper(base, base, null), NEUTRAL_DISPOSITIONS, rnd, () => true, last, { always: true });
    assert.ok(typeof pick !== 'string' && pick.variant.id !== last); last = pick.variant.id;
  }
});

test('voice off: one gentle accent as each new piece shows, from its clearest clause; nothing for what was already shown', () => {
  const face = new SpeechFace(undefined, 21); eager(face);
  face.cue({ kind: 'start', key: 't#shown', text: '真的超级好看！', voiced: false });
  run(face, 2, 60, () => free(false));
  const first = started(face.ledger);
  assert.ok(first.length >= 1 && first.every(r => r.timing === 'onset' && r.at < 0.05), JSON.stringify(first));
  // The same prefix again: nothing new. A longer prefix: only the new piece counts.
  face.cue({ kind: 'start', key: 't#shown', text: '真的超级好看！', voiced: false });
  run(face, 0.5, 60, () => free(false));
  assert.equal(started(face.ledger).length, first.length);
  face.cue({ kind: 'start', key: 't#shown', text: '真的超级好看！今天天气不错。', voiced: false });
  run(face, 0.5, 60, () => free(false));
  assert.equal(started(face.ledger).length, first.length, 'a calm new piece: nothing');
  // Amplitude is the gentle onset share.
  assert.ok(first.every(r => r.family === 'head' || r.amp! <= HARD.caps.smileEyes * SPEECH_FACE_KNOBS.timing.onsetGain + 1e-9), JSON.stringify(first));
});

test('system voice (no levels): accents at the clauses\' estimated starts, called onset, never a "peak"', () => {
  const face = new SpeechFace(undefined, 4); eager(face);
  face.cue({ kind: 'start', key: 's#0', text: '真的超级好看！你说是不是？哈哈，好开心～', voiced: true });
  run(face, 6, 60);
  const s = started(face.ledger);
  assert.ok(s.length >= 1 && s.every(r => r.timing === 'onset'), JSON.stringify(s.map(r => r.timing)));
  assertLimits(face.ledger);
});

test('perform(): the one entry point (intent, strength, timing); the hard rules still apply; a late request is dropped', () => {
  const face = new SpeechFace(undefined, 8);
  const planned = face.perform('emphasis', 1, { at: 'peak', seconds: 0.6 }, { always: true, families: ['face'] });
  assert.equal(planned.length, 1);
  const frames = run(face, 1.6, 60, () => free(false));
  const record = started(face.ledger)[0];
  assert.ok(record && Math.abs(record.peakAt! - 0.6) < 1 / 60 + 1e-9, `the accent lands at 0.6 s (${record?.peakAt})`);
  assert.ok(Math.max(...frames.map(f => f.out.browUp)) > 0.05);
  // A second one right after: held back by the spacing rule, not delayed.
  face.perform('emphasis', 1, { at: 'now' }, { always: true, families: ['face'] });
  run(face, 0.2, 60, () => free(false));
  assert.equal(face.ledger.at(-1)!.reason, 'spacing');
  // An accent whose peak is already too close: skipped at once.
  face.perform('emphasis', 1, { at: 'peak', seconds: 0.05 }, { always: true, families: ['face'] });
  assert.equal(face.ledger.at(-1)!.reason, 'late');
  // Malformed cues from the other window are ignored.
  assert.equal(sanitizeSpeechFaceCue({ kind: 'levels', key: 'x', aheadMs: 0, stepMs: 1, levels: [] }), null);
  assert.equal(sanitizeSpeechFaceCue({ kind: 'start', key: '', text: 'a', voiced: true }), null);
  assert.deepEqual(sanitizeSpeechFaceCue({ kind: 'levels', key: 'x', aheadMs: 5, stepMs: 40, levels: [2, -1, 'a'] }), { kind: 'levels', key: 'x', aheadMs: 5, stepMs: 40, levels: [1, 0, 0] });
});

test('recipes: every envelope starts and ends at rest; the accent key is inside; caps cover every range', () => {
  for (const [intent, variants] of Object.entries(RECIPES)) for (const v of variants) {
    assert.equal(v.keys[0][1], 0, `${intent}/${v.id} starts at rest`); assert.equal(v.keys.at(-1)![1], 0, `${intent}/${v.id} ends at rest`);
    assert.equal(envelope(v.keys, 0), 0); assert.equal(envelope(v.keys, v.keys.at(-1)![0]), 0);
    const cap = v.slider === 'nod' ? HARD.caps.nodDeg : v.slider === 'tilt' ? HARD.caps.tiltDeg : HARD.caps[v.slider as 'smileEyes'];
    assert.ok(v.amp[1] <= cap + 1e-9, `${v.id}: range within the cap`);
  }
});
