// I-192 arrival targets on every bundled model (docs/claude/2026-11-22-i192-arrival-targets.md), in the real full-screen frame loop with the page's
// own camera (the floor framing following her, the near plane following her nearest point): tests/helpers/unbound-arrival.ts. The user:
//  - "要像我们最初的凑近屏幕看看一样近"; "抱抱重点不是手收拢，在unbound里是脸贴过来……终点大概是到只看得到闭眼的稍稍侧的脸。亲亲同理。"
//    → the kiss and the hug bring her face (the point between her eyes and her mouth) onto the lens axis at its arrival distance, within tolerance;
//  - "注意不能穿模摄像头那一块" → at every frame nothing of her that the camera shows (head, hair with room to swing, nose, hands, arms) is nearer
//    than the near plane plus a margin, and nothing of her passes the viewer's eye plane at all;
//  - "嘟嘴没有展示出来" → the pucker shows during the kiss hold; while she speaks it waits, and the hold goes on until it has shown;
//  - "撑了1.5秒左右" → the hold is her own length (seconds), a nudge of the mouse never ends it, a clear move does after a short grace;
//  - R29: no teleport, no jolt (the unexpected step at 60 and 30 fps stays at the walking level the I-184 performance had).
// I192_REPORT=1 prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { axisOffset } from '../src/unbound/motion/lens-align';
import { faceAimNow } from '../src/unbound/motion/arrive';
import { ARRIVAL_KNOBS, headPointNow, windowPoint, type HeadOffset } from '../shared/unbound/arrival';
import { boneSurprises, inWindow, max, pointSurprises, runArrival, type ArrivalFrame, type ArrivalModel, type ArrivalRun } from './helpers/unbound-arrival';
import { closeFraming, type CloseFraming } from './helpers/close-framing';

const REPORT = process.env.I192_REPORT === '1';
// I-203: every run also keeps where her face sits on the screen in the approach, the hold and the way back (tests/helpers/close-framing.ts).
type FramedRun = ArrivalRun & { framings: CloseFraming[] };
const cache = new Map<string, Promise<FramedRun>>();
const run = (model: ArrivalModel, fps: number, kind: 'kiss' | 'hug' | 'look', options: Parameters<typeof runArrival>[3] = {}, key = '') => {
  const k = `${model}/${fps}/${kind}/${key}`, framings: CloseFraming[] = [];
  if (!cache.has(k)) cache.set(k, runArrival(model, fps, kind, { ...options, inspect: (frame, mesh, camera, figure, meshes) => {
    options.inspect?.(frame, mesh, camera, figure, meshes);
    if (kind !== 'look' && frame.phase && frame.phase !== 'notice') framings.push(closeFraming(frame, figure.sense?.face ?? null, figure.sense?.root.heading ?? 0));
  } }).then(r => ({ ...r, framings })));
  return cache.get(k)!;
};
const pick = (r: ArrivalRun, test: (name: string) => boolean) => r.boneNames.flatMap((n, i) => test(n) ? [i] : []);

function numbers(r: ArrivalRun) {
  const hold = r.frames.filter(f => f.phase === 'hold'), late = hold.slice(Math.floor(hold.length * 0.4));
  // Her point (the kiss: below her eyes; the hug: her ear) against where it goes (I-203: the hug's ear at the screen's right).
  const t = r.target as { dropM?: number; point?: HeadOffset | null; spot?: { u: number; v: number } } | null, drop = t?.dropM ?? 0;
  const aims = late.map(f => { const a = t?.point ? headPointNow(f.eyes, t.point) : faceAimNow(f.eyes, drop); if (!a) return null;
    const goal = axisOffset(f.lens, windowPoint(f.lens, axisOffset(f.lens, a).along, t?.spot ?? { u: 0, v: 0 })), at = axisOffset(f.lens, a);
    return { along: at.along, off: Math.abs(at.off - goal.off) }; }).filter((a): a is { along: number; off: number } => !!a);
  const near = r.frames.filter(f => f.nearest);
  // I-192 follow-up: both eyes and her mouth in the window (the worst |u| or |v|; ≤ 1 inside), at the first hold frame and through the hold.
  const framing = (f: ArrivalFrame) => Math.max(...[f.eyes.left, f.eyes.right, f.mouth].map(p => p ? Math.max(Math.abs(inWindow(f.view, p).u), Math.abs(inWindow(f.view, p).v)) : Infinity));
  return {
    // The arrival distance her aim really goes to (pushed out so her eyes and mouth fit), the planned one, and whether the hold began with her face there.
    target: r.target?.framedM ?? r.target?.distanceM ?? null, planned: r.target?.distanceM ?? null, clipped: r.target?.clipped ?? null,
    arrived: r.target?.arrived ?? null, waitS: r.target?.waitS ?? null,
    firstHoldFrame: hold.length ? framing(hold[0]) : null, holdFrame: hold.length ? max(hold.map(framing)) : null,
    aimAlong: aims.length ? [Math.min(...aims.map(a => a.along)), max(aims.map(a => a.along))] : null, aimOff: aims.length ? max(aims.map(a => a.off)) : null,
    holdS: r.holdS, plannedHoldS: (r.plan as { holdS: number }).holdS,
    pucker: hold.length ? max(hold.map(f => f.pucker)) : 0,
    viewMargin: near.length ? Math.min(...near.map(f => f.nearest!.view - f.nearM)) : null, nearestView: near.length ? Math.min(...near.map(f => f.nearest!.view)) : null,
    nearestAll: near.length ? Math.min(...near.map(f => f.nearest!.all)) : null,
    rootCm: max(pointSurprises(r.frames.map(f => f.root))), headCm: max(pointSurprises(r.frames.map(f => f.head))),
    torsoDeg: max(boneSurprises(r.frames, pick(r, n => /^(センター|上半身2?|首|頭)$/.test(n)))), upperDeg: max(boneSurprises(r.frames, pick(r, n => !/足|ひざ/.test(n)))),
    phases: [...new Set(r.frames.map(f => f.phase).filter(Boolean))], home: r.frames.at(-1)!.root,
  };
}
const NEAR_MARGIN = 0.005;

const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
/** I-203: where her face sits on the screen through the hold, and her head where she begins (tests/helpers/close-framing.ts). */
function framingNumbers(r: FramedRun) {
  const hold = r.framings.filter(f => f.phase === 'hold'), start = r.framings.find(f => f.phase === 'lean') ?? null;
  const pick = (get: (f: CloseFraming) => number | null | undefined) => hold.map(get).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const lean = r.frames.find(f => f.phase === 'lean')?.t ?? NaN, held = r.frames.find(f => f.phase === 'hold')?.t ?? NaN;
  return {
    eyesV: median(pick(f => f.eyes?.[1])), mouthV: median(pick(f => f.mouth?.[1])), eyesU: max(pick(f => Math.abs(f.eyes?.[0] ?? NaN))), mouthU: max(pick(f => Math.abs(f.mouth?.[0] ?? NaN))),
    earU: median(pick(f => f.ear?.[0])), earV: median(pick(f => f.ear?.[1])), headShare: median(pick(f => f.headShare)), crownV: median(pick(f => f.crownV)),
    turnMin: Math.min(...pick(f => f.turnDeg)), eyesUMin: Math.min(...pick(f => f.eyes?.[0])), startShare: start?.headShare ?? null, arriveS: held - lean,
    dipMax: max(r.frames.map(f => f.cameraDipM)), dipEnd: r.frames.at(-1)!.cameraDipM,
  };
}

for (const model of ['Gene', 'VRM'] as const) for (const kind of ['kiss', 'hug'] as const) for (const fps of [60, 30]) {
  test(`${model} ${kind} ${fps} fps: her face arrives where the user drew it (I-203), nothing of her comes into the camera, no jolt, her own hold`, async () => {
    // The synthetic VRM's arms cannot move (its standard body has no mesh); its hug is the same face arrival (I-192 follow-up), its arms stay still.
    const r = await run(model, fps, kind), n = numbers(r), s = framingNumbers(r), k = 60 / fps;
    if (REPORT) console.log(`[I-192/I-203 ${model} ${kind} ${fps}]`, JSON.stringify(n), JSON.stringify(s));
    assert.deepEqual(n.phases, ['notice', 'walk', 'lean', 'hold', 'back', 'settle'], 'every beat (she walks first to where she begins)');
    assert.ok(n.planned !== null && n.planned >= ARRIVAL_KNOBS.minFaceM - 1e-9 && n.planned <= (kind === 'kiss' ? 0.36 : 0.7), `her point's arrival distance (${n.planned} m)`);
    // I-192 follow-up (Codex T-263): the hold began with her face there; T-264: a bounded wait.
    assert.equal(n.arrived, true, `her face got there before the hold (after ${n.waitS} s)`);
    assert.ok(n.waitS! <= ARRIVAL_KNOBS.arriveWaitS + 1e-9, `a bounded wait (${n.waitS} s)`);
    assert.ok(n.target! >= n.planned! - 1e-9 && n.target! <= n.planned! * 1.45, `pushed out only as far as her eyes and mouth need (${n.planned} → ${n.target} m)`);
    assert.ok(n.aimAlong && n.aimAlong[0] > n.planned! - 0.03 && n.aimAlong[1] < n.target! + 0.03, `reached within 3 cm (${n.aimAlong} vs ${n.planned}…${n.target})`);
    // I-203: the storyboard's 01: her head about a fifth of the screen's width where she begins.
    assert.ok(s.startShare !== null && s.startShare > 0.12 && s.startShare < 0.3, `where she begins: her head ${s.startShare} of the width`);
    if (kind === 'kiss') {
      // The storyboard's 03/04: both eyes in the upper part, her mouth in the lower part, both centred, her face across the screen, the top edge
      // through her hair. The close-up camera sits above what her toes can reach: the viewer's eye dips a little to meet her (the lead's review).
      assert.ok(n.firstHoldFrame! <= 1 && n.holdFrame! <= 1.02, `both eyes and her mouth in the window when the hold begins (${n.firstHoldFrame}) and through it (${n.holdFrame})`);
      assert.ok(s.eyesV > 0.3 && s.eyesV < 0.7 && s.mouthV < -0.45 && s.mouthV > -0.9, `eyes up (${s.eyesV}), mouth down (${s.mouthV})`);
      assert.ok(s.dipMax > 0.005 && s.dipMax <= ARRIVAL_KNOBS.kissDipMaxM + 1e-9 && s.dipEnd < 1e-3, `the eye dips a little and comes back (${s.dipMax} m, at the end ${s.dipEnd})`);
      assert.ok(s.eyesU < 0.2 && s.mouthU < 0.2, `centred (${s.eyesU}, ${s.mouthU})`);
      assert.ok(s.crownV > 1, `the top of her head out of frame: the top edge cuts through her hair (${s.crownV})`);
      assert.ok(s.headShare > (model === 'Gene' ? 0.8 : 0.5), `her face across the screen (${s.headShare} of the width)`);
      assert.ok(n.aimOff !== null && n.aimOff < 0.035, `near the axis (${n.aimOff} m)`);
    } else {
      // The hug's last frame: her ear about three quarters across at mid-height, her head about 2/5 of the width, the top of her head out of frame,
      // her face turned OUTWARD (toward the screen's right) and cut by the right edge. Never toward the centre.
      assert.ok(s.earU > 0.25 && s.earU < 0.6 && s.earV > -0.5 && s.earV < 0.25, `her ear at the screen's right, mid-height (${s.earU}, ${s.earV})`);
      assert.ok(s.headShare > 0.3 && s.headShare < 0.5, `her head about 2/5 of the width (${s.headShare})`);
      assert.ok(s.crownV > 0.98, `the top of her head at or past the top edge (${s.crownV})`);
      assert.ok(s.turnMin > 25, `her face turned outward, to the screen's right, through the whole hold (at least ${s.turnMin}°)`);
      assert.equal(s.dipMax, 0, 'the hug never moves the camera');
      assert.ok(s.eyesUMin > 0.6, `her face at the right edge (her eyes from ${s.eyesUMin} across)`);
    }
    assert.ok(s.arriveS < 3, `from where she begins to arrived in ${s.arriveS} s (the storyboard: about 1.7)`);
    assert.ok(n.viewMargin !== null && n.viewMargin > NEAR_MARGIN, `what the camera shows stays beyond the near plane (+${n.viewMargin} m)`);
    assert.ok(n.nearestView! > ARRIVAL_KNOBS.minClearM - 0.01, `and out of the camera (${n.nearestView} m, her hair counted ${ARRIVAL_KNOBS.hairSwingM} m nearer)`);
    assert.ok(n.nearestAll! > 0, `nothing of her, arms included, passes the viewer's eye plane (${n.nearestAll} m)`);
    assert.ok(n.rootCm < 0.1 * k * k && n.headCm < 0.35 * k * k, `no teleport (root ${n.rootCm}, head ${n.headCm} cm)`);
    assert.ok(n.torsoDeg < 0.3 * k * k && n.upperDeg < 0.3 * k * k, `no jolt (torso ${n.torsoDeg}°, arms included ${n.upperDeg}°)`);
    assert.ok(n.holdS >= n.plannedHoldS - 0.05 && n.plannedHoldS >= ARRIVAL_KNOBS.closeHoldMinS, `her own hold (${n.holdS} s)`);
    // The pucker is her choice (I-203): it shows in the hold when she chose it, never otherwise.
    const puckered = (r.plan as { extras?: string[] }).extras?.includes('pucker') ?? false;
    if (puckered) assert.ok(n.pucker > 0.8, `the pucker she chose shows in the hold (${n.pucker})`); else assert.equal(n.pucker, 0, 'no pucker she did not choose');
    assert.ok(Math.hypot(n.home.x - 0.25, n.home.z + 2) < 0.06, 'back home');
  });
}

for (const model of ['Gene', 'VRM'] as const) {
  test(`${model} 60 fps: she speaks through the walk and into the hold — the pucker waits (never while she speaks), the hold goes on until it has shown`, async () => {
    const speakUntil = 13, r = await run(model, 60, 'kiss', { speaking: t => t > 3 && t < speakUntil }, 'speaking'), n = numbers(r);
    const hold = r.frames.filter(f => f.phase === 'hold');
    if (REPORT) console.log(`[I-192 ${model} kiss speaking]`, JSON.stringify({ holdS: n.holdS, holdFrom: hold[0]?.t, holdTo: hold.at(-1)?.t, pucker: n.pucker }));
    assert.ok(hold[0].t < speakUntil, 'she was still speaking when the hold began');
    assert.equal(max(r.frames.filter(f => f.t > 3 && f.t < speakUntil).map(f => f.pucker)), 0, 'never while she speaks');
    assert.ok(n.pucker > 0.8, `then it shows (${n.pucker})`);
    assert.ok(hold.at(-1)!.t >= speakUntil + ARRIVAL_KNOBS.afterSpeechS - 0.1, `the hold went on past her words (${hold.at(-1)!.t} s)`);
  });

  test(`${model} 60 fps: the look closely (peek) — her own hold, and nothing of her comes into the camera`, async () => {
    const n = numbers(await run(model, 60, 'look'));
    if (REPORT) console.log(`[I-192 ${model} look]`, JSON.stringify(n));
    assert.ok(n.plannedHoldS >= 3 && n.holdS >= n.plannedHoldS - 0.05, `her own hold (${n.holdS} s; the user saw 1.5)`);
    assert.ok(n.viewMargin !== null && n.viewMargin > NEAR_MARGIN && n.nearestAll! > 0, `beyond the near plane (+${n.viewMargin}), never past the eye plane (${n.nearestAll})`);
  });
}

test('Gene 60 fps: a large pull during the hold ends it at once, from where she is (no jolt); the mouse has no way to end it at all (2026-11-23)', async () => {
  const base = await run('Gene', 60, 'kiss'), holdAt = base.frames.find(f => f.phase === 'hold')!.t;
  const moved = await run('Gene', 60, 'kiss', { inputAt: holdAt + 1 }, 'pull'), m = numbers(moved);
  const back = moved.frames.find(f => f.phase === 'back')!.t;
  assert.ok(back - (holdAt + 1) >= 0 && back - (holdAt + 1) <= 2 / 60 + 1e-6, `the pull ends it at once (${back - holdAt - 1} s)`);
  assert.ok(m.headCm < 0.35 && m.torsoDeg < 0.3, `no jolt (${m.headCm} cm, ${m.torsoDeg}°)`);
  if (REPORT) console.log('[I-192 Gene pull]', JSON.stringify({ backAfterS: back - holdAt - 1, head: m.headCm, torso: m.torsoDeg }));
});
