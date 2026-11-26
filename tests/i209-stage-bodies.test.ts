// I-209 step 3: the shared stage's pure rules (shared/unbound/company/bodies.ts, floor.ts): never through anyone (keepApart), the one
// approached steps aside first or cannot (asideGoal), the windows' order (stackOrder), one voice (StageFloor), and
// what crosses the wire is checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asideGoal, contactM, keepApart, obstaclesFor, parseStageBody, parseStageView, stackOrder, StageFloor, type StageBody, type StageOther } from '../shared/unbound/company';

const body = (over: Partial<StageBody> = {}): StageBody => ({ xM: 0, depthM: 8, radiusM: 0.25, heightM: 1.6, faceM: 1.47, dipM: 0, vxM: 0, vdM: 0, pulled: false, closing: false, free: true, ...over });
const other = (id: string, over: Partial<StageBody> = {}): StageOther => ({ id, ...body(over) });
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('keepApart: 4000 random walks never end inside anyone, and a clear walk is untouched', () => {
  const r = rng(3);
  for (let n = 0; n < 4000; n++) {
    const root = { x: -2 + 4 * r(), z: -(5 + 5 * r()) }, goal = { x: -2 + 4 * r(), z: -(5 + 5 * r()) };
    const obstacles = [0, 1].map(() => ({ x: -2 + 4 * r(), z: -(5 + 5 * r()), reachM: 0.4 + 0.3 * r() })).filter(o => Math.hypot(root.x - o.x, root.z - o.z) >= o.reachM);
    const kept = keepApart(root, goal, obstacles);
    for (const o of obstacles) {
      // Every point of the walk to `kept` stays outside.
      for (let s = 0; s <= 1; s += 0.05) assert.ok(Math.hypot(root.x + (kept.x - root.x) * s - o.x, root.z + (kept.z - root.z) * s - o.z) >= o.reachM - 1e-9, `scene ${n}`);
    }
  }
  const goal = { x: 1, z: -8 };
  assert.equal(keepApart({ x: -1, z: -8 }, goal, [{ x: 0, z: -6, reachM: 0.5 }]), goal);
  const inside = { x: 0.1, z: -8 };
  assert.deepEqual(keepApart(inside, { x: -0.5, z: -8 }, [{ x: 0, z: -8, reachM: 0.5 }]), inside, 'already touching: never deeper, nor through her middle');
  assert.deepEqual(keepApart(inside, { x: 1, z: -8 }, [{ x: 0, z: -8, reachM: 0.5 }]), { x: 1, z: -8 }, 'but always straight out of it');
});

test('asideGoal: sideways out of the way she comes (back when right in line), only while free, null at the edge or into a third', () => {
  const bounds = { minX: -3, maxX: 3, minDepthM: 1.5, maxDepthM: 20 };
  const coming = other('a', { xM: -0.7, vxM: 0.8, goal: { xM: 2, depthM: 8 } });
  const step = asideGoal(body(), [coming], bounds)!;
  assert.ok(step, 'she steps');
  assert.ok(Math.abs(step.x) < 1e-6 && -step.z > 8.5, `right in line across the screen: she steps back (${JSON.stringify(step)})`);
  assert.equal(asideGoal(body({ free: false }), [coming], bounds), null, 'pulled, walking or in a moment: she does not');
  assert.equal(asideGoal(body(), [other('a', { xM: -2.5 })], bounds), null, 'nobody coming');
  const towardYou = other('a', { xM: -0.05, depthM: 8.7, vdM: -0.8, goal: { xM: -0.05, depthM: 4 } });
  const across = asideGoal(body(), [towardYou], bounds)!;
  assert.ok(across.x > 0.2 && Math.abs(-across.z - 8) < 1e-6, 'pulled toward you through her: she steps aside across, to her own side');
  assert.equal(asideGoal(body({ xM: 2.95 }), [other('a', { xM: 2.9, depthM: 8.7, vdM: -0.8, goal: { xM: 2.9, depthM: 4 } })], bounds), null, 'at the edge: she cannot (the one coming stops at contact)');
  assert.equal(asideGoal(body(), [coming, other('c', { xM: 0, depthM: 8.9, free: false })], bounds), null, 'not into a third one');
});

test('stackOrder: windows far to near, with hysteresis', () => {
  const bodies = new Map([['a', body({ depthM: 9 })], ['b', body({ depthM: 6 })], ['c', body({ depthM: 7 })]]);
  assert.deepEqual(stackOrder(bodies), ['a', 'c', 'b']);
  assert.deepEqual(stackOrder(new Map([['a', body({ depthM: 6.02 })], ['b', body({ depthM: 6 })]]), ['b', 'a']), ['b', 'a'], 'about the same depth: the order holds');
  assert.equal(contactM(body(), body()), 0.53);
  assert.equal(obstaclesFor(0.25, [body({ xM: 1, vxM: 1 })], 0.1)[0]!.x, 1.1, 'others predicted ahead');
});

test('one voice: the floor goes to the first line, the others wait in order; a line that ends or someone who leaves passes it on', () => {
  const floor = new StageFloor();
  assert.equal(floor.ask('r1', 'a'), 'now');
  assert.equal(floor.ask('r2', 'b'), 'queued');
  assert.equal(floor.ask('r3', 'c'), 'queued');
  assert.equal(floor.holder!.owner, 'a');
  assert.equal(floor.end('r1')!.owner, 'b');
  assert.equal(floor.leave('b')!.owner, 'c');
  assert.equal(floor.end('r3'), null);
});

test('one voice: the line the voice sounds takes the floor from a line that never ended; the queue keeps its order', () => {
  const floor = new StageFloor();
  floor.ask('mumi-1', 'mumi'); // her line took the floor and its end never came (never voiced, or its done came after the voice stopped)
  assert.equal(floor.ask('one-1', 'one'), 'queued');
  floor.ask('gene-1', 'gene');
  assert.equal(floor.sounding('one-1', 'one')!.owner, 'one', 'One sounds: the floor is hers, not the stale holder\'s');
  assert.deepEqual(floor.queue.map(turn => turn.replyId), ['gene-1'], 'the stale line is over, the one still waiting keeps its place');
  assert.equal(floor.sounding('one-1', 'one')!.replyId, 'one-1', 'the same line again changes nothing');
  assert.equal(floor.end('one-1')!.owner, 'gene');
  assert.equal(floor.sounding('x-1', 'x')!.owner, 'x', 'a line never asked for (no bubble yet) sounds: hers');
});

test('the wire: a body or a view out of range is refused, never guessed', () => {
  assert.equal(parseStageBody({ ...body(), radiusM: 9 }), null);
  assert.equal(parseStageBody({ ...body(), xM: Number.NaN }), null);
  assert.deepEqual(parseStageBody({ ...body(), goal: { xM: 1, depthM: 99 } })!.goal, undefined, 'a goal out of range is left out');
  assert.equal(parseStageView({ present: 4, self: 'a', others: [] }), null, 'at most three');
  assert.equal(parseStageView({ present: 2, self: '../x', others: [] }), null);
  const view = parseStageView({ present: 2, self: 'a', subject: { id: 'b', depthM: 6, heightM: 1.6, faceM: 1.4, dipM: 0, vdM: 0 }, others: [{ id: 'b', ...body() }, { id: 'c' }] })!;
  assert.equal('subject' in view, false, '2026-11-25: no shared eye crosses the wire (an old page or host sending one changes nothing)');
  assert.equal(view.others.length, 1, 'a malformed other is left out');
});
