/**
 * I-006 第 3 步 "跟着看"（docs/claude/2026-11-06-i006-step3.md）：屏幕共享开着、你在看视频时她转过去跟着看，偶尔回头看你；浏览器里的视频也认
 * （浏览器在前台停够 1 分钟、你又有一阵没操作时，让小模型看一张小图，回一个类别词），次数随聊天和互动变多。
 *
 * 全部用假的：假时钟、假的前台程序、假的小模型、假的"空闲秒数"；不读真屏幕、不读真键鼠、不开真屏幕共享。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HER_LIFE_TABLE, herLifeChatLine, herLifeSwitchOffer, herLifeWeights, pickHerLifeActivity, stepHerLife, type HerLifeActivity, type HerLifeRecord,
  type HerLifeStepInput, type HerLifeView,
} from '../shared/her-life';
import { HerLifeHost, type HerLifeTickInput } from '../electron/her-life/host';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import { watchKindOf } from '../shared/behaviors/watch-along/kind';
import { watchDirection, watchGaze } from '../shared/behaviors/watch-along/direction';
import { BrowserVideoGate, browserVideoQuota } from '../shared/behaviors/watch-along/gate';
import { WATCH_ALONG_KNOBS } from '../shared/behaviors/watch-along/knobs';
import { HerLifeStage, readScreenPlace } from '../src/stage/her-life-stage';
import { GLANCE_GAP_MS, PROBE_STALE_MS, ScreenGlance } from '../electron/screen-glance';
import type { ForegroundProbe, ForegroundReading } from '../electron/foreground-app';
import { SCREEN_ACTIVITIES, parseGlanceAnswer, type ScreenActivity } from '../shared/screen-activity';
import { createWatchAlong } from '../electron/watch-along';
import { createUserActivity } from '../electron/user-activity';

const MINUTE = 60_000;
const card = (motionMinutes = 5, weights: Partial<MoodParameters['weights']> = {}): MoodParameters => ({
  ...structuredClone(DEFAULT_MOOD_PARAMETERS),
  frequency: { ...DEFAULT_MOOD_PARAMETERS.frequency, motionIntervalMs: motionMinutes * MINUTE },
  weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights },
});
/** A small seeded generator, so the odds below are repeatable. */
function seeded(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------------------------------------------------------------- category → follow

test('类别对应到"跟着看"：只有看视频和玩游戏，别的类别都不跟', () => {
  assert.equal(watchKindOf('video'), 'video');
  assert.equal(watchKindOf('game'), 'game');
  for (const id of SCREEN_ACTIVITIES.filter(id => id !== 'video' && id !== 'game')) assert.equal(watchKindOf(id), null, id);
  assert.equal(watchKindOf(null), null);
  assert.equal(watchKindOf(undefined), null);
  assert.equal(HER_LIFE_TABLE.watching.label, '跟着看');
});

test('没有"跟着看"的来由时，一次都不会被选中；有来由时视频多半跟、游戏看她爱不爱玩', () => {
  const base = { current: 'company' as HerLifeActivity, localMinute: 14 * 60, mood: 'calm', weights: card().weights };
  assert.equal('watching' in herLifeWeights(base), false);
  assert.equal('watching' in herLifeWeights({ ...base, ownOnly: true, watch: { kind: 'video' } }), false, '"去忙自己的事"从来不选它');
  const share = (kind: 'video' | 'game', weights: MoodParameters['weights'], mood: string, current: HerLifeActivity = 'company') => {
    const random = seeded(7);
    let hit = 0;
    for (let i = 0; i < 4000; i++) if (pickHerLifeActivity({ ...base, current, mood, weights, watch: { kind } }, random) === 'watching') hit++;
    return hit / 4000;
  };
  // No watch: 4000 picks, never.
  const random = seeded(3);
  for (let i = 0; i < 4000; i++) assert.notEqual(pickHerLifeActivity(base, random), 'watching');
  const average = card().weights, playful = card(5, { playful: 1.7 }).weights, reserved = card(5, { playful: 0.4 }).weights;
  const video = share('video', average, 'calm');
  assert.ok(video > 0.55 && video < 0.9, `video ${video}`);
  const gameLoves = share('game', playful, 'happy'), gameAverage = share('game', average, 'calm'), gameReserved = share('game', reserved, 'sad');
  assert.ok(gameLoves > gameAverage && gameAverage > gameReserved, `game ${gameLoves} ${gameAverage} ${gameReserved}`);
  assert.ok(gameReserved < 0.25 && gameLoves > 0.3 && gameLoves < 0.7, `game ${gameLoves} ${gameReserved}`);
  assert.ok(video > gameLoves, 'a video is followed more than a game');
  // She may carry on with it (it is not excluded as "the current one"), and she may do something else too: not a fixed order.
  assert.ok(share('video', average, 'calm', 'watching') > 0.5 && share('video', average, 'calm', 'watching') < 1);
});

// ---------------------------------------------------------------- the state machine

const company: HerLifeRecord = { activity: 'company', since: 0, until: Number.MAX_SAFE_INTEGER, source: 'return' };
const daydream: HerLifeRecord = { activity: 'daydream', since: 0, until: 60 * MINUTE, source: 'rule' };
const watching: HerLifeRecord = { activity: 'watching', since: 0, until: 20 * MINUTE, source: 'rule' };
const step = (record: HerLifeRecord, over: Partial<HerLifeStepInput> = {}, random = () => 0.5) => stepHerLife(record, {
  now: 10 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over }, random);

test('一开始看视频，她可以马上转过去（每种只一次机会）；别的事做到一半也一样；睡意优先；不闲着（正在跟你互动）时不动', () => {
  // random 0.5 with the video weight: lands on watching for a daydreaming she.
  const turned = step(daydream, { watch: { kind: 'video', fresh: true } }, () => 0.9);
  assert.equal(turned.reason, 'watch');
  assert.equal(turned.record.activity, 'watching');
  assert.equal(step(daydream, { watch: { kind: 'video' } }).reason, 'unchanged', 'not fresh: she keeps on until her next change');
  assert.equal(step(daydream, { watch: { kind: 'video', fresh: true }, fatigue: 'drowsy' }).record.activity, 'drowsy', 'drowsy comes first');
  assert.equal(step(daydream, { watch: { kind: 'video', fresh: true }, idle: false }).reason, 'busy');
  assert.equal(step(daydream, { watch: { kind: 'video', fresh: true }, expressions: false }).reason, 'frozen');
  assert.equal(step(watching, { watch: { kind: 'video', fresh: true } }).reason, 'unchanged', 'already following');
});

test('看完了（共享关了、不再是视频），她回到自己的事；共享关着时一次都不会进入"跟着看"', () => {
  const over = step(watching, { now: 5 * MINUTE });
  assert.equal(over.reason, 'watch-over');
  assert.notEqual(over.record.activity, 'watching');
  assert.notEqual(over.record.activity, 'drowsy');
  // A long simulated afternoon with sharing off: she never follows anything.
  const random = seeded(11);
  let record: HerLifeRecord = company, entered = 0;
  for (let minute = 0; minute < 8 * 60; minute++) {
    const next = stepHerLife(record, { now: minute * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60 }, random);
    if (next.record.activity === 'watching') entered++;
    record = next.record;
  }
  assert.equal(entered, 0);
  // With a video on, over the same afternoon, she follows it a good part of the time but not all of it.
  record = company;
  let follows = 0, total = 0;
  for (let minute = 0; minute < 8 * 60; minute++) {
    const next = stepHerLife(record, { now: minute * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60,
      watch: { kind: 'video', ...(minute === 0 ? { fresh: true as const } : {}) } }, random);
    record = next.record; total++; if (record.activity === 'watching') follows++;
  }
  assert.ok(follows / total > 0.4 && follows / total < 0.95, `${follows}/${total}`);
});

test('"换件事做"不会把她从跟着看里叫走；她的话里只有"陪用户一起看屏幕"，没有任何屏幕内容', () => {
  const offer = herLifeSwitchOffer(watching, { now: 40 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card() });
  assert.equal(offer, null);
  assert.ok(herLifeSwitchOffer(daydream, { now: 40 * MINUTE, expressions: true, idle: true, fatigue: 'awake', parameters: card() })!.choices.every(id => id !== 'watching'));
  const line = herLifeChatLine({ activity: 'watching', minutes: 12 });
  assert.equal(line, '你刚才在：跟着用户一起看（约 12 分钟），被用户打断了；可以自然提一句，不用每次都提。');
  assert.doesNotMatch(line, /视频|电影|电视剧|游戏|网址|标题|画面/u, 'no content, and not even the category');
  const spec = HER_LIFE_TABLE.watching;
  assert.doesNotMatch(`${spec.label}${spec.chat}${spec.diaryLong}${spec.diaryShort}`, /视频|电影|游戏|网址|标题|画面/u);
});

// ---------------------------------------------------------------- the host

function hostHarness(file: string | null, writes: string[] = []) {
  const clock = { now: 1_000 * MINUTE };
  const changed: string[] = [], journal: string[] = [];
  const host = new HerLifeHost({ file: () => file, diagnosticsFile: () => null, developerMode: () => false, changed: id => changed.push(id),
    clock: () => clock.now, random: seeded(5), write: async (target, data) => { writes.push(String(data)); await writeFile(target, data); },
    journal: (_id, entry) => journal.push(`${entry.from}>${entry.to}`) });
  const tick = (over: Partial<HerLifeTickInput> = {}) => host.tick('gene', { now: clock.now, expressions: true, canExpress: true, phase: 'idle',
    lastInteractionAt: null, fatigue: 'awake', parameters: card(), mood: 'calm', localMinute: 14 * 60, ...over });
  return { host, clock, changed, journal, tick, writes };
}

test('host：共享关着，一整个下午一次都不会出现"跟着看"（视图、体验记录里都没有）', () => {
  const h = hostHarness(null);
  const seen = new Set<string>();
  for (let minute = 0; minute < 6 * 60; minute++) {
    h.clock.now += MINUTE;
    h.tick();
    seen.add(h.host.view('gene')!.activity);
    assert.equal(h.host.view('gene')!.watch, undefined);
  }
  assert.equal(seen.has('watching'), false);
  assert.equal(h.journal.some(line => line.includes('watching')), false);
});

test('host：看视频时视图带着"跟着看"和类别（不带别的）；看完后视图马上回到"陪着你"，即使她当时没空换', () => {
  const h = hostHarness(null);
  h.tick(); // she settles in
  let followed = false;
  for (let i = 0; i < 180 && !followed; i++) {
    h.clock.now += MINUTE;
    h.tick({ watch: 'video' });
    followed = h.host.view('gene')!.activity === 'watching';
  }
  assert.equal(followed, true, 'she turned to the video');
  const view = h.host.view('gene')!;
  assert.deepEqual(view.watch, { kind: 'video' });
  assert.deepEqual(Object.keys(view.watch!), ['kind']);
  // The video ends, but the user is just touching her (not idle): the state is still "watching" inside, the view already says company.
  const before = h.changed.length;
  h.clock.now += 5_000;
  h.tick({ phase: 'talking' as never, watch: undefined });
  const after = h.host.view('gene')!;
  assert.notEqual(after.activity, 'watching');
  assert.equal(after.watch, undefined);
  assert.ok(h.changed.length > before, 'the stage is told');
});

test('host：跟着看不写盘（记录里变成"陪着你"，日记素材里没有它），体验记录有"开始跟着看"这个类别', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'watch-along-'));
  const writes: string[] = [];
  const h = hostHarness(path.join(dir, 'her-life.json'), writes);
  await h.host.load();
  h.tick();
  let followed = false;
  for (let i = 0; i < 180 && !followed; i++) { h.clock.now += MINUTE; h.tick({ watch: 'video' }); followed = h.host.view('gene')!.activity === 'watching'; }
  assert.equal(followed, true);
  await h.host.flush();
  assert.ok(writes.length > 0);
  for (const text of writes) {
    assert.doesNotMatch(text, /watching|跟着看/u, 'the saved file never says she followed the screen');
    const saved = JSON.parse(text).characters.gene;
    assert.notEqual(saved.record.activity, 'watching');
    assert.equal(saved.log.some((row: { activity: string }) => row.activity === 'watching'), false);
  }
  assert.equal(h.journal.some(line => line.endsWith('>watching')), true);
  // Leaving "watching" does not put it in the log either, nor the diary material.
  h.clock.now += 30 * MINUTE;
  h.tick({ watch: undefined });
  h.clock.now += 30 * MINUTE;
  h.tick({ watch: undefined });
  await h.host.flush();
  for (const text of writes) assert.doesNotMatch(text, /watching/u);
  assert.doesNotMatch(h.host.diaryLine('gene', 0, h.clock.now + MINUTE, minute => minute), /看|屏幕/u);
  assert.deepEqual(await readdir(dir), ['her-life.json'], 'nothing else was written');
});

// ---------------------------------------------------------------- where she looks

test('视线方向：窗口在哪、屏幕在哪都对（单屏、右边的副屏、左边负坐标的副屏、竖屏），窗口正好在中间时不偏', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const at = (x: number, y: number, width = 400, height = 700) => ({ x, y, width, height });
  assert.deepEqual(watchDirection(at(760, 190), screen), { x: 0, y: watchDirection(at(760, 190), screen).y }); // centred sideways
  assert.ok(watchDirection(at(0, 190), screen).x > 0.7, 'window on the left: look right');
  assert.ok(watchDirection(at(1520, 190), screen).x < -0.7, 'window on the right: look left');
  assert.ok(watchDirection(at(760, 0, 400, 300), screen).y < 0, 'window at the top: look down');
  assert.ok(watchDirection(at(760, 780, 400, 300), screen).y > 0, 'window at the bottom: look up');
  // The same on a second screen to the right (x from 1920), and on one to the left (negative x): only the place on its own screen counts.
  const right = { x: 1920, y: 0, width: 2560, height: 1440 }, left = { x: -1920, y: -200, width: 1920, height: 1080 };
  const sameSpotRight = watchDirection(at(1920 + 100, 300), right), sameSpotMain = watchDirection(at(100, 300), { x: 0, y: 0, width: 2560, height: 1440 });
  assert.deepEqual(sameSpotRight, sameSpotMain);
  assert.ok(watchDirection(at(-1920, 100), left).x > 0.7, 'second screen on the left, window at its left edge: look right');
  assert.ok(watchDirection(at(-400, 100), left).x < -0.7, 'window at its right edge: look left');
  assert.ok(Math.abs(watchDirection(at(-1920 + 760, -200 + 190), left).x) < 0.01, 'centred on the second screen: not turned');
  // Not confused by where the other screens are: a window on the left screen measured against the main screen would look wrongly far right.
  assert.ok(watchDirection(at(-400, 100), screen).x < -1 + 1e-9 || watchDirection(at(-400, 100), screen).x === 1, 'against the wrong display it would be nonsense (clamped)');
  // Unreadable: straight ahead.
  for (const bad of [null, undefined, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }])
    assert.deepEqual(watchDirection(bad as never, screen), { x: 0, y: 0 });
  assert.deepEqual(watchDirection(at(0, 0), null), { x: 0, y: 0 });
  // The gaze: the wanted size, bounded, a little down when centred.
  const centred = watchGaze({ x: 0, y: 0 });
  assert.equal(centred.x, 0);
  assert.equal(centred.y, -WATCH_ALONG_KNOBS.gaze.down);
  assert.ok(Math.abs(watchGaze({ x: 5, y: 5 }).x) <= WATCH_ALONG_KNOBS.gaze.x + 1e-9, 'bounded');
});

test('读窗口和屏幕：缺哪个就不偏；有就用屏幕的工作区原点（多屏、负坐标都直接用）', () => {
  assert.equal(readScreenPlace({ window: {} }), null);
  assert.equal(readScreenPlace({}), null);
  const globals = { window: { screenX: -1500, screenY: 40, outerWidth: 400, outerHeight: 700, screen: { availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1040 } } };
  assert.deepEqual(readScreenPlace(globals), { window: { x: -1500, y: 40, width: 400, height: 700 }, display: { x: -1920, y: 0, width: 1920, height: 1040 } });
  assert.equal(readScreenPlace({ window: { ...globals.window, screen: { availWidth: 1920, availHeight: 1040 } } }), null, 'no origin of the display: not guessed');
});

const GATES = { expressive: true, engaged: false, bodyOwned: false, asleep: false, posture: 50 };
function frames(stage: HerLifeStage, seconds: number, input: Parameters<HerLifeStage['frame']>[1]) {
  for (let i = 0; i < Math.round(seconds * 60); i++) stage.frame(1 / 60, input);
  return stage.life;
}
const watchView = (activity: HerLifeActivity, watch = true): HerLifeView => ({ activity, since: 0, until: 1, source: 'rule', lookUp: null, ...(watch ? { watch: { kind: 'video' } } : {}) });

test('舞台：看视频时眼睛朝她所在那块屏幕的中间看；窗口拖到另一边，视线慢慢跟过去；晃得更轻；没有来由就不转', () => {
  const owner = {}, stage = new HerLifeStage(null);
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const input = (x: number, activity: HerLifeActivity = 'watching', watch = true) => ({ owner, view: watchView(activity, watch), gates: GATES, nowMs: 0,
    screen: { window: { x, y: 190, width: 400, height: 700 }, display } });
  frames(stage, 4, input(0));
  assert.ok((stage.life.gazeFixedX ?? 0) > 0.1, `left edge → eyes to the right (${stage.life.gazeFixedX})`);
  assert.ok(stage.life.saccade < 0.6 && stage.life.lookAtUser < 0.8 && stage.life.sway < 0.7, 'steadier, and she looks back at the user only now and then');
  assert.ok(stage.getState().watch > 0.9);
  // Dragged to the right edge: the gaze follows over a moment, never in one frame.
  let last = stage.life.gazeFixedX ?? 0, biggest = 0;
  for (let i = 0; i < 240; i++) { stage.frame(1 / 60, input(1520)); biggest = Math.max(biggest, Math.abs((stage.life.gazeFixedX ?? 0) - last)); last = stage.life.gazeFixedX ?? 0; }
  assert.ok(last < -0.1, `right edge → eyes to the left (${last})`);
  assert.ok(biggest < 0.02, `eased, not a step (${biggest})`);
  // The mirror image in the other direction: the same spot on a second screen to the left gives the same look.
  const second = new HerLifeStage(null);
  frames(second, 4, { owner, view: watchView('watching'), gates: GATES, nowMs: 0, screen: { window: { x: -1920, y: 190, width: 400, height: 700 }, display: { x: -1920, y: 0, width: 1920, height: 1080 } } });
  frames(stage, 0, input(0));
  const main = new HerLifeStage(null);
  frames(main, 4, input(0));
  assert.ok(Math.abs((second.life.gazeFixedX ?? 0) - (main.life.gazeFixedX ?? 0)) < 1e-6, 'a second screen on the left looks the same');
  // The user is here (typing, chatting): she gives way, as every one of her own things does.
  frames(stage, 0.5, { ...input(0), gates: { ...GATES, engaged: true } });
  assert.equal(stage.life.gazeFixedX, 0);
  // Without something to follow ("watching" with no watch, or any other state): straight, no turn at all.
  const idle = new HerLifeStage(null);
  frames(idle, 4, input(0, 'watching', false));
  assert.equal(idle.life.gazeFixedX, 0);
  assert.equal(idle.getState().activity, 'company');
  for (const activity of ['company', 'daydream', 'humming', 'thinking', 'drowsy'] as const) {
    const other = new HerLifeStage(null);
    frames(other, 4, { owner, view: watchView(activity, false), gates: GATES, nowMs: 0, screen: input(0).screen });
    assert.equal(other.life.gazeFixedX, 0, activity);
    assert.equal(other.life.gazeFixedY, 0, activity);
  }
});

// ---------------------------------------------------------------- the browser-video gate

test('每小时的上限：0 次互动 6、10 次 8、100 次 20（封顶），坏数字按 0', () => {
  assert.equal(browserVideoQuota(0), 6);
  assert.equal(browserVideoQuota(4), 6);
  assert.equal(browserVideoQuota(5), 7);
  assert.equal(browserVideoQuota(10), 8);
  assert.equal(browserVideoQuota(35), 13);
  assert.equal(browserVideoQuota(100), 20);
  assert.equal(browserVideoQuota(10_000), 20);
  for (const bad of [NaN, -3, undefined as never, Infinity]) assert.ok(browserVideoQuota(bad) >= 6 && browserVideoQuota(bad) <= 20);
  assert.deepEqual(WATCH_ALONG_KNOBS.quota, { base: 6, interactionsPerExtra: 5, max: 20, windowMinutes: 60 });
});

test('门：前台停够 1 分钟、又没操作才问一次；一直在前台不重复；你回来操作再停下才可能再问；读不到空闲秒数一次都不问', () => {
  const gate = new BrowserVideoGate();
  let now = 0;
  const ask = (idleSeconds: number | null, interactions = 0) => gate.ask({ now, idleSeconds, interactionsLastHour: interactions });
  gate.front('chrome', now);
  now += 59_000;
  assert.equal(ask(120), false, '59 seconds in front is not enough');
  now += 1_000;
  assert.equal(ask(null), false, 'idle unknown: no look');
  assert.equal(ask(10), false, 'the user is operating: no look');
  assert.equal(ask(120), true, 'a minute in front and away: one look');
  for (let i = 0; i < 600; i++) { now += 1_000; gate.front('chrome', now); assert.equal(ask(120 + i), false, 'still in front, still away: not asked again'); }
  // The user comes back and operates, then stops again: a new look is allowed.
  now += 1_000; assert.equal(ask(2), false);
  now += 60_000; gate.front('chrome', now);
  assert.equal(ask(90), true);
  // Left for another program (or her own window) and back: the minute is counted again from the return.
  gate.front(null, now); now += 1_000; gate.front('chrome', now);
  now += 30_000; assert.equal(ask(300), false);
  now += 30_000; assert.equal(ask(300), true);
  assert.equal(gate.count(now), 3);
});

test('门：每小时最多问 6 次（没互动）、互动多就多问，一小时后额度回来；共享关掉全忘', () => {
  const run = (interactions: number) => {
    const gate = new BrowserVideoGate();
    let now = 0, asked = 0;
    for (let n = 0; n < 40; n++) {
      // A new show every 90 seconds: the user pokes the mouse (idle small), the page is in front, then lets go.
      gate.front('chrome', now);
      now += 61_000;
      if (gate.ask({ now, idleSeconds: 100, interactionsLastHour: interactions })) asked++;
      gate.ask({ now: now + 1, idleSeconds: 1, interactionsLastHour: interactions });
      now += 29_000;
    }
    return asked;
  };
  assert.equal(run(0), 6);
  assert.equal(run(10), 8);
  assert.equal(run(100), 20);
  const gate = new BrowserVideoGate();
  gate.front('chrome', 0);
  for (let n = 0; n < 6; n++) { assert.equal(gate.ask({ now: 61_000 + n * 70_000, idleSeconds: 100, interactionsLastHour: 0 }), true); gate.ask({ now: 62_000 + n * 70_000, idleSeconds: 1, interactionsLastHour: 0 }); }
  assert.equal(gate.ask({ now: 61_000 + 6 * 70_000, idleSeconds: 100, interactionsLastHour: 0 }), false, 'the seventh in the same hour');
  assert.equal(gate.ask({ now: 61_000 + 61 * MINUTE, idleSeconds: 100, interactionsLastHour: 0 }), true, 'an hour later the earlier ones have left the count');
  gate.reset();
  assert.equal(gate.count(61 * MINUTE), 0);
});

// ---------------------------------------------------------------- ScreenGlance with the gate (fake probe, fake model, fake clock)

function fakeProbe() {
  let reading: ((value: ForegroundReading) => void) | null = null;
  const probe: ForegroundProbe & { starts: number } = { starts: 0, start(onReading) { this.starts++; reading = onReading; }, stop() { reading = null; } };
  return { probe, read: (value: ForegroundReading) => reading?.(value) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function watcher(options: { idle?: { value: number | null }; interactions?: { value: number }; mayLook?: () => boolean; answer?: string } = {}) {
  let now = 1_000_000;
  const reader = fakeProbe(), idle = options.idle ?? { value: 120 }, interactions = options.interactions ?? { value: 0 };
  const classified: string[] = [], thumbnails: string[] = [];
  const host = new ScreenGlance({
    probe: reader.probe,
    thumbnail: async () => { const picture = `data:image/jpeg;base64,/9j/${thumbnails.length}A==`; thumbnails.push(picture); return picture; },
    classify: async picture => { classified.push(picture); return options.answer ?? '看视频'; },
    mayLook: options.mayLook ?? (() => true),
    idleSeconds: () => idle.value, interactionsLastHour: () => interactions.value,
    clock: () => now, setTimeout: () => 0, clearTimeout: () => {},
  });
  /** A second at a time: the program in front is read, the one-second beat runs. */
  const seconds = async (count: number, exe: ForegroundReading = { exe: 'chrome.exe' }) => {
    for (let i = 0; i < count; i++) { now += 1_000; reader.read(exe); host.watchTick(); await flush(); }
  };
  return { host, reader, idle, interactions, classified, thumbnails, seconds, now: () => now };
}

test('浏览器视频：共享开着、浏览器在前台 1 分钟、你没操作 → 看一张小图，回"看视频"，她就跟着看；之后一直在前台不再问', async () => {
  const w = watcher();
  assert.equal(w.host.watching(), null);
  w.host.setSharing(true);
  await w.seconds(59);
  assert.equal(w.classified.length, 0, 'not yet a minute');
  await w.seconds(2);
  assert.equal(w.classified.length, 1, 'one look');
  assert.equal(w.host.watching(), 'video');
  // 40 minutes of the show: not asked again, and she still follows it long after the 5-minute cache would have gone.
  await w.seconds(40 * 60);
  assert.equal(w.classified.length, 1);
  assert.equal(w.thumbnails.length, 1);
  assert.equal(w.host.watching(), 'video');
  assert.equal(watchKindOf(w.host.watching()), 'video');
});

test('浏览器视频：共享关着一次都不看、不跟；开关"知道你是不是在忙"关着（读不到空闲秒数）也不看；模型不可用 / 用户说"别看"也不看', async () => {
  const off = watcher();
  await off.seconds(30 * 60);
  assert.equal(off.classified.length, 0);
  assert.equal(off.host.watching(), null);
  assert.equal(off.reader.probe.starts, 0, 'the foreground reader never even started');

  const blind = watcher({ idle: { value: null } });
  blind.host.setSharing(true);
  await blind.seconds(30 * 60);
  assert.equal(blind.classified.length, 0, 'idle seconds unknown (the switch is off): the browser is never looked at');
  assert.equal(blind.host.watching(), null);

  const refused = watcher({ mayLook: () => false });
  refused.host.setSharing(true);
  await refused.seconds(30 * 60);
  assert.equal(refused.classified.length, 0);

  // Sharing goes off in the middle: the answer is dropped and she stops following at once.
  const w = watcher();
  w.host.setSharing(true);
  await w.seconds(80);
  assert.equal(w.host.watching(), 'video');
  w.host.setSharing(false);
  assert.equal(w.host.watching(), null);
  await w.seconds(600);
  assert.equal(w.classified.length, 1, 'nothing more after it went off');
});

test('浏览器视频：你一直在操作不看；回来操作后她不再跟着看；别的程序在前台、或在她自己的窗口里操作也不看', async () => {
  const w = watcher({ idle: { value: 5 } });
  w.host.setSharing(true);
  await w.seconds(10 * 60);
  assert.equal(w.classified.length, 0, 'the user is typing in the browser');
  w.idle.value = 100;
  await w.seconds(5);
  assert.equal(w.classified.length, 1);
  assert.equal(w.host.watching(), 'video');
  w.idle.value = 2; // the user touches the mouse: back at it
  await w.seconds(1);
  w.idle.value = 100;
  // The streak's answer is gone; the cached one is the ordinary five-minute reading.
  await w.seconds(GLANCE_GAP_MS / 1000 + 5);
  assert.equal(w.classified.length, 2, 'a later pause may ask again (within the hourly count)');

  const code = watcher();
  code.host.setSharing(true);
  await code.seconds(10 * 60, { exe: 'Code.exe' });
  assert.equal(code.classified.length, 0, 'a program the table knows needs no look');
  assert.equal(watchKindOf(code.host.watching()), null, 'code is not followed');

  const self = watcher();
  self.host.setSharing(true);
  await self.seconds(30);
  await self.seconds(40, 'self');
  await self.seconds(30);
  assert.equal(self.classified.length, 0, 'her own window in between starts the minute again');
});

test('浏览器视频：小模型回的不是"看视频"（比如"上网"）就不跟；答非所问当不知道；画面不存、不出这个对象', async () => {
  const web = watcher({ answer: '上网' });
  web.host.setSharing(true);
  await web.seconds(90);
  assert.equal(web.host.watching(), 'web');
  assert.equal(watchKindOf(web.host.watching()), null);
  await web.seconds(10 * 60);
  assert.equal(web.classified.length, 1, 'an answer that is not a video is not asked again either');

  const chatty = watcher({ answer: '用户在看一部电影，画面里有一个人在哭' });
  chatty.host.setSharing(true);
  await chatty.seconds(90);
  assert.equal(chatty.host.watching(), null, 'a sentence is not a word: not known');

  const w = watcher();
  w.host.setSharing(true);
  await w.seconds(90);
  const text = JSON.stringify(Object.entries(w.host).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value, (_k, v) => v instanceof Map ? [...v] : v) : String(value)]));
  assert.equal(w.thumbnails.length, 1);
  assert.equal(text.includes('base64'), false, 'the picture is kept nowhere in the object');
  assert.deepEqual(Object.keys(w.host.view()).sort(), ['activity', 'answered', 'looks', 'reading', 'sharing']);
  assert.equal(JSON.stringify(w.host.view()).includes('chrome'), false);
});

test('浏览器视频的次数：每小时 6 次打底，互动多就多问（0 次 6、10 次 8、100 次 20）；两次之间至少隔 30 秒', async () => {
  const count = async (interactions: number) => {
    const w = watcher({ interactions: { value: interactions } });
    w.host.setSharing(true);
    for (let n = 0; n < 38; n++) {
      // Each round: a minute in front while away, then the user pokes the mouse; 90 seconds a round, 38 rounds is 57 minutes (inside one hour).
      w.idle.value = 100;
      await w.seconds(65);
      w.idle.value = 1;
      await w.seconds(1);
      w.idle.value = 100;
      await w.seconds(24);
    }
    return w.classified.length;
  };
  assert.equal(await count(0), 6);
  assert.equal(await count(10), 8);
  assert.equal(await count(100), 20);
});

test('公开的常量没动：扫一眼的间隔、过期；不读程序名的承诺', () => {
  assert.equal(GLANCE_GAP_MS, 30_000);
  assert.equal(PROBE_STALE_MS, 15_000);
});

test('小模型的回答：真调用里它把"玩游戏"答成了"游戏"，同一个词的短写也认；句子和别的词还是不认', () => {
  assert.equal(parseGlanceAnswer('游戏'), 'game');
  assert.equal(parseGlanceAnswer('视频。'), 'video');
  for (const bad of ['constructor', '__proto__', '游戏机', '看视频或游戏', '电影']) assert.equal(parseGlanceAnswer(bad), null, bad);
});

// ---------------------------------------------------------------- the source her life reads

test('跟着看的来源：共享关着、"别看"、或没有类别，都是 null；测试命令假装不需要共享也不读真屏幕', () => {
  let sharing = false, refused = false, activity: ScreenActivity | null = 'video', now = 0;
  const source = createWatchAlong({ sharing: () => sharing, refused: () => refused, activity: () => activity, clock: () => now });
  assert.equal(source.kind(), null, 'sharing off');
  sharing = true;
  assert.equal(source.kind(), 'video');
  activity = 'game'; assert.equal(source.kind(), 'game');
  activity = 'code'; assert.equal(source.kind(), null);
  activity = 'video'; refused = true; assert.equal(source.kind(), null, '别看');
  refused = false; sharing = false;
  source.pretend('video');
  assert.equal(source.kind(), 'video', 'a pretended video (developer test command)');
  now += 11 * MINUTE;
  assert.equal(source.kind(), null, 'the pretence ended by itself');
  source.pretend('game'); source.pretend(null);
  assert.equal(source.kind(), null);
  const throwing = createWatchAlong({ sharing: () => { throw new Error('x'); }, refused: () => false, activity: () => 'video' });
  assert.equal(throwing.kind(), null);
});

test('"知道你是不是在忙"：空闲秒数只在开关开着、没锁屏没睡眠、没在假装、读数新鲜时才有', () => {
  let now = 1_000, idle = 120, locked: (() => void) | null = null, unlocked: (() => void) | null = null;
  const power = { on: (event: string, listener: () => void) => { if (event === 'lock-screen') locked = listener; if (event === 'unlock-screen') unlocked = listener; } };
  const user = createUserActivity({ directory: () => null, idleSeconds: () => idle, windowFocused: () => false, power: power as never, clock: () => now });
  assert.equal(user.idleSeconds(), null, 'before any tick');
  user.tick();
  assert.equal(user.idleSeconds(), 120);
  now += 4_000; assert.equal(user.idleSeconds(), 120);
  now += 2_000; assert.equal(user.idleSeconds(), null, 'an old reading is not used');
  user.tick(); assert.equal(user.idleSeconds(), 120);
  locked!(); user.tick(); assert.equal(user.idleSeconds(), null, 'locked');
  unlocked!(); user.tick(); assert.equal(user.idleSeconds(), 120);
  user.pretend('busy'); user.tick(); assert.equal(user.idleSeconds(), null, 'pretending: the real idle time is not used');
  user.pretend(null); user.tick(); assert.equal(user.idleSeconds(), 120);
  user.setEnabled(false); user.tick(); assert.equal(user.idleSeconds(), null, 'switch off');
  idle = Number.NaN; user.setEnabled(true); user.tick(); assert.equal(user.idleSeconds(), null, 'unreadable');
});
