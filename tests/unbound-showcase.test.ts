// Unbound showcase (docs/claude/2026-11-14-lapwing-showcase.md): the beat validator (the program only clamps and drops), the
// warm-morning mood, the performer (seeded variation, late segments, blinks), and the body on the bundled Gene through the real
// frame loop (eyes near the middle, no jumps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { beatPeak, capMurmurs, lastJsonObject, liveliness, parseShowcaseSegment, sampleWarmMorning, showcasePrompt, validateBeats, WARM_MORNING } from '../shared/unbound/showcase';
import { ShowcasePerformer, setSpokenMouth, setStillWindows } from '../src/unbound/showcase/performer';
import { ShowcaseMotion, setShowcaseIdle } from '../src/unbound/motion/showcase-motion';
import { createLearnedIdle } from '../src/unbound/motion/learned-idle';
import { laptopLens } from './helpers/unbound-peek';
import { eyeAngles, fakeBeats, quantile, runShowcase, steps, SHOWCASE_TRACKED, pointSurprisesOf, maxOf } from './helpers/unbound-showcase';

test('validator: words outside the vocabulary are dropped, numbers clamped, unknown parameters fall back', () => {
  const seg = validateBeats([
    { at: 1, dur: 3, kind: 'own-world', side: 'left', eyes: 'closed', intensity: 0.5, feel: '看窗外' },
    { at: 2, dur: 3, kind: 'backflip', intensity: 1, feel: 'x' },
    { at: 3, dur: 99, kind: 'tilt', side: 'up', deg: 80, intensity: 7, feel: '<b>歪头</b>' },
    { at: 70, dur: 1, kind: 'notice', intensity: 0.5, feel: '' },
    { at: 4, dur: 5, kind: 'glance', dir: 'down', intensity: 0.5, feel: '' },
    'nonsense', null,
  ], { from: 0, to: 60 })!;
  assert.equal(seg.beats.length, 3);
  assert.equal(seg.dropped, 4);
  const tilt = seg.beats.find(b => b.kind === 'tilt')!;
  assert.equal(tilt.deg, 22); assert.equal(tilt.dur, 10); assert.equal(tilt.intensity, 1); assert.equal(tilt.side, 'left');
  assert.doesNotMatch(tilt.feel, /[<>]/);
  assert.equal(seg.beats.find(b => b.kind === 'glance')!.dur, 1.6);
  assert.equal(validateBeats([{ at: 1, kind: 'dance' }], { from: 0, to: 60 }), null);
});

test('the answer: the last JSON object wins, braces inside strings do not confuse it, nothing usable is null', () => {
  const text = '好的。\n```json\n{"summary":"一段 {有括号} 的概要","beats":[{"at":0,"dur":2,"kind":"notice","intensity":0.5,"feel":"}"}]}\n```';
  assert.equal((lastJsonObject(text) as { summary: string }).summary, '一段 {有括号} 的概要');
  assert.equal(parseShowcaseSegment(text, { from: 0, to: 30 })!.beats[0].kind, 'notice');
  assert.equal(parseShowcaseSegment('没有 JSON', { from: 0, to: 30 }), null);
  assert.equal(parseShowcaseSegment('{"beats":[]}', { from: 0, to: 30 }), null);
});

test('warm morning: every value inside its range; liveliness 0..1; the prompt carries the window and no private words', () => {
  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const mood = sampleWarmMorning(() => (r = (r * 9301 + 49297) % 233280 / 233280));
    for (const [k, [lo, hi]] of Object.entries(WARM_MORNING)) { const v = mood[k as keyof typeof mood]; assert.ok(v >= lo && v <= hi, `${k} ${v}`); }
    const l = liveliness(mood); assert.ok(l >= 0 && l <= 1);
  }
  const prompt = showcasePrompt({ mood: sampleWarmMorning(() => 0.5), situation: '早上', window: { from: 24, to: 50 }, part: 2, total: 50 });
  assert.match(prompt, /第 24\.0 秒到第 50\.0 秒/);
  // Round 2: no prescribed arc. Neither part tells her where to start, how many times to come close or to wave goodbye.
  const first = showcasePrompt({ mood: sampleWarmMorning(() => 0.5), situation: '早上', window: { from: 0, to: 24 }, part: 1, total: 50, opening: 'standing' });
  for (const p of [first, prompt]) {
    assert.doesNotMatch(p, /第一拍从 own-world|凑近和退开各|胸前轻轻挥手道别|至少有一段/);
    assert.match(p, /不要套一个固定的顺序/);
    // Round 4: no ending examples in the rules (Claude copied them); the program hands one ending direction per run instead.
    assert.doesNotMatch(p, /闭眼满足地笑，或者就安静看着他|结尾也按心情/);
  }
  const last = showcasePrompt({ mood: sampleWarmMorning(() => 0.5), situation: '早上', window: { from: 24, to: 50 }, part: 2, total: 50, ending: '打个小哈欠，慢慢困得出神', talk: 0 });
  assert.match(last, /打个小哈欠，慢慢困得出神/);
  assert.match(last, /这次她不说话/);
});

test('performer: the same seed plays the same; another seed varies every beat; a late segment never lands in the past', () => {
  const beats = fakeBeats('a'), lens = laptopLens();
  const play = (seed: number) => { const p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, seed); p.append(beats.filter(b => b.at < 20)); const out = []; for (let i = 0; i < 600; i++) out.push(p.frame(1 / 30, lens).intent); return { p, out }; };
  const a = play(0.3), b = play(0.3), c = play(0.7);
  assert.deepEqual(a.out.map(i => [i.tilt, i.face.warm, i.hands.right?.weight ?? null]), b.out.map(i => [i.tilt, i.face.warm, i.hands.right?.weight ?? null]));
  // Two runs of the same beat type differ in their parameters.
  const tiltsA = a.p.played.filter(x => x.kind === 'tilt').map(x => x.vary.amp), tiltsC = c.p.played.filter(x => x.kind === 'tilt').map(x => x.vary.amp);
  assert.ok(tiltsA.every((v, i) => Math.abs(v - tiltsC[i]) > 1e-6));
  assert.ok(a.out.some((x, i) => Math.abs(x.tilt - c.out[i].tilt) > 1e-3));
  // Late: the second half arrives after its own start time; it is shifted to now.
  const late = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.1);
  late.append(beats.filter(x => x.at < 20));
  for (let i = 0; i < 30 * 26; i++) late.frame(1 / 30, lens);
  late.append(beats.filter(x => x.at >= 20));
  assert.ok(late.played.every(x => x.at < 20 || x.playedAt >= late.clock));
});

test('silent talking: the line\'s pinyin drives the mouth, a stressed syllable lifts the brows; no pinyin falls back to a murmur', () => {
  const seg = validateBeats([{ at: 0, dur: 1.4, kind: 'murmur', intensity: 0.6, feel: '', line: '早安呀<b>', pinyin: 'zao *an* ya 早' }], { from: 0, to: 30 })!;
  const beat = seg.beats[0];
  assert.equal(beat.line, '早安呀 b');
  assert.equal(beat.pinyin, 'zao *an* ya');
  setSpokenMouth(true); // off by default since round 4; the mechanism stays tested
  const p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.3, 'standing'), lens = laptopLens();
  p.append([beat]);
  let maxA = 0, maxO = 0, maxStress = 0;
  for (let i = 0; i < 90; i++) { const f = p.frame(1 / 60, lens).intent.face; maxA = Math.max(maxA, f.mouth.a); maxO = Math.max(maxO, f.mouth.o); maxStress = Math.max(maxStress, f.stress); }
  assert.ok(maxA > 0.3, `a: ${maxA}`);
  assert.ok(maxStress > 0.5, 'the stressed syllable lifts the brows');
  assert.equal(maxO, 0, 'no o in "zao an ya": its main vowel is a');
  setSpokenMouth(false);
});

test('blinks: right-skewed gaps (not a metronome), and one at a big change of gaze', () => {
  const lens = laptopLens(), p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.42);
  p.append([{ at: 0, dur: 2, kind: 'own-world', intensity: 0.5, feel: '', side: 'left', eyes: 'open', pitch: 'level' }, { at: 30, dur: 1, kind: 'notice', intensity: 0.6, feel: '' }]);
  for (let i = 0; i < 60 * 120; i++) p.frame(1 / 60, lens);
  const gaps = p.blinkTimes.slice(1).map((t, i) => t - p.blinkTimes[i]);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length, median = quantile(gaps, 0.5);
  assert.ok(gaps.length > 20, `${gaps.length} blinks`);
  assert.ok(mean > median, `mean ${mean.toFixed(2)} > median ${median.toFixed(2)}`);
  const notice = p.played.find(x => x.kind === 'notice')!.playedAt;
  assert.ok(p.blinkTimes.some(t => t >= notice && t < notice + 0.1), 'a blink as she turns to you');
});

test('on the bundled Gene (30 fps, first 22 s of fake A): eyes near the middle, no jumps, feet stay', async () => {
  const beats = fakeBeats('a').filter(b => b.at < 20);
  const run = await runShowcase(30, 22, beats, { seed: 0.42 });
  const eyes = eyeAngles(run.frames.slice(30));
  assert.ok(quantile(eyes, 0.95) <= 15, `eye-in-head p95 ${quantile(eyes, 0.95).toFixed(1)}°`);
  const all = SHOWCASE_TRACKED.map((_, i) => i);
  assert.ok(maxOf(steps(run.frames.slice(2), all)) < 16, `largest bone step ${maxOf(steps(run.frames.slice(2), all)).toFixed(1)}°`);
  assert.ok(maxOf(pointSurprisesOf(run.frames.map(f => f.root))) < 0.2, 'her root never jumps');
  assert.ok(run.frames.some(f => f.handsUp > 0.9), 'a hand went up');
  const closest = Math.min(...run.frames.map(f => f.clearance ?? 1));
  assert.ok(closest >= 0, `fingers stay outside her face (closest ${(closest * 100).toFixed(2)} cm)`);
});

test('round 6: at most the hinted number of spoken lines (the earliest kept); every visible beat has a peak inside it', () => {
  const beats = [{ kind: 'murmur', at: 1 }, { kind: 'tilt', at: 2 }, { kind: 'murmur', at: 3 }, { kind: 'murmur', at: 4 }];
  const capped = capMurmurs(beats, 2);
  assert.deepEqual(capped.beats.map(b => b.at), [1, 2, 3]);
  assert.equal(capped.dropped, 1);
  assert.equal(capMurmurs(beats, 0).beats.filter(b => b.kind === 'murmur').length, 0);
  for (const b of fakeBeats('a')) { const p = beatPeak(b); if (p !== null) assert.ok(p >= 0 && p <= Math.max(0.3, b.dur) + 1e-9, `${b.kind} ${p}`); }
  assert.equal(beatPeak({ kind: 'blink-style', dur: 2 }), null);
});

// Round 6: the first 31 s of a recorded live run (v5-claude-run1, feelings and lines left out). At 27.5 s a fingertip rests at her chin
// while she tilts and then lowers her chin for a sly smile: before the fix her face met the fingers (-0.33 cm here at 60 fps, -0.8 cm on the recording page).
const CHIN_RUN = [{ at: 0, dur: 5.5, kind: 'own-world', intensity: 0.4, side: 'left', eyes: 'half', pitch: 'level' }, { at: 0.5, dur: 4.5, kind: 'murmur', intensity: 0.3 }, { at: 1, dur: 3, kind: 'blink-style', intensity: 0.3, style: 'soft' }, { at: 5.5, dur: 1, kind: 'glance', intensity: 0.4, dir: 'down-right' }, { at: 6.8, dur: 2.5, kind: 'expression', intensity: 0.4, name: 'confirm-smile', onset: 'quick' }, { at: 8, dur: 2, kind: 'notice', intensity: 0.5 }, { at: 9.5, dur: 2, kind: 'expression', intensity: 0.5, name: 'shy', onset: 'quick' }, { at: 10, dur: 2.5, kind: 'hand-face', intensity: 0.4, where: 'cheek', side: 'right', how: 'back' }, { at: 12.5, dur: 3, kind: 'hold-gaze', intensity: 0.6 }, { at: 13.5, dur: 3.5, kind: 'approach', intensity: 0.5, amount: 0.4, lean: 0.35 }, { at: 15, dur: 3, kind: 'tilt', intensity: 0.5, side: 'right', deg: 11 }, { at: 17.5, dur: 1.2, kind: 'glance', intensity: 0.4, dir: 'up-left' }, { at: 18.5, dur: 3.5, kind: 'expression', intensity: 0.7, name: 'warm-smile', onset: 'slow' }, { at: 22.5, dur: 3, kind: 'hold-gaze', intensity: 0.5 }, { at: 24.5, dur: 1.2, kind: 'glance', intensity: 0.4, dir: 'down-left' }, { at: 26, dur: 2.5, kind: 'tilt', intensity: 0.5, side: 'right', deg: 10 }, { at: 27.5, dur: 3, kind: 'hand-face', intensity: 0.5, where: 'chin', side: 'left', how: 'fingertip' }, { at: 29.5, dur: 3, kind: 'expression', intensity: 0.6, name: 'sly', onset: 'slow' }];

test('round 6, on the bundled Gene: a fingertip at the chin while she tilts and lowers her chin stays outside her face (60 and 30 fps)', async () => {
  const beats = validateBeats(CHIN_RUN.map(b => ({ ...b, feel: '—' })), { from: 0, to: 62 })!.beats;
  for (const fps of [60, 30]) {
    const run = await runShowcase(fps, 31, beats);
    const touching = run.frames.filter(f => f.t >= 27.5 && f.clearance !== null);
    assert.ok(touching.some(f => f.handsUp > 0.9), `${fps} fps: the hand reached her chin`);
    const closest = Math.min(...touching.map(f => f.clearance!));
    assert.ok(closest >= 0, `${fps} fps: fingers stay outside her face (closest ${(closest * 100).toFixed(2)} cm)`);
  }
});

test('round 7, learned idle: on in quiet holds and her own world, off while she steps; an arm a hand beat holds leaves it; it eases', () => {
  // The base fade of the idle (round 10's still windows then scale it down now and then; they have their own test).
  setStillWindows(false);
  const lens = laptopLens(), p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.3, 'away');
  p.append(validateBeats([
    { at: 0, dur: 3, kind: 'own-world', intensity: 0.5, feel: '—' },
    { at: 3, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' },
    { at: 4.5, dur: 6, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 6, dur: 3, kind: 'hand-face', where: 'cheek', side: 'left', intensity: 0.5, feel: '—' },
    { at: 11, dur: 2, kind: 'approach', amount: 0.6, intensity: 0.5, feel: '—' },
  ], { from: 0, to: 30 })!.beats);
  const at: Record<number, NonNullable<ReturnType<typeof p.frame>['intent']['idle']>> = {};
  let last = 0, biggest = 0;
  for (let i = 1; i <= 30 * 14; i++) {
    const idle = p.frame(1 / 30, lens).intent.idle!;
    biggest = Math.max(biggest, Math.abs(idle.weight - last)); last = idle.weight;
    at[i] = idle;
  }
  const t = (s: number) => at[Math.round(s * 30)];
  assert.ok(t(2.5).weight > 0.9, `own world: ${t(2.5).weight}`);
  assert.ok(t(4).weight < t(2.5).weight, 'eases out as she turns to notice you');
  assert.ok(t(8).weight > 0.9, `quiet hold: ${t(8).weight}`);
  assert.ok(t(8).arms.left < 0.02 && t(8).arms.right > 0.98, `the left hand is at her cheek: arms ${JSON.stringify(t(8).arms)}`);
  assert.ok(t(10.5).arms.left > t(9.5).arms.left, 'the arm comes back to the idle after the hand is down');
  assert.ok(t(12.5).weight < 0.2, `stepping toward you: ${t(12.5).weight}`);
  assert.ok(biggest < 0.06, `eased, never switched (largest step ${biggest.toFixed(3)} a frame at 30 fps)`);
  assert.ok(t(2.5).activation > t(8).activation, 'livelier in her own world than in a still, quiet look');
  // Layer 2 lays the idle on as asked: the held arm gets none of it, the free arm and the body do.
  setShowcaseIdle(() => createLearnedIdle({ heightM: 1.6, activation: 0.9, seed: 3 }));
  try {
    const motion = new ShowcaseMotion(), intent = { ...p.frame(1 / 30, lens).intent, idle: { weight: 1, activation: 0.9, arms: { left: 0, right: 1 } } };
    let out = motion.generate(intent, 1 / 30, { head: null, root: { heading: 0 } });
    for (let i = 0; i < 90; i++) out = motion.generate(intent, 1 / 30, { head: null, root: { heading: 0 } });
    const size = (r: { pitch: number; yaw: number; roll: number }) => Math.abs(r.pitch) + Math.abs(r.yaw) + Math.abs(r.roll);
    assert.equal(size(out.armRot!.left.upper) + size(out.armRot!.left.elbow), 0, 'the held arm: no idle');
    assert.ok(size(out.armRot!.right.upper) > 0, 'the free arm moves');
  } finally { setShowcaseIdle(null); setStillWindows(true); }
});

test('round 7, on the bundled Gene (30 fps, first 22 s of fake A, the procedural idle): eyes near the middle, no jumps, hands outside', async () => {
  const beats = fakeBeats('a').filter(b => b.at < 20);
  const off = await runShowcase(30, 22, beats, { seed: 0.42 });
  const on = await runShowcase(30, 22, beats, { seed: 0.42, idle: {} });
  const all = SHOWCASE_TRACKED.map((_, i) => i);
  for (const [name, run] of [['off', off], ['on', on]] as const) {
    const eyes = eyeAngles(run.frames.slice(30));
    assert.ok(quantile(eyes, 0.95) <= 15, `${name}: eye-in-head p95 ${quantile(eyes, 0.95).toFixed(1)}°`);
    assert.ok(maxOf(steps(run.frames.slice(2), all)) < 16, `${name}: largest bone step ${maxOf(steps(run.frames.slice(2), all)).toFixed(1)}°`);
    assert.ok(Math.min(...run.frames.map(f => f.clearance ?? 1)) >= 0, `${name}: fingers outside her face`);
  }
  // The idle moved her: the upper body differs somewhere in a quiet stretch.
  const chest = SHOWCASE_TRACKED.indexOf('上半身2');
  const apart = Math.max(...on.frames.map((f, i) => f.rotations[chest].angleTo(off.frames[i].rotations[chest]) * 180 / Math.PI));
  assert.ok(apart > 0.3, `the idle moves her upper body (${apart.toFixed(2)}°)`);
});

test('round 9, quiet moments: small quick head events follow the mood (lively: often, calm: rarely), only in a quiet hold, never a jump', () => {
  const lens = laptopLens();
  const hold = validateBeats([{ at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 10, kind: 'hold-gaze', intensity: 0.5, feel: '—' }], { from: 0, to: 30 })!.beats;
  const play = (liveliness: number) => {
    const p = new ShowcasePerformer({ x: 0, z: -1 }, liveliness, 0.42, 'standing');
    p.append(hold);
    let worst = 0, last: { nod: number; tilt: number; yaw: number } | null = null;
    for (let i = 0; i < 60 * 90; i++) {
      const it = p.frame(1 / 60, lens).intent, now = { nod: it.nod, tilt: it.tilt, yaw: it.headYaw ?? 0 };
      if (last) worst = Math.max(worst, Math.abs(now.nod - last.nod), Math.abs(now.tilt - last.tilt), Math.abs(now.yaw - last.yaw));
      last = now;
    }
    return { events: p.quietEventsStarted, worstDeg: worst * 180 / Math.PI };
  };
  const lively = play(0.8), calm = play(0.2);
  assert.ok(lively.events.length >= 25, `lively: ${lively.events.length} events in 90 s`);
  assert.ok(calm.events.length * 2.5 < lively.events.length, `calm: ${calm.events.length} events (lively ${lively.events.length})`);
  assert.ok(new Set(lively.events.map(e => e.kind)).size >= 3, 'more than one kind of event');
  assert.ok([...lively.events, ...calm.events].every(e => e.at >= 1.5), 'none before the hold');
  // Smooth bumps: at most ~2.5° of head turn, nod or tilt from one 60 fps frame to the next (a motion of ≤150°/s, never a jump).
  assert.ok(lively.worstDeg < 2.5, `largest per-frame head change ${lively.worstDeg.toFixed(2)}°`);
  // A glance, a hand or words are not quiet: no event starts while one is on.
  const busy = new ShowcasePerformer({ x: 0, z: -1 }, 0.8, 0.42, 'standing');
  busy.append(validateBeats([{ at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 10, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 3, dur: 8, kind: 'murmur', intensity: 0.5, feel: '—', line: '嗯' }], { from: 0, to: 30 })!.beats);
  for (let i = 0; i < 60 * 11; i++) busy.frame(1 / 60, lens);
  assert.ok(busy.quietEventsStarted.every(e => e.at < 3 || e.at > 11), `no event while she talks (${JSON.stringify(busy.quietEventsStarted)})`);
});

test('round 10, still windows: in a quiet hold the idle eases down to a little of itself now and then (calm: more), smoothly; no move starts inside one', () => {
  const lens = laptopLens();
  const hold = validateBeats([{ at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 10, kind: 'hold-gaze', intensity: 0.5, feel: '—' }], { from: 0, to: 30 })!.beats;
  const play = (liveliness: number) => {
    const p = new ShowcasePerformer({ x: 0, z: -1 }, liveliness, 0.42, 'standing');
    p.append(hold);
    const w: number[] = [];
    for (let i = 0; i < 60 * 90; i++) w.push(p.frame(1 / 60, lens).intent.idle!.weight);
    return { p, w };
  };
  for (const g of [0.8, 0.2]) {
    const { p, w } = play(g), settled = w.slice(60 * 4);
    const low = settled.filter(v => v < 0.2).length / settled.length;
    assert.ok(low > 0.1, `${g}: the idle is down to a fifth or less ${(low * 100).toFixed(0)}% of the time`);
    // Down within ~0.2 s by design (an S5 ramp: at most ~0.13 of the weight per 60 fps frame), never a switch.
    assert.ok(Math.max(...w.slice(1).map((v, i) => Math.abs(v - w[i]))) < 0.16, `${g}: eased, never switched (${Math.max(...w.slice(1).map((v, i) => Math.abs(v - w[i]))).toFixed(3)})`);
    const stills = (p as unknown as { quietEvents: { stills: { at: number; dur: number }[] } }).quietEvents.stills;
    assert.ok(p.quietEventsStarted.every(e => !stills.some(s => e.at > s.at + 1e-9 && e.at < s.at + s.dur - 1e-9)), `${g}: no move starts inside a still window`);
  }
  const lively = play(0.8).w.slice(240), calm = play(0.2).w.slice(240);
  assert.ok(calm.filter(v => v < 0.2).length > lively.filter(v => v < 0.2).length, 'a calm mood holds still more');
});

test('round 10, speech nods: a stressed syllable nods the head 3–5° over half a second (it showed at this framing), smoothly', () => {
  const lens = laptopLens(), p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.42, 'standing');
  p.append(validateBeats([{ at: 0, dur: 1, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1, dur: 8, kind: 'murmur', intensity: 0.8, feel: '—', line: '今天也辛苦啦' }], { from: 0, to: 30 })!.beats);
  const nods: number[] = [];
  for (let i = 0; i < 60 * 9; i++) nods.push(p.frame(1 / 60, lens).intent.nod);
  const peak = Math.max(...nods) * 180 / Math.PI, step = Math.max(...nods.slice(1).map((v, i) => Math.abs(v - nods[i]))) * 180 / Math.PI;
  assert.ok(peak >= 3 && peak <= 6, `the biggest speech nod ${peak.toFixed(2)}°`);
  assert.ok(step < 0.6, `largest per-frame nod change ${step.toFixed(2)}°`);
});

test('round 9, hair behind the ear: the hand reaches the temple, slides back, comes down; her head tilts toward it; outside her hair (30 fps)', async () => {
  const beats = validateBeats([
    { at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 8, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 2.5, dur: 3.6, kind: 'hand-face', where: 'ear', side: 'left', intensity: 0.6, feel: '—' },
  ], { from: 0, to: 30 })!.beats;
  assert.equal(beats[2].where, 'ear', 'the vocabulary has it');
  const lens = laptopLens(), p = new ShowcasePerformer({ x: 0, z: -1 }, 0.5, 0.42, 'standing');
  p.append(beats);
  const slides: number[] = [], tilts: number[] = [];
  for (let i = 0; i < 30 * 7; i++) { const it = p.frame(1 / 30, lens).intent; if (it.hands.left?.pose === 'tuck') { slides.push(it.hands.left.slide ?? -1); tilts.push(it.tilt); } }
  assert.ok(slides[0] === 0 && slides.at(-1)! === 1 && slides.every((s, i) => i === 0 || s >= slides[i - 1]), 'from the temple back to the ear, never back again');
  assert.ok(Math.max(...tilts) > 2 * Math.PI / 180, 'her head tilts toward the hand (her left)');
  const run = await runShowcase(30, 8, beats, { seed: 0.42 });
  const during = run.frames.filter(f => f.t >= 2.5 && f.t <= 6.1 && f.clearance !== null);
  assert.ok(during.some(f => f.handsUp > 0.9), 'the hand went up');
  const closest = Math.min(...during.map(f => f.clearance!));
  assert.ok(closest >= 0, `fingers outside her hair (closest ${(closest * 100).toFixed(2)} cm)`);
  const all = SHOWCASE_TRACKED.map((_, i) => i);
  assert.ok(maxOf(steps(run.frames.slice(2), all)) < 16, `largest bone step ${maxOf(steps(run.frames.slice(2), all)).toFixed(1)}°`);
});

test('round 11, a V by her cheek: index and middle up, ring and little curled; outside her face, no jumps (30 fps)', async () => {
  const beats = validateBeats([
    { at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' }, { at: 1.5, dur: 8, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
    { at: 2.5, dur: 3, kind: 'hand-sign', sign: 'v', side: 'right', intensity: 0.6, feel: '—' },
  ], { from: 0, to: 30 })!.beats;
  assert.equal(beats[2].sign, 'v');
  // The finger bones as posed in the hold (4.4 s).
  const posed = new Map<string, number>();
  const run = await runShowcase(30, 4.6, beats, { seed: 0.42, onFrame: (mesh, t) => {
    if (Math.abs(t - 4.4) > 1e-6 && !(t > 4.38 && t < 4.42)) return;
    for (const b of mesh.skeleton.bones) posed.set(b.name, 2 * Math.acos(Math.min(1, Math.abs(b.quaternion.w))) * 180 / Math.PI);
  } });
  assert.ok(run.frames.filter(f => f.t >= 3.8).every(f => f.handsUp > 0.9), 'the hand is up through the hold');
  const closest = Math.min(...run.frames.filter(f => f.clearance !== null).map(f => f.clearance!));
  assert.ok(closest >= 0, `fingers outside her face (closest ${(closest * 100).toFixed(2)} cm)`);
  const all = SHOWCASE_TRACKED.map((_, i) => i);
  assert.ok(maxOf(steps(run.frames.slice(2), all)) < 16, `largest bone step ${maxOf(steps(run.frames.slice(2), all)).toFixed(1)}°`);
  const bend = (name: string) => posed.get(name) ?? NaN;
  const curls = { index: bend('右人指２'), middle: bend('右中指２'), ring: bend('右薬指２'), little: bend('右小指２') };
  assert.ok(curls.ring > 40 && curls.little > 40, `ring and little curled (${JSON.stringify(curls)})`);
  assert.ok(curls.index < 15 && curls.middle < 15, `index and middle straight (${JSON.stringify(curls)})`);
});