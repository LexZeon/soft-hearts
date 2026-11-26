/**
 * I-154 batch 6 (docs/claude/2026-11-20-unbound-window-batch6.md): rows 33 她自己的生活, 37 跟音乐跳 and 25 眼泪 on the window engine.
 * The gates (the old stage's, plus the window's few), music only through the user's own switch, tears by the card, and two long scenes on
 * the real Gene frame loop at 60 and 30 fps through the code the stage runs (WindowOwnLife with WindowMotions, WindowGames,
 * WindowLiveliness): per frame, the step and the unexpected step (R29c) of her upper body and arms, against her own idle, against the
 * same scene with her own life's easing taken out, and against the same events on the old stage's real frame loop
 * (tests/helpers/gene-stage-harness.ts). WINDOW_BATCH6_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, Quaternion, Scene, type Material, type SkinnedMesh } from 'three';
import { type BodyMotionPlan } from '../shared/actions';
import type { HerLifeActivity, HerLifeView } from '../shared/stage/her-life';
import type { MoodView } from '../shared/mood';
import { WindowMotions, loadLibraryClip, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import { WindowReactions } from '../src/unbound/window-mode/window-reactions';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { WindowGames } from '../src/unbound/window-mode/window-games';
import { NO_MOTION_BLOCKS, slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { WindowOwnLife } from '../src/unbound/window-mode/window-own-life';
import { windowHerLifeGates, windowHerLifeLoader } from '../src/unbound/window-mode/window-her-life';
import { WindowMusic, musicSampleHeard, musicYieldReason, type WindowMusicEnv } from '../src/unbound/window-mode/window-music';
import { WindowUnderLayer } from '../src/unbound/window-mode/window-under-layer';
import { WindowCrying, windowTearsGate } from '../src/unbound/window-mode/window-tears';
import { WindowBlush } from '../src/unbound/window-mode/window-blush';
import { eyeBones } from '../src/unbound/window-mode/window-model';
import type { WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { loadLivelinessForEngine, loadMusicForEngine } from '../src/stage';
import { StageModelProfile } from '../src/stage/model-profile';
import { fileOrderOpaqueSort, type SortableRenderItem } from '../src/foundation/draw-order';
import { card, faceView } from './helpers/window-face-fixture';
import { frameSteps, surprises, windowGene, WINDOW } from './helpers/unbound-window';
import { max, standClip } from './helpers/unbound-gene';
import { catalogMotionFile, catalogSha, songSample, TRACKED_BONES } from './helpers/frame-stats';
import { settledVmdBytes } from './helpers/settled-vmd';

const REPORT = process.env.WINDOW_BATCH6_REPORT === '1';

// ---- the gates (pure) ---------------------------------------------------------------------------------------------------------
const baseEnv = (over: Partial<WindowMotionEnv> = {}): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false,
  pat: false, feeding: false, hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false,
  thinking: false, view: faceView(), blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false, ...over });
const host = (over: Partial<WindowStageHost> = {}): WindowStageHost => ({ isBehaviorModelSupported: async () => true,
  resolveChatGesture: async () => { throw Error('none'); }, resolveHerAction: async () => { throw Error('none'); }, reportHerAction: async () => {},
  getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan, resolveBehaviorBody: async () => { throw Error('none'); },
  resolveBehaviorMotion: async () => { throw Error('none'); },
  resolveHerLifeMotion: async motionId => ({ motionId: motionId as 'thinking', sha256: catalogSha('gene', motionId), durationMs: 10_000, url: `mmd-asset://${'c'.repeat(32)}/${motionId}.vmd` }), ...over });

test('row 33 gates: the old stage\'s owners on this window\'s state (music is the user here), and a reaction\'s stretch or the games\' arms take the held pose', () => {
  const motions = new WindowMotions(host(), () => baseEnv());
  const free = motions.lifeGates(baseEnv());
  assert.equal(free.engaged, false); assert.equal(free.bodyOwned, false); assert.equal(free.asleep, false);
  assert.equal(motions.lifeGates(baseEnv({ music: true })).engaged, true, 'dancing to music: the user is here (the old stage\'s gates.music)');
  assert.equal(motions.lifeGates(baseEnv({ typing: true })).engaged, true);
  assert.equal(motions.lifeGates(baseEnv({ asleep: true })).asleep, true, 'the sleep body holds her');
  const extras = { reactionHoldsBody: false, armsHeld: false };
  assert.deepEqual(windowHerLifeGates(free, extras), free, 'nothing else: the old stage\'s gates as they are');
  assert.equal(windowHerLifeGates(free, { ...extras, reactionHoldsBody: true }).bodyOwned, true, 'a stretch or wave reaction holds her shoulders');
  assert.equal(windowHerLifeGates(free, { ...extras, armsHeld: true }).bodyOwned, true, 'the game, an offer or her reach holds her arms');
  assert.equal(windowHerLifeGates(free, { ...extras, armsHeld: true }).engaged, false, 'holding her arms is not the user being here');
});

test('row 33 loader: the host\'s grant through the port; a conversation change while loading, a wrong id or an unfit model: no held pose', async () => {
  const mesh = {} as SkinnedMesh;
  let token = 'a', asked: string[] = [];
  const clip = { tracks: [] } as never;
  const make = (over: { unfit?: boolean; id?: string } = {}) => windowHerLifeLoader({ mesh: () => mesh, token: () => token,
    resolve: async (id, t) => { asked.push(`${id}@${t}`); return { motionId: (over.id ?? id) as 'thinking', sha256: 'x', durationMs: 1, url: 'mmd-asset://c/x.vmd' }; },
    load: async () => { token = token === 'switch' ? 'b' : token; return clip; }, unfit: () => over.unfit === true });
  assert.equal(await make()('thinking'), clip);
  assert.deepEqual(asked, ['thinking@a']);
  assert.equal(await make({ unfit: true })('thinking'), null, 'unfit for this model');
  assert.equal(await make({ id: 'sleepy' })('thinking'), null, 'not what was asked');
  token = 'switch';
  assert.equal(await make()('thinking'), null, 'the conversation changed while it loaded');
  token = '';
  asked = [];
  assert.equal(await make()('thinking'), null); assert.deepEqual(asked, [], 'no conversation: the host is not asked');
});

test('the layer under the clips: its writes come first and the clips over them; everything is put back, the clips\' first; arms held is the larger', () => {
  const bone = new Bone(), order: string[] = [];
  const target = new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 } as never, 0.5);
  const writer = { armsHeld: 0.3, write: (port: { blend(b: Bone, t: Quaternion, w: number): void; move(b: Bone, x: number, y: number, z: number): void }) => {
    order.push('under'); port.blend(bone, target, 1); port.move(bone, 0, 2, 0); } };
  const clips = { armsHeld: 0.6, restore: () => order.push('clips-restore'), beforeUpdate: () => order.push('clips-before'), frame: () => order.push('clips') };
  const layer = new WindowUnderLayer([writer]).over(clips);
  layer.beforeUpdate(0); layer.frame(1 / 60);
  assert.deepEqual(order, ['clips-before', 'under', 'clips']);
  const y = (): number => bone.position.y;
  assert.ok(bone.quaternion.angleTo(target) < 1e-6 && y() === 2, 'written');
  layer.restore();
  assert.equal(order.at(-1), 'clips-restore', 'the clips put back first (last written first)');
  assert.ok(bone.quaternion.angleTo(new Quaternion()) < 1e-6 && y() === 0, 'put back exactly');
  layer.frame(1 / 60); layer.frame(1 / 60); layer.restore();
  assert.ok(bone.quaternion.angleTo(new Quaternion()) < 1e-6 && y() === 0, 'two frames without a restore between: still the original (remembered once)');
  assert.equal(layer.armsHeld, 0.6);
});

const musicEnv = (over: Partial<WindowMusicEnv> = {}): WindowMusicEnv => ({ view: faceView(), shown: true, speaking: false, adjusting: false, behaviorBlocked: false,
  touched: false, manualHead: false, asleep: false, ...over });

test('row 37 gates: what the dance yields to (the old stage\'s order; the window adds a pull and her sleep body), and a sample counts only while she hears', () => {
  assert.equal(musicYieldReason(musicEnv(), true), null);
  assert.equal(musicYieldReason(musicEnv(), false), 'disabled');
  assert.equal(musicYieldReason(musicEnv({ shown: false, speaking: true }), true), 'hidden');
  assert.equal(musicYieldReason(musicEnv({ speaking: true, touched: true }), true), 'speech');
  assert.equal(musicYieldReason(musicEnv({ adjusting: true }), true), 'camera');
  assert.equal(musicYieldReason(musicEnv({ behaviorBlocked: true }), true), 'window-or-input');
  assert.equal(musicYieldReason(musicEnv({ touched: true }), true), 'direct-interaction');
  assert.equal(musicYieldReason(musicEnv({ manualHead: true }), true), 'manual-head');
  assert.equal(musicYieldReason(musicEnv({ asleep: true }), true), 'asleep');
  const sample = songSample(0);
  assert.equal(musicSampleHeard(true, sample), true);
  assert.equal(musicSampleHeard(false, sample), false, 'the 和她一起听 switch is off: not heard');
  assert.equal(musicSampleHeard(true, { ...sample, rms: Number.NaN }), false);
  assert.equal(musicSampleHeard(true, null), false);
});

/** A WindowMusic with the real performers, three bones to write on, and records of what it told. */
async function musicProbe() {
  const told: string[] = [], memory: string[] = [];
  const music = new WindowMusic({ face: () => ({ performPick: () => null, setTint: () => {} }), hasFace: () => false, told: intent => told.push(intent),
    tier: tier => told.push(`tier:${tier}`), memory: () => ({ match: async () => { memory.push('match'); return null; }, learn: async () => { memory.push('learn'); } }), now: () => clock, wall: () => clock });
  let clock = 1_000;
  music.load(await loadMusicForEngine());
  const center = new Bone(), chest = new Bone(), head = new Bone();
  center.add(chest); chest.add(head);
  music.attach({ center, chest, head, height: 20 });
  const layer = new WindowUnderLayer([music]);
  /** `seconds` of frames at 30 Hz with a sample each, the layer writing; the largest rotation away from rest that was shown. */
  const run = (seconds: number, env: Partial<WindowMusicEnv> = {}) => {
    let shown = 0, offset = 0;
    for (let i = 0; i < seconds * 30; i++) {
      clock += 1000 / 30;
      music.setSample({ ...songSample(frame++), time: clock / 1000 });
      music.frame(1 / 30, musicEnv(env));
      layer.restore(); layer.frame(1 / 30);
      shown = Math.max(shown, head.quaternion.angleTo(new Quaternion()), chest.quaternion.angleTo(new Quaternion()));
      offset = Math.max(offset, Math.abs(center.position.y));
    }
    return { shown, offset };
  };
  let frame = 0;
  return { music, run, told, memory, layer, head };
}

test('row 37: only through the user\'s own switch: samples while it is off move nothing, tell nothing and learn nothing; on, she dances; hidden resets', async () => {
  const p = await musicProbe();
  const off = p.run(3);
  assert.equal(off.shown, 0, 'switch off: no dance, whatever arrives');
  assert.equal(off.offset, 0);
  assert.equal(p.music.presence().music, 'off');
  assert.deepEqual(p.memory, [], 'no song is looked up or learned');
  assert.equal(p.music.beat, null);
  p.music.setEnabled(true); // the 和她一起听 switch (the R15 dance until the music settings come)
  const on = p.run(3);
  assert.ok(on.shown > 0.002, `on: she dances (${on.shown})`);
  assert.equal(p.music.moving, true);
  // Hidden while she dances: nothing is on screen, so it resets at once; nothing is written, and no nod is handed on.
  p.layer.restore(); p.layer.frame(0);
  assert.ok(p.head.quaternion.angleTo(new Quaternion()) > 0, 'dancing: the head is written');
  p.music.notShown();
  p.layer.restore(); p.layer.frame(0);
  assert.equal(p.head.quaternion.angleTo(new Quaternion()), 0, 'hidden: nothing written');
  assert.equal(p.music.beat, null);
  assert.ok(p.run(3).shown > 0.002, 'shown again with the music on: she dances again');
  // A touch: the dance yields by its own fade (R29b), not a cut; the share it shows goes down.
  const touched = p.run(1.5, { touched: true });
  assert.equal(p.music.yieldReason, 'direct-interaction');
  assert.ok(p.music.getState().dance!.presence < 0.05, `yielded (${p.music.getState().dance!.presence})`);
  assert.ok(touched.shown > 0, 'the fade itself was shown');
  // Off again: she stops hearing; the dance eases out by its release.
  p.music.setEnabled(false);
  assert.equal(p.music.presence().music, 'off');
});

test('row 25 gate (I-024 能流泪): the reviewed Gene unless the card turns it off; another model only when its card has it on', () => {
  assert.deepEqual(windowTearsGate(true, null), { gene: true, card: false, reason: null }, 'the reviewed Gene, before any card');
  assert.equal(windowTearsGate(true, card([], { tears: 'off' })).gene, false, 'the card turned it off');
  assert.ok(windowTearsGate(true, card([], { tears: 'off' })).reason, 'and says why');
  assert.deepEqual(windowTearsGate(false, card(['tears'])), { gene: false, card: true, reason: null });
  assert.deepEqual(windowTearsGate(false, card([])), { gene: false, card: false, reason: null }, 'another model without it on its card');
});

/** The opaque render items of her multi-material mesh, drawn by the window's sort (fileOrderRenderer). */
const drawnOrder = (mesh: SkinnedMesh) => {
  const materials = mesh.material as Material[];
  const items: (SortableRenderItem & { index: number })[] = mesh.geometry.groups.map((group, index) => ({ groupOrder: 0, renderOrder: mesh.renderOrder, material: materials[group.materialIndex!], z: 0, id: mesh.id, index }));
  return items.sort(fileOrderOpaqueSort).map(item => item.index);
};

test('row 25 on the Unbound Gene: the tears go on her face over the blush, keep the file place, follow the card, and a cry eases in and out (60 / 30 fps)', async () => {
  const g = await windowGene();
  try {
    const mesh = g.fixture.mesh, painter = new WindowBlush(mesh, g.figure.head, eyeBones(mesh));
    const order = mesh.geometry.groups.map((_, index) => index);
    assert.equal(painter.build(null, true), true, painter.reason);
    painter.setTearsGate(windowTearsGate(true, null));
    assert.equal(painter.tearsSupported, true, painter.tearsReason);
    assert.deepEqual(drawnOrder(mesh), order, 'blush and tears: still drawn in file order (the face never drops behind the brows)');
    painter.build(null, true); // a calibration change: the blush is measured again, the tears go back over it
    assert.equal(painter.tearsSupported, true, 'the tears survive a blush rebuild');
    assert.deepEqual(drawnOrder(mesh), order);
    painter.setTearsGate(windowTearsGate(true, card([], { tears: 'off' })));
    assert.equal(painter.tearsSupported, false, 'the card turned them off');
    assert.match(painter.tearsReason, /能流泪/);
    painter.setTearsGate(windowTearsGate(true, null));
    for (const fps of [60, 30]) {
      const AT = 5_000_000;
      const view = (snapshot: Partial<MoodView['snapshot']> = {}): MoodView => { const v = faceView(); return { ...v, snapshot: { ...v.snapshot, ...snapshot } } as MoodView; };
      const crying = view({ reunion: { id: `back-${fps}`, at: AT, longing: 90, crying: true }, cryingCandidate: true });
      const run = (input: { adjusting?: boolean; faceBlocked?: boolean; comfortAt?: number }) => {
        const timeline = new WindowCrying(), amounts: number[] = [];
        for (let i = 0; i <= fps * 10; i++) {
          const now = AT + i * 1000 / fps;
          const v = input.comfortAt !== undefined && now - AT >= input.comfortAt ? view({ ...crying.snapshot, lastInteractionAt: AT + input.comfortAt }) : crying;
          const shown = timeline.frame(i ? 1 / fps : 0, { view: v, visible: true, adjusting: input.adjusting === true, faceBlocked: input.faceBlocked === true, supported: painter.tearsSupported, nowMs: now });
          painter.updateTears(shown.amount, shown.elapsedMs);
          amounts.push(shown.amount);
        }
        return amounts;
      };
      const cry = run({});
      const steps = cry.slice(1).map((a, i) => Math.abs(a - cry[i])), bends = steps.slice(1).map((s, i) => Math.abs(s - steps[i]));
      if (REPORT) console.log(JSON.stringify({ tears: fps, peak: +max(cry).toFixed(3), step: +max(steps).toFixed(4), bend: +max(bends).toFixed(4) }));
      assert.ok(max(cry) > 0.4, `a cry shows (${max(cry)})`);
      assert.ok(max(steps) < (fps === 60 ? 0.06 : 0.12), `it eases (largest step ${max(steps).toFixed(4)})`);
      assert.equal(cry.at(-1), 0, 'and is over');
      const comforted = run({ comfortAt: 1_500 });
      assert.ok(comforted.findIndex((a, i) => i > fps * 1.5 && a === 0) < cry.findIndex((a, i) => i > fps && a === 0), 'comfort shortens it');
      assert.equal(max(run({ adjusting: true })), 0, 'a window or camera move: no cry starts');
      assert.equal(max(run({ faceBlocked: true })), 0, 'a picked expression owns her face: no cry');
    }
  } finally { g.close(); }
});

// ---- the real Gene: her own life and music through the code the stage runs ------------------------------------------------------

const MEASURED = [...TRACKED_BONES];
const NAIVE = { yieldS: 1e-3, returnS: 1e-3, crossfadeS: 1e-3, lookUp: { rise: 1e-3, hold: 1, fall: 1e-3 }, poseAccel: { enter: Infinity, yield: Infinity } };
const lifeView = (view: MoodView, activity: HerLifeActivity): MoodView =>
  ({ ...view, revision: view.revision + 1, herLife: { activity, since: 0, until: 9e15, source: 'rule', lookUp: null } as HerLifeView });

interface Ctx { view: MoodView; env: WindowMotionEnv; own: WindowOwnLife; hearing: boolean; now: () => number }

async function windowLifeRun(fps: number, seconds: number, script: (t: number, c: Ctx) => void, options: { naive?: boolean } = {}) {
  const bytes = settledVmdBytes(url => {
    const match = /^mmd-asset:\/\/c{32}\/(thinking|sleepy)\.vmd$/.exec(url);
    if (!match) throw Error(`unexpected ${url}`);
    return catalogMotionFile('gene', match[1]);
  }, { delayMs: 25 });
  const g = await windowGene();
  let clock = 1_000_000, sampleFrame = 0;
  const now = () => clock;
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  g.figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace']));
  const lively = new WindowLiveliness(() => {}, () => 0.5), scene = new Scene(), games = new WindowGames(scene), reactions = new WindowReactions();
  scene.add(mesh);
  const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib);
  lively.sleep.attach({ mesh, profile, baseY: 0, hasNeck: true });
  const h = host();
  const c: Ctx = { view: lifeView(faceView({ primary: 'calm', companion: null }), 'company'), env: baseEnv(), own: null as never, hearing: false, now };
  const motions = new WindowMotions(h, () => c.env, now);
  motions.attach({ figure: g.figure, mesh, reviewed: true, retarget: null, transform: undefined, profile, standard: false });
  const own = c.own = new WindowOwnLife({ face: () => face.musicFace(), hasFace: () => face.hasSpeechFace, now, wall: now, danceStarts: () => motions.gatesChanged(true, false) },
    options.naive ? NAIVE : undefined);
  own.herLife.load(lib); own.music.load(await loadMusicForEngine());
  own.attach({ figure: g.figure, clips: motions.clips, resolve: (id, token) => h.resolveHerLifeMotion(id, token), token: () => c.view.token,
    load: (url, owner) => loadLibraryClip(url, owner, undefined), unfit: () => false });
  const bones = MEASURED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: Quaternion[][] = [], states: { presence: number; pose: string | null; weight: number; dancing: boolean; root: number; bodyMusic: boolean }[] = [];
  try {
    for (let i = 0; i <= Math.round(fps * seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clock += dt * 1000;
      script(t, c);
      // The capture's samples at 30 Hz, only while the switch is on (the wiring's AudioReadingClient).
      if (c.hearing) while (sampleFrame < Math.floor(t * 30) + 1) own.music.setSample({ ...songSample(sampleFrame), time: 1000 + sampleFrame++ / 30 });
      const env = c.env = { ...c.env, view: c.view, music: own.music.moving };
      face.setMood(c.view);
      motions.frame();
      const ownFrame = own.frame(dt, { owner: mesh, env, lifeGates: motions.lifeGates(env), reactionHoldsBody: reactions.holdsBody, armsHeld: games.armsHeld(false), nowMs: clock });
      const gamesFrame = games.frame(dt, { mesh, pointer: { x: 0.2, y: 0.05 }, follow: true, camera: g.camera, base: ownFrame.activity });
      lively.frame(dt, g.body, face, { view: c.view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: env.speaking, armsHeld: false },
        pointer: { x: 0.2, y: 0.05 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: env.pat, breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false,
        camera: g.camera, lift: g.figure.floorUnits, width: WINDOW.width, height: WINDOW.height, scene, games: gamesFrame, music: ownFrame.music });
      motions.afterBody(dt);
      mesh.updateMatrixWorld(true);
      frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion())));
      const life = own.herLife.getState(), root = g.figure.rootM;
      states.push({ presence: life?.presence ?? 0, pose: life?.pose?.id ?? null, weight: life?.pose?.weight ?? 0, dancing: own.music.moving, root: Math.hypot(root.x, root.z),
        bodyMusic: motions.bodyGates(env).music });
      await bytes.settle();
    }
  } finally { bytes.restore(); motions.dispose(); own.music.dispose(); g.close(); }
  // Two frames before `from`: a change made at `from` shows in the step into its first frame (the old her-life test's rule).
  const span = (from: number, to: number) => frames.slice(Math.max(0, Math.round(from * fps) - 2), Math.round(to * fps) + 1);
  const row = (from: number, to: number) => ({ step: +max(frameSteps(span(from, to))).toFixed(3), surprise: +max(surprises(span(from, to)).perFrame).toFixed(3) });
  const at = (time: number) => states[Math.min(states.length - 1, Math.round(time * fps))];
  return { row, at, states };
}

/** Her own life (s): company; thinking (the hand to her chin); you type; you stop; drowsy (the slump); company again. */
const L = { thinking: 2, typing: 8, typingOff: 10, drowsy: 15, company: 22, end: 28 } as const;
function lifeScene(): (t: number, c: Ctx) => void {
  const done = new Set<string>();
  const at = (key: keyof typeof L, t: number) => t >= L[key] && !done.has(key) && !!done.add(key);
  return (t, c) => {
    if (at('thinking', t)) c.view = lifeView(c.view, 'thinking');
    if (at('typing', t)) c.env = { ...c.env, typing: true };
    if (at('typingOff', t)) c.env = { ...c.env, typing: false };
    if (at('drowsy', t)) c.view = lifeView(c.view, 'drowsy');
    if (at('company', t)) c.view = lifeView(c.view, 'company');
  };
}
/** Music (s): her own life daydreaming; the switch on (the R15 dance); she speaks; a pat; the switch off. */
const M = { on: 2, speak: 7, speakOff: 9, pat: 11, patOff: 12, off: 14, end: 18 } as const;
function musicScene(): (t: number, c: Ctx) => void {
  const done = new Set<string>();
  const at = (key: keyof typeof M, t: number) => t >= M[key] && !done.has(key) && !!done.add(key);
  return (t, c) => {
    if (t === 0) c.view = lifeView(c.view, 'daydream');
    if (at('on', t)) { c.hearing = true; c.own.music.setEnabled(true); }
    if (at('speak', t)) c.env = { ...c.env, speaking: true };
    if (at('speakOff', t)) c.env = { ...c.env, speaking: false };
    if (at('pat', t)) c.env = { ...c.env, pat: true };
    if (at('patOff', t)) c.env = { ...c.env, pat: false };
    if (at('off', t)) { c.hearing = false; c.own.music.setEnabled(false); }
  };
}

for (const fps of [60, 30]) {
  test(`Gene, ${fps} fps: her own life on the window engine: the hand to her chin eases in, gives way to you, the slump, back to company; she never walks`, { timeout: 900_000 }, async () => {
    const r = await windowLifeRun(fps, L.end, lifeScene());
    const naive = await windowLifeRun(fps, L.end, lifeScene(), { naive: true });
    const rows = { idle: r.row(0.5, L.thinking), enter: r.row(L.thinking, L.typing), typing: r.row(L.typing, L.typingOff), back: r.row(L.typingOff, L.drowsy),
      drowsy: r.row(L.drowsy, L.company), leave: r.row(L.company, L.end) };
    const cut = { enter: naive.row(L.thinking, L.typing), typing: naive.row(L.typing, L.typingOff), back: naive.row(L.typingOff, L.drowsy), leave: naive.row(L.company, L.end) };
    if (REPORT) console.log(JSON.stringify({ life: fps, window: rows, instant: cut }));
    // What happened, on her own life's state.
    assert.ok(r.at(L.typing - 0.1).pose === 'thinking' && r.at(L.typing - 0.1).weight > 0.8, `the hand is at her chin (${JSON.stringify(r.at(L.typing - 0.1))})`);
    assert.ok(r.at(L.typing + 0.5).presence < 0.05, 'you type: her own activity gave way');
    assert.ok(r.at(L.typingOff - 0.05).weight < r.at(L.typing).weight * 0.3, 'and the hand came down');
    assert.ok(r.at(L.drowsy - 0.1).weight > 0.8, 'you stopped: it came back');
    assert.equal(r.at(L.company - 0.1).pose, 'sleepy', 'drowsy: the slump (after the hand fully gave way)');
    assert.equal(r.at(L.end).pose, null, 'company: the slump has given way and was released');
    assert.ok(r.states.every(s => s.root < 1e-9), 'she never walks (window mode)');
    // R29: no hand-over is a jump: within her own idle (with room for Unbound's livelier idle); the same
    // scene with the easing taken out is caught by the same measure.
    const limit = (_name: keyof typeof rows) => Math.max(fps === 60 ? 0.3 : 0.9, rows.idle.surprise * 1.5);
    for (const name of ['enter', 'typing', 'back', 'drowsy', 'leave'] as const)
      assert.ok(rows[name].surprise <= limit(name), `${name}: unexpected step ${rows[name].surprise}° ≤ ${limit(name).toFixed(3)}° (idle ${rows.idle.surprise})`);
    for (const name of ['enter', 'typing'] as const)
      assert.ok(cut[name].surprise > limit(name), `the instant ${name} is caught: ${cut[name].surprise}° > ${limit(name).toFixed(3)}°`);
  });

  test(`Gene, ${fps} fps: music on the window engine: only after the switch, the dance yields to speech and a pat and comes back, eases out when it goes off; her own life gives way`, { timeout: 900_000 }, async () => {
    const r = await windowLifeRun(fps, M.end, musicScene());
    const rows = { before: r.row(0.2, M.on), on: r.row(M.on, M.speak), speak: r.row(M.speak, M.speakOff + 1.5), pat: r.row(M.pat - 0.3, M.patOff + 1.5), off: r.row(M.off - 0.3, M.end) };
    if (REPORT) console.log(JSON.stringify({ music: fps, window: rows }));
    assert.equal(r.at(M.on - 0.1).dancing, false, 'before the switch: no dance');
    assert.ok(r.at(M.on - 0.1).presence > 0.9, 'her own life shows while the music is off');
    assert.equal(r.at(M.speak - 0.1).dancing, true, 'the switch on: she dances');
    assert.equal(r.at(M.speak - 0.1).bodyMusic, true, 'no automatic body motion starts while she dances (the old stage\'s gates.music)');
    assert.ok(r.at(M.speak - 0.1).presence < 0.05, 'dancing: her own life gave way (the user is here)');
    assert.ok(r.at(M.off + 0.7).dancing === false, 'off: the dance has eased out');
    assert.ok(r.at(M.end).presence > 0.9, 'and her own life came back');
    assert.ok(r.states.every(s => s.root < 1e-9), 'she never walks (window mode)');
    assert.ok(rows.on.step > rows.before.step, `the dance moves her (${rows.on.step}° > ${rows.before.step}°)`);
    // A hand-over adds at most a quarter over the dance's own beat ('on'): this engine has no display guard to smooth it (the old stage has).
    const limit = (name: keyof typeof rows) => Math.max(fps === 60 ? 0.3 : 0.9, (name === 'on' ? rows.before : rows.on).surprise * 1.25);
    for (const name of ['on', 'speak', 'pat', 'off'] as const)
      assert.ok(rows[name].surprise <= limit(name), `${name}: unexpected step ${rows[name].surprise}° ≤ ${limit(name).toFixed(3)}° (before ${rows.before.surprise})`);
  });
}
