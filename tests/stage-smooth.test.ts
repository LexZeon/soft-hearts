// 三人同框别卡: with several characters on the full-screen stage, the
// one you are with draws as she always did; an idle extra draws at 30 frames a second and one pixel tier lower, and is back at full the next
// frame when she speaks, is touched, walks, plays a close moment or dances (or is the one you click). One on stage: nothing changes. And one
// frame-time row a minute per instance, numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerfManager } from '../src/unbound/perf';
import { StagePage, type StagePageEnv } from '../src/unbound/company/stage-page';
import { EXTRA_PACE_KNOBS, ExtraPace, FULL_PACE, INVOLVEMENT_KINDS, type Involvement, type OwnInvolvement } from '../shared/unbound/company/extra-pace';
import { FRAME_SAMPLER_KNOBS, FrameSampler } from '../shared/unbound/company/frame-sampler';
import { FrameGovernor } from '../shared/unbound/perf-tiers';
import { UNBOUND_STAGE_REQUESTS, type StageView } from '../shared/unbound/company';
import { stageWorld } from './helpers/stage-world';
import { MAIN_KEY } from '../electron/unbound/company/stage';
import { UNBOUND_STAGE_EVENTS } from '../shared/unbound/company';

const NONE: Involvement = { focused: false, speaking: false, touched: false, walking: false, closing: false, dancing: false };
const OWN_NONE: OwnInvolvement = { speaking: false, touched: false, walking: false, closing: false, dancing: false };
const view = (over: Partial<StageView> = {}): StageView => ({ present: 3, self: 'a', others: [], focus: 'b', ...over });

/** One page's tick as src/unbound/main.ts runs it: the page's pace, then the governor's admit. */
function pageOf(options: { present?: number; focus?: string; own?: () => OwnInvolvement; pace?: boolean } = {}) {
  const own = { ...OWN_NONE };
  const pixels: string[] = [];
  const perf = new PerfManager({ storage: null, onTier: () => {}, onPixel: () => { pixels.push(perf.pixelTier.id); }, pin: 'high', quiet: false, pace: options.pace });
  const page = new StagePage({ api: null, figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100,
    involvement: options.own ?? (() => own) } satisfies StagePageEnv);
  page.receive(view({ present: options.present ?? 3, focus: options.focus ?? 'b' }), 0);
  const tick = (now: number): boolean => { const pace = page.pace(now); perf.setPace(pace.capFps, pace.lowered); return perf.admit(now, false); };
  /** Draws counted over `ms` of 60 Hz display ticks from `from`. */
  const run = (from: number, ms: number): number => { let drawn = 0; for (let now = from; now < from + ms; now += 1000 / 60) if (tick(now)) drawn++; return drawn; };
  return { own, perf, page, tick, run, pixels };
}

test('ExtraPace: an idle extra on a crowded stage draws at 30 at once, one pixel tier lower once settled', () => {
  const pace = new ExtraPace();
  assert.deepEqual(pace.step(0, 3, NONE), { capFps: 30, lowered: false, idle: true }, 'the rate drops at once, the canvas is not resized for a blink');
  assert.equal(pace.step(EXTRA_PACE_KNOBS.settleMs - 1, 3, NONE).lowered, false);
  assert.deepEqual(pace.step(EXTRA_PACE_KNOBS.settleMs, 3, NONE), { capFps: 30, lowered: true, idle: true });
});

test('ExtraPace: alone on stage, or the one you are with, is never throttled', () => {
  const pace = new ExtraPace();
  for (let now = 0; now < 10_000; now += 100) {
    assert.deepEqual(pace.step(now, 1, NONE), FULL_PACE, 'one on stage: exactly as before');
    assert.deepEqual(pace.step(now, 3, { ...NONE, focused: true }), FULL_PACE, 'the one you clicked last');
  }
});

for (const kind of INVOLVEMENT_KINDS) {
  test(`ExtraPace: ${kind} brings an idle extra back to full on that very step, and she has to settle again to be lowered`, () => {
    const pace = new ExtraPace();
    pace.step(0, 3, NONE);
    assert.equal(pace.step(5_000, 3, NONE).lowered, true);
    assert.deepEqual(pace.step(5_016, 3, { ...NONE, [kind]: true }), FULL_PACE, `${kind} starts: full rate, full pixels`);
    const after = pace.step(5_032, 3, NONE);
    assert.deepEqual(after, { capFps: 30, lowered: false, idle: true }, 'idle again: the rate drops at once, the pixels wait');
  });
}

test('FrameGovernor: a cap holds the rate down busy or not, never raises it, and lifting it wakes her at once', () => {
  const governor = new FrameGovernor(60, false);
  let drawn = 0;
  governor.setCap(30);
  for (let now = 0; now < 2_000; now += 1000 / 60) if (governor.admit(now, true)) drawn++;
  assert.ok(drawn >= 58 && drawn <= 62, `capped at 30 (drew ${drawn} in 2 s)`);
  governor.setCap(null);
  assert.equal(governor.admit(2_003, true), true, 'the very next tick draws once the cap is lifted');
  const slow = new FrameGovernor(30, false); slow.setCap(60);
  assert.equal(slow.admit(0, true) && !slow.admit(5, true), true, 'a cap above the tier\'s rate changes nothing');
});

test('three on stage: an idle extra draws 30 a second at a lower pixel tier; the one you are with draws 60 at her tier; alone nothing changes', () => {
  const idle = pageOf({ focus: 'b' }), mine = pageOf({ focus: 'a' }), alone = pageOf({ present: 1, focus: 'a' });
  const drawnIdle = idle.run(0, 4_000), drawnMine = mine.run(0, 4_000), drawnAlone = alone.run(0, 4_000);
  assert.ok(drawnIdle >= 118 && drawnIdle <= 124, `idle extra: about 30 fps over 4 s (drew ${drawnIdle})`);
  assert.ok(drawnMine >= 236 && drawnMine <= 244, `the one you are with: 60 fps (drew ${drawnMine})`);
  assert.equal(drawnAlone, drawnMine, 'one on stage: the same as ever');
  assert.equal(idle.perf.pixelTier.id, 'medium', 'one tier below high');
  assert.equal(idle.perf.tier.id, 'high', 'her own tier is untouched (the self-test and the adapt watcher keep reading it)');
  assert.equal(mine.perf.pixelTier.id, 'high'); assert.equal(alone.perf.pixelTier.id, 'high');
  assert.deepEqual(idle.pixels, ['medium'], 'the canvas was resized once');
  assert.deepEqual(mine.pixels, []); assert.deepEqual(alone.pixels, []);
});

for (const kind of ['speaking', 'touched', 'walking', 'closing', 'dancing'] as const) {
  test(`an idle extra is back at 60 and full pixels within a frame when ${kind} starts`, () => {
    const p = pageOf();
    p.run(0, 3_000);
    assert.equal(p.perf.pixelTier.id, 'medium');
    p.own[kind] = true;
    const now = 3_000 + 1000 / 60;
    assert.equal(p.tick(now), true, 'the first tick after it starts draws');
    assert.equal(p.perf.fps, 60, 'at her tier\'s rate');
    assert.equal(p.perf.pixelTier.id, 'high', 'at her tier\'s pixel ratio before that frame is drawn');
    const drawn = p.run(now + 16, 2_000);
    assert.ok(drawn >= 117, `and stays at full while it goes on (drew ${drawn})`);
  });
}

test('the one you click becomes the focus: her page hears it and draws at full; the one before drops to idle', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a');
  const last = (win: typeof main) => (win.of(UNBOUND_STAGE_EVENTS.stage) as StageView[]).at(-1)!;
  assert.equal(last(a).focus, MAIN_KEY, 'before anyone is clicked, the first one is who you are with');
  assert.equal(last(main).focus, MAIN_KEY);
  w.stage.address('vrm-a');
  assert.equal(last(a).focus, 'vrm-a'); assert.equal(last(main).focus, 'vrm-a', 'everyone hears it');
  const mine = new StagePage({ api: null, figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100, involvement: () => OWN_NONE });
  mine.receive(last(a), 0);
  assert.equal(mine.pace(0).idle, false, 'the page of the one clicked');
  const other = new StagePage({ api: null, figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100, involvement: () => OWN_NONE });
  other.receive(last(main), 0);
  assert.equal(other.pace(0).idle, true, 'the page of the one before');
  w.host.exit(); w.host.quit();
});

test('alone on stage the view carries no focus (the page does exactly what it did)', async () => {
  const w = stageWorld();
  const main = await w.enter();
  assert.ok((main.of(UNBOUND_STAGE_EVENTS.stage) as StageView[]).every(v => v.focus === undefined));
  w.host.exit(); w.host.quit();
});

test('a page without a reading of what she does, or without a view, always draws at full', () => {
  const none = new StagePage({ api: null, figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100 });
  assert.deepEqual(none.pace(0), FULL_PACE);
  none.receive(view(), 0);
  assert.deepEqual(none.pace(10), FULL_PACE, 'a stage page with no reading never guesses');
  const blank = new StagePage({ api: null, figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100, involvement: () => OWN_NONE });
  assert.deepEqual(blank.pace(0), FULL_PACE, 'no view yet: she is alone as far as she knows');
  blank.receive(view({ focus: undefined }), 1);
  assert.equal(blank.pace(2).idle, false, 'a view without a focus: not known, so full');
});

test('measuring runs (?pace=0) and a running self-test ignore the cap', () => {
  const off = pageOf({ pace: false });
  assert.ok(off.run(0, 4_000) >= 236, 'pace off: full rate');
  assert.equal(off.perf.pixelTier.id, 'high');
  const testing = new PerfManager({ storage: { getItem: () => null, setItem: () => {} }, onTier: () => {} });
  testing.setKey('1000x600@1|1:1');
  assert.equal(testing.testing, true);
  testing.setPace(30, true);
  assert.equal(testing.paced, false, 'what a self-test measures must be the tier, not the cap');
});

// ---- the frame-time row --------------------------------------------------------------------------------------------------------

test('the frame-time row comes once a minute, numbers only, and counts the idle share', () => {
  const sampler = new FrameSampler();
  let rows = 0, last = null as ReturnType<FrameSampler['feed']>;
  for (let now = 0; now < FRAME_SAMPLER_KNOBS.minuteMs * 2.5; now += 33.4) { const row = sampler.feed(now, 33.4, true); if (row) { rows++; last = row; } }
  assert.equal(rows, 2, 'two minutes in two and a half');
  assert.deepEqual(Object.keys(last!).sort(), ['fps', 'frames', 'idlePct', 'medianMs', 'p95Ms']);
  assert.ok(Object.values(last!).every(v => typeof v === 'number'), 'no text can be in it');
  assert.ok(Math.abs(last!.fps - 30) < 0.5 && Math.abs(last!.medianMs - 33.4) < 0.1 && last!.idlePct === 100, JSON.stringify(last));
});

test('the page sends its minute to the host, with her tier and whether you are with her', () => {
  const sent: unknown[] = [];
  const page = new StagePage({ api: { stageFrames: async row => { sent.push(row); }, companyGuard: async () => {}, stageBody: async () => {}, stageLeft: async () => {}, onStage: () => () => {} },
    figure: () => null, scene: () => null, faceM: () => null, dipM: () => 0, closing: () => false, pulled: () => false, occupied: () => false, unitsPerM: 100, involvement: () => OWN_NONE });
  page.receive(view({ focus: 'b' }), 0);
  for (let now = 0; now <= FRAME_SAMPLER_KNOBS.minuteMs + 100; now += 16.7) { page.pace(now); page.feed(now, 16.7, 60, 'high'); }
  assert.equal(sent.length, 1, 'one a minute');
  const row = sent[0] as Record<string, unknown>;
  assert.equal(row.tier, 'high'); assert.equal(row.withYou, false, 'she is not the one you are with');
  assert.equal(row.idlePct, 100);
});

test('the host takes a page\'s frame-time row only from her own window, as a checked row with the stage\'s own count, at most every 30 s', async () => {
  const w = stageWorld();
  const main = await w.enter(), a = await w.bringOut('vrm-a'), b = await w.bringOut('pmx-b');
  const minute = { tier: 'high', withYou: false, fps: 30, medianMs: 33.3, p95Ms: 34.1, frames: 1800, idlePct: 100 };
  await w.call(UNBOUND_STAGE_REQUESTS.frames, a, { ...minute, text: '不该出现的话', onStage: 1 });
  assert.equal(w.frames.length, 1);
  assert.deepEqual(w.frames[0], { id: 'vrm-a', row: { tier: 'high', onStage: 3, withYou: false, fps: 30, medianMs: 33.3, p95Ms: 34.1, frames: 1800, idlePct: 100 } }, 'her own card, the stage\'s count of three, no extra field');
  await w.call(UNBOUND_STAGE_REQUESTS.frames, a, minute);
  assert.equal(w.frames.length, 1, 'a second row from the same page within 30 s is dropped');
  await w.call(UNBOUND_STAGE_REQUESTS.frames, main, { ...minute, withYou: true });
  assert.equal(w.frames.length, 2); assert.equal(w.frames[1]!.id, 'gene', 'the first one is her card too');
  for (const junk of [{ ...minute, tier: 'ultra' }, { ...minute, fps: 'fast' }, { ...minute, frames: -1 }, { ...minute, idlePct: 400 }, [1, 2], 'text']) {
    await w.call(UNBOUND_STAGE_REQUESTS.frames, b, junk);
  }
  assert.equal(w.frames.length, 2, 'rows that do not fit are not written');
  await w.call(UNBOUND_STAGE_REQUESTS.frames, b, minute);
  assert.equal(w.frames.length, 3, 'a bad row does not use up her minute');
  w.host.exit(); w.host.quit();
});
