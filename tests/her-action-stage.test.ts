/**
 * 她的动作 (T-211, docs/claude/2026-11-04-codex-actions.md): Codex's 15 actions through the real Stage frame loop on the bundled
 * Gene (Stand, procedural life, the display guard), loaded by the stage's own playHerAction (resolve, MMDLoader with keyframe
 * interpolation, the required-part check). What a viewer would notice is measured frame by frame against an identical stage
 * that does not play it:
 *  - the action really shows (the moving part leaves the idle pose by a clear angle);
 *  - nothing jumps: the display guard has nothing to catch, and the first and last frames of the action move no more than the
 *    idle itself does (it eases in from the live pose and back into it);
 *  - afterwards she is back in her idle pose, and the action has ended;
 *  - a pat in the middle makes it hand back smoothly (R29d: 0.3–0.8 s), not freeze or cut.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, type AnimationClip, type Bone, type Quaternion } from 'three';
import { HER_ACTION_SPECS, HER_BODY_ACTIONS, herActionDurationMs, type HerActionId } from '../shared/her-actions';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { HerActionPlayer } from '../src/stage/her-action';
import { geneStage, patContact, type GeneStage, type ShownFrame } from './helpers/gene-stage-harness';

const DEG = 180 / Math.PI;
/** Watched per action: wrists and fingers (arms), head (all), chest; and Gene's grant child of the forearm twist. */
const EXTRA = ['右手首', '左手首', '右人指１', '左人指１', '頭', '首', '上半身2', '右手捩連', '左手捩連'] as const;
const WATCH: Readonly<Record<'arms-right' | 'arms-both' | 'head' | 'bow', readonly (typeof EXTRA[number])[]>> = {
  'arms-right': ['右手首'], 'arms-both': ['右手首', '左手首'], head: ['頭'], bow: ['上半身2', '頭'],
};
const watchOf = (action: HerActionId) => {
  const spec = HER_ACTION_SPECS[action];
  if (spec.mode === 'delta') return spec.required.includes('upperBody2') ? WATCH.bow : WATCH.head;
  return spec.required.includes('armLeft') ? WATCH['arms-both'] : WATCH['arms-right'];
};
const all = (frame: ShownFrame): Quaternion[] => [...frame.world, ...frame.extra];
const maxStep = (frames: readonly ShownFrame[]) => {
  let best = 0;
  for (let i = 1; i < frames.length; i++) { const a = all(frames[i]), b = all(frames[i - 1]); for (let k = 0; k < a.length; k++) best = Math.max(best, a[k].angleTo(b[k]) * DEG); }
  return best;
};
const stepAt = (frames: readonly ShownFrame[], i: number) => { const a = all(frames[i]), b = all(frames[i - 1]); return Math.max(...a.map((q, k) => q.angleTo(b[k]) * DEG)); };

async function pair() {
  const options = { herActions: true, fps: 60, extraBones: EXTRA } as const;
  const action = await geneStage(options), idle = await geneStage(options);
  // Closed in reverse: each harness puts back the loader and globals it found.
  return { action, idle, close: () => { idle.close(); action.close(); } };
}
function lockstep(a: GeneStage, b: GeneStage, seconds: number, each?: (time: number) => void) {
  for (let i = 0, n = Math.round(seconds * a.rate); i < n; i++) { each?.(a.time()); a.tick(); b.tick(); }
}
/** Largest angle (degrees) between the two stages' shown frames over [from, to), for the named extra bones. */
function apart(a: GeneStage, b: GeneStage, from: number, to: number, bones: readonly string[]) {
  let best = 0;
  for (let i = from; i < to; i++) for (const name of bones) {
    const k = EXTRA.indexOf(name as typeof EXTRA[number]);
    best = Math.max(best, a.shown[i].extra[k].angleTo(b.shown[i].extra[k]) * DEG);
  }
  return best;
}

test('每个动作在 Gene 上: shows clearly, the display guard catches nothing, eases in and out of the live pose, and she is back in her idle after', async t => {
  const lines: string[] = [];
  const { action: h, idle, close } = await pair();
  try {
    lockstep(h, idle, 1.0);
    for (const id of HER_BODY_ACTIONS) {
      const spec = HER_ACTION_SPECS[id], seconds = herActionDurationMs(id) / 1000;
      const jumps = h.shown.at(-1)!.guardJumps, start = h.shown.length;
      const report = await h.playAction(id);
      assert.equal(report?.status, 'played', `${id}: ${JSON.stringify(report)}`);
      assert.equal(h.stage.herAction.active, true, id);
      lockstep(h, idle, seconds + 0.5);
      const end = h.shown.length, frames = h.shown.slice(start - 1, end), idleFrames = idle.shown.slice(start - 1, end);
      assert.equal(h.stage.herAction.active, false, `${id} has ended`);
      assert.equal(h.shown.at(-1)!.guardJumps, jumps, `${id}: the display guard caught ${h.shown.at(-1)!.guardJumps - jumps} jumps (${h.shown.at(-1)!.guardLast})`);
      const finish = start + Math.round(seconds * h.rate);
      const own = spec.mode === 'arms' ? [...watchOf(id), ...watchOf(id).map(name => name === '右手首' ? '右人指１' : '左人指１')] : watchOf(id);
      const peak = apart(h, idle, start, end, watchOf(id));
      // Eased in and out: in its first frames and around its end, the parts it moves are still (or again) where the idle has them.
      // (Her procedural life gives way while she performs, as for a chat gesture, and comes back on its own slow easing: the head
      // can differ from the idle stage by a degree or two there, smoothly; the guard and the step bound below catch any cut.)
      const opening = apart(h, idle, start, start + 2, own), closing = apart(h, idle, finish - 2, finish + 2, own);
      const back = apart(h, idle, end - 3, end, EXTRA);
      const first = stepAt(frames, 1), idleFirst = stepAt(idleFrames, 1), step = maxStep(frames), idleMax = maxStep(idleFrames);
      lines.push(`${id}: peak ${peak.toFixed(1)}°, max step ${step.toFixed(2)}°/frame (idle ${idleMax.toFixed(2)}), first ${first.toFixed(3)}° (idle ${idleFirst.toFixed(3)}), opening ${opening.toFixed(3)}°, closing ${closing.toFixed(3)}°, back ${back.toFixed(2)}°`);
      assert.ok(peak > (spec.mode === 'arms' ? 25 : 4), `${id} shows: ${peak.toFixed(1)}°`);
      assert.ok(opening < (spec.mode === 'arms' ? 0.5 : 1.5), `${id} eases in from the live pose: ${opening.toFixed(3)}° off the idle in its first frames`);
      assert.ok(closing < (spec.mode === 'arms' ? 1 : 2.5), `${id} eases back out: ${closing.toFixed(3)}° off the idle around its end`);
      assert.ok(back < 1.5, `${id}: back in her idle pose (${back.toFixed(2)}° from the stage that did nothing)`);
      assert.ok(step < 9, `${id}: no frame moves more than 9° (${step.toFixed(2)}°)`);
    }
  } finally { close(); }
  t.diagnostic(lines.join('\n'));
});

test('a pat in the middle: the action hands back smoothly within 0.8 s (never freezes or cuts), and the next one is refused while she is being patted', async () => {
  const { action: h, idle, close } = await pair();
  try {
    lockstep(h, idle, 0.8);
    for (const id of ['cover-face', 'bow', 'two-hand-heart'] as const) {
      const jumps = h.shown.at(-1)!.guardJumps;
      assert.equal((await h.playAction(id))?.status, 'played', id);
      lockstep(h, idle, 1.4);
      const start = h.shown.length;
      let yieldedAt = -1;
      lockstep(h, idle, 1.2, time => { h.stage.setMoodContact(patContact(time)); idle.stage.setMoodContact(patContact(time)); if (yieldedAt < 0 && !h.stage.herAction.active) yieldedAt = time; });
      assert.equal(h.stage.herAction.active, false, `${id}: handed back during the pat`);
      const frames = h.shown.slice(start - 1);
      assert.equal(h.shown.at(-1)!.guardJumps, jumps, `${id}: nothing for the guard to catch (${h.shown.at(-1)!.guardLast})`);
      assert.ok(maxStep(frames) < 9, `${id}: the hand-back moves at most 9° a frame (${maxStep(frames).toFixed(2)}°)`);
      // The next action while the hand is on her head: refused, and it says why.
      const refused = await h.playAction('nod');
      assert.equal(refused?.status, 'busy'); assert.match(refused!.detail, /摸她/u);
      lockstep(h, idle, 1.0, () => { h.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0 }); idle.stage.setMoodContact({ ...patContact(0), contact: false, hover: 0 }); });
      assert.ok(apart(h, idle, h.shown.length - 3, h.shown.length, EXTRA) < 1.5, `${id}: back with the idle stage after the pat`);
    }
  } finally { close(); }
});

test('哈欠捂嘴: the hand comes with her usual P1 yawn on the same clock (mouth, lids, chin); the other actions start no yawn', async () => {
  const h = await geneStage({ herActions: true, fps: 60 });
  try {
    h.run(0.8);
    assert.equal((await h.playAction('eat-mime'))?.status, 'played');
    h.run(0.5);
    assert.notEqual(h.stage.poseReaction?.getState().playing?.kind, 'yawn', 'pretending to eat is the hand only');
    h.run(HER_ACTION_SPECS['eat-mime'].durationFrames / 30);
    const jumps = h.shown.at(-1)!.guardJumps;
    assert.equal((await h.playAction('cover-yawn'))?.status, 'played');
    h.run(0.5);
    const reaction = h.stage.poseReaction.getState();
    assert.equal(reaction.playing?.kind, 'yawn', JSON.stringify(reaction));
    assert.equal(h.stage.herAction.active, true);
    h.run(HER_ACTION_SPECS['cover-yawn'].durationFrames / 30 + 0.3);
    assert.equal(h.stage.herAction.active, false);
    assert.equal(h.stage.poseReaction.getState().playing, null, 'the yawn ended with the hand');
    assert.equal(h.shown.at(-1)!.guardJumps, jumps, `hand and yawn together: nothing for the guard (${h.shown.at(-1)!.guardLast})`);
  } finally { h.close(); }
});

test('the lowest frame rate (24 fps, frames landing on a 60 Hz screen with jitter): the quick head actions leave the guard nothing either', async t => {
  // Pretrial 2026-11-04: the authored shake's reversals (about 40 rad/s² at the head) were caught on a late 24 fps frame in a real
  // window (4.3° and 4.9°); it now plays at rate 0.8 and strength 0.75 (shared/her-actions.ts). Reproduced here before the change.
  for (const [refreshHz, jitterMs] of [[undefined, 8], [60, 8]] as const) {
    const h = await geneStage({ herActions: true, fps: 24, refreshHz, jitterMs });
    try {
      h.run(1);
      for (let k = 0; k < 9; k++) {
        const id = (['shake', 'nod', 'tilt'] as const)[k % 3], before = h.shown.at(-1)!.guardJumps;
        assert.equal((await h.playAction(id))?.status, 'played');
        h.run(herActionDurationMs(id) / 1000 + 0.4);
        assert.equal(h.shown.at(-1)!.guardJumps, before, `${id} #${k} at 24 fps (refresh ${refreshHz ?? 'none'}): ${h.shown.at(-1)!.guardLast}`);
      }
    } finally { h.close(); }
  }
  t.diagnostic('shake, nod and tilt three times each, twice: nothing caught');
});

test('鼓掌 (batch 009 revision): opens wide and claps three times, the third after the old 3.2 s end, and plays to its new end at 5.43 s', async t => {
  // Codex T-211 batch 009: near at f56–57, f83–84, f110–111, open again at f123, back at the Stand at f163. The old spec length
  // (96 frames) would not even bind these tracks (they run past it), so the length in the table is load-bearing.
  const h = await geneStage({ herActions: true, fps: 60 });
  try {
    const palm = (side: '右' | '左') => ['手首', '人指１', '中指１', '薬指１', '小指１'].map(name => h.mesh.skeleton.getBoneByName(`${side}${name}`)!);
    const right = palm('右'), left = palm('左');
    assert.ok([...right, ...left].every(Boolean), 'Gene has the palm bones');
    const centre = (bones: readonly Bone[]) => bones.reduce((sum, bone) => sum.add(bone.getWorldPosition(new Vector3())), new Vector3()).divideScalar(bones.length);
    h.run(0.8);
    const jumps = h.shown.at(-1)!.guardJumps;
    const restDistance = centre(right).distanceTo(centre(left));
    assert.equal((await h.playAction('clap'))?.status, 'played');
    const state = h.stage.herAction.getState();
    assert.ok(Math.abs(state.durationMs - 163 / 30 * 1000) < 1, `plays for 163 frames: ${state.durationMs} ms`);
    assert.equal(state.trackNames.length, 38, 'both arms and all fingers bound');
    const clip: AnimationClip = await h.stage.herActionClips.get(`${h.stage.modelGeneration}:${HER_ACTION_SPECS.clap.sha256}`);
    assert.deepEqual(new HerActionPlayer(h.mesh).bindable(clip, 96 / 30), [], 'with the old 96-frame length nothing would bind');
    const samples: { t: number; d: number; active: boolean }[] = [];
    for (let i = 1, n = Math.round(6.2 * h.rate); i <= n; i++) {
      h.tick();
      samples.push({ t: i / h.rate, d: centre(right).distanceTo(centre(left)), active: h.stage.herAction.active });
    }
    const during = samples.filter(sample => sample.active);
    const open = Math.max(...during.map(sample => sample.d)), near = Math.min(...during.map(sample => sample.d));
    // Hysteresis: a clap is a dip into the lowest quarter of the swing with the hands wide open (top quarter) before and after it.
    // (Gene's Stand holds the hands close in front, so the start and the end are low too; they are not claps.)
    const low = near + (open - near) * 0.25, high = near + (open - near) * 0.75;
    const claps: number[] = [];
    let opened = false, dip: { t: number; d: number } | null = null;
    for (const sample of during) {
      if (sample.d > high) { if (dip) claps.push(dip.t); dip = null; opened = true; }
      else if (sample.d < low && opened && (!dip || sample.d < dip.d)) dip = { t: sample.t, d: sample.d };
    }
    const lastActive = during.at(-1)!.t;
    t.diagnostic(`palm-centre distance: rest ${restDistance.toFixed(3)}, open ${open.toFixed(3)}, near ${near.toFixed(3)} (swing ${(open - near).toFixed(3)}); claps at ${claps.map(time => time.toFixed(2)).join(', ')} s; active until ${lastActive.toFixed(2)} s`);
    assert.equal(claps.length, 3, `three claps: ${claps.map(time => time.toFixed(2)).join(', ')}`);
    for (const [k, frame] of [56.5, 83.5, 110.5].entries())
      assert.ok(Math.abs(claps[k] - frame / 30) < 0.1, `clap ${k + 1} near f${frame}: ${claps[k].toFixed(3)} s`);
    assert.ok(claps[2] > 96 / 30 + 0.3, 'the third clap comes after the old end');
    assert.ok(open - near > 1.5, `a wide swing (Codex: 2.466 open, 0.661 near): ${(open - near).toFixed(3)}`);
    // Open again after the third clap (f123), then the way back to the idle (f163): it still shows then.
    const at = (time: number) => samples.reduce((best, sample) => Math.abs(sample.t - time) < Math.abs(best.t - time) ? sample : best);
    assert.ok(at(123 / 30).d > high, `open again at f123: ${at(123 / 30).d.toFixed(3)}`);
    assert.equal(at(5.3).active, true, 'still playing at 5.3 s (the old length ended at 3.2 s)');
    assert.ok(Math.abs(lastActive - 163 / 30) < 0.05, `ends at its new end: ${lastActive.toFixed(3)} s`);
    assert.ok(Math.abs(samples.at(-1)!.d - restDistance) < 0.05, `the hands are back where they were (${samples.at(-1)!.d.toFixed(3)} vs ${restDistance.toFixed(3)})`);
    assert.equal(h.shown.at(-1)!.guardJumps, jumps, `nothing for the guard to catch (${h.shown.at(-1)!.guardLast})`);
  } finally { h.close(); }
});

test('one at a time: a second action while one shows is refused (busy), not queued and not cut in', async () => {
  const { action: h, idle, close } = await pair();
  try {
    lockstep(h, idle, 0.5);
    assert.equal((await h.playAction('hello-wave'))?.status, 'played');
    lockstep(h, idle, 0.6);
    const second = await h.playAction('cheer');
    assert.equal(second?.status, 'busy'); assert.match(second!.detail, /上一个动作/u);
    assert.equal(h.stage.herAction.getState().id?.startsWith('act'), true);
    lockstep(h, idle, HER_ACTION_SPECS['hello-wave'].durationFrames / 30);
    assert.equal(h.stage.herAction.active, false);
    // An expired or unknown cue does nothing at all.
    await h.stage.playHerAction({ id: 'late', action: 'nod', at: Date.now() - 20_000, expiresAt: Date.now() - 12_000 });
    await h.stage.playHerAction({ id: 'odd', action: 'dance', at: Date.now(), expiresAt: Date.now() + 1_000 });
    assert.equal(h.stage.herAction.active, false);
  } finally { close(); }
});

test('X-321 follow-up: a body action still loading when the conversation or character changes never starts in the new one; a mood update in the same conversation keeps it', async t => {
  const lines: string[] = [];
  type Path = 'setMood token' | 'setMood character' | 'setMood away and back' | 'same conversation';
  const paths: Path[] = ['setMood token', 'setMood character', 'setMood away and back', 'same conversation'];
  for (const where of ['resolver', 'vmd'] as const) for (const path of paths) {
    const h = await geneStage({ herActions: true, fps: 60 });
    const desktop = (globalThis as { window: { desktop: { resolveHerAction(id: string): Promise<unknown> } } }).window.desktop, resolve = desktop.resolveHerAction;
    const loader = MMDLoader.prototype as unknown as { loadVMD(...args: unknown[]): void }, loadVMD = loader.loadVMD;
    let release!: () => void, reached = false;
    const gate = new Promise<void>(done => { release = done; });
    if (where === 'resolver') desktop.resolveHerAction = async id => { reached = true; await gate; return resolve(id); };
    else loader.loadVMD = function (this: unknown, ...args: unknown[]) { reached = true; void gate.then(() => loadVMD.apply(this, args)); };
    try {
      h.run(0.5);
      const pending = h.playAction('nod');
      for (let i = 0; i < 100 && !reached; i++) await new Promise(done => setTimeout(done, 0));
      assert.ok(reached, `${where}: the cue is waiting there`);
      const view = h.stage.moodView;
      h.stage.setMood({ ...view, revision: view.revision + 1, ...(path === 'setMood character' ? { characterId: 'another' }
        : path === 'same conversation' ? {} : { token: 'gene_token_next' }) });
      if (path === 'setMood away and back') h.stage.setMood({ ...view, revision: view.revision + 2 });
      release();
      const report = await pending;
      h.run(0.2);
      lines.push(`${where} / ${path}: ${report?.status ?? 'no start (stale)'}, playing ${h.stage.herAction.active}`);
      if (path === 'same conversation') {
        assert.equal(report?.status, 'played', `${where}: a mood update in the same conversation does not drop it`);
        assert.equal(h.stage.herAction.active, true);
      } else {
        assert.equal(report, undefined, `${where} / ${path}: the old conversation's cue does not start (${JSON.stringify(report)})`);
        assert.equal(h.stage.herAction.active, false, `${where} / ${path}: nothing plays in the new conversation`);
        loader.loadVMD = loadVMD; desktop.resolveHerAction = resolve;
        assert.equal((await h.playAction('nod'))?.status, 'played', `${where} / ${path}: a new cue plays`);
      }
    } finally { loader.loadVMD = loadVMD; desktop.resolveHerAction = resolve; h.close(); }
  }
  t.diagnostic(lines.join('\n'));
});
