/**
 * #32 on the real MoodHost (electron/mood.ts) with an isolated temporary profile: 20 days of one snack a day before (FixedFeedCue =
 * the old "啊～ / 嗯～") and after (FeedCueDirector); eating several in a row slows her down by #21's own freshness; #21's landing
 * reaches the bite; I-019's taste (its mood shift) colours the next snack for a while; her I-019 line keeps the word away; nothing
 * while 自动表现 is off; the why developer-only and never saved. FEED_CUE_REPORT=1 prints the 20 days and real why lines.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { FEED_SOUND_TEXT } from '../shared/feed-cue';
import { FEED_MOOD_REASONS } from '../shared/feed-recognition';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { TouchFeedEffectDirector } from '../shared/behaviors/touch-feed-effect/choose';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { TOUCH_FEED_EFFECT_KNOBS, TOUCH_FEED_LANDING_IDS, type TouchFeedLandingId } from '../shared/behaviors/touch-feed-effect/knobs';
import type { TouchFeedEffectHost } from '../shared/behaviors/touch-feed-effect/interface';
import { FEED_LANDING_WORDS, FEED_LINE_FOLLOWS_WORDS, FeedCueDirector } from '../shared/behaviors/feed-cue/choose';
import { FixedFeedCue } from '../shared/behaviors/feed-cue/fake';
import type { FeedCueHost, FeedCueNow, FeedCueView } from '../shared/behaviors/feed-cue/interface';
import { formatFeedCueLines } from '../src/ui/MoodPanel';
import { seeded } from './helpers/seeded';

const DAY = 24 * 60 * 60_000;
const report = !!process.env.FEED_CUE_REPORT;

async function withHost(feedCue: FeedCueHost, run: (context: { host: MoodHost; clock: { now: number }; directory: string }) => Promise<void> | void,
  options: { touchFeed?: TouchFeedEffectHost; card?: MoodParameters } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-feed-cue-'));
  const clock = { now: Date.UTC(2026, 10, 4, 15, 0, 0) };
  const host = new MoodHost(directory, () => {}, () => clock.now, { boredomTiming: new FixedBoredomTiming(), feedCue,
    touchFeedEffect: options.touchFeed ?? new TouchFeedEffectDirector({ random: seeded(4) }) });
  try {
    await host.load();
    host.activate('gene', structuredClone(options.card ?? DEFAULT_MOOD_PARAMETERS));
    await run({ host, clock, directory });
  } finally {
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
const input = (host: MoodHost, value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
/** One snack: dragged in (the open pick comes with this view), held at her mouth, the bite. Returns the views at the mouth and after the bite. */
function feed(host: MoodHost, clock: { now: number }, id: string): { atMouth: MoodView; bitten: MoodView } {
  const atMouth = input(host, { type: 'phase', sessionId: id, phase: 'food-wait' });
  clock.now += 600;
  input(host, { type: 'phase', sessionId: id, phase: 'food-ready' });
  const bitten = input(host, { type: 'food', sessionId: id, id: `${id}-bite` });
  clock.now += 900;
  input(host, { type: 'phase', sessionId: id, phase: 'idle' });
  return { atMouth, bitten };
}
const text = (sound: string | null) => sound === null ? '不出声' : FEED_SOUND_TEXT[sound as keyof typeof FEED_SOUND_TEXT];

/** A FeedCueHost that records what the host told it, around a real one. */
class Spy implements FeedCueHost {
  readonly opens: { sessionId: string; now: FeedCueNow | null }[] = [];
  readonly bites: { sessionId: string; landing: TouchFeedLandingId | null }[] = [];
  constructor(private readonly inner: FeedCueHost) {}
  open(characterId: string, sessionId: string, at: number, now: () => FeedCueNow | null) {
    this.inner.open(characterId, sessionId, at, () => { const moment = now(); this.opens.push({ sessionId, now: moment }); return moment; });
  }
  bite(characterId: string, sessionId: string, at: number, landing: TouchFeedLandingId | null, now: () => FeedCueNow | null) {
    this.bites.push({ sessionId, landing }); this.inner.bite(characterId, sessionId, at, landing, now);
  }
  view(characterId: string, at: number) { return this.inner.view(characterId, at); }
  recent(characterId: string) { return this.inner.recent(characterId); }
}

test('20 days of one snack on the real host: before always "啊～ / 嗯～"; now several, never the same twice in a row; the why developer-only, never saved', async () => {
  const days = async (cue: FeedCueHost) => {
    const rows: { open: FeedCueView['open']; eat: NonNullable<FeedCueView['eat']> }[] = [];
    let hidden = true, saved = '', why: MoodView['feedCueWhy'];
    await withHost(cue, async ({ host, clock, directory }) => {
      clock.now += DAY;
      const first = feed(host, clock, 'day-0');
      hidden = !('feedCueWhy' in first.bitten);
      rows.push({ open: first.atMouth.feedCue!.open, eat: first.bitten.feedCue!.eat! });
      host.setDeveloperMode(true);
      for (let day = 1; day < 20; day++) {
        clock.now += DAY; // fresh again: the same scene
        const { atMouth, bitten } = feed(host, clock, `day-${day}`);
        assert.equal(atMouth.feedCue?.sessionId, `day-${day}`, 'the open pick comes with the view of the first food-wait');
        assert.equal(atMouth.feedCue?.eat, undefined);
        rows.push({ open: atMouth.feedCue!.open, eat: bitten.feedCue!.eat! });
      }
      why = host.get().feedCueWhy;
      await host.flush();
      saved = await readFile(path.join(directory, 'mood-state.json'), 'utf8');
    });
    return { rows, hidden, saved, why };
  };
  const before = await days(new FixedFeedCue());
  const after = await days(new FeedCueDirector({ random: seeded(32) }));
  const pairs = (rows: typeof before.rows) => rows.map(row => `${text(row.open.sound)} / ${text(row.eat.sound)}`);
  if (report) {
    console.log(`before: ${pairs(before.rows).join('，')}`);
    console.log(`after:  ${pairs(after.rows).join('，')}`);
    console.log(formatFeedCueLines(after.why, 3));
  }
  assert.equal(new Set(pairs(before.rows)).size, 1);
  assert.equal(pairs(before.rows)[0], '啊～ / 嗯～');
  assert.ok(new Set(after.rows.map(r => r.open.sound)).size >= 4 && new Set(after.rows.map(r => r.eat.sound)).size >= 4, pairs(after.rows).join(' '));
  for (let i = 1; i < 20; i++) {
    assert.notEqual(after.rows[i].open.sound, after.rows[i - 1].open.sound, `day ${i}`);
    assert.notEqual(after.rows[i].eat.sound, after.rows[i - 1].eat.sound, `day ${i}`);
  }
  for (const row of after.rows) assert.deepEqual([row.open.mouth, row.eat.chew, row.open.shake], [{ rate: 1, size: 1 }, { rate: 1, size: 1 }, null], 'fresh: she eats as before');
  assert.ok(after.hidden, 'not in developer mode: no why in the view');
  assert.ok(after.why!.length === 3 && after.why!.every(row => row.open.why.length && row.eat?.why.length && row.manner.label === '照常'));
  for (const word of [...Object.values(FEED_SOUND_TEXT), '慢慢吃', '不出声', 'feedCue', '腻了']) assert.ok(!after.saved.includes(word), `saved file has no "${word}"`);
});

test('several snacks in a row on the real host: the first ones as before, then slower and smaller by #21\'s own freshness, now and then a small shake', async () => {
  let shakesEarly = 0, shakesLate = 0;
  for (let seed = 0; seed < 24; seed++) {
    const touch = new TouchFeedEffectDirector({ random: seeded(100 + seed) });
    await withHost(new FeedCueDirector({ random: seeded(seed) }), async ({ host, clock }) => {
      host.setDeveloperMode(true);
      clock.now += DAY;
      const rates: number[] = [], chews: number[] = [];
      for (let i = 0; i < 6; i++) {
        const { atMouth, bitten } = feed(host, clock, `s${seed}-${i}`);
        rates.push(atMouth.feedCue!.open.mouth.rate); chews.push(bitten.feedCue!.eat!.chew.rate);
        if (atMouth.feedCue!.open.shake) { if (i < 2) shakesEarly++; else shakesLate++; }
        // The why's freshness is #21's: the same percentage its panel shows for this snack.
        const fresh = bitten.touchFeedWhy!.find(row => row.contact === 'food')!.fresh.first;
        const manner = bitten.feedCueWhy![0].manner;
        if (i >= 2) assert.ok(manner.why.some(line => line.includes(`新鲜感还剩 ${fresh}%`)), `${manner.why.join('；')} vs #21 ${fresh}%`);
        if (report && seed === 0) console.log(`snack ${i + 1}: ${formatFeedCueLines(bitten.feedCueWhy, 1)}`);
        clock.now += 20_000;
      }
      assert.deepEqual([rates[0], rates[1], chews[0], chews[1]], [1, 1, 1, 1], `the first two exactly as before (${rates})`);
      assert.ok(rates[2] < 1 && rates[5] < rates[2] && chews[5] < 1, `then slower (${rates.join(' ')} / ${chews.join(' ')})`);
    }, { touchFeed: touch });
  }
  if (report) console.log(`shakes: ${shakesEarly} in the first two snacks, ${shakesLate} of 96 in snacks 3–6 (24 runs)`);
  assert.equal(shakesEarly, 0, 'never while fresh');
  assert.ok(shakesLate >= 6 && shakesLate <= 60, `now and then once full (${shakesLate} of 96)`);
});

test('#21\'s landing for this very bite reaches the pick; a fake #21 (no landing) is "not known"', async () => {
  const spy = new Spy(new FeedCueDirector({ random: seeded(5) }));
  const touch = new TouchFeedEffectDirector({ random: seeded(6) });
  const labels = Object.fromEntries(TOUCH_FEED_LANDING_IDS.map(id => [TOUCH_FEED_EFFECT_KNOBS.food.landings[id].label, id]));
  await withHost(spy, async ({ host, clock }) => {
    host.setDeveloperMode(true);
    for (let day = 0; day < 15; day++) {
      clock.now += DAY;
      const { bitten } = feed(host, clock, `l${day}`);
      const landing = labels[bitten.touchFeedWhy!.find(row => row.contact === 'food')!.landing];
      assert.deepEqual(spy.bites.at(-1), { sessionId: `l${day}`, landing });
    }
    assert.ok(new Set(spy.bites.map(b => b.landing)).size >= 2);
    const named = host.get().feedCueWhy!.flatMap(row => row.eat?.why ?? []);
    assert.ok(Object.values(FEED_LANDING_WORDS).some(words => named.includes(words)) || named.length > 0);
  }, { touchFeed: touch });
  const plain = new Spy(new FeedCueDirector({ random: seeded(5) }));
  await withHost(plain, ({ host, clock }) => { clock.now += DAY; feed(host, clock, 'x'); }, { touchFeed: new FixedTouchFeedEffect() });
  assert.equal(plain.bites[0].landing, null);
});

test('I-019\'s taste colours the next snack for a while: after something not edible she opens small and slowly and may ask "嗯？"; ten minutes later not', async () => {
  const spy = new Spy(new FeedCueDirector({ random: seeded(8) }));
  await withHost(spy, ({ host, clock }) => {
    host.setDeveloperMode(true);
    clock.now += DAY;
    feed(host, clock, 'paper');
    host.lift({ id: 'feed-taste-paper', delta: { D: -6, E: -3 }, reason: FEED_MOOD_REASONS.notFood });
    host.lift({ id: 'need-soothed-x', delta: { O: 1 }, reason: FEED_MOOD_REASONS.loved }); // not I-019's: ignored
    clock.now += 60_000;
    const next = feed(host, clock, 'cake').atMouth.feedCue!;
    assert.equal(spy.opens.at(-1)!.now!.taste, 'notFood');
    assert.ok(next.open.mouth.size <= 0.55 && next.open.mouth.rate <= 0.6, JSON.stringify(next.open.mouth));
    assert.ok(host.get().feedCueWhy![0].manner.why.includes('不久前喂过不是吃的，这次张嘴小心'));
    host.lift({ id: 'feed-taste-cake', delta: { D: 3 }, reason: FEED_MOOD_REASONS.loved });
    clock.now += 60_000; feed(host, clock, 'cake-2');
    assert.equal(spy.opens.at(-1)!.now!.taste, 'loved');
    clock.now += 11 * 60_000; feed(host, clock, 'later');
    assert.equal(spy.opens.at(-1)!.now!.taste, null, 'ten minutes later it no longer counts');
  });
});

test('her I-019 line follows the bite: never the word "好吃～" (the line says it); a source that throws counts as no line', async () => {
  const eats: (string | null)[] = [];
  await withHost(new FeedCueDirector({ random: seeded(9) }), ({ host, clock }) => {
    host.setFeedLineSource(() => true);
    host.setDeveloperMode(true);
    for (let day = 0; day < 40; day++) {
      clock.now += DAY;
      const { bitten } = feed(host, clock, `w${day}`);
      eats.push(bitten.feedCue!.eat!.sound);
      assert.ok(bitten.feedCueWhy![0].eat!.why.includes(FEED_LINE_FOLLOWS_WORDS));
    }
  });
  if (report) console.log(`with her line: ${eats.map(text).join(' ')}`);
  assert.ok(!eats.includes('haochi'), eats.join(' '));
  const free: (string | null)[] = [];
  await withHost(new FeedCueDirector({ random: seeded(9) }), ({ host, clock }) => {
    host.setFeedLineSource(() => { throw new Error('gone'); });
    for (let day = 0; day < 40; day++) { clock.now += DAY; free.push(feed(host, clock, `f${day}`).bitten.feedCue!.eat!.sound); }
  });
  assert.ok(free.includes('haochi'), 'without her line the word does come');
});

test('自动表现 off: no pick is asked for or shown; the stage and the cues keep the old way', async () => {
  const spy = new Spy(new FeedCueDirector({ random: seeded(1) }));
  await withHost(spy, ({ host, clock }) => {
    host.setExpressions(false);
    clock.now += DAY;
    const { atMouth, bitten } = feed(host, clock, 'off');
    assert.equal(atMouth.feedCue, undefined); assert.equal(bitten.feedCue, undefined);
    assert.equal(spy.opens.length + spy.bites.length, 0);
    host.setExpressions(true);
    clock.now += DAY;
    assert.ok(feed(host, clock, 'on').bitten.feedCue?.eat);
  });
});
