/**
 * #32 喂点心时的语气词和吃法 (shared/behaviors/feed-cue/): the fixed sounds, the contract both implementations keep, 20 times the
 * same scene, never the same sound twice in a row, her mood, card, this bite (#21) and I-019's taste lean it, a word never talks
 * over her I-019 line, eating more slows her down (and only then), the safety line, one knob changes only what it governs, the stage
 * side (continuous, bit-identical without a pick), the cue port (waits briefly, falls back, never blocks the feed) and no model call.
 * FEED_CUE_REPORT=1 prints the 20 draws.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MOOD_PARAMETERS, type MoodLabel, type MoodTendency } from '../shared/mood';
import { MOOD_LABELS } from '../shared/mood-runtime';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { CUE_TEXT, FEED_CUE_INSTRUCTION, FEED_CUE_TEXT, FEED_EAT_SOUND_IDS, FEED_OPEN_SOUND_IDS, FEED_SOUND_IDS, FEED_SOUND_TEXT, cueInstruction, isCueKind,
  type CueKind } from '../shared/feed-cue';
import { FEED_CUE_KNOBS, type FeedCueKnobs } from '../shared/behaviors/feed-cue/knobs';
import { drawFeedEat, drawFeedOpen, FEED_LINE_FOLLOWS_WORDS, feedCueNow, feedCuePlanSafe, FeedCueDirector, feedSatiety, feedSlowness,
  type FeedEatChoice, type FeedOpenChoice } from '../shared/behaviors/feed-cue/choose';
import { FixedFeedCue } from '../shared/behaviors/feed-cue/fake';
import { FeedEatPerformer, readFeedCueView } from '../shared/behaviors/feed-cue/perform';
import type { FeedCueHost, FeedCueNow, FeedCueView } from '../shared/behaviors/feed-cue/interface';
import { freshnessLeft, tiredFreshness, tireFactor } from '../shared/behaviors/touch-feed-effect/choose';
import { TOUCH_FEED_EFFECT_KNOBS } from '../shared/behaviors/touch-feed-effect/knobs';
import { FeedCueSynth } from '../electron/feed-cue';
import { CHEW_OPEN, EMPTY_CONTACT, FEED_OPEN, MoodFeedback, type MoodContact, type StageMoodState } from '../src/stage/mood-feedback';
import { ChosenFeedCues, FEED_CUE_PLAN_WAIT_MS, type ChosenFeedCuePlayer } from '../src/ui/feed-cue-choice';
import { FEED_CUE_DEADLINE_MS, FEED_CUE_WAIT_MS, FEED_RESUME_DELAY_MS, FeedSpeechPause } from '../src/ui/feed-speech-pause';
import { FeedCuePlayer } from '../src/ui/feed-cue-player';
import { fileURLToPath } from 'node:url';
import { seeded } from './helpers/seeded';
import { pausableEngine } from './helpers/feed-pause-audio';

const report = !!process.env.FEED_CUE_REPORT;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOODS = Object.keys(MOOD_LABELS) as MoodLabel[];
const TENDENCIES: MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const plain = { playful: 1, close: 1, comfortable: 1, cautious: 1 };
const calm: FeedCueNow = { mood: 'calm', tendency: null, personality: plain, moments: [], satiety: 0, fresh: 1, taste: null, lineFollows: false };
const at = (patch: Partial<FeedCueNow>): FeedCueNow => ({ ...calm, ...patch, personality: { ...plain, ...patch.personality } });
const label = (id: FeedOpenChoice | FeedEatChoice, family: 'open' | 'eat') => id === 'quiet' ? '不出声' : (FEED_CUE_KNOBS[family] as unknown as Record<string, { text: string }>)[id].text;
const count = <T extends string>(items: readonly T[]) => items.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map<T, number>());
const share = <T extends string>(items: readonly T[], ids: readonly T[]) => items.filter(item => ids.includes(item)).length / items.length;

// ------------------------------------------------------------------------------------------------ the sounds

test('ten fixed sounds (five before the bite, five after), "no sound" in each group; the two originals keep their text and voice style', () => {
  assert.equal(FEED_OPEN_SOUND_IDS.length, 5); assert.equal(FEED_EAT_SOUND_IDS.length, 5); assert.equal(FEED_SOUND_IDS.length, 10);
  assert.deepEqual(FEED_CUE_TEXT, { ah: '啊～', mm: '嗯～' }, 'the original two are unchanged');
  assert.equal(cueInstruction('ah'), FEED_CUE_INSTRUCTION); assert.equal(cueInstruction('mm'), FEED_CUE_INSTRUCTION);
  const texts = FEED_SOUND_IDS.map(id => FEED_SOUND_TEXT[id]);
  assert.equal(new Set(texts).size, 10, 'ten different texts');
  for (const id of FEED_SOUND_IDS) {
    assert.equal(CUE_TEXT[id], FEED_SOUND_TEXT[id]);
    assert.ok(FEED_SOUND_TEXT[id].length >= 1 && FEED_SOUND_TEXT[id].length <= 4, `${id}: a short sound (${FEED_SOUND_TEXT[id]})`);
    assert.ok(cueInstruction(id).includes('只读') && cueInstruction(id).length < 80, `${id}: a tone that says "read only this"`);
    assert.ok(isCueKind(id));
  }
  assert.equal(CUE_TEXT.think, '嗯…', 'X1 untouched');
  for (const bad of ['啊～', '好吃', 'quiet', '', null, 'ah ', 'toString']) assert.equal(isCueKind(bad), false, String(bad));
  assert.ok('quiet' in FEED_CUE_KNOBS.open && 'quiet' in FEED_CUE_KNOBS.eat);
  assert.equal(FEED_CUE_KNOBS.eat.haochi.word, true, '"好吃～" is the one word');
});

test('the host synthesizes only the fixed text of a named sound, in its tone, once per voice and kind: nothing else can be asked for', async () => {
  const requests: { text: string; instruction?: string }[] = [];
  const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k', model: 'qwen3-tts-instruct-flash' };
  const synth = new FeedCueSynth(async (config, text, _signal, emit) => {
    requests.push({ text, instruction: config.instruction });
    await emit({ type: 'audio', data: Buffer.alloc(24 * 300 * 2).toString('base64'), format: 'pcm_s16le', sampleRate: 24000, channels: 1 } as TtsStreamEvent);
    return { firstAudioMs: 1, audioBytes: 24 * 600 };
  }, () => 0);
  for (const id of FEED_SOUND_IDS) assert.ok(await synth.clip(id, bailian), id);
  for (const id of FEED_SOUND_IDS) await synth.clip(id, bailian);
  assert.equal(requests.length, 10, 'each sound once for this voice (cached after)');
  assert.deepEqual(requests.map(r => r.text), FEED_SOUND_IDS.map(id => FEED_SOUND_TEXT[id]), 'only the fixed texts');
  for (const bad of ['我饿了', '好吃', 'quiet']) await assert.rejects(synth.clip(bad, bailian), /种类/);
});

test('no model is ever asked: the feed-cue folder imports only shared code, and a pick is a plain synchronous draw', async () => {
  const folder = path.join(REPO_ROOT, 'shared', 'behaviors', 'feed-cue');
  for (const file of await readdir(folder)) {
    const text = await readFile(path.join(folder, file), 'utf8');
    for (const [, from] of text.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(from.startsWith('./') || from.startsWith('../../') || from.startsWith('../touch-feed-effect/'), `${file} imports ${from}`);
      assert.ok(!/electron|claude|model|fetch|tts|speech|inner-loop/i.test(from), `${file} imports ${from}`);
    }
  }
  const director = new FeedCueDirector({ random: seeded(1) });
  const result = director.open('gene', 's1', 0, () => calm);
  assert.equal(result, undefined, 'synchronous: no promise, nothing to wait for');
  assert.ok(director.view('gene', 0)!.open.sound === null || FEED_OPEN_SOUND_IDS.includes(director.view('gene', 0)!.open.sound!));
});

// ------------------------------------------------------------------------------------------------ the contract

function contract(name: string, make: () => FeedCueHost) {
  test(`contract (${name}): one pick per snack, "此刻" read at most once, a bite adds the second, only her own and recent, always safe, plain data`, () => {
    const host = make();
    let reads = 0;
    const now = () => { reads++; return calm; };
    assert.equal(host.view('gene', 0), null);
    host.open('gene', 's1', 1_000, now);
    host.open('gene', 's1', 1_200, now);
    assert.equal(reads <= 1, true, 'read once for the snack');
    const first = host.view('gene', 1_300)!;
    assert.equal(first.sessionId, 's1'); assert.equal(first.eat, undefined);
    assert.deepEqual(host.view('gene', 1_400), first, 'the same pick until the bite');
    assert.ok(feedCuePlanSafe(first));
    host.bite('gene', 's1', 2_000, 'usual', now);
    host.bite('gene', 's1', 2_100, 'full', now);
    const bitten = host.view('gene', 2_200)!;
    assert.ok(bitten.eat, 'the bite adds the sound after it');
    assert.deepEqual(bitten.open, first.open, 'the open pick stays');
    assert.deepEqual(host.view('gene', 2_300)!.eat, bitten.eat, 'one pick per bite');
    assert.ok(feedCuePlanSafe(bitten));
    assert.equal(reads <= 1, true);
    assert.equal(host.view('other', 2_300), null, 'only her own snack');
    assert.equal(host.view('gene', 2_000 + 61_000), null, 'a minute after the bite it is no longer given');
    // A bite without an open first (自动表现 turned on mid-snack): the open pick is made then.
    host.bite('gene', 's2', 3_000, null, now);
    const late = host.view('gene', 3_000)!;
    assert.equal(late.sessionId, 's2'); assert.ok(late.open && late.eat);
    assert.ok(reads <= 2);
    // The view and the why are copies of plain data.
    late.open.mouth && ((late.open.mouth as { rate: number }).rate = 99);
    assert.notEqual(host.view('gene', 3_000)!.open.mouth.rate, 99);
    const why = host.recent('gene');
    assert.ok(why.length >= 1);
    assert.deepEqual(JSON.parse(JSON.stringify(why)), why);
    (why[0].manner.why as string[]).push('x');
    assert.ok(!host.recent('gene')[0].manner.why.includes('x'));
    // No character: nothing, no throw.
    host.open('', 's3', 0, now); host.bite('', 's3', 0, null, now);
    assert.equal(host.view('', 0), null);
    assert.ok(readFeedCueView(host.view('gene', 3_000)), 'what the host gives the stage passes the stage\'s check');
  });
}
contract('real', () => new FeedCueDirector({ random: seeded(7) }));
contract('fake', () => new FixedFeedCue());

test('the fake is the old way: always "啊～" then "嗯～", the old mouth and chew', () => {
  const fake = new FixedFeedCue();
  for (let i = 0; i < 5; i++) {
    fake.open('gene', `s${i}`, i * 1000, () => at({ satiety: 1, mood: 'happy' }));
    fake.bite('gene', `s${i}`, i * 1000 + 600, 'full', () => null);
    const view = fake.view('gene', i * 1000 + 700)!;
    assert.deepEqual({ open: view.open.sound, eat: view.eat!.sound, mouth: view.open.mouth, chew: view.eat!.chew, shake: view.open.shake },
      { open: 'ah', eat: 'mm', mouth: { rate: 1, size: 1 }, chew: { rate: 1, size: 1 }, shake: null });
  }
});

// ------------------------------------------------------------------------------------------------ her picks

test('20 times the same scene (a calm, fresh snack): before always "啊～ / 嗯～"; now several sounds, never the same twice in a row', () => {
  const fake = new FixedFeedCue(), director = new FeedCueDirector({ random: seeded(32) });
  const before: string[] = [], opens: FeedOpenChoice[] = [], eats: FeedEatChoice[] = [];
  for (let day = 0; day < 20; day++) {
    for (const host of [fake, director]) { host.open('gene', `d${day}`, day, () => calm); host.bite('gene', `d${day}`, day, 'usual', () => calm); }
    const old = fake.view('gene', day)!;
    before.push(`${label(old.open.sound ?? 'quiet', 'open')} / ${label(old.eat!.sound ?? 'quiet', 'eat')}`);
    const view = director.view('gene', day)!;
    opens.push(view.open.sound ?? 'quiet'); eats.push(view.eat!.sound ?? 'quiet');
    assert.deepEqual(view.open.mouth, { rate: 1, size: 1 }, 'not full: she opens exactly as before');
    assert.deepEqual(view.eat!.chew, { rate: 1, size: 1 }, 'and chews exactly as before');
    assert.equal(view.open.shake, null);
  }
  if (report) {
    console.log('before:', before.join('，'));
    console.log('open:', opens.map(id => label(id, 'open')).join(' '), [...count(opens)].map(([id, n]) => `${label(id, 'open')}×${n}`).join(' '));
    console.log('eat :', eats.map(id => label(id, 'eat')).join(' '), [...count(eats)].map(([id, n]) => `${label(id, 'eat')}×${n}`).join(' '));
  }
  assert.equal(new Set(before).size, 1, 'before: 20 times the same');
  assert.ok(count(opens).size >= 4, `before the bite: ${count(opens).size} kinds`);
  assert.ok(count(eats).size >= 4, `after the bite: ${count(eats).size} kinds`);
  for (let i = 1; i < 20; i++) { assert.notEqual(opens[i], opens[i - 1], `open ${i}`); assert.notEqual(eats[i], eats[i - 1], `eat ${i}`); }
  assert.ok(count(opens).get('ah')! >= 4 && count(eats).get('mm')! >= 4, 'the originals are still the most common when calm');
});

test('never the same sound twice in a row, in any mood, card or fullness (300 runs of 30); only when one sound is all that fits may it repeat, and the why says so', () => {
  for (let run = 0; run < 300; run++) {
    const random = seeded(1000 + run), director = new FeedCueDirector({ random });
    const now = at({ mood: MOODS[run % MOODS.length], satiety: (run % 7) / 6, taste: ([null, 'loved', 'disliked', 'notFood'] as const)[run % 4],
      personality: Object.fromEntries(TENDENCIES.map(t => [t, 0.3 + random() * 2])) as Record<MoodTendency, number>,
      moments: run % 5 === 0 ? ['sleepy'] : [], lineFollows: run % 3 === 0 });
    let last: { open: string; eat: string } | null = null;
    for (let i = 0; i < 30; i++) {
      director.open('gene', `r${run}-${i}`, i, () => now);
      director.bite('gene', `r${run}-${i}`, i, (['full', 'usual', 'light'] as const)[i % 3], () => now);
      const view = director.view('gene', i)!;
      const current = { open: view.open.sound ?? 'quiet', eat: view.eat!.sound ?? 'quiet' };
      if (last) { assert.notEqual(current.open, last.open, `run ${run} #${i}`); assert.notEqual(current.eat, last.eat, `run ${run} #${i}`); }
      if (now.lineFollows) assert.notEqual(view.eat!.sound, 'haochi', 'a word never talks over her I-019 line');
      assert.ok(feedCuePlanSafe(view, now.lineFollows));
      last = current;
    }
  }
  // Only "啊～" fits (every other sound weighs 0): it may repeat, and the why says so.
  const only: FeedCueKnobs = structuredClone(FEED_CUE_KNOBS) as FeedCueKnobs;
  for (const id of [...FEED_OPEN_SOUND_IDS, 'quiet'] as const) if (id !== 'ah') (only.open[id] as { base: number }).base = 0;
  const lonely = new FeedCueDirector({ random: seeded(3), knobs: only });
  for (let i = 0; i < 3; i++) lonely.open('gene', `o${i}`, i, () => calm);
  assert.equal(lonely.view('gene', 2)!.open.sound, 'ah');
  assert.ok(lonely.recent('gene')[0].open.why.includes('只有这一种合适，和上次一样'));
});

/** 400 snacks in a row with the same "此刻" (each a new snack): the share of each sound. */
function picks(now: FeedCueNow, landing: 'full' | 'usual' | 'light' | null = 'usual', seed = 5, knobs: FeedCueKnobs = FEED_CUE_KNOBS) {
  const director = new FeedCueDirector({ random: seeded(seed), knobs });
  const opens: FeedOpenChoice[] = [], eats: FeedEatChoice[] = [], views: FeedCueView[] = [], whys: string[][] = [];
  for (let i = 0; i < 400; i++) {
    director.open('gene', `p${i}`, i, () => now); director.bite('gene', `p${i}`, i, landing, () => now);
    const view = director.view('gene', i)!;
    views.push(view); opens.push(view.open.sound ?? 'quiet'); eats.push(view.eat!.sound ?? 'quiet');
    const why = director.recent('gene')[0];
    whys.push([...why.open.why, ...(why.eat?.why ?? []), ...why.manner.why]);
  }
  return { opens, eats, views, whys };
}

test('her mood, card, this bite (#21) and what I-019 recognized lately lean the sounds; the why names only what is true', () => {
  const base = picks(calm);
  const happy = picks(at({ mood: 'happy', taste: 'loved' }));
  // (Never twice in a row caps any one sound near half, so the brighter pair is compared.)
  assert.ok(share(happy.opens, ['wa', 'aowu']) > 1.6 * share(base.opens, ['wa', 'aowu']),
    `happy + loved: "哇～""嗷呜～" ${share(happy.opens, ['wa', 'aowu'])} vs ${share(base.opens, ['wa', 'aowu'])}`);
  assert.ok(share(happy.opens, ['wa']) > share(happy.opens, ['ah']), '"哇～" over the plain "啊～"');
  const wary = picks(at({ taste: 'notFood' }));
  assert.ok(share(wary.opens, ['huh']) > 3 * share(base.opens, ['huh']), `after something not edible: "嗯？" ${share(wary.opens, ['huh'])} vs ${share(base.opens, ['huh'])}`);
  assert.ok(wary.views.every(view => view.open.mouth.size <= 0.55 + 1e-9 && view.open.mouth.rate <= 0.6 + 1e-9), 'and she opens small and slowly');
  assert.ok(wary.whys.every(why => why.includes('不久前喂过不是吃的，这次张嘴小心')));
  const sleepy = picks(at({ moments: ['sleepy'] }));
  assert.ok(share(sleepy.opens, ['quiet', 'soft']) > 1.4 * share(base.opens, ['quiet', 'soft']), 'sleepy: quieter');
  const playful = picks(at({ personality: { ...plain, playful: 1.8 }, tendency: 'playful' }));
  assert.ok(share(playful.opens, ['aowu']) > 1.6 * share(base.opens, ['aowu']), `a playful card: "嗷呜～" ${share(playful.opens, ['aowu'])} vs ${share(base.opens, ['aowu'])}`);
  const shy = picks(at({ personality: { ...plain, cautious: 1.8 } }));
  assert.ok(share(shy.opens, ['soft', 'quiet']) > 1.4 * share(base.opens, ['soft', 'quiet']), 'a cautious (shy) card: softer');
  const tasty = picks(calm, 'full'), meh = picks(calm, 'light');
  assert.ok(share(tasty.eats, ['yum', 'haochi']) > 1.8 * share(meh.eats, ['yum', 'haochi']), 'this bite tasted good: brighter');
  assert.ok(share(meh.eats, ['wu', 'quiet']) > 2 * share(tasty.eats, ['wu', 'quiet']), 'no appetite for this one: duller');
  const line = picks(at({ lineFollows: true }), 'full');
  assert.equal(line.eats.filter(id => id === 'haochi').length, 0, 'her I-019 line follows: never the word');
  assert.ok(line.whys.every(why => why.includes(FEED_LINE_FOLLOWS_WORDS)));
  assert.ok(tasty.eats.includes('haochi'), 'without the line, "好吃～" does come');
  // A calm, fresh, average card: no reason about what is not true.
  for (const why of base.whys) for (const word of ['性格', '困了', '有点累', '有点腻了', '吃了好几块', '不久前', '这一块吃得很香', '这一块没什么胃口', '认图', '调皮'])
    assert.ok(!why.some(line => line.includes(word)), `"${word}" in ${why.join('；')}`);
  assert.ok(base.whys.some(why => why.some(line => line.includes('上次是'))), 'the no-repeat is named');
});

test('eating more slows her down, and only then: exactly the old mouth and chew while fresh; slower, smaller and now and then a small head shake when full', () => {
  // #21's tiredness, the same numbers its panel shows: default card, 0 / 1 / 2 / 3 snacks still counted.
  const fresh = [0, 1, 2, 3].map(taken => feedSatiety(DEFAULT_MOOD_PARAMETERS.freshness, plain, taken));
  assert.deepEqual(fresh.map(f => Math.round(f.fresh * 100)), [100, 60, 36, 22]);
  const tired = tiredFreshness(DEFAULT_MOOD_PARAMETERS.freshness, tireFactor(TOUCH_FEED_EFFECT_KNOBS.food.tire, plain).factor, TOUCH_FEED_EFFECT_KNOBS.food.tire.minFloor);
  assert.equal(fresh[2].fresh, freshnessLeft(tired, 2), '#21\'s own algorithm');
  assert.ok(feedSatiety(DEFAULT_MOOD_PARAMETERS.freshness, { ...plain, comfortable: 1.6 }, 2).satiety < fresh[2].satiety, 'an easygoing card tires of snacks slower (#21)');
  const rows = [0, 0.3, 0.5, 0.8, 1].map(satiety => {
    const { views } = picks(at({ satiety }), 'usual', 9);
    const mean = (pick: (v: FeedCueView) => number) => views.reduce((sum, v) => sum + pick(v), 0) / views.length;
    return { satiety, open: mean(v => v.open.mouth.rate), size: mean(v => v.open.mouth.size), chew: mean(v => v.eat!.chew.rate),
      shakes: views.filter(v => v.open.shake).length / views.length, views };
  });
  if (report) console.log(rows.map(r => `腻 ${r.satiety}: 张嘴 ×${r.open.toFixed(2)} 张开 ×${r.size.toFixed(2)} 嚼 ×${r.chew.toFixed(2)} 摇头 ${(r.shakes * 100).toFixed(0)}%`).join('\n'));
  for (const r of rows.slice(0, 2)) for (const v of r.views) {
    assert.deepEqual([v.open.mouth.rate, v.open.mouth.size, v.eat!.chew.rate, v.eat!.chew.size, v.open.shake], [1, 1, 1, 1, null], `not full yet (${r.satiety}): exactly as before`);
  }
  for (let i = 2; i < rows.length; i++) {
    assert.ok(rows[i].open < rows[i - 1].open - 0.03 && rows[i].chew < rows[i - 1].chew - 0.02, `slower as she gets fuller (${rows[i].satiety})`);
    assert.ok(rows[i].shakes >= rows[i - 1].shakes);
  }
  const full = rows.at(-1)!;
  assert.ok(full.views.every(v => v.open.mouth.rate >= 0.45 && v.open.mouth.rate <= 0.65 && v.eat!.chew.rate >= 0.6 && v.eat!.chew.rate <= 0.78));
  assert.ok(full.shakes > 0.3 && full.shakes < 0.6, `full: "now and then" a shake (${full.shakes})`);
  assert.ok(full.views.every(v => !v.open.shake || (v.open.shake.amplitude <= 0.035 && v.open.shake.ms <= 1000)), 'a light, short one');
  assert.equal(feedSlowness(0.35), 0); assert.equal(feedSlowness(1), 1);
  assert.ok(full.views.some(v => v.open.sound === 'huh' || v.eat!.sound === 'wu'), 'full: a reluctant sound now and then');
});

test('every draw is safe and takes a fixed count of random numbers; a broken knob falls back to the old way', () => {
  const random = seeded(77);
  for (let i = 0; i < 2000; i++) {
    const now = at({ mood: MOODS[i % MOODS.length], satiety: random(), fresh: random(), taste: ([null, 'loved', 'disliked', 'notFood'] as const)[i % 4],
      personality: Object.fromEntries(TENDENCIES.map(t => [t, random() * 4])) as Record<MoodTendency, number>, lineFollows: i % 2 === 0,
      moments: (i % 3 === 0 ? ['tired'] : i % 3 === 1 ? ['sleepy'] : []) as FeedCueNow['moments'] });
    let calls = 0;
    const counted = () => { calls++; return random(); };
    const open = drawFeedOpen(now, ['ah', 'wa'], counted);
    assert.equal(calls, 6);
    const eat = drawFeedEat(now, (['full', 'usual', 'light', null] as const)[i % 4], ['mm'], counted);
    assert.equal(calls, 9);
    const view: FeedCueView = { sessionId: 's', open: { id: 's:open', sound: open.sound.id === 'quiet' ? null : open.sound.id, mouth: open.mouth, shake: open.shake },
      eat: { id: 's:eat', sound: eat.sound.id === 'quiet' ? null : eat.sound.id, chew: eat.chew } };
    assert.ok(feedCuePlanSafe(view, now.lineFollows), JSON.stringify(view));
    assert.ok(view.open.mouth.rate <= 1 && view.open.mouth.size <= 1 && view.eat!.chew.rate <= 1 && view.eat!.chew.size <= 1, 'never faster or wider than before');
  }
  assert.equal(drawFeedOpen(null, [], seeded(1)).sound.id, 'ah', 'no "此刻": the original sound');
  const fast = structuredClone(FEED_CUE_KNOBS) as FeedCueKnobs;
  (fast.manner.open as unknown as { rate: [number, number] }).rate = [1.4, 1.6]; // would open faster than before
  const director = new FeedCueDirector({ random: seeded(2), knobs: fast });
  director.open('gene', 's', 0, () => at({ satiety: 1 }));
  const view = director.view('gene', 0)!;
  assert.deepEqual([view.open.sound, view.open.mouth, view.open.shake], ['ah', { rate: 1, size: 1 }, null]);
  assert.ok(director.recent('gene')[0].open.why.includes('（兜底：这一次按原来的）'));
});

test('one knob changes only what it governs', () => {
  const seq = (knobs: FeedCueKnobs, satiety = 0.9) => {
    const director = new FeedCueDirector({ random: seeded(11), knobs }), out: FeedCueView[] = [];
    for (let i = 0; i < 60; i++) { director.open('gene', `k${i}`, i, () => at({ satiety })); director.bite('gene', `k${i}`, i, 'usual', () => at({ satiety })); out.push(director.view('gene', i)!); }
    return out;
  };
  const base = seq(FEED_CUE_KNOBS);
  const noWa = structuredClone(FEED_CUE_KNOBS) as FeedCueKnobs; (noWa.open.wa as { base: number }).base = 0;
  const a = seq(noWa);
  assert.ok(a.every(v => v.open.sound !== 'wa'), 'open.wa.base 0: never "哇～"');
  assert.deepEqual(a.map(v => [v.open.mouth, v.open.shake, v.eat!.chew]), base.map(v => [v.open.mouth, v.open.shake, v.eat!.chew]), 'the manner is untouched');
  const noShake = structuredClone(FEED_CUE_KNOBS) as FeedCueKnobs; (noShake.manner.shake as { chance: number }).chance = 0;
  const b = seq(noShake);
  assert.ok(base.some(v => v.open.shake) && b.every(v => !v.open.shake), 'manner.shake.chance 0: no shake');
  assert.deepEqual(b.map(v => [v.open.sound, v.eat!.sound, v.open.mouth, v.eat!.chew]), base.map(v => [v.open.sound, v.eat!.sound, v.open.mouth, v.eat!.chew]), 'everything else the same');
  const never = structuredClone(FEED_CUE_KNOBS) as FeedCueKnobs; (never.manner as { start: number }).start = 1;
  const c = seq(never);
  assert.ok(c.every(v => v.open.mouth.rate === 1 && v.eat!.chew.rate === 1 && !v.open.shake), 'manner.start 1: she always eats as before');
  assert.deepEqual(c.map(v => [v.open.sound, v.eat!.sound]), base.map(v => [v.open.sound, v.eat!.sound]), 'and says the same');
});

test('"此刻" comes from the snapshot, the card, her tiredness, how full she is, the taste and the line only', () => {
  const now = feedCueNow({ snapshot: { primary: 'happy', companion: 'playful', tendencies: { playful: 0.6 } }, personality: { playful: 1.4 }, fatiguePhase: 'drowsy',
    freshness: { card: DEFAULT_MOOD_PARAMETERS.freshness, taken: 2 }, taste: 'loved', lineFollows: true });
  assert.deepEqual(now, { mood: 'happy', tendency: 'playful', personality: { playful: 1.4, close: 1, comfortable: 1, cautious: 1 }, moments: ['sleepy'],
    satiety: feedSatiety(DEFAULT_MOOD_PARAMETERS.freshness, { ...plain, playful: 1.4 }, 2).satiety, fresh: 0.36, taste: 'loved', lineFollows: true });
  const faint = feedCueNow({ snapshot: { primary: 'calm', companion: 'close', tendencies: { close: 1e-10 } }, personality: null, fatiguePhase: null,
    freshness: { card: DEFAULT_MOOD_PARAMETERS.freshness, taken: 0 }, taste: 'nonsense' as never, lineFollows: false });
  assert.deepEqual([faint.tendency, faint.taste, faint.satiety, faint.fresh], [null, null, 0, 1], 'a faint leftover tendency, an unknown taste: nothing');
});

// ------------------------------------------------------------------------------------------------ the stage side

const eatingMood: StageMoodState = { mood: 'calm', phase: 'food-ready', expressive: true, face: 50, posture: 50, playful: 50, responding: false };
const plan = (patch: { rate?: number; size?: number; chew?: number; chewSize?: number; shake?: FeedCueView['open']['shake']; id?: string; eat?: boolean } = {}): FeedCueView => ({
  sessionId: patch.id ?? 's', open: { id: `${patch.id ?? 's'}:open`, sound: 'ah', mouth: { rate: patch.rate ?? 1, size: patch.size ?? 1 }, shake: patch.shake ?? null },
  ...(patch.eat === false ? {} : { eat: { id: `${patch.id ?? 's'}:eat`, sound: 'mm', chew: { rate: patch.chew ?? 1, size: patch.chewSize ?? 1 } } }) });
/** A snack's path: approaching (near 0 → 1 over 0.5 s), held at the mouth 0.7 s (prepared after 0.65 s), the bite 0.9 s, then gone 0.6 s. */
function feedRun(feed: FeedCueView | undefined, options: { headAllowed?: boolean; dt?: number; layer?: MoodFeedback } = {}) {
  const layer = options.layer ?? new MoodFeedback(), dt = options.dt ?? 1 / 60, rows: ReturnType<MoodFeedback['frame']>[] = [];
  const frames = (seconds: number, input: (t: number) => MoodContact, phase = 'food-ready') => {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) rows.push(layer.frame(dt, input(i / n), { ...eatingMood, phase, feed }, false, options.headAllowed ?? true));
  };
  frames(0.5, t => ({ ...EMPTY_CONTACT, feeding: true, prepared: false, near: t }));
  frames(0.7, t => ({ ...EMPTY_CONTACT, feeding: true, prepared: t >= 0.93, near: 1 }));
  frames(0.9, () => ({ ...EMPTY_CONTACT, feeding: true, prepared: true, accepted: true }), 'food-eating');
  frames(0.6, () => EMPTY_CONTACT, 'idle');
  return rows;
}

test('stage: without a pick, or with the plain one, every frame is exactly the old one; a full snack opens slower and smaller and chews slower', () => {
  const none = feedRun(undefined), plainRun = feedRun(plan());
  assert.deepEqual(plainRun, none, 'a plain pick (all 1, no shake) is bit-identical to no pick');
  const slow = feedRun(plan({ rate: 0.5, size: 0.85, chew: 0.65, chewSize: 0.85 }));
  const reach = (rows: typeof none, level: number) => rows.findIndex(row => row.mouth >= level);
  const level = FEED_OPEN * 0.55 * 0.7;
  assert.ok(reach(slow, level) > reach(none, level) + 3, `opens slower (${reach(slow, level)} vs ${reach(none, level)} frames)`);
  const slowOnly = feedRun(plan({ rate: 0.5 })), wideOnly = feedRun(plan({ size: 0.85 }));
  assert.ok(reach(slowOnly, level) > reach(none, level) + 3, `the pace alone slows it (${reach(slowOnly, level)} vs ${reach(none, level)} frames)`);
  assert.ok(Math.max(...slowOnly.slice(0, 72).map(row => row.mouth)) > Math.max(...wideOnly.slice(0, 72).map(row => row.mouth)) - 0.2, 'the pace alone does not make it small');
  assert.ok(Math.max(...wideOnly.slice(0, 72).map(row => row.mouth)) <= FEED_OPEN * 0.85 + 1e-9, 'the size alone keeps it smaller');
  const widest = (rows: typeof none) => Math.max(...rows.slice(0, 72).map(row => row.mouth));
  assert.ok(widest(slow) <= FEED_OPEN * 0.85 + 1e-9 && widest(slow) < widest(none) - 0.05, 'and not as wide');
  // Chewing: count the mouth's turning points during the bite (after the bite has closed it).
  const turns = (rows: typeof none) => { const bite = rows.slice(72 + 20, 72 + 54).map(row => row.mouth); let n = 0;
    for (let i = 1; i < bite.length - 1; i++) if ((bite[i] - bite[i - 1]) * (bite[i + 1] - bite[i]) < 0) n++; return n; };
  assert.ok(turns(slow) < turns(none), `chews slower (${turns(slow)} vs ${turns(none)} turns)`);
  assert.ok(Math.max(...slow.slice(72 + 20, 72 + 54).map(r => r.mouth)) <= CHEW_OPEN + 0.1);
  // R29: no snap anywhere (the bite itself closes like a bite, ≤ 0.065 a frame at 60 fps); when the bite ends mid-chew the chew
  // fades out instead of dropping (the old reset of its clock dropped the mouth by 0.107 in one frame here).
  for (const rows of [none, slow]) {
    for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i].mouth - rows[i - 1].mouth) < 0.08, `no snap at frame ${i}`);
    for (let i = 120; i < 140; i++) assert.ok(Math.abs(rows[i].mouth - rows[i - 1].mouth) < 0.02, `the chew fades out at frame ${i} (${rows[i - 1].mouth.toFixed(3)} → ${rows[i].mouth.toFixed(3)})`);
  }
  assert.equal(none.at(-1)!.headY, plainRun.at(-1)!.headY);
});

test('stage: a pick arriving mid-approach eases in, never jumps; the head shake is small, smooth, once per snack, and only when the head is free', () => {
  // The pick arrives a third of the way to her mouth.
  const layer = new MoodFeedback(), dt = 1 / 60, rows: ReturnType<MoodFeedback['frame']>[] = [];
  const slow = plan({ rate: 0.45, size: 0.8, eat: false });
  for (let i = 0; i < 60; i++) rows.push(layer.frame(dt, { ...EMPTY_CONTACT, feeding: true, prepared: false, near: Math.min(1, i / 30) }, { ...eatingMood, feed: i < 10 ? undefined : slow }));
  const steps = rows.slice(1).map((row, i) => row.mouth - rows[i].mouth);
  for (let i = 1; i < steps.length; i++) assert.ok(Math.abs(steps[i] - steps[i - 1]) < 0.01, `mouth speed continuous at ${i} (${steps[i - 1].toFixed(4)} → ${steps[i].toFixed(4)})`);
  const shake = { amplitude: 0.035, ms: 900, swings: 2 };
  const shaking = feedRun(plan({ shake })), still = feedRun(plan());
  const yaw = shaking.map((row, i) => row.headY - still[i].headY);
  const before = yaw.slice(0, 29);
  assert.ok(before.every(value => value === 0), 'nothing before the snack reaches her mouth');
  const peak = Math.max(...yaw.map(Math.abs));
  assert.ok(peak > 0.01 && peak <= shake.amplitude, `a light shake (${peak.toFixed(4)} rad)`);
  const velocity = shaking.slice(1).map((row, i) => (row.headY - shaking[i].headY) * 60);
  for (let i = 1; i < velocity.length; i++) assert.ok(Math.abs(velocity[i] - velocity[i - 1]) < 0.05, `head speed continuous at ${i}`);
  assert.ok(Math.abs(yaw.at(-1)!) < 0.002, 'settled again');
  const signs = yaw.filter(v => Math.abs(v) > 0.004).map(Math.sign);
  assert.ok(signs.some((s, i) => i > 0 && s !== signs[i - 1]), 'side to side');
  // Back at her mouth with the same snack: no second shake. Head busy (body motion, asleep): none.
  const performer = new FeedEatPerformer(), feed = plan({ shake });
  let max2 = 0;
  for (let round = 0; round < 2; round++) for (let i = 0; i < 90; i++) {
    const out = performer.frame(1 / 60, { feeding: true, holding: i < 60, eating: false }, feed, true);
    if (round === 1) max2 = Math.max(max2, Math.abs(out.yaw));
  }
  assert.equal(max2, 0, 'once per snack');
  const busy = feedRun(plan({ shake }), { headAllowed: false }), busyStill = feedRun(plan(), { headAllowed: false });
  assert.deepEqual(busy.map(r => r.headY), busyStill.map(r => r.headY), 'no shake while the head is not hers to move');
  // A malformed or out-of-range pick from the host is ignored (the old way).
  for (const bad of [{ ...plan(), open: { ...plan().open, mouth: { rate: 2, size: 1 } } }, { ...plan(), open: { ...plan().open, sound: '我' } }, { sessionId: 's' }])
    assert.deepEqual(feedRun(bad as FeedCueView), feedRun(undefined));
});

// ------------------------------------------------------------------------------------------------ the cue port

function clock() {
  let now = 0, ids = 0;
  const due: { at: number; id: number; callback: () => void }[] = [];
  return {
    now: () => now,
    timers: { set: (callback: () => void, ms: number) => { due.push({ at: now + ms, id: ++ids, callback }); return ids; },
      clear: (handle: unknown) => { const i = due.findIndex(item => item.id === handle); if (i >= 0) due.splice(i, 1); } },
    async advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now++;
        for (;;) { due.sort((a, b) => a.at - b.at); const next = due[0]; if (!next || next.at > now) break; due.shift(); next.callback(); await Promise.resolve(); }
        await Promise.resolve();
      }
    },
  };
}
function port(options: { ready?: (kind: CueKind) => boolean } = {}) {
  const c = clock(), played: string[] = [], prepared: (CueKind | undefined)[] = [];
  let listener: ((view: unknown) => void) | null = null;
  const player: ChosenFeedCuePlayer = {
    async play(kind, deadline) { played.push(`${kind}@${c.now()}≤${deadline}`); return { ended: Promise.resolve() }; },
    stop() {}, prepare(first) { prepared.push(first); }, sharesEngine: () => false, ready: options.ready,
  };
  const cues = new ChosenFeedCues({ player, onMood: callback => { listener = callback as (view: unknown) => void; return () => { listener = null; }; }, timers: c.timers, now: c.now });
  return { c, cues, played, prepared, publish: (view: object) => listener?.({ characterId: 'gene', expressions: true, ...view }) };
}
const sounds = (open: FeedCueView['open']['sound'], eat?: NonNullable<FeedCueView['eat']>['sound'], id = 's1'): FeedCueView => ({
  sessionId: id, open: { id: `${id}:open`, sound: open, mouth: { rate: 1, size: 1 }, shake: null },
  ...(eat === undefined ? {} : { eat: { id: `${id}:eat`, sound: eat, chew: { rate: 1, size: 1 } } }) });

test('cue port: plays her pick at each moment; "no sound" is silence; the bite\'s pick a few ms late is waited for inside the deadline', async () => {
  const p = port();
  p.cues.prepare(); p.publish({ feedCue: sounds('wa') });
  assert.ok(await p.cues.play('ah', FEED_CUE_DEADLINE_MS.ah));
  assert.deepEqual(p.played, [`wa@0≤${FEED_CUE_DEADLINE_MS.ah}`]);
  assert.deepEqual(p.cues.last, { moment: 'ah', sound: 'wa', source: 'plan' });
  const bite = p.cues.play('mm', FEED_CUE_DEADLINE_MS.mm);
  await p.c.advance(30); p.publish({ feedCue: sounds('wa', 'yum') });
  assert.ok(await bite);
  assert.equal(p.played.at(-1), `yum@30≤${FEED_CUE_DEADLINE_MS.mm - 30}`, 'played when the pick came, the rest of the deadline left');
  // Next snack: quiet before, quiet after.
  p.cues.prepare(); p.publish({ feedCue: sounds(null, null, 's2') });
  assert.equal(await p.cues.play('ah', 250), null); assert.equal(await p.cues.play('mm', 350), null);
  assert.equal(p.played.length, 2, 'no sound means nothing is played');
  assert.equal(p.cues.last?.source, 'quiet');
});

test('cue port: no pick in time → the original sound; 自动表现 off → the original at once; the same snack back at her mouth says its pick again', async () => {
  const p = port();
  p.cues.prepare();
  const late = p.cues.play('ah', 250);
  await p.c.advance(FEED_CUE_PLAN_WAIT_MS.ah + 5);
  assert.ok(await late);
  assert.equal(p.played[0], `ah@${FEED_CUE_PLAN_WAIT_MS.ah}≤${250 - FEED_CUE_PLAN_WAIT_MS.ah}`, 'waited at most its bound, then the old "啊～"');
  const off = port();
  off.publish({ expressions: false });
  off.cues.prepare();
  assert.ok(await off.cues.play('ah', 250));
  assert.ok(await off.cues.play('mm', 350));
  assert.deepEqual(off.played, ['ah@0≤250', 'mm@0≤350'], 'exactly as before, no waiting');
  const again = port();
  again.cues.prepare(); again.publish({ feedCue: sounds('aowu') });
  await again.cues.play('ah', 250);
  await again.cues.play('ah', 250); // the snack left her mouth and came back
  assert.deepEqual(again.played, ['aowu@0≤250', 'aowu@0≤250']);
  again.cues.prepare(); // a new snack: the old pick is not reused
  const fresh = again.cues.play('ah', 250);
  await again.c.advance(10); again.publish({ feedCue: sounds('soft', undefined, 's2') });
  await fresh;
  assert.equal(again.played.at(-1), 'soft@10≤240');
});

test('cue port (Bailian): a sound not synthesized yet → the original if it is cached, else only the motion; the picked one is fetched first', async () => {
  const cached = new Set<CueKind>(['ah', 'mm']);
  const p = port({ ready: kind => cached.has(kind) });
  p.cues.prepare(); p.publish({ feedCue: sounds('huh', 'wuen') });
  assert.ok(await p.cues.play('ah', 250));
  assert.deepEqual([p.played.at(-1), p.cues.last?.source, p.prepared.at(-1)], ['ah@0≤250', 'cached-original', 'huh']);
  cached.clear();
  assert.equal(await p.cues.play('mm', 350), null, 'nothing cached: only the motion');
  assert.deepEqual([p.cues.last?.source, p.prepared.at(-1)], ['not-ready', 'wuen']);
});

test('a failing, hanging or throwing synthesis never blocks the feed: she still pauses, eats and goes on talking in bounded time', async t => {
  for (const mode of ['fails', 'hangs', 'throws'] as const) {
    const e = pausableEngine(t);
    const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
    const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
    const player = new FeedCuePlayer({ getTtsConfig: () => bailian, getVoiceConfig: () => voice, timers: e.timers, now: e.now,
      api: { synthesizeFeedCue: () => mode === 'fails' ? Promise.resolve(null) : mode === 'hangs' ? new Promise(() => {}) : Promise.reject(new Error('network')) },
      audio: { prewarm() {}, acquire: () => new Promise(() => {}), dispose() {} } as never });
    const cues = new ChosenFeedCues({ player, timers: e.timers, now: e.now });
    cues.view({ characterId: 'gene', expressions: true, feedCue: sounds('wa') });
    const log: string[] = [];
    const pause = new FeedSpeechPause({ targets: [{ pause: () => log.push(`pause@${e.now()}`), resume: () => log.push(`resume@${e.now()}`) }], cues, voiceOn: () => true, timers: e.timers, now: e.now });
    pause.feedback({ feeding: true, prepared: false, near: 1 });
    await e.advance(700); pause.feedback({ feeding: true, prepared: true, near: 1 }); pause.feedback({ feeding: true, prepared: true, accepted: true });
    cues.view({ characterId: 'gene', expressions: true, feedCue: sounds('wa', 'yum') });
    await e.advance(900); pause.feedback({ feeding: false, prepared: false });
    await e.advance(FEED_CUE_WAIT_MS + FEED_RESUME_DELAY_MS + 200);
    assert.deepEqual(log, ['pause@0', `resume@${1600 + FEED_RESUME_DELAY_MS}`], `${mode}: resumed on time, as if no cue had been ready`);
    player.dispose(); cues.dispose(); pause.dispose();
  }
});
