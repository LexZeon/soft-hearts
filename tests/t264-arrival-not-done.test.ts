// T-264 (Codex, docs/claude/2026-11-22-i185-words-kiss-hug.md "2026-11-23 T-264"): a kiss or a hug is recorded as done only when her face really
// arrived. Two minimal inputs from Codex's report, through the real Director, the real close-moment performance and the real host, with a
// fake skeleton (the eyes are scripted; the camera is Codex's: (0, 1.5, 0), axis -z, a window of +-0.5 per metre):
//  1. the mouth stays out of the window for the whole arrival wait: she backs off, nothing is recorded;
//  2. the checker is running and then one eye's reading is lost on the key frame: a missing eye is never "in the window".
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { NEUTRAL_MOOD, parsePeekReport, type PeekCommand, type PeekPhase } from '../shared/unbound/director';
import { closeMissedLine, type CloseHappened } from '../shared/unbound/close-moments';
import { PeekDirectorHost, type PeekLink, type PeekPorts } from '../electron/unbound/peek';
import { CloseMomentsHost, type CloseMomentPorts } from '../electron/unbound/close-moments';
import { Director } from '../src/unbound/director/director';
import { closeMomentAction } from '../src/unbound/director/close-moment';
import { REST_TARGETS, type BodySense, type MotionRequest } from '../src/unbound/motion/generator';
import type { LensView, V3 } from '../src/unbound/motion/lens-align';

const WARM = { ...NEUTRAL_MOOD, O: 80, E: 66, D: 62, M: 20 };
const LENS: LensView = { camera: { x: 0, y: 1.5, z: 0 }, axis: { x: 0, y: 0, z: -1 }, heightPerM: 1, window: { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5 } };
const HOME = { x: 0, z: -1.2 };
const FPS = 60;

type Eyes = { left: V3 | null; right: V3 | null };

function rig(kind: 'kiss' | 'hug') {
  let now = 1_700_000_000_000;
  const sent: PeekCommand[] = [], moments: string[] = [], happened: CloseHappened[] = [], notReached: { kind: string }[] = [];
  const closePorts: CloseMomentPorts = {
    clock: () => now, random: () => 0.4, day: () => 'today', mood: () => ({ ...WARM }), view: () => null,
    typing: () => false, playing: () => false, moment: k => { moments.push(k); return true; }, happened: item => happened.push(item),
  };
  const close = new CloseMomentsHost(closePorts);
  const ports: PeekPorts = {
    clock: () => now, random: () => 0.4, idleSeconds: () => 120, asleep: () => false, inCall: () => false, userTalking: () => true,
    mood: () => ({ ...WARM }), lastInteractionAt: () => null, answered: () => true, readingAloud: () => false,
    every: () => () => {}, close,
    notes: { missed: () => {}, interrupted: () => {}, notReached: (k: 'kiss' | 'hug') => { notReached.push({ kind: k }); } } as never,
  };
  const link: PeekLink = { shown: () => true, fullscreen: () => false, send: c => sent.push(c), changed: () => {} };
  const host = new PeekDirectorHost(ports, link);
  assert.equal(host.chatBeat(kind), 'play');
  const start = sent.find((c): c is Extract<PeekCommand, { type: 'start' }> => c.type === 'start')!;
  return { host, close, moments, happened, notReached, start };
}

/**
 * Plays the whole performance. `eyesAt`: the eyes this frame (a null eye = its reading lost). The root follows the place the performance
 * asks for on the next frame, as a gait that arrived.
 */
function play(kind: 'kiss' | 'hug', eyesAt: (ctx: { phase: PeekPhase | null; sinceLean: number; approachS: number }) => Eyes) {
  const f = rig(kind), plan = f.start.plan as unknown as { approachS: number };
  const root = { x: 0.5, z: -2.2 }, requests: MotionRequest[] = [];
  const phases: PeekPhase[] = [], reports: unknown[] = [];
  let performance: { target: { arrived: boolean | null; waitS: number } | null } | null = null;
  const action = closeMomentAction({ near: () => null, mouth: () => ({ mayStart: true, speaking: false }), armsFree: () => true, armsCan: () => true });
  const wrapped = { id: action.id, begin: (...args: Parameters<typeof action.begin>) => { const p = action.begin(...args); performance = p as never; return p; } };
  const generator = { generate: (request: MotionRequest) => { requests.push(request); return { ...REST_TARGETS }; }, reset() {} } as never;
  const director = new Director([wrapped], generator, report => { reports.push(report); f.host.report(report); });
  director.command(f.start, { lens: LENS, home: HOME });
  let leanAt: number | null = null, phase: PeekPhase | null = null;
  const body = { sense: null as BodySense | null, setPoseTargets() {}, intentIdle: true };
  for (let k = 0; k < FPS * 60 && (k === 0 || director.active); k++) {
    const t = k / FPS, eyes = eyesAt({ phase, sinceLean: leanAt === null ? 0 : t - leanAt, approachS: plan.approachS });
    const both = eyes.left && eyes.right;
    body.sense = {
      root: { ...root, heading: 0 }, moving: false, eyes,
      head: both ? { x: (eyes.left!.x + eyes.right!.x) / 2, y: (eyes.left!.y + eyes.right!.y) / 2 - 0.03, z: (eyes.left!.z + eyes.right!.z) / 2 - 0.03 } : { x: 0, y: 1.43, z: -0.23 },
      frame: { eyes: { left: { x: 0.03, y: 1.46, z: -0.2 }, right: { x: -0.03, y: 1.46, z: -0.2 } }, pivot: { x: 0, y: 0.9, z: 0 } },
      offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: 0.02, tiptoeRise: 0,
      face: { eyes: { x: 0, y: 0.03, z: 0.03 }, eyeSizeM: 0.02, mouthDropM: 0.08, points: [{ x: 0, y: 0.03, z: 0.03 }] },
    };
    director.frame(1 / FPS, { lens: LENS, home: HOME }, body);
    const intent = requests.at(-1)?.intent as { place?: { x: number; z: number } | null } | undefined;
    if (intent && 'place' in intent && intent.place) { root.x = intent.place.x; root.z = intent.place.z; }
    const now = director.phase;
    if (now !== phase) { phase = now; if (now) phases.push(now); if (now === 'lean') leanAt = t; }
  }
  return { f, phases, reports: reports.map(r => parsePeekReport(r)!), performance: performance as unknown as { target: { arrived: boolean | null; waitS: number } | null } };
}

const counts = (f: ReturnType<typeof rig>) => ({ moments: f.moments.length, happened: f.happened.length, done: f.close.view().done });

test('T-264 input 1 (kiss): her mouth stays out of the window for the whole wait: she backs off, nothing is recorded as done, the host is told it did not happen', () => {
  const fixed: Eyes = { left: { x: 0.03, y: 1.46, z: -0.2 }, right: { x: -0.03, y: 1.46, z: -0.2 } };
  const r = play('kiss', () => fixed);
  assert.equal(r.performance.target?.arrived, false, 'her face never arrived');
  assert.ok(!r.phases.includes('hold'), `no hold began (${r.phases.join(' > ')})`);
  assert.ok(r.phases.includes('back') && r.reports.at(-1)?.phase === 'done', 'she backed off and finished');
  assert.deepEqual(counts(r.f), { moments: 0, happened: 0, done: 0 }, 'not recorded: no mood moment, no history, no cooldown');
  assert.equal(r.f.close.history.lastAt(), null, 'no cooldown started');
  assert.equal(r.reports.find(p => p.phase === 'back')?.cancelled, 'unreached', 'the report says why');
  assert.deepEqual(r.f.notReached, [{ kind: 'kiss' }], 'journaled and told once');
  assert.ok(Math.abs(r.performance.target!.waitS - ARRIVAL_KNOBS.arriveWaitS) <= 1.5 / FPS, `the wait ended at its limit (${r.performance.target!.waitS} s)`);
});

test('T-264 input 2 (hug): one eye\'s reading is lost on the key frame: a missing eye is not "in the window" — she waits, and at the wait\'s end backs off; nothing recorded', () => {
  const left: V3 = { x: -0.02, y: 1.541, z: -0.15 }, right: V3 = { x: -0.08, y: 1.541, z: -0.15 };
  // The control: the same frames with the right eye kept (it is outside the window: u -1.067): she never holds.
  const control = play('hug', () => ({ left, right }));
  assert.ok(!control.phases.includes('hold'), 'control: she never holds');
  assert.deepEqual(counts(control.f), { moments: 0, happened: 0, done: 0 });
  let lost = false;
  const r = play('hug', ({ sinceLean, approachS, phase }) => {
    if (phase === 'lean' && sinceLean >= approachS) { lost = true; return { left, right: null }; }
    return { left, right };
  });
  assert.ok(lost, 'the key frame came');
  assert.ok(!r.phases.includes('hold'), `the lost eye did not end the wait early (${r.phases.join(' > ')})`);
  assert.notEqual(r.performance.target?.arrived, true, 'never marked arrived');
  assert.deepEqual(counts(r.f), { moments: 0, happened: 0, done: 0 });
  assert.ok(r.performance.target!.waitS >= ARRIVAL_KNOBS.arriveWaitS - 1.5 / FPS, `she waited the whole limit (${r.performance.target!.waitS} s)`);
  assert.deepEqual(r.f.notReached, [{ kind: 'hug' }]);
});

test('what she is told next turn: an action that did not happen is information, with no instruction and no number', () => {
  const kiss = closeMissedLine([{ kind: 'kiss', block: 'unreached', at: 1 }]), hug = closeMissedLine([{ kind: 'hug', block: 'unreached', at: 1 }]);
  assert.match(kiss, /亲/); assert.match(hug, /抱/);
  for (const line of [kiss, hug]) {
    assert.match(line, /没做成/, 'says it did not happen');
    assert.ok(!/\d/.test(line) && !/(必须|应该|不要|别)/.test(line), line);
  }
});
