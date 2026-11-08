/**
 * M1 on the real Stage frame loop (the bundled Gene, its Stand VMD, real procedural life, the R15 dance; gene-stage-harness):
 *  - "让她一直跟着跳" gives exactly the original R15 frames (a digest of every displayed frame), by every route into it;
 *  - her own choice: calm nods (R18 small motion), happy dances, sad stays still, drowsy and asleep stop;
 *  - R29: entering, leaving, and every change of tier in the middle of a song keep the surprise per frame within the
 *    R15 standard (no jump, no dead stop, no teleport); the numbers are printed under R29_REPORT=1;
 *  - a chat request lifts her; a stale one does not.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { between, geneStage, measureHandoff, surprises, type BoneHandoff, type GeneStage, type GeneStageOptions, type ShownFrame } from './helpers/gene-stage-harness';

const FLOOR = 0.15;
const her = (stage: any) => stage.setMusicSettings({ alwaysDance: false });
const view = (h: GeneStage, patch: Record<string, unknown>) => h.stage.setMood({ ...h.stage.moodView, ...patch });
const snapshot = (h: GeneStage, primary: string) => ({ snapshot: { ...h.stage.moodView.snapshot, primary } });
const listen = (h: GeneStage) => h.stage.setMusicEnabled(true);
const tierOf = (h: GeneStage) => h.stage.musicChoice?.tier as string | undefined;

/** A digest of every displayed frame: the rotations of all tracked and derived bones plus the face morphs, bit for bit. */
function digest(frames: readonly ShownFrame[]): string {
  const hash = createHash('sha256'), buffer = new Float64Array(4);
  for (const frame of frames) {
    for (const q of [...frame.world, ...frame.derived]) { buffer[0] = q.x; buffer[1] = q.y; buffer[2] = q.z; buffer[3] = q.w; hash.update(Buffer.from(buffer.buffer)); }
    buffer[0] = frame.blink; buffer[1] = frame.smile; buffer[2] = frame.brow; buffer[3] = frame.mouth; hash.update(Buffer.from(buffer.buffer));
  }
  return hash.digest('hex');
}
/**
 * I-016 (docs/claude/2026-11-03-listen-kind.md): with the music settings received, "一直跟着跳" shows the dance once the sound is
 * recognized as music. The R15 analysis runs from the first sample either way,
 * so from the moment the dance is fully shown (`open`, after the hold's 0.6 s ease-in) every frame is R15's own, bit for bit.
 */
async function r15Frames(route: (h: GeneStage) => void, options: GeneStageOptions = {}): Promise<{ hash: string; count: number; open: number; frames: ShownFrame[] }> {
  const h = await geneStage({ music: false, ...options });
  try {
    route(h);
    let open = -1, wasHeld = false;
    const held = () => (h.stage.musicChoice ? h.stage.musicDance.heldShare : 1) as number;
    h.run(8, () => { const share = held(); if (share < 1) { wasHeld = true; open = -1; } else if (wasHeld && open < 0) open = h.shown.length; });
    h.stage.setMusicEnabled(false);
    h.run(2);
    return { hash: digest(h.shown), count: h.shown.length, open: wasHeld ? open : 0, frames: h.shown };
  } finally { h.close(); }
}
const from = (run: { frames: ShownFrame[] }, index: number) => digest(run.frames.slice(index));

test('M1 fallback: "让她一直跟着跳" gives the original R15 frames bit for bit, by every route, whatever her mood or sleep', async () => {
  // Route 0 bypasses the new code: the original dance switch itself.
  const original = await r15Frames(h => h.stage.setDanceOn(true));
  assert.equal(original.count, 600);
  assert.equal(original.open, 0);
  // Before the music settings arrive the stage is the original R15 path itself, from the first frame.
  const routes: [string, (h: GeneStage) => void][] = [
    ['default: no music setting received (the audio switch alone)', h => listen(h)],
    ['the setting received as on, before the music starts', h => { h.stage.setMusicSettings({ alwaysDance: true }); listen(h); }],
  ];
  for (const [name, route] of routes) { const run = await r15Frames(route); assert.deepEqual([run.hash, run.count, run.open], [original.hash, original.count, 0], name); }
  // I-016: the routes through the director wait for the music to be recognized, then are R15 frame for frame (the exit too).
  const recognized: [string, (h: GeneStage) => void][] = [
    ['her choice switched off again before the music starts', h => { her(h.stage); h.stage.setMusicSettings({ alwaysDance: true }); listen(h); }],
    ['switched to her choice and back to always while the music plays', h => { listen(h); her(h.stage); h.stage.setMusicSettings({ alwaysDance: true }); }],
  ];
  for (const [name, route] of recognized) {
    const run = await r15Frames(route);
    assert.ok(run.open > 60 && run.open < 4 * 60, `${name}: shown in full ${(run.open / 60).toFixed(2)} s in (recognized, then 0.6 s in)`);
    assert.equal(from(run, run.open), from(original, run.open), `${name}: R15's frames from then on`);
  }
  // A sad her still dances in always mode: nothing about her state reaches the dance.
  const sad = await r15Frames(h => { h.stage.setMusicSettings({ alwaysDance: true }); her(h.stage); h.stage.setMusicSettings({ alwaysDance: true }); listen(h); }, { primary: 'sad' });
  const sadR15 = await r15Frames(h => h.stage.setDanceOn(true), { primary: 'sad' });
  assert.equal(from(sad, sad.open), from(sadR15, sad.open));
  // And her own choice really is different from it (the test can tell the paths apart).
  const hers = await r15Frames(h => { her(h.stage); listen(h); }, { primary: 'sad' });
  assert.notEqual(from(hers, sad.open), from(sad, sad.open), 'sad, by her own choice, she does not dance');
});

test('M1 choice: calm nods through the small motions, happy dances, sad stays still, drowsy and asleep stop', async () => {
  const outcome = async (options: GeneStageOptions, after?: (h: GeneStage) => void) => {
    const h = await geneStage({ music: false, ...options });
    try {
      her(h.stage); listen(h); h.run(8);
      after?.(h);
      return { tier: tierOf(h), dance: h.stage.musicEnabled as boolean, nod: h.stage.musicNod.active as boolean, line: h.stage.musicChoice.getState().line as string };
    } finally { h.close(); }
  };
  const calm = await outcome({ primary: 'calm' });
  assert.deepEqual([calm.tier, calm.dance, calm.nod], ['nod', false, true]);
  assert.match(calm.line, /^听到了 · 想跳 0\.\d\d · 点头晃一晃/, 'R18: the line first says she heard it');
  const happy = await outcome({ primary: 'happy' });
  assert.deepEqual([happy.tier, happy.dance, happy.nod], ['dance', true, false]);
  const sad = await outcome({ primary: 'sad' });
  assert.deepEqual([sad.tier, sad.dance, sad.nod], ['none', false, false]);
  const drowsy = await outcome({ primary: 'happy', drowsy: true });
  assert.deepEqual([drowsy.tier, drowsy.dance, drowsy.nod], ['none', false, false], 'a happy but drowsy her does not dance');
  const asleep = await outcome({ primary: 'excited' }, h => { view(h, { fatigue: { ...h.stage.moodView.fatigue, phase: 'asleep', sleeping: true, gazeAllowed: false } }); h.run(0.2); });
  assert.deepEqual([asleep.tier, asleep.dance], ['none', false], 'asleep never moves, even excited');
});

test('M1 nod: it is the small motions, not the dance: gaze and blink keep running and nothing yields to "music"', async () => {
  const h = await geneStage({ music: false, primary: 'calm' });
  try {
    her(h.stage); listen(h); h.run(8);
    assert.equal(tierOf(h), 'nod');
    assert.equal(h.stage.musicEnabled, false, 'the R15 dance is not on');
    const life = h.stage.life.getState().primitives;
    for (const primitive of [life.gaze, life.tilt, life.sway]) assert.ok(!primitive.yielding.includes('music'), `${JSON.stringify(primitive.yielding)}: procedural life does not give way to a dance`);
    const nod = h.stage.musicNod.getState();
    assert.ok(nod.engine.level > 0.1 && Math.abs(nod.headX) <= 0.04 && Math.abs(nod.bodyZ) <= 0.015, JSON.stringify(nod));
  } finally { h.close(); }
});

// ----------------------------------------------------------------- R29: no jump, no teleport

const bone = (bones: BoneHandoff[], name: string) => bones.find(value => value.bone === name)!;
function report(label: string, bones: BoneHandoff[]): void {
  if (!process.env.R29_REPORT) return;
  const f = (value: number) => value.toFixed(3);
  console.log(`${label}\n${['センター', '上半身', '首', '頭'].map(name => bone(bones, name)).map(v => `  ${v.bone} surprise ${f(v.startSurprise)}/${f(v.endSurprise)} (source ${f(v.sourceSurprise)}) step ${f(v.handoffStep)} (p95 ${f(v.sourceStep)}) held ${v.heldTravel.toFixed(2)}/${v.sourceTravel.toFixed(2)}`).join('\n')}`);
}
const script = { t0: 3.6, hold: 8, after: 2 };
const enter = { ...script, prepare: (h: GeneStage) => her(h.stage), start: (h: GeneStage) => listen(h), end: (h: GeneStage) => h.stage.setMusicEnabled(false) };
const r15 = { ...script, start: (h: GeneStage) => listen(h), end: (h: GeneStage) => h.stage.setMusicEnabled(false) };
const worst = (bones: BoneHandoff[], key: 'startSurprise' | 'endSurprise') => Math.max(...bones.map(value => value[key]));

test('M1 R29: a light nod comes in and goes out without a jump, and really moves her a little', async () => {
  const m = await measureHandoff({ music: false, primary: 'calm' }, enter);
  report('nod in/out', m.bones);
  for (const value of m.bones) {
    const limit = Math.max(value.sourceSurprise * 1.25, FLOOR);
    assert.ok(value.startSurprise <= limit, `nod: ${value.bone} jumps at the start (${value.startSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
    assert.ok(value.endSurprise <= limit, `nod: ${value.bone} jumps at the end (${value.endSurprise.toFixed(3)} > ${limit.toFixed(3)} deg)`);
    assert.ok(value.handoffStep <= Math.max(value.sourceStep * 3, 0.25), `nod: ${value.bone} has no big step at either edge (${value.handoffStep.toFixed(3)} deg)`);
  }
  const head = bone(m.bones, '頭'), body = bone(m.bones, '上半身');
  assert.ok(head.heldTravel > head.sourceTravel * 1.1, `the nod adds head motion (${head.heldTravel.toFixed(2)} vs ${head.sourceTravel.toFixed(2)} deg undisturbed)`);
  assert.ok(body.heldTravel >= body.sourceTravel * 0.9, 'the small motions underneath keep going');
  assert.equal(m.guard.jumps, 0, 'the display bridge had nothing to catch');
});

test('M1 R29: the dance by her own choice enters and leaves exactly as R15 does, and the nod is much smaller than the dance', async () => {
  const original = await measureHandoff({ music: false, primary: 'happy' }, r15);
  const hers = await measureHandoff({ music: false, primary: 'happy' }, enter);
  report('dance, R15 itself', original.bones);
  report('dance, her choice', hers.bones);
  // I-016: her dance starts when the music is recognized (about a second after R15's own here), so it is at another phase of
  // the beat when the music stops, and R15's own exit varies with that phase (0.06–0.30° on the head between these stops).
  // Her exit is held to R15's exits over the same range of phases; tests/listen-kind-stage.test.ts shows her dance is R15's
  // own dance, sample for sample, from the moment it starts.
  const exits: Awaited<ReturnType<typeof measureHandoff>>[] = [];
  for (const hold of [8, 8.1, 8.2, 8.3, 8.4]) exits.push(await measureHandoff({ music: false, primary: 'happy' }, { ...r15, hold }));
  for (const value of hers.bones) {
    const before = original.bones.find(item => item.bone === value.bone)!;
    const exit = Math.max(...exits.map(m => m.bones.find(item => item.bone === value.bone)!.endSurprise));
    assert.ok(value.startSurprise <= Math.max(before.startSurprise * 1.25, FLOOR), `${value.bone} start ${value.startSurprise.toFixed(3)} vs R15 ${before.startSurprise.toFixed(3)}`);
    assert.ok(value.endSurprise <= Math.max(exit * 1.25, FLOOR), `${value.bone} end ${value.endSurprise.toFixed(3)} vs R15 ${exit.toFixed(3)} at its worst phase`);
    assert.ok(value.handoffStep <= Math.max(before.handoffStep, ...exits.map(m => m.bones.find(item => item.bone === value.bone)!.handoffStep)) * 1.25 + 0.01, `${value.bone} edge step ${value.handoffStep.toFixed(3)}`);
    assert.ok(Math.abs(value.heldTravel - before.heldTravel) <= before.heldTravel * 0.2 + 0.5, `${value.bone} moves about as much as R15 (${value.heldTravel.toFixed(1)} vs ${before.heldTravel.toFixed(1)} deg)`);
  }
  assert.equal(hers.guard.jumps, 0);
  const nod = await measureHandoff({ music: false, primary: 'calm' }, enter);
  const extra = (m: typeof hers, name: string) => bone(m.bones, name).heldTravel - bone(m.bones, name).sourceTravel;
  assert.ok(extra(nod, '頭') > 0 && extra(nod, '頭') < extra(hers, '頭') * 0.6, `head: nod +${extra(nod, '頭').toFixed(1)} vs dance +${extra(hers, '頭').toFixed(1)} deg`);
});

test('M1 R29: when she starts speaking in the middle of a nod, the nod hands over smoothly and comes back after', async () => {
  const m = await measureHandoff({ music: false, primary: 'calm', beforeLayers: (stage: any) => { her(stage); stage.setMusicEnabled(true); } },
    { t0: 8, hold: 3, after: 3, start: h => { h.stage.speaking = true; }, end: h => { h.stage.speaking = false; } });
  report('nod + speech', m.bones);
  for (const value of m.bones) {
    const limit = Math.max(value.sourceSurprise * 1.25, FLOOR);
    assert.ok(value.startSurprise <= limit, `${value.bone} start ${value.startSurprise.toFixed(3)} > ${limit.toFixed(3)} deg`);
    assert.ok(value.endSurprise <= limit, `${value.bone} end ${value.endSurprise.toFixed(3)} > ${limit.toFixed(3)} deg`);
  }
  assert.equal(m.guard.jumps, 0);
});

/** Largest per-frame surprise (degrees) of the tracked bones over [from, to] seconds. */
function worstSurprise(frames: readonly ShownFrame[], from: number, to: number) {
  const values = surprises(between(frames, from, to));
  return Math.max(0, ...values.map(list => Math.max(0, ...list)));
}
/** Runs a song, applies a change at `at`, and measures the frames around the moment her tier actually changes. */
async function change(options: GeneStageOptions, at: number, apply: (h: GeneStage) => void, until: number) {
  const h = await geneStage({ music: false, ...options });
  try {
    her(h.stage); listen(h);
    h.run(at);
    const from = tierOf(h);
    apply(h);
    let last = from, changeAt = Number.NaN;
    h.run(until - at, time => { const now = tierOf(h); if (now !== last) { if (Number.isNaN(changeAt)) changeAt = time; last = now; } });
    const base = worstSurprise(h.shown, 1.2, at - 0.5);
    const around = Number.isNaN(changeAt) ? Number.NaN : worstSurprise(h.shown, changeAt - 0.3, changeAt + 1.5);
    return { base, around, from, to: tierOf(h), changeAt, jumps: h.shown.at(-1)!.guardJumps };
  } finally { h.close(); }
}

test('M1 R29: every change of tier in the middle of a song is smooth (nod -> dance, dance -> nod, dance -> none, nod -> none, none -> nod)', async () => {
  const original = await measureHandoff({ music: false, primary: 'happy' }, r15);
  const ENTRY = worst(original.bones, 'startSurprise'), EXIT = worst(original.bones, 'endSurprise');
  if (process.env.R29_REPORT) console.log(`R15 itself: dance entry worst surprise ${ENTRY.toFixed(3)} deg, exit ${EXIT.toFixed(3)} deg`);
  const cases: { name: string; options: GeneStageOptions; apply: (h: GeneStage) => void; from: string; to: string; until: number; limit: number }[] = [
    // A request reaches full strength a few seconds after the message (a willing card's ramp), an asleep or paused her stops at once,
    // and a mood change is judged at the next scheduled judgement (the catch-on one at 5 s, then every 15 s).
    { name: 'nod -> dance (asked to dance)', options: { primary: 'calm' }, from: 'nod', to: 'dance', until: 18, limit: ENTRY * 1.25,
      apply: h => view(h, { danceRequest: { id: 'ask', at: Date.now() } }) },
    { name: 'dance -> nod (mood settles)', options: { primary: 'happy' }, from: 'dance', to: 'nod', until: 32, limit: EXIT * 1.25,
      apply: h => view(h, snapshot(h, 'calm')) },
    { name: 'none -> nod (mood lifts)', options: { primary: 'sad' }, from: 'none', to: 'nod', until: 32, limit: FLOOR,
      apply: h => view(h, snapshot(h, 'calm')) },
    { name: 'dance -> none (she falls asleep)', options: { primary: 'excited' }, from: 'dance', to: 'none', until: 14, limit: EXIT * 1.25,
      apply: h => view(h, { fatigue: { ...h.stage.moodView.fatigue, phase: 'falling-asleep', sleeping: false } }) },
    { name: 'nod -> none (自动表现 paused)', options: { primary: 'calm' }, from: 'nod', to: 'none', until: 14, limit: FLOOR,
      apply: h => view(h, { expressions: false }) },
  ];
  for (const c of cases) {
    const result = await change(c.options, 9, c.apply, c.until);
    if (process.env.R29_REPORT) console.log(`${c.name}: ${result.from} -> ${result.to} at ${result.changeAt.toFixed?.(2)} s; steady worst surprise ${result.base.toFixed(3)} deg, around the change ${result.around.toFixed(3)} deg (limit ${c.limit.toFixed(3)}), guard jumps ${result.jumps}`);
    assert.equal(result.from, c.from, `${c.name}: before`);
    assert.equal(result.to, c.to, `${c.name}: after`);
    assert.ok(!Number.isNaN(result.changeAt), `${c.name}: the tier changed`);
    assert.ok(result.around <= Math.max(c.limit, result.base * 1.25, FLOOR), `${c.name}: the change is not a jump (${result.around.toFixed(3)} deg > ${Math.max(c.limit, result.base * 1.25, FLOOR).toFixed(3)})`);
  }
});

test('M1 request: a fresh "跳一个" marker lifts a calm her from a nod to the dance within seconds; an old one does nothing', async () => {
  const run = async (at: number) => {
    const h = await geneStage({ music: false, primary: 'calm' });
    try {
      her(h.stage); listen(h); h.run(8);
      assert.equal(tierOf(h), 'nod');
      view(h, { danceRequest: { id: 'ask-1', at } });
      h.run(8);
      return { tier: tierOf(h), dance: h.stage.musicEnabled as boolean };
    } finally { h.close(); }
  };
  assert.deepEqual(await run(Date.now()), { tier: 'dance', dance: true });
  assert.deepEqual(await run(Date.now() - 60_000), { tier: 'nod', dance: false }, 'a minute-old marker (a late view) starts nothing');
});

test('M1 developer line: her want to dance and why, shown only in developer mode', async () => {
  const h = await geneStage({ music: false, primary: 'happy' });
  try {
    assert.equal(h.stage.getMusicChoiceLine(), '', 'nothing before the music settings are received');
    her(h.stage); listen(h); h.run(1);
    assert.equal(h.stage.getMusicChoiceLine(), '', 'not in developer mode');
    view(h, { developerMode: true });
    // I-016: before the music is recognized she has nothing to judge; the fast layer's own part follows the M1 line.
    assert.match(h.stage.getMusicChoiceLine(), /^想跳：听到声音，还没认出是音乐.* ｜ 像音乐 0\.\d\d（.*）→ 不是音乐$/);
    h.run(3);
    assert.match(h.stage.getMusicChoiceLine(), /^听到了 · 想跳 0\.\d\d · 跳起来 · 心情愉快\+0\.22.* → 跳起来 · 第 1 次判断 ｜ 像音乐 0\.\d\d（节拍 .*）→ 认出是音乐$/);
    h.stage.setListenKindLine('宿主：音乐 0.80（节拍）');
    assert.match(h.stage.getMusicChoiceLine(), / ｜ 宿主：音乐 0\.80（节拍）$/, 'the host\'s judgement, when the panel feed brings it');
    const data = JSON.parse(h.stage.renderer.domElement.dataset.musicDance ?? 'null');
    assert.equal(data.choice.mode, 'her');
    h.stage.setMusicSettings({ alwaysDance: true });
    assert.match(h.stage.getMusicChoiceLine(), /让她一直跟着跳：开/);
  } finally { h.close(); }
});
