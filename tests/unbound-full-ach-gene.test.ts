/**
 * Batches C and H of full-screen Unbound (docs/claude/2026-11-21-unbound-full-ACH.md) on the bundled public Gene, in the page's own frame order
 * (owners → her face over them → her motions' gates → the idle layer → her frame → her mouth → a face shape of hers), at 60 and 30 fps.
 *
 * C, one 17 s scene: a chat gesture standing; a walk across with a wave started as she goes (her clips use her upper body only while she
 * walks); the wave goes on after she stops; an automatic body motion standing, then a walk home that hands it back (never a cut), with a nod
 * on the way. Measured per frame against the same run without her motions: the TRACKED bones' step and unexpected step (R29c) per segment,
 * her hips and legs while she walks (the same as without the clips), how far she walked, and her answers.
 * H: the same frame loop with her procedural life loaded or not, standing, under an owner's small move and while she walks: it stacks.
 * FULL_ACH_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { UnboundFigure } from '../src/unbound/figure';
import { UnboundMouth } from '../src/unbound/mouth';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { REST_TARGETS, type PoseTargets } from '../src/unbound/motion/generator';
import { HerOutFace } from '../src/unbound/her/out-face';
import { HerOutMotions, type HerMotionApi } from '../src/unbound/her/out-motions';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { loadLivelinessForEngine } from '../src/stage';
import catalog from '../shared/actions/motion-catalog.json';
import { BEHAVIOR_RECIPES, BODY_START_AGE_MS, type BodyMotionCue, type BodyMotionPlan } from '../shared/actions';
import { HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome } from '../shared/actions/her-actions';
import type { MoodView } from '../shared/mood';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { standClip, TRACKED, max } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { faceView } from './helpers/window-face-fixture';
import { settledVmdBytes } from './helpers/settled-vmd';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { windowVrm } from './helpers/unbound-vrm';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { catalogMotionFile } from './helpers/frame-stats';

const REPORT = process.env.FULL_ACH_REPORT === '1';
const DEG = 180 / Math.PI;
const HOME = { xM: 0, depthM: 3 };
/** Her hips and legs, the bones her gait owns while she walks. */
/** TRACKED's upper body (センター to the elbows): her clips' part, measured apart from her gait while she walks. */
const UPPER = 11;
const GAIT = ['下半身', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'];
const say = (line: string) => { if (REPORT) console.log(line); else console.log(line.slice(0, 400)); };

interface Scene { view: MoodView; play(action: HerActionId): void; place(x: number | null): void; own(move: Partial<PoseTargets> | null): void; now(): number; motions: HerOutMotions | null }

async function run(fps: number, seconds: number, opts: { motions: boolean; life: boolean }, script: (t: number, s: Scene) => void) {
  const bytes = settledVmdBytes(url => {
    const match = /^mmd-asset:\/\/([abd])[abd]{31}\/(.+)\.vmd$/.exec(url), pack = match ? { a: BEHAVIOR_RECIPES['idle.neutral'].packId, b: 'genea-2022-gestures', d: HER_ACTION_PACK }[match[1] as 'a' | 'b' | 'd'] : '';
    return match ? catalogMotionFile(pack, match[2]) : new URL(url);
  }, { delayMs: 10 });
  const fixture = await loadPublicGeneForTargets(), mesh = fixture.mesh;
  const measured = measureWindowModel(mesh, null, true);
  const figure = new UnboundFigure(mesh, HOME);
  figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
  figure.setBreath(0.5);
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idleLayer = new UnboundIdleLayer(async heightM => createBundledIdle(heightM, shipped, 11));
  idleLayer.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  const mouth = UnboundMouth.forMesh(mesh);
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const face = new HerOutFace(random);
  if (opts.life) face.loadLife(await loadLivelinessForEngine());
  face.attach({ body: figure, mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
  let clock = 1_000_000;
  const now = () => clock, outcomes: HerActionOutcome[] = [], cues = new Map<string, HerActionCue>();
  let listener: ((cue: unknown) => void) | null = null;
  const s: Scene = { view: faceView({ primary: 'happy', companion: 'comfortable' }), now, motions: null, play: () => {}, place: () => {}, own: () => {} };
  const api: HerMotionApi = {
    resolveChatGesture: async cueId => {
      const entry = catalog.packs.find(p => p.id === 'genea-2022-gestures')!.motions.find(m => m.id === 'speaking-gesture-2')!;
      return { cueId, intent: 'explain', packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2', sha256: entry.sha256, durationMs: entry.durationFrames / 30 * 1000,
        url: `mmd-asset://${'b'.repeat(32)}/speaking-gesture-2.vmd` };
    },
    resolveHerAction: async cueId => {
      const live = cues.get(cueId)!;
      return { cueId, action: live.action, packId: HER_ACTION_PACK, motionId: live.action, sha256: HER_ACTION_SPECS[live.action].sha256,
        durationMs: HER_ACTION_SPECS[live.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${live.action}.vmd` };
    },
    reportHerAction: async outcome => { outcomes.push(outcome); },
    bodyPlan: async () => s.view.body ?? ({ mode: 'closed', reason: 'normal-pool-closed', cue: null } as BodyMotionPlan),
    resolveBody: async cueId => {
      const recipe = BEHAVIOR_RECIPES['idle.neutral'];
      return { cueId, recipeId: 'idle.neutral', packId: recipe.packId, motionId: recipe.motionId, sha256: recipe.sha256, maskId: recipe.mask, durationMs: recipe.durationMs,
        url: `mmd-asset://${'a'.repeat(32)}/${recipe.motionId}.vmd` } as never;
    },
    resolveBehaviorMotion: async () => { throw Error('none'); },
    onHerAction: callback => { listener = callback; return () => {}; },
  };
  const motions = opts.motions ? new HerOutMotions(api, now) : null;
  s.motions = motions;
  motions?.attach({ figure, mesh, reviewed: true, retarget: null, transform: undefined, profile: measured.profile, standard: null });
  motions?.setClips({ pose: null, gesture: null }, true, { face: false, mouth: false, head: false });
  let goal: number | null = null, move: Partial<PoseTargets> | null = null, lastKey = '';
  s.place = x => { goal = x; };
  s.own = value => { move = value; }; // an owner's small move (her life's), H
  s.play = action => { const cue: HerActionCue = { id: `full-${action}-${Math.round(clock)}`, action, at: now(), expiresAt: now() + HER_ACTION_CUE_MS }; cues.set(cue.id, cue); listener?.(cue); };
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const gait = GAIT.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: { t: number; rotations: Quaternion[]; gait: Quaternion[]; x: number; walking: boolean; chat: boolean; action: boolean; body: boolean; bridge: boolean; mask: number }[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      clock += dt * 1000;
      script(t, s);
      const owners = face.wrap(idleLayer.wrap(figure));
      const key = JSON.stringify([goal, move]);
      if (key !== lastKey) { lastKey = key; owners.setPoseTargets({ ...REST_TARGETS, ...(move ?? {}), ...(goal === null ? {} : { place: { x: goal, z: -HOME.depthM } }) } as PoseTargets); }
      face.setMood(s.view); motions?.setMood(s.view);
      // The page's order (src/unbound/main.ts → her/out-page.ts frame): her motions' gates, her face over the owners, the idle, her frame, her mouth, a face shape.
      const card = face.face.capabilities();
      motions?.frame({ shown: true, adjusting: false, pulled: false, walking: figure.walking, contact: face.contact, speaking: false, preparing: false,
        thinking: false, lidsHeld: face.lids, blink: face.naturalBlink, mouthOff: card?.mouth?.choice === 'off', eyesOff: card?.closeEyes?.choice === 'off' });
      const faced = face.frame(dt, idleLayer.wrap(figure), { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking, nowMs: clock });
      idleLayer.frame(dt, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }));
      mouth?.restore();
      figure.frame(dt);
      mouth?.apply(dt, faced.mouth);
      motions?.afterBody(dt);
      mesh.updateMatrixWorld(true);
      const clips = motions?.motions.clips;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), gait: gait.map(b => b.getWorldQuaternion(new Quaternion())), x: figure.placement.xM,
        walking: figure.walking, chat: clips?.chat.getState().active === true, action: clips?.action.active === true, body: (clips?.bodyTracks().length ?? 0) > 0,
        bridge: clips?.bridging === true, mask: motions?.mask.weight ?? 0 });
      await bytes.settle();
    }
  } finally { bytes.restore(); motions?.dispose(); face.attach(null); figure.dispose(); fixture.close(); }
  const within = (from: number, to: number) => frames.map((f, i) => ({ f, i })).filter(({ f, i }) => i >= 2 && f.t >= from && f.t <= to);
  const step = (from: number, to: number) => max(within(from, to).map(({ i }) => Math.max(...frames[i].rotations.map((q, b) => q.angleTo(frames[i - 1].rotations[b]) * DEG))));
  /** The largest unexpected step (R29c) in a span, and where (for the record and a failing assert). */
  const worst = (from: number, to: number, upper = false) => {
    let out = { angle: 0, t: 0, bone: '' }; const a = new Quaternion(), b = new Quaternion(), inv = new Quaternion();
    for (const { f, i } of within(from, to)) for (let k = 0; k < (upper ? UPPER : bones.length); k++) {
      a.copy(frames[i].rotations[k]).multiply(inv.copy(frames[i - 1].rotations[k]).invert());
      b.copy(frames[i - 1].rotations[k]).multiply(inv.copy(frames[i - 2].rotations[k]).invert());
      const angle = a.angleTo(b) * DEG;
      if (angle > out.angle) out = { angle, t: f.t, bone: TRACKED[k] };
    }
    return out;
  };
  const surprise = (from: number, to: number, upper = false) => worst(from, to, upper).angle;
  return { frames, step, surprise, worst, outcomes, within };
}

// ---- C: her motions out here ------------------------------------------------------------------------------------------------------

/** The scene's timeline (s). */
const C = { gesture: 1, gestureOff: 3.2, across: 4, wave: 4.3, body: 10, home: 12, nod: 12.4, end: 17 } as const;
const C_SEGMENTS: [string, number, number][] = [['idle', 0.4, 1], ['gesture', 1, 3.2], ['handed back', 3.2, 4], ['walk+wave', 4, 6.5], ['wave', 6.5, 9.5], ['body', 10, 12], ['walk home', 12, 14.5], ['rest', 14.5, 17]];

function motionScene(): (t: number, s: Scene) => void {
  const done = new Set<string>();
  const at = (key: keyof typeof C, t: number) => { if (t >= C[key] && !done.has(key)) { done.add(key); return true; } return false; };
  return (t, s) => {
    if (at('gesture', t)) s.view = { ...s.view, gesture: { id: 'fullg', at: s.now(), expiresAt: s.now() + 60_000, intent: 'explain', strength: 0.55, reason: 'test' } };
    if (at('across', t)) { s.place(1.2); }
    if (at('gestureOff', t)) s.view = { ...s.view, gesture: null };
    if (at('wave', t)) s.play('hello-wave');
    if (at('body', t)) {
      const recipe = BEHAVIOR_RECIPES['idle.neutral'];
      const cue: BodyMotionCue = { id: 'fullbody', token: s.view.token, recipeId: 'idle.neutral', at: s.now(), expiresAt: s.now() + recipe.durationMs + BODY_START_AGE_MS,
        durationMs: recipe.durationMs, strength: 0.3 };
      s.view = { ...s.view, body: { mode: 'idle-scheduler', reason: 'idle-issued', observationEpoch: 'full-epoch', cue } as BodyMotionPlan };
    }
    if (at('home', t)) s.place(HOME.xM);
    if (at('nod', t)) s.play('nod');
  };
}

for (const fps of [60, 30]) {
  test(`full-screen Gene, ${fps} fps (C): a chat gesture, a wave as she walks, an automatic body motion handed back by a walk, a nod on the way; nothing jumps; her legs are her gait's`, async () => {
    const off = await run(fps, C.end, { motions: false, life: false }, motionScene()), on = await run(fps, C.end, { motions: true, life: false }, motionScene());
    const during = (r: typeof on, key: 'chat' | 'action' | 'body' | 'bridge' | 'walking', from: number, to: number) => r.within(from, to).some(({ f }) => f[key]);
    assert.ok(during(on, 'chat', 1.5, 3.5), 'the chat gesture played');
    assert.ok(during(on, 'walking', 4.3, 5.5) && during(on, 'action', 4.5, 5.5), 'the wave started while she walked');
    assert.deepEqual(on.outcomes.map(o => `${o.status}`), ['played', 'played'], `her answers: ${JSON.stringify(on.outcomes)}`);
    assert.ok(during(on, 'body', 10.5, 12), 'the automatic body motion played standing');
    assert.ok(!during(on, 'body', 12.6, 17), 'the walk handed it back');
    assert.ok(during(on, 'bridge', 12, 13), 'through the bridge, never a cut');
    // She walks the same way, and while she walks her hips and legs are what her gait makes of them (the mask is fully in after WALK_MASK_S).
    const xs = (r: typeof on, at: number) => r.frames.find(f => f.t >= at)!.x;
    assert.ok(xs(on, 9) > 1 && Math.abs(xs(on, 9) - xs(off, 9)) < 0.03, `walked across (${xs(off, 9).toFixed(3)} → ${xs(on, 9).toFixed(3)} m)`);
    assert.ok(Math.abs(xs(on, 16.5) - xs(off, 16.5)) < 0.03, `and home (${xs(off, 16.5).toFixed(3)} → ${xs(on, 16.5).toFixed(3)} m)`);
    let legs = 0;
    for (const { f, i } of on.within(4, 16.5)) if (f.walking && f.mask >= 1 && off.frames[i]?.walking) legs = Math.max(legs, ...f.gait.map((q, b) => q.angleTo(off.frames[i].gait[b]) * DEG));
    // Per segment: the unexpected step stays within R29c's level (the old stage's motions on the window engine measured the same way).
    const rows = C_SEGMENTS.map(([name, from, to]) => ({ name, offStep: off.step(from, to), onStep: on.step(from, to), offSurprise: off.surprise(from, to), onSurprise: on.surprise(from, to), offUpper: off.surprise(from, to, true), onUpper: on.surprise(from, to, true) }));
    // The window batch 5 bound (its clips standing); for her upper body while she walks, plus what her walk itself makes there.
    const limit = fps === 60 ? 0.6 : 1.4;
    say(`  full C ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}° (upper body ${r.offUpper.toFixed(3)}→${r.onUpper.toFixed(3)}°)`).join(' · ')
      + ` · legs while walking ${legs.toFixed(3)}°`);
    assert.ok(legs < 0.5, `her hips and legs while walking: ${legs.toFixed(3)}° from the run without her motions`);
    for (const [k, row] of rows.entries()) assert.ok(row.onSurprise < Math.max(limit, row.offSurprise * 1.5), `${row.name}: unexpected step ${row.onSurprise.toFixed(3)}° (without ${row.offSurprise.toFixed(3)}°) at ${JSON.stringify(on.worst(C_SEGMENTS[k][1], C_SEGMENTS[k][2]))}`);
    for (const [k, row] of rows.entries()) assert.ok(row.onUpper < limit + row.offUpper, `${row.name}: upper body unexpected step ${row.onUpper.toFixed(3)}° (without ${row.offUpper.toFixed(3)}°) at ${JSON.stringify(on.worst(C_SEGMENTS[k][1], C_SEGMENTS[k][2], true))}`);
  });
}

// ---- C on a VRM (the standard body): a face shape of hers while she walks ----------------------------------------------------------

for (const fps of [60, 30]) {
  test(`full-screen VRM, ${fps} fps (C): a wink on the VRM's own shapes while she walks, eased; her answer; the walk mask holds her standard skeleton's hips and legs`, async () => {
    const bytes = settledVmdBytes(url => catalogMotionFile(HER_ACTION_PACK, /\/([a-z-]+)\.vmd$/.exec(url)![1]), { delayMs: 5 });
    const w = await windowVrm(syntheticVrm({ face: 'full' }));
    const rig = windowFaceRig(w.standard.mesh, null, false, w.figure.head, w.standard);
    const face = new WindowFace(); face.attach(rig); w.body.bindFace(slotBindings(rig, face.blushMorph()));
    let clock = 1_000_000;
    const heard: { listener: ((cue: unknown) => void) | null } = { listener: null };
    const now = () => clock, outcomes: HerActionOutcome[] = [], cues = new Map<string, HerActionCue>();
    const motions = new HerOutMotions({
      resolveHerAction: async cueId => { const cue = cues.get(cueId)!; return { cueId, action: cue.action, packId: HER_ACTION_PACK, motionId: cue.action, sha256: HER_ACTION_SPECS[cue.action].sha256,
        durationMs: HER_ACTION_SPECS[cue.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${cue.action}.vmd` }; },
      reportHerAction: async outcome => { outcomes.push(outcome); }, onHerAction: callback => { heard.listener = callback; return () => {}; } }, now);
    motions.attach({ figure: w.figure, mesh: w.standard.mesh, reviewed: false, retarget: null, transform: w.standard.transform, profile: null, standard: w.standard });
    const view = faceView();
    motions.setMood(view);
    const skin = w.standard.model.meshes.find(m => m.morphTargetDictionary?.Fcl_EYE_Close_L !== undefined && /SKIN/.test((Array.isArray(m.material) ? m.material[0] : m.material).name))!;
    const values: number[] = [], held = motions.mask.heldBones;
    let walked = false;
    try {
      assert.ok(held >= 5, `the walk mask finds her standard skeleton hips and legs (${held})`);
      for (let i = 0; i <= Math.round(fps * 5); i++) {
        const dt = i ? 1 / fps : 0;
        clock += dt * 1000;
        if (i === Math.round(fps * 0.5)) w.figure.followTo({ x: 0.8, z: 0 });
        if (i === Math.round(fps)) { const cue: HerActionCue = { id: 'vrm-wink-full', action: 'wink' as HerActionId, at: now(), expiresAt: now() + HER_ACTION_CUE_MS }; cues.set(cue.id, cue); heard.listener?.(cue); }
        face.setMood(view);
        motions.frame({ shown: true, adjusting: false, pulled: false, walking: w.figure.walking, contact: null, speaking: false, preparing: false, thinking: false, lidsHeld: 0,
          blink: 0, mouthOff: false, eyesOff: false });
        const goals = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking: false, heightM: w.figure.heightM });
        w.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false, face: goals });
        motions.afterBody(dt);
        walked ||= w.figure.walking && motions.mask.weight > 0.99;
        values.push(skin.morphTargetInfluences![skin.morphTargetDictionary!.Fcl_EYE_Close_L]);
        await bytes.settle();
      }
    } finally { bytes.restore(); motions.dispose(); w.close(); }
    const change = max(values.slice(1).map((v, k) => Math.abs(v - values[k])));
    assert.deepEqual(outcomes.map(o => o.status), ['played'], JSON.stringify(outcomes));
    assert.ok(walked, 'she walked while it played (the mask fully in)');
    assert.ok(max(values) > 0.3 && values.at(-1)! < 0.02, `the wink shows and goes (peak ${max(values).toFixed(3)})`);
    assert.ok(change < (fps === 60 ? 0.35 : 0.6), `eased: per-frame change ${change.toFixed(3)}`);
    say(`  full VRM ${fps} fps · wink peak ${max(values).toFixed(2)} Δ/frame ${change.toFixed(3)} while walking · mask bones ${held}`);
  });
}

// ---- H: her procedural life out here ----------------------------------------------------------------------------------------------

/** An owner's small move (her life's: a glance at you and a little tilt), standing and then while she walks. */
const H_SEGMENTS: [string, number, number][] = [['stand', 1, 5], ['small move', 5, 8], ['walk', 8.2, 10.5], ['walk back', 10.5, 13]];
function lifeScene(): (t: number, s: Scene) => void {
  const done = new Set<string>();
  const at = (key: string, when: number, t: number) => { if (t >= when && !done.has(key)) { done.add(key); return true; } return false; };
  return (t, s) => {
    if (at('move', 5, t)) s.own({ head: { pitch: 0.06, yaw: 0.12, roll: 0.04 } });
    if (at('rest', 7.5, t)) s.own(null);
    if (at('across', 8.2, t)) s.place(1.0);
    if (at('home', 10.5, t)) s.place(HOME.xM);
  };
}

for (const fps of [60, 30]) {
  test(`full-screen Gene, ${fps} fps (H): her procedural life stacks on an owner's small move and on her walk; nothing jumps; she walks as before`, async () => {
    const off = await run(fps, 13, { motions: false, life: false }, lifeScene()), on = await run(fps, 13, { motions: false, life: true }, lifeScene());
    const HEAD = TRACKED.indexOf('頭'), at = (r: typeof on, t: number) => r.frames.find(f => f.t >= t)!;
    // It shows: her head is not where it would be without it (a tilt, a drift), standing and under the owner's move (which still shows: stacked).
    const apart = (from: number, to: number) => max(on.within(from, to).map(({ f, i }) => f.rotations[HEAD].angleTo(off.frames[i].rotations[HEAD]) * DEG));
    assert.ok(apart(1, 5) > 0.3, `standing: her life moves her head ${apart(1, 5).toFixed(2)}°`);
    const moved = at(off, 7).rotations[HEAD].angleTo(at(off, 4.9).rotations[HEAD]) * DEG;
    assert.ok(moved > 3, `the owner's small move shows without her life (${moved.toFixed(2)}°)`);
    const movedOn = at(on, 7).rotations[HEAD].angleTo(at(on, 4.9).rotations[HEAD]) * DEG;
    assert.ok(Math.abs(movedOn - moved) < 3 && movedOn > 2, `and with it, stacked (${movedOn.toFixed(2)}°)`);
    const xs = (r: typeof on, t: number) => at(r, t).x;
    assert.ok(xs(on, 10.4) > 0.3 && Math.abs(xs(on, 10.4) - xs(off, 10.4)) < 0.03, `walked across the same (${xs(off, 10.4).toFixed(3)} → ${xs(on, 10.4).toFixed(3)} m)`);
    const rows = H_SEGMENTS.map(([name, from, to]) => ({ name, offStep: off.step(from, to), onStep: on.step(from, to), offSurprise: off.surprise(from, to), onSurprise: on.surprise(from, to) }));
    const limit = fps === 60 ? 0.5 : 1.0;
    for (const row of rows) assert.ok(row.onSurprise < Math.max(limit, row.offSurprise * 1.5), `${row.name}: unexpected step ${row.onSurprise.toFixed(3)}° (without ${row.offSurprise.toFixed(3)}°)`);
    say(`  full H ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}°`).join(' · ')
      + ` · head apart standing ${apart(1, 5).toFixed(2)}° · owner move ${moved.toFixed(2)}° → ${movedOn.toFixed(2)}°`);
  });
}
