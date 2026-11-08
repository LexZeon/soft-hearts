/**
 * #26 on the real MoodHost (electron/mood.ts) with an isolated temporary profile, and on the stage with a blush part (a model
 * with its own blush morph, like Gene's 赤み): 20 times "a pat after five quiet minutes" with the card's blush (FixedBlush = as
 * before) and with hers (BlushDirector); the snapshot carries the picked shape all the way through; never more often than the
 * card; the shy card blushes where the card's threshold would not; the why developer-only and never saved.
 * The pat amounts are the card's fixed ones here (FixedTouchFeedEffect), so only the blush differs. BLUSH_REPORT=1 prints the 20.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Bone, Euler, PerspectiveCamera, Quaternion, SkinnedMesh } from 'three';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS, getBlushAmount, type MoodBlushSnapshot, type MoodParameters } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { BlushDirector } from '../shared/behaviors/blush/choose';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import type { BlushHost } from '../shared/behaviors/blush/interface';
import { MmdStage } from '../src/stage/MmdStage';
import { EMPTY_CONTACT, MoodFeedback } from '../src/stage/mood-feedback';
import { formatBlushLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

const MINUTE = 60_000;
const report = !!process.env.BLUSH_REPORT;
type Seen = { id: string; at: number; until: number; profile: MoodBlushSnapshot['profile']; strength: number };

async function withHost(blush: BlushHost, card: MoodParameters, run: (context: { host: MoodHost; clock: { now: number }; seen: Seen[]; directory: string; views: MoodView[] }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-blush-host-'));
  const clock = { now: Date.UTC(2026, 10, 4, 15, 0, 0) };
  const seen: Seen[] = [], views: MoodView[] = [];
  const host = new MoodHost(directory, view => {
    views.push(view);
    const b = view.snapshot.blush;
    if (b && !seen.some(row => row.id === b.id)) seen.push({ id: b.id, at: b.at, until: b.until, profile: { ...b.profile }, strength: b.strength });
  }, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush });
  try {
    await host.load();
    host.activate('gene', structuredClone(card));
    await run({ host, clock, seen, directory, views });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const input = (host: MoodHost, value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
function pat(host: MoodHost, clock: { now: number }, id: string, seconds = 5): void {
  input(host, { type: 'phase', sessionId: id, phase: 'rua' });
  for (let i = 0; i < seconds * 2; i++) { clock.now += 500; input(host, { type: 'rua', sessionId: id, id: `${id}-${i}`, activeMs: 500 }); }
  input(host, { type: 'phase', sessionId: id, phase: 'idle' });
}
/** A quiet stretch, one tick a second so the host stays online. */
function rest(host: MoodHost, clock: { now: number }, minutes: number): void {
  for (let t = 0; t < minutes * MINUTE; t += 1_000) { clock.now += 1_000; host.tick(true); }
}
/**
 * A day away: her mood is back at the baseline and a pat is fully fresh again, so every scene starts the same. (Five quiet minutes
 * are not enough: closeness has a 40-minute half-life, so pat after pat it stays high and each pat lifts it less; by the fourth
 * the card's own threshold of 6 is no longer reached, before or after.)
 */
function away(host: MoodHost, clock: { now: number }): void { clock.now += 24 * 60 * MINUTE; host.tick(true); }
const card = DEFAULT_MOOD_PARAMETERS;
const length = (p: Pick<MoodBlushSnapshot['profile'], 'riseMs' | 'holdMs' | 'fadeMs'>) => p.riseMs + p.holdMs + p.fadeMs;

async function twentyPats(blush: BlushHost, personality: Partial<MoodParameters['weights']> = {}) {
  let why: MoodView['blushWhy'], saved = '', shown = null as MoodParameters | null, hidden = true;
  const cardHere = { ...structuredClone(card), weights: { ...card.weights, ...personality } };
  const rows: Seen[] = [];
  await withHost(blush, cardHere, async ({ host, clock, seen, directory }) => {
    hidden = !('blushWhy' in host.get());
    host.setDeveloperMode(true);
    for (let i = 0; i < 20; i++) { away(host, clock); pat(host, clock, `pat-${i}`); }
    rows.push(...seen);
    why = host.get().blushWhy;
    shown = host.get().parameters;
    await host.flush();
    saved = await readFile(path.join(directory, 'mood-state.json'), 'utf8');
  });
  return { rows, why, saved, shown: shown!, hidden };
}

test('20 pats a day apart on the real host: before the same blush every time; now its depth and length vary, it still comes every time, the why is developer-only and never saved', async () => {
  const before = await twentyPats(new FixedBlush());
  const after = await twentyPats(new BlushDirector({ random: seeded(20) }));
  if (report) {
    console.log(`before: ${before.rows.map(r => `${r.profile.intensity}/${length(r.profile)}ms`).join(' ')}`);
    console.log(`after:  ${after.rows.map(r => `${r.profile.intensity}/${length(r.profile)}ms`).join(' ')}`);
    for (const entry of after.why!) console.log(`why: ${entry.contact} → ${entry.look}｜${entry.why.join('；')}｜${entry.shape}｜冷却 ${entry.cooldownMs}（分量：${entry.weights}）`);
  }
  assert.equal(before.rows.length, 20); assert.equal(after.rows.length, 20, 'she still blushes at every pat (a day apart is past any cooldown)');
  assert.equal(new Set(before.rows.map(r => JSON.stringify(r.profile))).size, 1);
  assert.deepEqual(before.rows[0].profile, card.blush);
  assert.ok(new Set(after.rows.map(r => length(r.profile))).size >= 15);
  assert.ok(new Set(after.rows.map(r => r.profile.intensity)).size >= 8);
  for (const row of after.rows) {
    assert.equal(row.until - row.at, length(row.profile), 'how long it lasts is the shape the snapshot carries');
    assert.ok(row.profile.intensity >= 0.7 * card.blush.intensity - 1e-9 && row.profile.intensity <= 1.15 * card.blush.intensity + 1e-9);
    assert.equal(row.profile.size, card.blush.size); assert.equal(row.profile.enabled, true);
  }
  assert.ok(after.hidden, 'not in developer mode: no why in the view');
  assert.ok(after.why!.length >= 3 && after.why!.every(row => row.contact === 'pat' && row.why[0].includes('——') && row.cooldownMs >= card.blush.cooldownMs));
  assert.deepEqual(after.shown, DEFAULT_MOOD_PARAMETERS);
  const file = JSON.parse(after.saved) as { profiles: { parameters: MoodParameters }[] };
  assert.deepEqual(file.profiles[0].parameters, DEFAULT_MOOD_PARAMETERS);
  for (const word of ['红透', '微微一红', '红一下', 'blushWhy', '深浅']) assert.ok(!after.saved.includes(word), `saved file has no "${word}"`);
});

test('the snapshot carries the picked shape for the whole blush, and its amount is that shape\'s envelope', async () => {
  await withHost(new BlushDirector({ random: seeded(7) }), card, ({ host, clock }) => {
    away(host, clock);
    input(host, { type: 'phase', sessionId: 'p', phase: 'rua' });
    let first: MoodBlushSnapshot | null = null;
    for (let i = 0; i < 10 && !first; i++) { clock.now += 500; input(host, { type: 'rua', sessionId: 'p', id: `p-${i}`, activeMs: 500 }); first = host.get().snapshot.blush; }
    input(host, { type: 'phase', sessionId: 'p', phase: 'idle' });
    assert.ok(first, 'blushed');
    let samples = 0;
    while (clock.now < first!.until + 1_000) {
      clock.now += 250; host.tick(true);
      const b = host.get().snapshot.blush;
      if (clock.now >= first!.until) { assert.equal(b, null, 'gone when its own length is over'); continue; }
      assert.ok(b && b.id === first!.id);
      assert.deepEqual(b.profile, first!.profile);
      assert.ok(Math.abs(b.amount - getBlushAmount(clock.now - b.at, b.strength, b.profile)) < 1e-12);
      samples++;
    }
    assert.ok(samples >= 8);
  });
});

test('never more often than the card: a warm word every 15 s for 20 minutes, blushes at least the card\'s cooldown apart and never more of them; the shy blush more than the bold', async () => {
  // Warm words open the mood model's gate every time (closeness up by more than 2); only the cooldown holds her back. A card whose
  // closeness and comfort settle within a minute keeps it that way for all 20 minutes (on the default card closeness saturates
  // after a few minutes of this and the gate closes by itself, before and after alike).
  let chat = 0;
  const quick = { ...structuredClone(card), halfLifeMs: { ...card.halfLifeMs, O: 30_000, E: 30_000 } };
  const count = async (blush: BlushHost, cautious = 1) => {
    const starts: number[] = [];
    await withHost(blush, { ...quick, weights: { ...card.weights, cautious } }, ({ host, clock, seen }) => {
      for (let i = 0; i < 80; i++) { rest(host, clock, 15 / 60); host.event({ type: 'chat', id: `warm-${++chat}`, delta: { O: 4, E: 2 }, context: 'support', reason: '收到用户聊天' }); }
      starts.push(...seen.map(row => row.at));
    });
    return starts;
  };
  const before = await count(new FixedBlush());
  for (const [seed, cautious] of [[1, 1], [2, 1.6], [3, 0.4], [4, 1]] as const) {
    const after = await count(new BlushDirector({ random: seeded(seed) }), cautious);
    for (let i = 1; i < after.length; i++) assert.ok(after[i] - after[i - 1] >= card.blush.cooldownMs, `seed ${seed}: ${after[i] - after[i - 1]} ms apart`);
    assert.ok(after.length <= before.length, `seed ${seed}: ${after.length} > ${before.length}`);
  }
  const shy = await count(new BlushDirector({ random: seeded(9) }), 1.6), bold = await count(new BlushDirector({ random: seeded(9) }), 0.4);
  if (report) console.log(`blushes in 20 minutes of warm words — card before: ${before.length}, shy: ${shy.length}, bold: ${bold.length}; gaps after (s): ${shy.slice(1).map((at, i) => Math.round((at - shy[i]) / 1000)).join(' ')} / ${bold.slice(1).map((at, i) => Math.round((at - bold[i]) / 1000)).join(' ')}`);
  assert.equal(shy.length, before.length, 'the shy card: as often as the card allows');
  assert.ok(bold.length < shy.length);
});

test('the shy card blushes at a pat the card\'s own threshold would not reach (and says so); the card itself does not', async () => {
  const weak = { ...structuredClone(card), sensitivity: { ...card.sensitivity, O: 0.5 }, weights: { ...card.weights, cautious: 1.6 } };
  const run = async (blush: BlushHost) => {
    let seen: Seen[] = [], why: MoodView['blushWhy'];
    await withHost(blush, weak, ({ host, clock, seen: s }) => { host.setDeveloperMode(true); away(host, clock); pat(host, clock, 'soft'); seen = [...s]; why = host.get().blushWhy; });
    return { seen, why };
  };
  const before = await run(new FixedBlush()), after = await run(new BlushDirector({ random: seeded(5) }));
  assert.equal(before.seen.length, 0, 'a soft pat: the card\'s threshold of 6 is not reached');
  assert.equal(after.seen.length, 1);
  assert.match(after.why![0].why.join('；'), /性格：谨慎（容易害羞）：涨够 4\.2 就红了（卡上要涨够 6）/);
});

function stageWith(blushChannel: { index: number; name: string } | null) {
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, { surprisePending: null, surprisePreview: null });
  const head = new Bone(); head.name = '頭'; head.position.set(0, 15, 0);
  const mesh = new SkinnedMesh(); mesh.add(head); mesh.morphTargetInfluences = [0.1, 0.2, 0.05, 0, 0.07];
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, 10, 35); camera.lookAt(0, 10, 0); camera.updateMatrixWorld(true);
  Object.assign(stage, { mesh, head, eyes: [], camera, controls: { interacting: false }, hostVisible: true,
    renderer: { domElement: { dataset: {} } }, container: { clientWidth: 400, clientHeight: 560 }, height: 20,
    moodFeedback: new MoodFeedback(), moodContact: { ...EMPTY_CONTACT }, moodFaceBlocked: false, moodHeadBlocked: false,
    boneLayers: [], morphLayers: [], rotation: new Euler(), offset: new Quaternion(),
    blinkIndex: 0, smileIndex: 1, mouthIndex: 2, sadIndex: 3, blushChannel, speaking: false });
  return stage;
}

test('on a model with a blush part the stage draws her picked blush: a long one still shows where the card\'s would be over; without one it skips quietly', async () => {
  const found: { snapshot: MoodView['snapshot'] | null } = { snapshot: null };
  await withHost(new BlushDirector({ random: seeded(12) }), card, ({ host, clock }) => {
    for (let i = 0; i < 40 && !found.snapshot; i++) {
      away(host, clock);
      input(host, { type: 'phase', sessionId: `s${i}`, phase: 'rua' });
      let b: MoodBlushSnapshot | null = null;
      for (let j = 0; j < 10 && !b; j++) { clock.now += 500; input(host, { type: 'rua', sessionId: `s${i}`, id: `s${i}-${j}`, activeMs: 500 }); b = host.get().snapshot.blush; }
      input(host, { type: 'phase', sessionId: `s${i}`, phase: 'idle' });
      // A longer blush than the card's 3.45 s: look at it at 3.6 s, when the card's shape would already be over.
      if (b && length(b.profile) > 4_000) { clock.now = b.at + 3_600; found.snapshot = host.get().snapshot; }
    }
  });
  const snapshot = found.snapshot;
  assert.ok(snapshot && snapshot.blush, 'found a long blush');
  const blush = snapshot.blush;
  const expected = getBlushAmount(3_600, blush.strength, blush.profile);
  assert.equal(getBlushAmount(3_600, blush.strength, card.blush), 0, 'the card\'s own shape is over by now');
  assert.ok(expected > 0.05);
  const stage = stageWith({ index: 4, name: '赤み' });
  stage.moodView = { expressions: true, snapshot, parameters: DEFAULT_MOOD_PARAMETERS };
  stage.animateMood(1 / 30);
  const drawn = stage.mesh.morphTargetInfluences[4];
  assert.ok(Math.abs(drawn - Math.max(0.07, expected)) < 1e-6, `${drawn} vs ${expected}`);
  stage.restoreLayers();
  assert.equal(stage.mesh.morphTargetInfluences[4], 0.07, 'the authored base comes back');
  const none = stageWith(null);
  none.moodView = { expressions: true, snapshot, parameters: DEFAULT_MOOD_PARAMETERS };
  assert.doesNotThrow(() => none.animateMood(1 / 30));
  assert.deepEqual(none.mesh.morphTargetInfluences.slice(4), [0.07], 'no blush part: nothing is written');
});

test('the developer panel line says how she blushed, why, and how long until the next one', async () => {
  await withHost(new BlushDirector({ random: seeded(2) }), card, ({ host, clock }) => {
    host.setDeveloperMode(true);
    away(host, clock);
    pat(host, clock, 'p');
    const line = formatBlushLines(host.get().blushWhy);
    assert.match(line, /^脸红：.+ 被摸头 → (一下子红透了|红一下|微微一红)｜.+——.+；被摸头，亲近一下子涨了 \d+(\.\d)?｜深浅 ×\d(\.\d+)? · 红起来 [\d.]+ 秒 · 停 [\d.]+ 秒 · 退 [\d.]+ 秒（一共 [\d.]+ 秒）｜下次至少隔 \d+ 秒（分量：.+）$/);
    assert.equal(formatBlushLines(undefined), '脸红：暂无');
  });
});
