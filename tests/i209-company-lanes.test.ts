// I-209 step 1: the others keep out of each other's way (shared/unbound/company/lanes.ts) and the frame-cost guard (guard.ts), pure.
// Lanes: random scenes give targets that are all clear of each other, each on her own side, in her order; a simulated minute of the one
// you talk with wandering and being pulled across the screen with the others walking at her pace never has anyone walk through anyone.
// Guard: with only the one you talk with it never acts; over budget with company it sends one back after its window, never during a load's
// grace, never for the quiet 30 fps or a single hitch.
import test from 'node:test';
import assert from 'node:assert/strict';
// Step 1's page tuning (its page stage was replaced by each one's own full screen in step 3, shared/unbound/company/bodies.ts): kept here
// so the lanes' own guarantee stays pinned.
const COMPANY_LEAD_S = 0.6, COMPANY_REPLAN_S = 0.15, COMPANY_YIELD_PACE = 1.6;
import { COMPANY_KNOBS, arrange, clearOf, firstWish, needAcross, offStage, type Spot } from '../shared/unbound/company/lanes';
import { COMPANY_GUARD_KNOBS, CompanyGuard } from '../shared/unbound/company/guard';
import { placementAcross, resolvePhysicalScreen } from '../shared/unbound/world';
import { spotOfPlacement } from '../shared/unbound/life/place-record';

const USER_DISPLAY = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const view = { screen: resolvePhysicalScreen(USER_DISPLAY, null), viewerDistanceM: 0.55 };
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const spot = (r: () => number, lo = 0.07, hi = 0.93): Spot => ({ across: lo + (hi - lo) * r(), depthM: 5 + 7.5 * r() });

test('random scenes: every target clear of everyone, on her own side, in her order, inside the screen', () => {
  const r = rng(209);
  for (let n = 0; n < 4000; n++) {
    const main = spot(r);
    const count = 1 + Math.floor(r() * 2);
    const lanes = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, at: spot(r, -0.12, 1.12), want: spot(r) })).filter(l => Math.abs(l.at.across - main.across) > 1e-6);
    const out = arrange(view, main, lanes);
    const all = [main, ...lanes.map(l => out.get(l.id)!)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(clearOf(view, all[i]!, all[j]!), `scene ${n}: ${JSON.stringify(all)}`);
    for (const lane of lanes) {
      const target = out.get(lane.id)!;
      assert.equal(Math.sign(target.across - main.across), Math.sign(lane.at.across - main.across), `scene ${n}: she keeps her side`);
      assert.ok(target.across >= COMPANY_KNOBS.across[0] - 1e-9 && target.across <= COMPANY_KNOBS.across[1] + 1e-9);
    }
    const right = lanes.filter(l => l.at.across > main.across).sort((a, b) => a.at.across - b.at.across);
    for (let i = 1; i < right.length; i++) {
      const a = out.get(right[i - 1]!.id)!, b = out.get(right[i]!.id)!;
      assert.ok(a.across <= b.across + 1e-9 || Math.abs(a.depthM - b.depthM) >= COMPANY_KNOBS.backStepM * 0.9, `scene ${n}: order kept outward`);
    }
  }
});

test('a simulated minute: you wander across the screen; the others walk at your pace, briskly when making room (as the stage does); nobody walks through anybody (60 and 30 fps)', () => {
  for (const fps of [60, 30]) {
    const r = rng(fps), dt = 1 / fps, speed = 0.7, brisk = speed * COMPANY_YIELD_PACE, body = 0.42; // two bodies closer than this (m, centre to centre, same depth band) touch
    const toM = (s: Spot) => placementAcross(view, s.across, s.depthM);
    let main = { xM: 0, depthM: 8 };
    const others = [{ id: 'a', at: toM({ across: 0.7, depthM: 8 }), want: { across: 0.72, depthM: 8 } }, { id: 'b', at: toM({ across: 0.3, depthM: 7.5 }), want: { across: 0.25, depthM: 7.5 } }];
    let goal = { ...main }, replan = 0, minGap = Infinity;
    const side = others.map(o => Math.sign(o.at.xM * (0.55 + 8) / (0.55 + o.at.depthM) - main.xM));
    const targets = new Map<string, { xM: number; depthM: number }>();
    for (let f = 0; f < 60 * fps; f++) {
      if (f % (fps * 4) === 0) goal = toM({ across: 0.1 + 0.8 * r(), depthM: 5.5 + 6 * r() }); // she walks off, or you pull her, somewhere new every 4 s
      const step = (from: { xM: number; depthM: number }, to: { xM: number; depthM: number }, pace = speed) => {
        const dx = to.xM - from.xM, dz = to.depthM - from.depthM, d = Math.hypot(dx, dz), m = Math.min(d, pace * dt);
        return d < 1e-9 ? from : { xM: from.xM + dx / d * m, depthM: from.depthM + dz / d * m };
      };
      const before = main;
      main = step(main, goal);
      replan -= dt;
      if (replan <= 0) {
        replan = COMPANY_REPLAN_S;
        const mainSpot = spotOfPlacement(view, main)!, lead = COMPANY_LEAD_S / dt;
        const ahead = spotOfPlacement(view, { xM: main.xM + (main.xM - before.xM) * lead, depthM: main.depthM + (main.depthM - before.depthM) * lead })!;
        for (const [id, s] of arrange(view, mainSpot, others.map(o => ({ id: o.id, at: spotOfPlacement(view, o.at)!, want: o.want })), COMPANY_KNOBS, ahead)) targets.set(id, toM(s));
      }
      for (const o of others) { const target = targets.get(o.id) ?? o.at, wanted = toM(o.want); o.at = step(o.at, target, Math.hypot(target.xM - wanted.xM, target.depthM - wanted.depthM) > 0.05 ? brisk : speed); }
      const all = [main, ...others.map(o => o.at)];
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!, b = all[j]!;
        if (Math.abs(a.depthM - b.depthM) < 0.5) minGap = Math.min(minGap, Math.abs(a.xM - b.xM));
      }
      others.forEach((o, i) => {
        const across = spotOfPlacement(view, o.at)!.across, mainAcross = spotOfPlacement(view, main)!.across;
        assert.equal(Math.sign(across - mainAcross), side[i], `${fps} fps frame ${f}: ${o.id} never crosses to the other side`);
      });
    }
    console.log(`[i209] ${fps} fps simulated minute: closest two bodies came ${minGap.toFixed(2)} m centre to centre (same depth band)`);
    assert.ok(minGap > body, `${fps} fps: the closest two bodies came was ${minGap.toFixed(2)} m (centre to centre, same depth)`);
  }
});

test('a newcomer\'s first wish is beside the others with room; she enters and leaves on her own side', () => {
  const main = { across: 0.8, depthM: 8 };
  const wish = firstWish(view, main, []);
  assert.ok(wish.across < main.across, 'more room on the left');
  assert.ok(clearOf(view, main, wish));
  const second = firstWish(view, main, [wish]);
  assert.ok(clearOf(view, main, second) && clearOf(view, wish, second));
  assert.equal(offStage(main, wish).across, COMPANY_KNOBS.offAcross[0]);
  assert.equal(offStage(main, { across: 0.9, depthM: 8 }).across, COMPANY_KNOBS.offAcross[1]);
  assert.ok(needAcross(view, { across: 0, depthM: 5 }, { across: 0, depthM: 12 }) > needAcross(view, { across: 0, depthM: 12 }, { across: 0, depthM: 12 }), 'the nearer one sets the room');
});

test('guard: alone it never acts; over budget with company it says one fewer after its window; loads, the quiet rate and a hitch are not slow', () => {
  const k = COMPANY_GUARD_KNOBS;
  const run = (guard: CompanyGuard, from: number, seconds: number, ms: number, fps = 60) => {
    let t = from, verdict = null;
    while (t < from + seconds * 1000) { t += ms; verdict ??= guard.feed(t, ms, fps); }
    return { t, verdict };
  };
  const alone = new CompanyGuard(); alone.changed(0, 1);
  assert.equal(run(alone, 0, 30, 40).verdict, null, 'only the one you talk with: never');
  const three = new CompanyGuard(); three.changed(0, 3);
  assert.equal(run(three, 0, k.graceMs / 1000, 40).verdict, null, 'a load or an arrival is not a slow machine');
  const slow = run(three, k.graceMs, k.windowS + 2, 30);
  assert.ok(slow.verdict, 'over budget with company: one fewer');
  assert.equal(slow.verdict!.present, 3);
  assert.ok(slow.verdict!.p95Ms >= 29 && slow.verdict!.budgetMs < 21);
  const fine = new CompanyGuard(); fine.changed(0, 2);
  assert.equal(run(fine, 0, 30, 16.7).verdict, null, 'on budget: never');
  const quiet = new CompanyGuard(); quiet.changed(0, 2);
  assert.equal(run(quiet, 0, 30, 33.3, 30).verdict, null, 'the quiet 30 fps is not late');
  const hitch = new CompanyGuard(); hitch.changed(0, 2);
  let t = 0, verdict = null;
  for (let s = 0; s < 30; s++) for (let f = 0; f < 60; f++) { const ms = s % 7 === 3 && f < 6 ? 60 : 16.7; t += ms; verdict ??= hitch.feed(t, ms, 60); }
  assert.equal(verdict, null, 'a bad second now and then is not a slow machine');
});
