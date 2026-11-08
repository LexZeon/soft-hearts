/**
 * #21 on the real MoodHost (electron/mood.ts) with an isolated temporary profile: 20 days of "a fresh 5-second pat" and "a snack"
 * with the old fixed amounts (FixedTouchFeedEffect = the card, as before) and with hers (TouchFeedEffectDirector). Also: never
 * more than the old amount, I-019's taste shift (#47) on top never more than before, the why developer-only and never saved,
 * the shown and saved parameters the card's. TOUCH_FEED_REPORT=1 prints the 20 days before and after.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { TouchFeedEffectDirector } from '../shared/behaviors/touch-feed-effect/choose';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import type { TouchFeedEffectHost } from '../shared/behaviors/touch-feed-effect/interface';
import { feedMoodLift, type FeedVerdict } from '../shared/feed-recognition';
import { formatTouchFeedLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

const DAY = 24 * 60 * 60_000;
const report = !!process.env.TOUCH_FEED_REPORT;
const loved: FeedVerdict = { edible: true, category: '甜点', name: '草莓蛋糕', liking: '爱吃', summary: '她爱吃的甜点' };

async function withHost(effect: TouchFeedEffectHost, card: MoodParameters, run: (context: { host: MoodHost; clock: { now: number }; directory: string }) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-touch-feed-'));
  const clock = { now: Date.UTC(2026, 10, 4, 15, 0, 0) };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: effect });
  try {
    await host.load();
    host.activate('gene', structuredClone(card));
    await run({ host, clock, directory });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const input = (host: MoodHost, value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
/** One pat: hold her head for `seconds`, reporting half a second at a time; the summed rise of the last 10 s (fastWindowMs). */
function pat(host: MoodHost, clock: { now: number }, id: string, seconds = 5): MoodView['snapshot']['trend'] {
  input(host, { type: 'phase', sessionId: id, phase: 'rua' });
  for (let i = 0; i < seconds * 2; i++) { clock.now += 500; input(host, { type: 'rua', sessionId: id, id: `${id}-${i}`, activeMs: 500 }); }
  const trend = { ...host.get().snapshot.trend };
  input(host, { type: 'phase', sessionId: id, phase: 'idle' });
  return trend;
}
function feed(host: MoodHost, clock: { now: number }, id: string): MoodView['snapshot']['trend'] {
  input(host, { type: 'phase', sessionId: id, phase: 'food-wait' });
  clock.now += 600;
  input(host, { type: 'phase', sessionId: id, phase: 'food-ready' });
  input(host, { type: 'food', sessionId: id, id: `${id}-bite` });
  return { ...host.get().snapshot.trend };
}
async function twentyDays(effect: TouchFeedEffectHost) {
  const pats: { O: number; E: number }[] = [], snacks: { D: number; E: number }[] = [];
  let why: MoodView['touchFeedWhy'], saved = '', shown = null as MoodParameters | null, hidden = true;
  await withHost(effect, DEFAULT_MOOD_PARAMETERS, async ({ host, clock, directory }) => {
    hidden = !('touchFeedWhy' in host.get());
    host.setDeveloperMode(true);
    for (let day = 0; day < 20; day++) {
      clock.now += DAY; // everything back to her baseline and fully fresh: the same scene every day
      const t = pat(host, clock, `pat-${day}`);
      pats.push({ O: t.O, E: t.E });
      clock.now += 60_000;
      const f = feed(host, clock, `snack-${day}`);
      snacks.push({ D: f.D, E: f.E });
    }
    why = host.get().touchFeedWhy;
    shown = host.get().parameters;
    await host.flush();
    saved = await readFile(path.join(directory, 'mood-state.json'), 'utf8');
  });
  return { pats, snacks, why, saved, shown: shown!, hidden };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

test('20 days on the real host: before every pat and snack gave the same; now it varies, never more than before; the why is developer-only and never saved', async () => {
  const before = await twentyDays(new FixedTouchFeedEffect());
  const after = await twentyDays(new TouchFeedEffectDirector({ random: seeded(20) }));
  if (report) {
    console.log(`pat O before: ${before.pats.map(p => r2(p.O)).join(' ')}`); console.log(`pat O after:  ${after.pats.map(p => r2(p.O)).join(' ')}`);
    console.log(`snack D before: ${before.snacks.map(s => r2(s.D)).join(' ')}`); console.log(`snack D after:  ${after.snacks.map(s => r2(s.D)).join(' ')}`);
    for (const entry of after.why!) console.log(`why: ${entry.contact} → ${entry.landing} × ${entry.scale}｜${entry.why.join('；')}｜新鲜感 ${entry.fresh.first}%→${entry.fresh.last}%（${entry.doses} 剂）（分量：${entry.weights}）`);
  }
  for (const key of ['O', 'E'] as const) assert.equal(new Set(before.pats.map(p => r2(p[key]))).size, 1, `before: every pat the same ${key}`);
  for (const key of ['D', 'E'] as const) assert.equal(new Set(before.snacks.map(s => r2(s[key]))).size, 1, `before: every snack the same ${key}`);
  assert.ok(new Set(after.pats.map(p => r2(p.O))).size >= 10, after.pats.map(p => r2(p.O)).join(' '));
  assert.ok(new Set(after.snacks.map(s => r2(s.D))).size >= 10, after.snacks.map(s => r2(s.D)).join(' '));
  after.pats.forEach((p, i) => {
    assert.ok(p.O <= before.pats[i].O + 1e-9 && p.E <= before.pats[i].E + 1e-9, `day ${i}: a pat gave more than before`);
    assert.ok(p.O >= 0.55 * before.pats[i].O, `day ${i}: still a real pat`);
  });
  after.snacks.forEach((s, i) => assert.ok(s.D <= before.snacks[i].D + 1e-9 && s.E <= before.snacks[i].E + 1e-9, `day ${i}: a snack gave more than before`));
  // The why: developer mode only, memory only; the shown and saved parameters are the card.
  assert.ok(after.hidden, 'not in developer mode: no why in the view');
  const why = after.why!;
  assert.ok(why.length >= 2 && why.some(row => row.contact === 'pat') && why.some(row => row.contact === 'food'));
  assert.ok(why.every(row => row.why[0].includes('——') && row.scale >= 0.6 && row.scale <= 1));
  assert.deepEqual(after.shown, DEFAULT_MOOD_PARAMETERS);
  const file = JSON.parse(after.saved) as { profiles: { parameters: MoodParameters }[] };
  assert.deepEqual(file.profiles[0].parameters, DEFAULT_MOOD_PARAMETERS);
  for (const word of ['挠到心上', '受用', '胃口', '吃得很香', 'touchFeed', '腻得']) assert.ok(!after.saved.includes(word), `saved file has no "${word}"`);
});

test('a long pat tires her by her card: dose by dose on the real host, clingy keeps more, distant less; the first dose never above before', async () => {
  const doses = async (effect: TouchFeedEffectHost, close: number) => {
    const card = { ...structuredClone(DEFAULT_MOOD_PARAMETERS), weights: { ...DEFAULT_MOOD_PARAMETERS.weights, close } };
    const out: number[] = [];
    await withHost(effect, card, ({ host, clock }) => {
      clock.now += DAY;
      input(host, { type: 'phase', sessionId: 'long', phase: 'rua' });
      let last = host.get().snapshot.values.O;
      for (let dose = 0; dose < 4; dose++) {
        for (let i = 0; i < 10; i++) { clock.now += 500; input(host, { type: 'rua', sessionId: 'long', id: `long-${dose}-${i}`, activeMs: 500 }); }
        const now = host.get().snapshot.values.O;
        out.push(r2(now - last)); last = now;
      }
    });
    return out;
  };
  const card = await doses(new FixedTouchFeedEffect(), 1);
  // random 0: the first kind (正好挠到心上) at the bottom of its range (× 0.92), the same for both cards.
  const clingy = await doses(new TouchFeedEffectDirector({ random: () => 0 }), 1.6);
  const distant = await doses(new TouchFeedEffectDirector({ random: () => 0 }), 0.4);
  if (report) console.log(`one long pat, O per 5 s — card: ${card.join(' ')} | clingy: ${clingy.join(' ')} | distant: ${distant.join(' ')}`);
  assert.ok(clingy[0] <= card[0] + 1e-9 && distant[0] <= card[0] + 1e-9);
  assert.ok(clingy[3] > card[3] && distant[3] < card[3], `${clingy} / ${card} / ${distant}`);
});

test('I-019 on top (#47): what she was fed shifts what this bite really gave, so the two together are never more than before', async () => {
  for (let seed = 0; seed < 10; seed++) {
    const totals: number[] = [];
    for (const effect of [new FixedTouchFeedEffect(), new TouchFeedEffectDirector({ random: seeded(seed) })]) {
      await withHost(effect, DEFAULT_MOOD_PARAMETERS, ({ host, clock }) => {
        clock.now += DAY;
        const start = host.get().snapshot.values.D;
        feed(host, clock, 'cake');
        const bite = host.lastAcceptedFood()!.delta!;
        const lift = feedMoodLift(loved, bite)!;
        assert.equal(lift.delta.D, Math.round(bite.D * 0.5 * 10) / 10, 'the shift is half of this bite');
        assert.ok(bite.D <= 12 + 1e-9, 'one bite never more than the old 12');
        host.lift({ id: 'feed-taste-cake', ...lift });
        totals.push(host.get().snapshot.values.D - start);
      });
    }
    assert.ok(totals[1] <= totals[0] + 1e-9, `seed ${seed}: bite + loved ${totals[1]} > before ${totals[0]}`);
  }
});

test('the developer panel line says what this one was, by how much, and why', async () => {
  await withHost(new TouchFeedEffectDirector({ random: seeded(3) }), { ...structuredClone(DEFAULT_MOOD_PARAMETERS), weights: { ...DEFAULT_MOOD_PARAMETERS.weights, close: 1.6 } },
    ({ host, clock }) => {
      host.setDeveloperMode(true);
      clock.now += DAY;
      pat(host, clock, 'first', 10);
      clock.now += 2_000;
      pat(host, clock, 'second', 5);
      const lines = formatTouchFeedLines(host.get().touchFeedWhy).split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^摸头喂食：.+ 摸头 → (正好挠到心上|照常受用|淡淡的) × 0\.\d+｜.+——.+；腻得慢（性格：黏人）；刚被摸过头或捏过脸，这一次开始时新鲜感还剩 \d+%｜新鲜感 \d+% → \d+%（这次 1 剂）（分量：.+）$/);
      assert.match(lines[1], /（这次 2 剂）/);
      assert.equal(formatTouchFeedLines(undefined), '摸头喂食：暂无');
    });
});
