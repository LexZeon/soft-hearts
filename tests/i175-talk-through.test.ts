/**
 * I-175 step 2 (docs/claude/2026-11-22-i175-part-mixer.md): the mouth while she reads aloud, on the Unbound engine (the companion window and
 * full-screen share the figure, the mouth and window-motions.ts).
 *  - Each bundled model's real morph names (One: the standard face a VRM gets; Mumi: the converted VRoid face; Gene: gene.pmx): the flap finds
 *    its vowels, a pout leans it to う (お where there is no う), a smile to い (え).
 *  - The real Gene window frame loop, streamed reading (on 250 ms / off 100 ms) with a pout asked mid-reading: the pucker shows while she
 *    reads, the mouth keeps moving (opening > 0, at most 0.6× the flap without the pout), on う. 60 and 30 fps.
 *  - Her face actions through window-motions.ts on the real Gene with the real VMD bytes: a pout asked while she reads goes to her face (talks
 *    through); a cheek puff asked while she reads never starts while the held flag is on, starts after the reading; a cancelled reply never
 *    plays its waiting puff. 60 and 30 fps.
 * I175_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig, NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { vowelIndices, SpeechOwner } from '../src/unbound/mouth';
import { SpeechBeatsView } from '../src/brain/speech-beats-view';
import { WindowStageFace, noteShown } from '../src/unbound/window-mode/window-stage-face';
import { ShownSentence } from '../shared/behaviors/part-mix/closed-mouth';
import { HerOut } from '../src/unbound/her/out-page';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { talkThroughMouth } from '../shared/behaviors/part-mix/mouth';
import { MOUTH_TALK_THROUGH, PART_MIX_KNOBS } from '../shared/behaviors/part-mix/knobs';
const ALL_OPEN = { a: 1, i: 1, u: 1, e: 1, o: 1 };
import { STAGE_MORPH_NAMES } from '../electron/stage/model-import/vrm/mapping';
import { standardMorphSpec } from '../src/unbound/model/standard-skeleton';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import type { WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { HER_ACTION_CUE_MS, HER_ACTION_DETAILS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome } from '../shared/actions/her-actions';
import type { BodyMotionPlan } from '../shared/actions';
import { windowGene } from './helpers/unbound-window';
import { faceView } from './helpers/window-face-fixture';
import { settledVmdBytes } from './helpers/settled-vmd';
import type { Vowel } from '../shared/behaviors/part-mix/interface';
import { catalogMotionFile } from './helpers/frame-stats';

const REPORT = process.env.I175_REPORT === '1';
/** Streamed reading's raw flag: on 250 ms, off 100 ms, from `from` for `long` seconds. */
const reading = (t: number, from: number, long: number) => t >= from && t < from + long && ((t - from) * 1000) % 350 < 250;

// ---- the three bundled models' names ------------------------------------------------------------------------------------------
test('the flap finds its vowels and leans with the base on One, Mumi and Gene\'s own morph names', async () => {
  const g = await windowGene();
  const gene = g.fixture.mesh.morphTargetDictionary!;
  g.close();
  // One (a VRoid VRM): the standard face the engine drives, with the slots her VRM has (vowels, blinks, the spelled pucker, じと目).
  const oneSlots = new Set(['a', 'i', 'u', 'e', 'o', 'blink', 'blinkLeft', 'blinkRight', 'mouthPucker', 'jitome']);
  const one = Object.fromEntries(standardMorphSpec(slot => oneSlots.has(slot)).map((m, i) => [m.name, i]));
  // Mumi (a VRoid face converted to PMX): the stage names the converter writes, beside the source's own Fcl_ targets.
  const mumi = Object.fromEntries([...STAGE_MORPH_NAMES, 'Fcl_MTH_A', 'Fcl_MTH_U', 'Fcl_MTH_Small'].map((name, i) => [name, i]));
  const pout = { pucker: 1, smile: 0, strength: 1 }, smile = { pucker: 0, smile: 1, strength: 1 };
  const rows: string[] = [];
  for (const [name, dictionary] of [['One', one], ['Mumi', mumi], ['Gene', gene]] as const) {
    const vowels = vowelIndices(dictionary);
    for (const v of ['a', 'i', 'u', 'e', 'o'] as Vowel[]) assert.ok(vowels[v] >= 0, `${name} has ${v}`);
    const has = (v: Vowel) => vowels[v] >= 0;
    // The lean rules alone (every vowel parting the lips like あ: the 2026-11-22 floor never needed; it is in mouth-shut-while-talking.test.ts).
    assert.equal(talkThroughMouth(pout, has, PART_MIX_KNOBS, ALL_OPEN).vowels.u, 1, `${name}: a pout flaps on う`);
    assert.ok(Math.abs(talkThroughMouth(smile, has, PART_MIX_KNOBS, ALL_OPEN).vowels.i - PART_MIX_KNOBS.smileVowelMax) < 1e-9, `${name}: a smile leans a little to い (2026-11-22: a blend, mostly あ)`);
    rows.push(`${name} vowels ${JSON.stringify(vowels)}`);
  }
  assert.ok(gene.mouthPucker !== undefined && gene.cheekPuff !== undefined, 'gene.pmx has its own mouthPucker and cheekPuff');
  // A model without う: the pout's share goes to お; without either, to あ.
  const noU = vowelIndices({ あ: 0, い: 1, え: 2, お: 3 });
  assert.equal(talkThroughMouth(pout, v => noU[v] >= 0, PART_MIX_KNOBS, ALL_OPEN).vowels.o, 1);
  if (REPORT) console.log(rows.join('\n'));
});

// ---- the real Gene window frame loop: a pout mid-reading -------------------------------------------------------------------------
async function poutRun(fps: number, pout: boolean) {
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null }));
  g.body.bindFace(slotBindings(rig, face.blushMorph()));
  const dict = mesh.morphTargetDictionary!, inf = mesh.morphTargetInfluences!, vowels = vowelIndices(dict);
  const rows: { t: number; held: boolean; pucker: number; open: number; scale: number; u: number; a: number; shares: Record<Vowel, number> }[] = [];
  let shown = false;
  try {
    for (let k = 0; k <= Math.round(fps * 7); k++) {
      const t = k / fps, dt = k ? 1 / fps : 0, raw = reading(t, 1, 4);
      g.body.setSpeaking(raw);
      if (pout && t >= 2 && !shown) { shown = true; assert.equal(face.show('pout', { holdS: 2.4, onset: 'quick' }).ok, true); }
      const f = face.frame(dt, { shown: true, adjusting: false, voiced: g.body.mouth?.voiced === true, speaking: raw });
      g.body.frame(dt, { pointer: { x: 0, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: f });
      const m = g.body.mouth!;
      rows.push({ t, held: m.voiced, pucker: inf[dict.mouthPucker] ?? 0, open: m.shownOpen, scale: m.talkScale, u: inf[vowels.u] ?? 0, a: inf[vowels.a] ?? 0, shares: { ...m.vowelShares } });
    }
  } finally { g.close(); }
  return rows;
}

for (const fps of [60, 30]) {
  test(`Gene window, ${fps} fps: a pout asked mid-reading shows while she reads, the mouth keeps moving on う at ≤ 0.6× the flap`, async () => {
    const plain = await poutRun(fps, false), pouted = await poutRun(fps, true);
    const during = (rows: typeof plain) => rows.filter(r => r.t >= 2.6 && r.t <= 4.2);
    const p = during(pouted), q = during(plain);
    const pucker = Math.max(...p.map(r => r.pucker));
    assert.ok(pucker > 0.3, `the pucker shows while she reads (${pucker.toFixed(3)}; before I-175 it stepped aside to 0)`);
    const opens = p.filter(r => r.held).map(r => r.open);
    assert.ok(opens.length > 10 && Math.min(...opens) > 0, 'the mouth never stops while she reads');
    assert.ok(Math.max(...opens) - Math.min(...opens) > 0.05, `the mouth moves (${Math.min(...opens).toFixed(3)}..${Math.max(...opens).toFixed(3)})`);
    const flapPeak = Math.max(...q.map(r => r.open)), poutPeak = Math.max(...opens);
    assert.ok(poutPeak <= MOUTH_TALK_THROUGH * flapPeak + 0.02, `at most 0.6× the flap without the pout (${poutPeak.toFixed(3)} vs ${flapPeak.toFixed(3)})`);
    const settled = p.filter(r => r.t >= 3 && r.held);
    assert.ok(settled.every(r => Math.abs(r.scale - MOUTH_TALK_THROUGH) < 1e-6), 'under the full pout the amplitude is exactly the knob');
    assert.ok(settled.every(r => r.shares.u >= r.shares.a), 'the flap opens う (the pout\'s vowel), not あ');
    assert.ok(Math.max(...settled.map(r => r.u)) > 0.1, 'Gene\'s う moves');
    // Eased: no morph jumps (the opening hands over to the pout's base and back).
    const step = (key: 'pucker' | 'u' | 'a') => Math.max(...pouted.slice(1).map((r, i) => Math.abs(r[key] - pouted[i][key])));
    for (const key of ['pucker'] as const) assert.ok(step(key) < (fps === 60 ? 0.08 : 0.16), `${key} eases: largest step ${step(key).toFixed(3)}`);
    // Without the pout: the flap is as before (あ at full amplitude).
    assert.ok(q.filter(r => r.held).every(r => r.scale === 1 && r.shares.u === 0), 'no base: the flap is the old one');
    const line = `${fps} fps: pucker while reading ${pucker.toFixed(3)}; opening ${Math.min(...opens).toFixed(3)}..${poutPeak.toFixed(3)} vs plain flap peak ${flapPeak.toFixed(3)} (×${(poutPeak / flapPeak).toFixed(2)}); pucker largest step ${step('pucker').toFixed(3)}`;
    console.log(line);
  });
}

// ---- her face actions through window-motions.ts (the real VMD bytes) -----------------------------------------------------------
async function actionRun(fps: number, script: { action: HerActionId; at: number; cancelAt?: number; readAloud?: boolean; openUntil?: number }) {
  const bytes = settledVmdBytes(url => { const m = /^mmd-asset:\/\/d{32}\/(.+)\.vmd$/.exec(url); return m ? catalogMotionFile(HER_ACTION_PACK, m[1]) : new URL(url); }, { delayMs: 15 });
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  let clock = 1_000_000;
  const now = () => clock, outcomes: HerActionOutcome[] = [], cues = new Map<string, HerActionCue>(), shownFaces: string[] = [];
  const host: WindowStageHost = {
    isBehaviorModelSupported: async () => true, resolveChatGesture: async () => { throw Error('none'); },
    resolveHerAction: async cueId => { const live = cues.get(cueId)!; return { cueId, action: live.action, packId: HER_ACTION_PACK, motionId: live.action,
      sha256: HER_ACTION_SPECS[live.action].sha256, durationMs: HER_ACTION_SPECS[live.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${live.action}.vmd` }; },
    reportHerAction: async outcome => { outcomes.push(outcome); },
    getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan,
    resolveBehaviorBody: async () => { throw Error('none'); }, resolveBehaviorMotion: async () => { throw Error('none'); }, resolveHerLifeMotion: async () => { throw Error('none'); },
  };
  const owner = new SpeechOwner(), view = faceView({ primary: 'calm', companion: null });
  const env: WindowMotionEnv = { shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false, hover: false, pinch: false,
    pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false, view, blocks: NO_MOTION_BLOCKS, showing: false,
    reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false };
  const motions = new WindowMotions(host, () => env, now);
  motions.mouth.talkingFace = (name, holdS) => { shownFaces.push(`${name}:${holdS.toFixed(2)}`); return true; };
  motions.attach({ figure: g.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile, standard: false });
  motions.setMood(view);
  const puff = mesh.morphTargetDictionary!.cheekPuff, log: { t: number; held: boolean; active: boolean; puff: number }[] = [];
  try {
    for (let k = 0; k <= Math.round(fps * 9); k++) {
      const t = k / fps, dt = k ? 1 / fps : 0;
      clock += dt * 1000;
      const raw = script.readAloud === false ? false : reading(t, 1, 4);
      owner.note(raw);
      env.speaking = owner.speaking(owner.frame(dt, raw));
      if (script.openUntil !== undefined) env.sentenceOpen = t < script.openUntil; // read-aloud off: the bubble is mid-sentence until then
      if (Math.abs(t - script.at) < 0.5 / fps) {
        const cue: HerActionCue = { id: `i175${script.action.replace(/[^a-z]/g, '')}${k}`, action: script.action, at: now(), expiresAt: now() + HER_ACTION_CUE_MS };
        cues.set(cue.id, cue); void motions.playHerAction(cue);
      }
      if (script.cancelAt !== undefined && Math.abs(t - script.cancelAt) < 0.5 / fps) motions.dropWaitingMouth();
      motions.frame();
      g.frame(dt);
      motions.afterBody(dt);
      log.push({ t, held: env.speaking, active: motions.faceActive, puff: mesh.morphTargetInfluences![puff] ?? 0 });
      await bytes.settle();
    }
  } finally { bytes.restore(); motions.dispose(); g.close(); }
  return { log, outcomes, shownFaces };
}

for (const fps of [60, 30]) {
  test(`Gene window motions, ${fps} fps: a pout asked while she reads talks through; a cheek puff waits for the end of the reading; a cancel drops it`, async () => {
    const pout = await actionRun(fps, { action: 'pout', at: 2 });
    assert.deepEqual(pout.outcomes.map(o => o.status), ['played'], 'the pout plays while she reads (before: busy 她正在说话)');
    assert.equal(pout.shownFaces.length, 1, 'it went to her face (the base shape), not the face exclusive');
    assert.ok(pout.log.every(r => !r.active), 'the face exclusive (which would freeze lip-sync) never takes the mouth');

    const puff = await actionRun(fps, { action: 'cheek-puff', at: 2 });
    assert.deepEqual(puff.outcomes.map(o => [o.status, o.detail]), [['played', HER_ACTION_DETAILS.queued]], 'accepted, waiting for the pause');
    assert.ok(puff.log.every(r => !(r.active && r.held)), 'never starts while the held "she is speaking" is on');
    const started = puff.log.find(r => r.active);
    assert.ok(started && started.t >= 5 && started.t < 5.6, `starts right after the reading (${started?.t.toFixed(3)} s; the reading ends at 5 s, the hold 0.4 s)`);
    assert.ok(Math.max(...puff.log.map(r => r.puff)) > 0.3, 'her cheeks puff');

    const cancelled = await actionRun(fps, { action: 'cheek-puff', at: 2, cancelAt: 3.5 });
    assert.ok(cancelled.log.every(r => !r.active), 'a cancelled reply never plays its waiting puff');
    console.log(`${fps} fps: puff starts at ${started!.t.toFixed(3)} s (reading ends 5.0 s); held-and-active frames ${puff.log.filter(r => r.active && r.held).length}; cancelled: active frames ${cancelled.log.filter(r => r.active).length}`);
  });
}

// C336 input 1 (Codex T-258 C01): read-aloud off, the bubble mid-sentence, a cheek puff asked while the mouth is idle never starts before the sentence ends.
for (const fps of [60, 30]) {
  test(`read-aloud off, ${fps} fps: a cheek puff asked mid-sentence waits for the sentence to end (not started at once)`, async () => {
    const run = await actionRun(fps, { action: 'cheek-puff', at: 2, readAloud: false, openUntil: 5 });
    assert.deepEqual(run.outcomes.map(o => [o.status, o.detail]), [['played', HER_ACTION_DETAILS.queued]], 'accepted, waiting for the sentence end');
    const started = run.log.find(r => r.active);
    assert.ok(started && started.t >= 5 && started.t < 5.2, `starts at the sentence end (${started?.t.toFixed(3)} s; the sentence ends at 5 s)`);
    const idle = await actionRun(fps, { action: 'cheek-puff', at: 2, readAloud: false });
    assert.deepEqual(idle.outcomes.map(o => [o.status, o.detail]), [['played', '']], 'a finished sentence: plays at once, as before');
    assert.ok(idle.log.find(r => r.active)!.t < 2.3);
  });
}

// ---- the wiring: who says "cancelled", and full-screen ----------------------------------------------------------------------------
test('the companion window: stop and a new reply say cancelled / new, the end of her speaking says ended; the stage drops waiting shapes only for the first two', () => {
  const reasons: string[] = [];
  let now = 0;
  const view = new SpeechBeatsView({ now: () => now, setTimer: () => 1, clearTimer: () => {}, perform: () => {}, release: reason => { reasons.push(reason); }, pacing: () => 'shown' });
  view.begin('r1');
  view.cancel();
  view.begin('r2'); view.shown('r2', '好。', '好。'); view.done('r2', 2); now = 10_000; view.shown('r2', '好。', '好。');
  assert.deepEqual(reasons, ['new', 'cancelled', 'new', 'ended']);
  // The window stage: cancelled / new drop the waiting mouth shapes; ended does not (a puff waiting for the end of the reading still plays).
  const dropped: string[] = [], released: string[] = [];
  const fake = { motions: { dropWaitingMouth: () => dropped.push('drop') }, face: { speechBeatsRelease: () => released.push('release') }, mouthLog: { release() {} } };
  for (const reason of ['ended', 'cancelled', 'new'] as const) (WindowStageFace.prototype.speechBeatsRelease as (this: unknown, r: string) => void).call(fake, reason);
  assert.deepEqual(dropped, ['drop', 'drop'], 'only a cancelled or a new reply drops them');
  assert.deepEqual(released, ['release', 'release', 'release']);
});

test('read-aloud off: the bubble\'s own cue tells whether a sentence is still being shown (a closed-mouth shape waits for its end)', () => {
  const watch = new ShownSentence();
  noteShown(watch, { kind: 'start', key: 'r#shown', text: '今天起得好', voiced: false }, 10);
  assert.equal(watch.open(10.2), true, 'mid-sentence');
  noteShown(watch, { kind: 'start', key: 'r#shown', text: '今天起得好早。', voiced: false }, 10.3);
  assert.equal(watch.open(10.4), false, 'the sentence is shown');
  noteShown(watch, { kind: 'start', key: 'r#shown', text: '今天起得好早。昨晚', voiced: false }, 10.5);
  assert.equal(watch.open(12.5), false, 'no new text for 1.5 s: over (a last sentence without a full stop)');
  noteShown(watch, { kind: 'start', key: 'r#0', text: '读到这里', voiced: true }, 13);
  assert.equal(watch.open(13), false, 'a voiced segment is not the bubble');
});

test('full-screen shares it: her pout goes to her face, the bubble\'s sentence reaches her motions, a new or failed reply drops waiting shapes', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  assert.equal(typeof her.motions.motions.mouth.talkingFace, 'function', 'a pout while she speaks has her face to go to');
  const inner = { sense: null, intentIdle: null, setPoseTargets() {} } as never;
  her.shown({ id: 'r', rev: 1, text: '今天起得好', visible: true }, false);
  her.frame(1 / 60, inner, { shown: true, adjusting: false, voiced: false, speaking: false, walking: false, breath: 0.5, pointer: null });
  assert.equal(her.motions.motions['env']().sentenceOpen, true, 'mid-sentence reaches her motion gates');
  let drops = 0;
  const original = her.motions.motions.dropWaitingMouth.bind(her.motions.motions);
  her.motions.motions.dropWaitingMouth = () => { drops++; original(); };
  const beats = new UnboundSpeechBeats(new ProceduralGenerator(), () => her.dropWaitingMouth());
  beats.receive({ id: 'a', type: 'delta', text: '嗯' } as never);
  beats.receive({ id: 'a', type: 'error', text: '' } as never);
  beats.receive({ id: 'b', type: 'delta', text: '好' } as never);
  assert.equal(drops, 3, 'reply a began (new), failed (cancelled), reply b began (new)');
});
