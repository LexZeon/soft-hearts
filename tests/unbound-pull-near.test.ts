// I-159 E:
// the two near stations of a pull (face, eyes) from the camera and Gene's body; the pull reaches the eyes station; let go at or beyond the face
// station she stays, between the gate and the face she walks back, at the eyes she plays the peek and then stands at the face station;
// the pull itself, and a short buffer after it, never count as "you moved the mouse". `PULL_NEAR_REPORT=1` prints the numbers.
import test from 'node:test';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { geneFigure } from './helpers/unbound-gene';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';
import { applyWorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { UnboundPull, type StagePullHit, type UnboundPullFigure } from '../src/unbound/pull-input';
import { FACE_FILL, FACE_MARGIN, NEAR_WAIT_MS, NearReturn, nearBodyOf, nearOutcome, nearStations, pullNearLimit, type NearStations } from '../src/unbound/pull-near';
import { Director } from '../src/unbound/director/director';
import { PEEK_LENS } from '../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { NEAR_ARM_MS, clampFollowDepth, parsePullAnswer, parseUnboundPull, pullReportMessage, type UnboundPullMessage } from '../shared/unbound/pull';
import { planPeek, parsePeekReport, PEEK_TIMING, type PeekCommand } from '../shared/unbound/director';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { NEUTRAL_MOOD } from '../shared/unbound/director';

const REPORT = process.env.PULL_NEAR_REPORT === '1';
const answer = parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const DIP = { w: LAPTOP.workArea.width / LAPTOP.scaleFactor, h: LAPTOP.workArea.height / LAPTOP.scaleFactor };

/** The real camera of the laptop window as the page applies it. */
function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M;
  const camera = new PerspectiveCamera(30, DIP.w / DIP.h, 0.05 * U, 400 * U);
  const world = { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical' as const,
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: { xM: 0, depthM: 8 } };
  applyWorldCamera(camera, world as never, 0.05);
  return camera;
}

async function geneStations() {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 8 });
  for (let i = 0; i < 30; i++) figure.frame(1 / 60);
  const body = nearBodyOf(figure)!, lens = laptopLens(), stations = nearStations(lens, body)!;
  return { fixture, figure, body, lens, stations };
}

test('Gene: the face station fits her head in the window and takes at most FACE_FILL of it; the eyes station is where the peek brings her eye; both come near', async () => {
  const { fixture, figure, body, lens, stations } = await geneStations();
  try {
    const perM = lens.heightPerM!, aFace = stations.faceDepthM + lens.camera.z;
    const share = 2 * body.headR / (perM * aFace), axisY = lens.camera.y + lens.axis.y / -lens.axis.z * aFace;
    const top = (body.headY + body.headR - axisY) / (perM * aFace) + 0.5, bottom = (body.headY - body.headR - axisY) / (perM * aFace) + 0.5; // 0 = the window's bottom edge
    if (REPORT) console.log('PULL_NEAR', JSON.stringify({ heightM: figure.heightM, headY: body.headY, headR: body.headR, camY: lens.camera.y, eyeForwardM: body.eyeForwardM, eyeSizeM: body.eyeSizeM, stations, share, top, bottom }));
    assert.ok(share <= FACE_FILL + 1e-9, `her head takes ${share} of the window's height`);
    assert.ok(bottom >= FACE_MARGIN / 2 - 1e-9 && top <= 1 - FACE_MARGIN / 2 + 1e-9, `her head fits the window: ${bottom}..${top}`);
    assert.ok(stations.faceDepthM >= 0.6 && stations.faceDepthM < 5, `the face station is near but a place the host keeps: ${stations.faceDepthM}`);
    assert.ok(stations.eyeDepthM < stations.gateDepthM && stations.gateDepthM < stations.faceDepthM);
    assert.ok(stations.faceDepthM - stations.eyeDepthM >= 0.3, 'the two stations are apart');
    assert.ok(stations.eyeDepthM > -lens.camera.z + 0.03, 'her eye stays in front of the lens, not through it');
    // A smaller figure or a camera farther off: the stations move (nothing is a written metre).
    const far = nearStations({ ...lens, camera: { ...lens.camera, z: lens.camera.z + 0.3 } }, body)!;
    assert.notEqual(far.eyeDepthM, stations.eyeDepthM);
    const big = nearStations(lens, { ...body, headR: body.headR * 2 })!;
    assert.ok(big.faceDepthM > stations.faceDepthM, 'a bigger head needs more room');
  } finally { figure.dispose(); fixture.close(); }
});

test('the pull may come to the eyes station, her own range stays 5–12.5 m; letting go: face or farther stays, between the gate and the face walks back, nearer than the gate is the peek', () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  assert.equal(clampFollowDepth(-5, s.eyeDepthM), -0.3, 'nearest: the eyes station');
  assert.equal(clampFollowDepth(30, s.eyeDepthM), 12.5);
  assert.equal(clampFollowDepth(2, s.eyeDepthM), 2);
  assert.equal(clampFollowDepth(1), 5, 'no stations known: the old limit');
  assert.equal(pullNearLimit(s, 5), -0.3);
  assert.equal(nearOutcome(8, s), 'stay'); assert.equal(nearOutcome(1.2, s), 'stay'); assert.equal(nearOutcome(1.19, s), 'face');
  assert.equal(nearOutcome(0.46, s), 'face'); assert.equal(nearOutcome(0.44, s), 'eyes'); assert.equal(nearOutcome(-0.3, s), 'eyes');
  assert.equal(nearOutcome(0.1, null), 'stay');
});


// ---- the page's pull: fake body, the wanted points and what the end says -----------------------------------------------------------

function rig(stations: NearStations | null, start = { x: 0, z: -8 }) {
  const goals: { x: number; z: number }[] = [], messages: UnboundPullMessage[] = [], ends: { outcome: string; face: { x: number; z: number } }[] = [];
  let clock = 0, steps = 0;
  const root = { ...start };
  const figure: UnboundPullFigure = {
    pullHit: () => ({ part: 'torso', side: null, group: 'torso', heightPx: 300 } as StagePullHit), pullStart: () => true, pullTo: () => {}, pullEnd: () => {},
    setPullStance: () => {}, pullShownM: () => ({ x: 0, z: 0 }), rootM: root, followTo: p => { goals.push({ ...p }); }, setStance: () => {}, heightM: 1.5,
    get report() { return { steps }; },
  };
  const camera = laptopCamera(), view = { camera, width: DIP.w, height: DIP.h };
  const pulls = new UnboundPull({
    figure: () => figure, view: () => view, eligible: () => true,
    send: async m => { messages.push(m); return m.phase === 'start' ? answer : undefined; },
    clampX: x => Math.min(1.5, Math.max(-1.5, x)), clampDepth: d => clampFollowDepth(d, stations?.eyeDepthM), clock: () => clock,
    near: () => stations, viewerDistanceM: () => 0.55, nearEnd: (outcome, face) => ends.push({ outcome, face }),
  });
  return {
    pulls, goals, messages, ends, root, clock: () => clock,
    async press(y0 = 300) { assert.ok(pulls.down(800, y0)); pulls.move(802, y0 + 20); clock += 100; pulls.frame(); await flush(); },
    async release() { pulls.up(); await flush(); },
    drag(dx: number, y: number) { pulls.move(800 + dx, y); clock += 50; pulls.frame(); },
    arrive(depth: number) { root.z = -depth; steps += 5; },
  };
}
const endMessage = (m: UnboundPullMessage[]) => m.filter(x => x.phase === 'report').pop() as Extract<UnboundPullMessage, { phase: 'report' }>;

test('page pull (the joystick, I-196): the pointer held below the press asks for nearer and nearer, to the eyes station and no nearer; above it she goes back, to 12.5 m and no farther', async () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  const r = rig(s);
  await r.press();
  let last = 8;
  for (let i = 0; i < 400; i++) { r.drag(0, 700); const goal = r.goals[r.goals.length - 1]; const depth = -goal.z; assert.ok(depth <= last + 1e-9, `${i}: ${depth}`); last = depth; r.root.z = goal.z; } // she arrives at each goal
  assert.ok(Math.abs(last - -0.3) < 1e-6, `all the way down: ${last}`);
  await r.release();
  const far = rig(s);
  await far.press(700);
  let farthest = 8;
  for (let i = 0; i < 400; i++) { far.drag(0, 100); const goal = far.goals[far.goals.length - 1]; farthest = Math.max(farthest, -goal.z); far.root.z = goal.z; }
  assert.ok(farthest > 8 && farthest <= 12.5 + 1e-9, `up is away, within 12.5 m: ${farthest}`);
});

test('page pull: let go at or beyond the face station, she stays where she stands and nothing is asked of the host', async () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  const r = rig(s);
  await r.press(); r.drag(0, 700); r.arrive(2.5); await r.release();
  const end = endMessage(r.messages);
  assert.equal(r.ends.length, 0);
  assert.deepEqual(end.place && Math.round(end.place.depthM * 10) / 10, 2.5);
  assert.equal(end.near, undefined);
  const at = rig(s);
  await at.press(); at.drag(0, 700); at.arrive(1.2); await at.release();
  assert.equal(at.ends.length, 0, 'at the face station exactly: she stays');
});

test('page pull: let go between the gate and the face she walks back to the face station and that is her place; no peek', async () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  const r = rig(s);
  await r.press(); r.drag(0, 700); r.arrive(0.8); await r.release();
  assert.deepEqual(r.ends.map(e => e.outcome), ['face']);
  const goal = r.goals[r.goals.length - 1];
  assert.ok(Math.abs(goal.z - -1.2) < 1e-9, `the wanted point is the face station: ${goal.z}`);
  const end = endMessage(r.messages);
  assert.equal(end.place?.depthM, 1.2);
  assert.equal(end.near, undefined, 'the host plays no peek for this');
});

test('page pull: let go nearer than the gate she stays put for the peek, the place is the face station and the report asks for the peek', async () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  const r = rig(s);
  await r.press(); r.drag(0, 700); r.arrive(0.1); await r.release();
  assert.deepEqual(r.ends.map(e => e.outcome), ['eyes']);
  const goal = r.goals[r.goals.length - 1];
  assert.ok(Math.abs(goal.z - -0.1) < 1e-9, `she is told to stay where she is: ${goal.z}`);
  const end = endMessage(r.messages);
  assert.equal(end.place?.depthM, 1.2);
  assert.equal(end.near, true);
  // IPC: the host takes only a plain true next to a place.
  assert.equal(parseUnboundPull({ phase: 'report', report: {}, near: true }) && (parseUnboundPull({ phase: 'report', report: {}, near: true }) as { near?: boolean }).near, undefined);
  assert.equal((parseUnboundPull({ phase: 'report', report: {}, place: { xM: 0, depthM: 1.2 }, near: 'yes' }) as { near?: boolean }).near, undefined);
  assert.equal((parseUnboundPull(JSON.parse(JSON.stringify(end))) as { near?: boolean }).near, true);
  assert.equal((pullReportMessage({} as never, { xM: 0, depthM: 1.2 }, true) as { near?: boolean }).near, true);
  // A pull that never walked (a lean, a tap) is not a near let-go.
  const none = rig(s, { x: 0, z: -0.1 });
  await none.press(); await none.release();
  assert.equal(none.ends.length, 0);
});

test('stations unknown (no body measured yet): the pull is what it was, nothing near happens', async () => {
  const r = rig(null);
  await r.press(); r.drag(0, 700); r.arrive(5); await r.release();
  assert.equal(r.ends.length, 0);
  assert.ok(-r.goals.filter(g => Number.isFinite(g.z)).pop()!.z >= 0, 'still a floor point');
});

// ---- she is not teleported while she goes back, and a peek that never comes is not the end of it -----------------------------------

test('NearReturn: busy until she stands at the face station; the eyes case waits for the peek, then lets her go when it is over; no peek: she walks back herself', () => {
  const face = { x: 0.2, z: -1.2 }, walks: { x: number; z: number }[] = [];
  const walkTo = (p: { x: number; z: number }) => walks.push(p);
  const a = new NearReturn();
  a.begin('face', face, 0);
  assert.equal(a.busy, true);
  a.frame(100, { x: 0.2, z: -0.8 }, true, false, walkTo); assert.equal(a.busy, true, 'still walking');
  a.frame(200, { x: 0.2, z: -1.2 }, false, false, walkTo); assert.equal(a.busy, false);
  const b = new NearReturn();
  b.begin('eyes', face, 0);
  b.frame(300, { x: 0.2, z: -0.1 }, false, false, walkTo); assert.equal(b.busy, true, 'waiting for the host');
  b.frame(400, { x: 0.2, z: -0.1 }, false, true, walkTo); b.frame(5000, { x: 0.2, z: -0.4 }, true, true, walkTo);
  assert.equal(b.busy, true, 'the peek plays');
  b.frame(9000, { x: 0.2, z: -1.2 }, false, false, walkTo); assert.equal(b.busy, false, 'the peek is over');
  assert.equal(walks.length, 0);
  const c = new NearReturn();
  c.begin('eyes', face, 0);
  c.frame(NEAR_WAIT_MS - 1, { x: 0.2, z: -0.1 }, false, false, walkTo); assert.equal(walks.length, 0);
  c.frame(NEAR_WAIT_MS + 1, { x: 0.2, z: -0.1 }, false, false, walkTo);
  assert.deepEqual(walks, [face], 'the host never sent a peek: she walks to the face station');
  c.frame(NEAR_WAIT_MS + 100, face, false, false, walkTo); assert.equal(c.busy, false);
  const d = new NearReturn(); d.begin('face', face, 0); d.cancel(); assert.equal(d.busy, false, 'you take hold of her again');
});

// ---- the host: the peek for a near let-go, and the buffer ---------------------------------------------------------------------------

function hostRig() {
  let now = 1_000_000, idle = 3, timers: (() => void)[] = [];
  const sent: PeekCommand[] = [], forced: boolean[] = [];
  let answered = 0;
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.5, idleSeconds: () => idle, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => { answered++; return true; },
    every: (_ms, run) => { timers.push(run); return () => { timers = timers.filter(t => t !== run); }; },
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  return { host, sent, forced, advance(ms: number) { now += ms; for (const t of [...timers]) t(); }, set idle(v: number) { idle = v; }, get answered() { return answered; } };
}

test('host: a near let-go starts a peek that is not counted and writes no mood; keys and the mouse after the let-go never send her back (2026-11-23)', () => {
  const f = hostRig();
  assert.equal(f.host.pulledNear(), true);
  const start = f.sent.find((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start')!;
  assert.equal(start.armAfterMs, NEAR_ARM_MS, 'the page arms its own mouse reading after the same buffer');
  f.idle = 0.4; f.advance(200); f.idle = 0; f.advance(200); // the hand leaves the mouse, a wiggle: inside the buffer
  f.idle = 0.6; f.advance(200); f.idle = 0; f.advance(200);
  assert.equal(f.sent.filter(c => c.type === 'cancel').length, 0, 'nothing in the buffer counts');
  f.idle = 2; f.advance(300); f.idle = 2.5; f.advance(200);
  assert.equal(f.sent.filter(c => c.type === 'cancel').length, 0, 'calm after the buffer: she stays');
  f.idle = 0; f.advance(200); f.idle = 2; f.advance(1_200);
  for (let i = 0; i < 10; i++) { f.idle = 0.05; f.advance(200); }
  assert.equal(f.sent.filter(c => c.type === 'cancel').length, 0, 'keys and the mouse going on: she stays');
  f.host.report({ id: start.id, phase: 'done' });
  assert.equal(f.answered, 0, 'never an O lift');
  assert.equal(f.host.view().lastAt, null, 'not counted as one of her own peeks');
});

test('host: no near peek while one is playing or when she is not shown', () => {
  const f = hostRig();
  assert.equal(f.host.pulledNear(), true);
  assert.equal(f.host.pulledNear(), false);
  assert.equal(parsePeekReport({ id: 'peek-1', phase: 'done' })?.phase, 'done');
});

test('page: the pull, the let-go and any mouse after it never send her back (2026-11-23: the director takes no pointer input); and holding her again is a new pull, not a fright', async () => {
  const lens = laptopLens(), home = { x: 0.2, z: -1.2 };
  const plan = planPeek({ ...NEUTRAL_MOOD, D: 70 }, () => 0.5);
  const director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {});
  assert.equal((director as unknown as { input?: unknown }).input, undefined, 'the director takes no pointer input at all');
  director.command({ type: 'start', id: 'peek-near', plan, trial: true, armAfterMs: NEAR_ARM_MS }, { lens, home });
  const body = { sense: null, setPoseTargets: () => {}, intentIdle: true };
  const world = { lens, home };
  for (let i = 0; i < 120; i++) director.frame(1 / 60, world, body); // 2 s of your hand on the mouse: nothing reaches her
  assert.equal(director.active, true);
  assert.equal(director.cancelled, null, 'the mouse never sent her back');
  assert.ok(PEEK_TIMING.trialArmMs >= NEAR_ARM_MS);
});

// ---- the real body: Gene is pulled all the way up, never faster than she walks, and let go at the eyes -----------------------------

test('Gene (real frame loop, 60 fps): pulled up she walks to the eyes station without a jump, the let-go asks for the peek and her place is the face station', async () => {
  const { fixture, figure, lens } = await geneStations();
  try {
    figure.place({ xM: 0, depthM: 8 });
    for (let i = 0; i < 60; i++) figure.frame(1 / 60);
    const camera = laptopCamera(), view = { camera, width: DIP.w, height: DIP.h };
    const messages: UnboundPullMessage[] = [], ends: string[] = [];
    let clock = 0;
    const stationsNow = () => nearStations(lens, nearBodyOf(figure)!);
    const pulls = new UnboundPull({
      figure: () => figure, view: () => view, eligible: () => true,
      send: async m => { messages.push(m); return m.phase === 'start' ? answer : undefined; },
      clampX: x => Math.min(1.5, Math.max(-1.5, x)), clampDepth: d => clampFollowDepth(d, stationsNow()?.eyeDepthM), clock: () => clock,
      near: stationsNow, viewerDistanceM: () => 0.55, nearEnd: outcome => ends.push(outcome),
    });
    const chest = () => { fixture.mesh.updateMatrixWorld(true); const p = fixture.mesh.skeleton.bones.find(b => b.name === '上半身2')!.getWorldPosition(new Vector3()).project(camera); return { x: (p.x + 1) / 2 * DIP.w, y: (1 - p.y) / 2 * DIP.h }; };
    const from = chest();
    assert.ok(pulls.down(from.x, from.y), 'the press lands on her');
    const steps: number[] = [], s = stationsNow()!;
    let prev = figure.rootM, minDepth = 8, released = false;
    const director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {}), phases = new Set<string>();
    const plan = planPeek({ ...NEUTRAL_MOOD, D: 70 }, () => 0.5);
    let home: { x: number; z: number } | null = null, peekStartedAt = -1, doneAt = -1;
    for (let frame = 0; frame < 60 * 90 && doneAt < 0; frame++) {
      clock = frame * 1000 / 60;
      const t = frame / 60;
      if (t < 20) { const k = Math.min(1, t / 1.5); pulls.move(from.x, from.y + k * 0.5 * DIP.h); }
      else if (!released) { pulls.up(); released = true; }
      pulls.frame(); await Promise.resolve(); await Promise.resolve();
      if (released && peekStartedAt < 0 && t >= 20.2) { // the host: her place first, then the peek with the buffer
        const end = endMessage(messages);
        home = { x: end.place!.xM, z: -end.place!.depthM }; peekStartedAt = t;
        director.command({ type: 'start', id: 'peek-near', plan, trial: true, armAfterMs: NEAR_ARM_MS }, { lens, home });
      }
      if (home) { director.frame(1 / 60, { lens, home }, figure); if (director.phase) phases.add(director.phase); if (peekStartedAt >= 0 && !director.active && t > peekStartedAt + 1) doneAt = t; }
      figure.frame(1 / 60);
      const root = figure.rootM; steps.push(Math.hypot(root.x - prev.x, root.z - prev.z) * 100); prev = { ...root };
      minDepth = Math.min(minDepth, -root.z);
    }
    const walkCap = 0.8 / 60 * 100;
    if (REPORT) console.log('PULL_NEAR_BODY', JSON.stringify({ minDepth, eyes: s.eyeDepthM, face: s.faceDepthM, gate: s.gateDepthM, maxStepCm: Math.max(...steps), walkCapCm: walkCap, ends, end: messages[messages.length - 1] }));
    assert.ok(minDepth < s.gateDepthM, `she came nearer than the gate: ${minDepth} (gate ${s.gateDepthM})`);
    assert.ok(minDepth >= s.eyeDepthM - 0.1, `never past the eyes station: ${minDepth} (${s.eyeDepthM})`);
    assert.deepEqual(ends, ['eyes']);
    const end = endMessage(messages);
    assert.equal(end.near, true);
    assert.ok(Math.abs(end.place!.depthM - s.faceDepthM) < 1e-9, 'her place is the face station');
    // The peek from there: leans in, stares, backs off, and she stands at the face station, never faster than she walks.
    assert.ok(doneAt > 0, 'the peek ended');
    for (const phase of ['lean', 'hold', 'back', 'settle']) assert.ok(phases.has(phase), `the peek reached ${phase}`);
    const last = figure.rootM;
    assert.ok(Math.hypot(last.x - home!.x, last.z - home!.z) < 0.05, `back at the face station: ${last.z} vs ${home!.z}`);
    assert.ok(Math.max(...steps) <= walkCap * 1.6, `no frame faster than she walks, the peek included: ${Math.max(...steps)} cm`);
    if (REPORT) console.log('PULL_NEAR_PEEK', JSON.stringify({ doneAt, peekS: doneAt - peekStartedAt, phases: [...phases] }));
  } finally { figure.dispose(); fixture.close(); }
});
