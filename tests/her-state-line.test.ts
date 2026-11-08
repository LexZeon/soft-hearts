// I-017 "啥都是状态"（docs/claude/2026-11-03-her-state-line.md）：每一轮的【此刻的感知】也说她听到了什么、身体在怎么动、
// 刚被摸头喂食捏脸；渲染端只经一个窄通道报"在不在、是什么"，过期和晚到的不复活；内心循环的【此刻】也带上听和她自己在做的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTACT_MOOD_REASON, HER_CONTACTS, HER_CONTACT_RECENT_MS, HER_STATE_MAX, STAGE_MUSIC_STATES, asksAboutHearing, briefHearingWords, contactWords, contactsToTell, hearingInnerLoopLine,
  hearingWords, parseStageStateReport, type HearingNow, type HerContact, type HerStateNow, type StageMusicState,
} from '../shared/her-state';
import { PERCEPTION_LINE_MAX, SENSING_AND_HEARING_OFF_LINE, perceptionTurnLine, type PerceptionTurn } from '../shared/perception-rule';
import { HearingTold, STAGE_STATE_TTL_MS, StageStateHost, createHerState, hearingSource } from '../electron/her-state-host';
import { musicPresence } from '../src/stage/music-presence';
import { HER_STATE_REPORT_HEARTBEAT_MS, HerStateReporter } from '../src/ui/her-state-reporter';
import { buildInnerLoopPrompt, innerLoopQuiet } from '../shared/inner-loop';
import { innerLoopPrompt, type InnerLoopContextSources } from '../electron/inner-loop/context';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { CompanionService } from '../electron/companion';
import type { MoodInput } from '../shared/mood-runtime';
import type { AudioCaptureState } from '../shared/audio-capture';

const sight = (patch: Partial<PerceptionTurn> = {}): PerceptionTurn => ({ screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null, ...patch });
const hearing = (source: HearingNow['source'], music: StageMusicState | null, always = false, transcript = false): HearingNow =>
  ({ source, stage: music ? { music, always } : null, transcript });
const state = (h: HearingNow, contacts: HerContact[] = []): HerStateNow => ({ hearing: h, contacts });

test('典型几种情况的原文：默认最短，开着音乐照实说在不在放、她在跳还是点头还是没动，听不懂歌词', () => {
  const off = sight();
  assert.equal(perceptionTurnLine(off, state(hearing(null, null))), `【此刻的感知】${SENSING_AND_HEARING_OFF_LINE}`);
  assert.equal(SENSING_AND_HEARING_OFF_LINE, '你看不到用户的屏幕和摄像头画面，也听不到声音。');
  assert.equal(perceptionTurnLine(off, state(hearing('system-audio', 'dance'))),
    '【此刻的感知】你看不到用户的屏幕和摄像头画面。用户让你听到电脑里的声音，现在在放有节奏的声音（像是歌），你正跟着跳；你只听得到节奏，听不懂歌词。');
  assert.equal(perceptionTurnLine(off, state(hearing('system-audio', 'dance', true))),
    '【此刻的感知】你看不到用户的屏幕和摄像头画面。用户让你听到电脑里的声音，现在在放有节奏的声音（像是歌），你正跟着跳（用户设了让你一直跟着跳）；你只听得到节奏，听不懂歌词。');
  assert.match(perceptionTurnLine(off, state(hearing('system-audio', 'nod'))), /你正跟着轻轻点头、晃一晃；你只听得到节奏，听不懂歌词。$/u);
  assert.match(perceptionTurnLine(off, state(hearing('system-audio', 'still'))), /现在在放有节奏的声音（像是歌），你没跟着动；/u);
  assert.match(perceptionTurnLine(off, state(hearing('system-audio', 'silent'))), /用户让你听到电脑里的声音，这会儿好像没声音。$/u);
  // On, but the pet window has said nothing fresh: only what the host knows.
  assert.match(perceptionTurnLine(off, state(hearing('system-audio', null))), /用户让你听到电脑里的声音；你只听得到声音和节奏，听不懂歌词。$/u);
  assert.match(perceptionTurnLine(off, state(hearing('microphone', 'dance'))), /用户让你听到麦克风里的声音/u);
  // A transcript block in this turn: the words are the transcript's, not "听不懂歌词".
  const transcribed = perceptionTurnLine(off, state(hearing('system-audio', 'nod', false, true)));
  assert.match(transcribed, /听到的内容只以附的转写为准/u); assert.doesNotMatch(transcribed, /听不懂歌词/u);
  assert.equal(hearingWords(hearing(null, null, false, true)), '你听不到声音本身，只有附的那段声音转写。');
  // Just touched (and not in the mood note).
  assert.equal(perceptionTurnLine(off, state(hearing(null, null), ['pat'])), `【此刻的感知】${SENSING_AND_HEARING_OFF_LINE}用户刚才摸了摸你的头。`);
  assert.equal(contactWords(['food', 'pinch', 'pat', 'pat']), '用户刚才喂了你一份点心、捏了捏你的脸、摸了摸你的头。');
  // The step-1 line is untouched when the caller passes no state (tests and the voice path).
  assert.equal(perceptionTurnLine(off), '【此刻的感知】你看不到用户的屏幕和摄像头画面。');
});

test('R28 两次都没过线：详细的只在一段对话开头和开关变了的那一轮，问到时带简版，其余几轮一个字不加（就是第 1 步那一行）', () => {
  const off = sight();
  const say = (mode: 'brief' | 'none', h: HearingNow, contacts: HerContact[] = []) => perceptionTurnLine(off, { hearing: h, contacts, say: mode });
  assert.equal(say('none', hearing('system-audio', 'dance')), '【此刻的感知】你看不到用户的屏幕和摄像头画面。', 'byte for byte the step-1 line');
  assert.equal(say('none', hearing(null, null)), perceptionTurnLine(off));
  assert.equal(say('none', hearing('system-audio', 'dance'), ['pat']), '【此刻的感知】你看不到用户的屏幕和摄像头画面。用户刚才摸了摸你的头。', 'a touch is news: always said');
  assert.equal(say('brief', hearing('system-audio', 'dance')), '【此刻的感知】你看不到用户的屏幕和摄像头画面。电脑里在放有节奏的声音，你正跟着跳；听不懂歌词。');
  assert.equal(say('brief', hearing(null, null)), `【此刻的感知】${SENSING_AND_HEARING_OFF_LINE}`, 'asked while off: she cannot hear, said plainly');
  assert.equal(briefHearingWords(hearing('system-audio', 'dance', true)), '电脑里在放有节奏的声音，你正跟着跳（一直跟着跳）；听不懂歌词。');
  assert.equal(briefHearingWords(hearing('system-audio', 'nod')), '电脑里在放有节奏的声音，你正跟着轻轻点头；听不懂歌词。');
  assert.equal(briefHearingWords(hearing('system-audio', 'still')), '电脑里在放有节奏的声音，你没跟着动；听不懂歌词。');
  assert.equal(briefHearingWords(hearing('system-audio', 'silent')), '电脑里这会儿好像没声音。');
  assert.equal(briefHearingWords(hearing('microphone', null)), '你听得到麦克风里的声音，听不懂歌词。');
  assert.equal(briefHearingWords(hearing('system-audio', 'nod', false, true)), '电脑里在放有节奏的声音，你正跟着轻轻点头；内容以转写为准。');
  for (const music of STAGE_MUSIC_STATES) for (const always of [false, true]) for (const transcript of [false, true]) {
    const h = hearing('system-audio', music, always, transcript);
    assert.ok(briefHearingWords(h).length < hearingWords(h).length, `${music}: brief is shorter`);
  }
  // The message is about it.
  for (const text of ['你在干嘛呀？', '你在听歌吗', '这首歌唱的什么呀', '好听吗', '你怎么在晃', '跳一个', '吵不吵', 'what song is this']) assert.equal(asksAboutHearing(text), true, text);
  for (const text of ['晚上吃什么好呢？', '今天写了一下午代码', '嗯嗯', '', null, 42]) assert.equal(asksAboutHearing(text), false, String(text));

  // Which turn gets which: once per conversation and per change of the switch.
  const told = new HearingTold();
  assert.equal(told.repeat('conversation-1', 'system-audio|false'), false, 'first turn: in full');
  assert.equal(told.repeat('conversation-1', 'system-audio|false'), true);
  assert.equal(told.repeat('conversation-1', 'off|false'), false, 'the switch went off');
  assert.equal(told.repeat('conversation-1', 'system-audio|false'), false, 'and on again');
  assert.equal(told.repeat('conversation-2', 'system-audio|false'), false, 'a new conversation hears it in full again');
  assert.equal(told.repeat('', 'off|false'), false); assert.equal(told.repeat('', 'off|false'), false, 'no scope: always in full');

  // Through the host reader, as electron/main.ts calls it.
  let scope = 'conversation-a', music: StageMusicState = 'dance', seq = 0, on = true;
  const stage = new StageStateHost(() => 1_000);
  const report = () => stage.accept({ instance: 'pet-page-told-1', seq: ++seq, music, always: false });
  report();
  const herState = createHerState({ stage, scope: () => scope, now: () => 1_000, contacts: () => [], legacy: () => null,
    capture: () => ({ revision: 1, slots: { 'system-audio': { id: 's', source: 'system-audio', owner: 'pet', revision: 1, chat: false, dance: on, ambient: null }, microphone: null } }) });
  const line = (text: string) => perceptionTurnLine(off, herState.chatTurn('人设', text));
  assert.match(line('嗨'), /用户让你听到电脑里的声音.*你正跟着跳；你只听得到节奏/u, 'first turn of the conversation: in full');
  assert.equal(line('晚上吃什么好呢？'), perceptionTurnLine(off), 'an unrelated turn: nothing added');
  assert.match(line('你在听歌吗'), /电脑里在放有节奏的声音，你正跟着跳；听不懂歌词。$/u, 'asked: brief');
  music = 'nod'; report();
  assert.equal(line('今天好累'), perceptionTurnLine(off), 'her body changing alone is not worth a slower turn');
  assert.match(line('你在干嘛'), /你正跟着轻轻点头；听不懂歌词。$/u, 'asked: the current state');
  on = false;
  assert.equal(line('今天好累'), `【此刻的感知】${SENSING_AND_HEARING_OFF_LINE}`, 'the switch went off: in full');
  assert.equal(line('今天好累'), perceptionTurnLine(off));
  on = true; scope = 'conversation-b';
  assert.match(line('今天好累'), /用户让你听到/u, 'a new conversation: in full');
  assert.equal(herState.chatTurn('人设', '嗯').say, 'none');
});

test('所有组合：一行、有字数上限、默认最短、不矛盾（"听不到"和"在放/在跳"不同时出现；关着不提"让你听到"）', () => {
  const sights = [sight(), sight({ screen: true }), sight({ camera: 'local' }), sight({ camera: 'frames' }), sight({ asked: 'screen' }), sight({ asked: 'camera', camera: 'local' }),
    sight({ screen: true, camera: 'frames', attached: { screen: true, camera: true }, asked: 'either' }), sight({ attached: { screen: true, camera: false } })];
  const hearings: HearingNow[] = [];
  for (const source of [null, 'system-audio', 'microphone'] as const) for (const music of [null, ...STAGE_MUSIC_STATES]) for (const always of [false, true]) for (const transcript of [false, true])
    hearings.push(hearing(source, source ? music : null, always, transcript));
  const contactSets: HerContact[][] = [[], ['pat'], ['food', 'pinch'], [...HER_CONTACTS]];
  const shortest = perceptionTurnLine(sight(), { ...state(hearing(null, null)), say: 'none' });
  let count = 0;
  for (const s of sights) for (const h of hearings) for (const c of contactSets) for (const say of ['full', 'brief', 'none'] as const) {
    const line = perceptionTurnLine(s, { ...state(h, c), say }); count++;
    assert.ok(line.startsWith('【此刻的感知】') && !line.includes('\n'), line);
    assert.ok(line.length <= PERCEPTION_LINE_MAX, `${line.length}: ${line}`);
    assert.ok((hearingWords(h) + contactWords(c)).length <= HER_STATE_MAX, hearingWords(h) + contactWords(c));
    assert.ok(line.length >= shortest.length, line);
    if (/听不到/u.test(line)) assert.doesNotMatch(line, /跟着跳|点头|在放|让你听到/u, line);
    if (!h.source) assert.doesNotMatch(line, /让你听到|听得到|在放|跟着跳|点头|很安静/u, line);
    if (say === 'none') assert.equal(line, perceptionTurnLine(s) + contactWords(c), 'nothing about hearing');
    else if (h.source) assert.match(line, say === 'brief' ? /里在放|这会儿好像没声音|你听得到/u : /用户让你听到/u, line);
    if (say !== 'none' && h.source && h.stage && ['still', 'nod', 'dance'].includes(h.stage.music)) assert.match(line, h.transcript ? /以(?:附的)?转写为准/u : /听不懂歌词/u, line);
    assert.doesNotMatch(line, /[他她]/u, 'the user is 用户 / 你');
  }
  assert.equal(count, sights.length * hearings.length * contactSets.length * 3);
});

test('渲染端的报告只认白名单形状：四个字段、枚举、正整数序号、实例号', () => {
  const good = { instance: 'a1b2c3d4-0000-4000-8000-000000000001', seq: 1, music: 'dance', always: false };
  assert.deepEqual(parseStageStateReport(good), good);
  for (const music of STAGE_MUSIC_STATES) assert.ok(parseStageStateReport({ ...good, music }));
  const bad: unknown[] = [null, [], 'dance', { ...good, extra: 1 }, { instance: good.instance, seq: 1, music: 'dance' }, { ...good, music: 'sing' },
    { ...good, seq: 0 }, { ...good, seq: 1.5 }, { ...good, seq: '2' }, { ...good, always: 'yes' }, { ...good, instance: 'short' }, { ...good, instance: '../../etc/passwd' },
    { ...good, instance: 'x'.repeat(65) }, Object.assign(Object.create({ polluted: true }), good),
    Object.defineProperty({ instance: good.instance, seq: 1, always: false }, 'music', { get: () => 'dance', enumerable: true })];
  for (const value of bad) assert.equal(parseStageStateReport(value), null, JSON.stringify(value));
});

test('宿主：只信新鲜的；同一次页面加载序号必须变大；被换掉的页面加载晚到的报告不复活', () => {
  let now = 1_000_000;
  const host = new StageStateHost(() => now);
  const report = (instance: string, seq: number, music: StageMusicState, always = false) => ({ instance, seq, music, always });
  const first = 'page-one-0001', second = 'page-two-0002';
  assert.equal(host.current(), null);
  assert.equal(host.accept(report(first, 1, 'nod')), true);
  assert.deepEqual(host.current(), { music: 'nod', always: false });
  assert.equal(host.accept(report(first, 1, 'dance')), false, 'the same seq again is a replay');
  assert.equal(host.accept(report(first, 3, 'dance')), true);
  assert.equal(host.accept(report(first, 2, 'still')), false, 'an older one arriving late');
  assert.deepEqual(host.current(), { music: 'dance', always: false });
  assert.equal(host.accept({ music: 'off' }), false);
  // The window reloaded: a new instance takes over and the old one is never heard again.
  assert.equal(host.accept(report(second, 1, 'silent')), true);
  assert.equal(host.accept(report(first, 9, 'dance')), false, 'a replaced page load does not come back');
  assert.deepEqual(host.current(), { music: 'silent', always: false });
  // Stale: the window went quiet (hidden and throttled, or gone).
  now += STAGE_STATE_TTL_MS + 1;
  assert.equal(host.current(), null);
  assert.equal(host.accept(report(second, 2, 'dance', true)), true);
  assert.deepEqual(host.current(), { music: 'dance', always: true });
  host.reset();
  assert.equal(host.current(), null);
  assert.equal(host.accept(report(second, 3, 'dance')), false, 'after a reset the old page load is retired');
});

test('能不能听到由宿主自己的开关定：律动开关（系统声音优先、麦克风）、旧的声音理解音乐模式；渲染端说在跳也不算', () => {
  const capture = (system: boolean | null, mic: boolean | null): AudioCaptureState => ({ revision: 1, slots: {
    'system-audio': system === null ? null : { id: 's', source: 'system-audio', owner: 'pet', revision: 1, chat: false, dance: system, ambient: null },
    microphone: mic === null ? null : { id: 'm', source: 'microphone', owner: 'pet', revision: 1, chat: !mic, dance: mic, ambient: null } } });
  assert.equal(hearingSource(capture(true, true), null), 'system-audio');
  assert.equal(hearingSource(capture(false, true), null), 'microphone');
  assert.equal(hearingSource(capture(null, false), null), null, 'the microphone open for voice chat is not hearing music');
  assert.equal(hearingSource(null, { active: true, mode: 'music' }), 'system-audio');
  assert.equal(hearingSource(null, { active: true, mode: 'movie' }), null);
  assert.equal(hearingSource(null, null), null);

  let switchOn = false;
  const stage = new StageStateHost(() => 5_000);
  stage.accept({ instance: 'pet-page-0001', seq: 1, music: 'dance', always: false });
  const herState = createHerState({ stage, capture: () => capture(switchOn, null), legacy: () => null, contacts: () => [], now: () => 5_000 });
  assert.deepEqual(herState.chatTurn('人设'), { hearing: { source: null, stage: null, transcript: false }, contacts: [], say: 'full' }, 'the switch is off: the stage is not believed');
  switchOn = true;
  assert.deepEqual(herState.chatTurn('人设').hearing, { source: 'system-audio', stage: { music: 'dance', always: false }, transcript: false });
  assert.equal(herState.chatTurn('…<external-audio-data>\n[]\n</external-audio-data>').hearing.transcript, true);
  assert.match(herState.innerLoopLine(), /你正跟着跳/u);
  switchOn = false;
  assert.equal(herState.innerLoopLine(), '', 'the inner loop says nothing while she hears nothing');
  const broken = createHerState({ stage, capture: () => { throw new Error('x'); }, legacy: () => null, contacts: () => { throw new Error('y'); } });
  assert.deepEqual(broken.chatTurn(''), { hearing: { source: null, stage: null, transcript: false }, contacts: [], say: 'full' }, 'a failing reader is "off", never a crash');
});

test('刚刚的触碰：只要几秒内的，最新的在前，心情说明里已经写了"最近原因"的不重复', () => {
  const now = 1_000_000;
  const recent = [{ kind: 'pat' as const, at: now - 2_000 }, { kind: 'food' as const, at: now - 500 }, { kind: 'pinch' as const, at: now - HER_CONTACT_RECENT_MS - 1 }];
  assert.deepEqual(contactsToTell(recent, '', now), ['food', 'pat']);
  assert.deepEqual(contactsToTell(recent, `……最近原因：${CONTACT_MOOD_REASON.food}。近期事件变化……`, now), ['pat']);
  assert.deepEqual(contactsToTell([{ kind: 'pat', at: now - 100 }, { kind: 'pat', at: now - 50 }], '', now), ['pat']);
  assert.deepEqual(contactsToTell([{ kind: 'pat', at: now + 60_000 }, { kind: 'nope' as HerContact, at: now }], '', now), []);
});

test('真实的心情宿主：摸头和喂食记下来；下一轮心情说明里写了喂食，感知那一行只补"摸了摸你的头"', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-state-contacts-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://her-state.invalid/v1', model: '' }, 'Gene');
    const input = (value: Record<string, unknown>) => service.mood.interaction({ token: service.mood.get().token, ...value } as MoodInput);
    assert.deepEqual(service.mood.recentContacts(), []);
    input({ type: 'phase', sessionId: 'pat', phase: 'rua' });
    await new Promise(resolve => setTimeout(resolve, 330));
    input({ type: 'rua', sessionId: 'pat', id: 'pat-1', activeMs: 300 });
    input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' });
    await new Promise(resolve => setTimeout(resolve, 520));
    input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' });
    input({ type: 'food', sessionId: 'meal', id: 'release-meal' });
    assert.deepEqual(service.mood.recentContacts().map(item => item.kind), ['food', 'pat']);
    const turn = await service.begin('t1', '嘿嘿', 'Gene', () => {});
    assert.ok(turn.persona.includes(`最近原因：${CONTACT_MOOD_REASON.food}`), 'the mood note names the snack');
    const herState = createHerState({ stage: new StageStateHost(), capture: () => null, legacy: () => null, contacts: () => service.mood.recentContacts() });
    const line = perceptionTurnLine(sight(), herState.chatTurn(turn.persona));
    assert.equal(line, `【此刻的感知】${SENSING_AND_HEARING_OFF_LINE}用户刚才摸了摸你的头。`);
    assert.deepEqual(herState.chatTurn('人设').contacts, [], 'told once: the next quick message does not repeat the pat or the snack');
    await turn.finish('stopped');
    assert.deepEqual(service.mood.recentContacts(Date.now() + HER_CONTACT_RECENT_MS + 1_000), [], 'a while later: nothing');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('真实的心情宿主：捏脸记成 pinch（和摸头分开）', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-her-state-cheek-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://her-state.invalid/v1', model: '' }, 'Gene');
    const input = (value: Record<string, unknown>) => service.mood.interaction({ token: service.mood.get().token, ...value } as MoodInput);
    input({ type: 'phase', phase: 'cheek', sessionId: 'squish' });
    await new Promise(resolve => setTimeout(resolve, 230));
    input({ type: 'cheek', sessionId: 'squish', id: 'squish-release', activeMs: 200 });
    assert.deepEqual(service.mood.recentContacts().map(item => item.kind), ['pinch']);
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('舞台：她身体在做什么只读出来，不改她的选择（关、安静、不动、点头、跳；"一直跟着跳"走原来的路）', () => {
  const choice = (tier: 'none' | 'nod' | 'dance', audible: boolean, isAlways = false) => ({ isAlways, tier, getState: () => ({ audible }) as ReturnType<import('../src/stage/music-choice').MusicChoice['getState']> });
  // I-016 adds `beat` (the fast layer's score; 0 when not given) and, given `music`, "still" whenever it is not recognized as music.
  assert.deepEqual(musicPresence({ hearing: false, choice: choice('none', false), danceOn: false, sinceLoudS: 0 }), { music: 'off', always: false, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('nod', false), danceOn: false, sinceLoudS: 0.1 }), { music: 'silent', always: false, beat: 0 }, 'her choice: R18 audible decides');
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('none', true), danceOn: false, sinceLoudS: 0.1 }), { music: 'still', always: false, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('nod', true), danceOn: false, sinceLoudS: 0.1 }), { music: 'nod', always: false, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('dance', true), danceOn: true, sinceLoudS: 0.1 }), { music: 'dance', always: false, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('dance', false, true), danceOn: true, sinceLoudS: 0.5 }), { music: 'dance', always: true, beat: 0 }, 'always: a loud sample a moment ago');
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('dance', false, true), danceOn: true, sinceLoudS: 9 }), { music: 'silent', always: true, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: undefined, danceOn: true, sinceLoudS: 0.2 }), { music: 'dance', always: true, beat: 0 }, 'before the music settings: the R15 path');
  assert.deepEqual(musicPresence({ hearing: false, choice: undefined, danceOn: false, sinceLoudS: Infinity }), { music: 'off', always: true, beat: 0 });
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('dance', true), danceOn: true, sinceLoudS: 0.1, music: false, beat: 0.234 }), { music: 'still', always: false, beat: 0.23 }, 'I-016: sound that is not music: neither dance nor nod is shown');
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('dance', false, true), danceOn: true, sinceLoudS: 0.1, music: false, beat: 0.1 }), { music: 'still', always: true, beat: 0.1 }, 'I-016: "一直跟着跳" holds the dance back too');
  assert.deepEqual(musicPresence({ hearing: true, choice: choice('nod', true), danceOn: false, sinceLoudS: 0.1, music: true, beat: 0.81 }), { music: 'nod', always: false, beat: 0.81 });
  assert.deepEqual(musicPresence({ hearing: false, choice: choice('nod', true), danceOn: false, sinceLoudS: 0.1, music: true, beat: 0.81 }), { music: 'off', always: false, beat: 0 });
});

test('渲染端：变了就报、平时每 5 秒报一次心跳，同一次页面加载序号递增；读失败不报', () => {
  let now = 0, current: { music: StageMusicState; always: boolean } = { music: 'off', always: false }, failing = false;
  const sent: unknown[] = [];
  const reporter = new HerStateReporter({ read: () => { if (failing) throw new Error('x'); return current; }, send: report => { sent.push(report); }, now: () => now, instance: 'pet-page-test-1' });
  assert.equal(reporter.tick(), true);
  now += 1_000; assert.equal(reporter.tick(), false, 'unchanged and not due');
  current = { music: 'dance', always: false }; now += 1_000; assert.equal(reporter.tick(), true, 'a change goes at once');
  now += HER_STATE_REPORT_HEARTBEAT_MS; assert.equal(reporter.tick(), true, 'the heartbeat');
  failing = true; now += HER_STATE_REPORT_HEARTBEAT_MS; assert.equal(reporter.tick(), false);
  assert.deepEqual(sent, [
    { instance: 'pet-page-test-1', seq: 1, music: 'off', always: false },
    { instance: 'pet-page-test-1', seq: 2, music: 'dance', always: false },
    { instance: 'pet-page-test-1', seq: 3, music: 'dance', always: false },
  ]);
  for (const report of sent) assert.ok(parseStageStateReport(report), 'every report passes the host check');
  // What the reporter sends, the host takes in order.
  const host = new StageStateHost(() => 0);
  assert.deepEqual(sent.map(report => host.accept(report)), [true, true, true]);
  assert.equal(host.accept(sent[1]), false);
});

const awake = innerLoopQuiet({ phase: 'awake', localMinute: 14 * 60 });
const loopBase = { persona: 'P', mood: 'M', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 14 * 60, quiet: awake, minutesSinceInteraction: 12 };

test('内心循环的【此刻】：带上听到的和她自己在做的事；有"换件事做"时不重复，陪着你和听不到时不写', () => {
  const dancing = hearingInnerLoopLine(hearing('system-audio', 'dance'));
  const speech = buildInnerLoopPrompt({ ...loopBase, cue: 'speech', allowSpeech: true, hearing: dancing, activity: { current: 'humming', minutes: 6.4 } });
  const now = speech.slice(speech.indexOf('【此刻】'), speech.indexOf('【怎么选】'));
  assert.ok(now.includes(dancing), 'the hearing line sits in 【此刻】');
  assert.ok(now.includes('你自己现在在做的事：轻轻哼歌（没出声）（约 6 分钟）。'));
  const offered = buildInnerLoopPrompt({ ...loopBase, cue: 'motion', allowSpeech: false, activity: { current: 'daydream', minutes: 3 },
    herLife: { current: 'daydream', minutes: 3, choices: ['humming', 'thinking'] } });
  assert.equal(offered.split('你自己现在在做的事：').length - 1, 1, 'the switch offer already says it, once');
  const company = buildInnerLoopPrompt({ ...loopBase, cue: 'speech', allowSpeech: true, activity: { current: 'company', minutes: 30 }, hearing: hearingInnerLoopLine(hearing(null, null)) });
  assert.doesNotMatch(company, /你自己现在在做的事|让你听到|听不到声音。/u, 'the plain default adds nothing');
  assert.equal(company, buildInnerLoopPrompt({ ...loopBase, cue: 'speech', allowSpeech: true }), 'byte for byte the prompt without the new fields');
});

test('内心循环的读取：听和她自己在做的事从宿主读，读失败就当没有', () => {
  const base: InnerLoopContextSources = { now: () => 10 * 60_000, persona: () => 'P', language: () => '', mood: () => 'M', parameters: () => DEFAULT_MOOD_PARAMETERS,
    lastInteractionAt: () => null, profileEnabled: () => false, profilePoints: () => '', audioReading: () => false, ambientText: () => '' };
  const claim = { id: 'c', kind: 'speech' as const, at: 0, characterId: 'gene' };
  const line = '用户让你听到电脑里的声音，现在很安静，没在放东西。';
  const prompt = innerLoopPrompt({ ...base, hearing: () => line, activity: () => ({ activity: 'thinking', since: 2 * 60_000 }) }, claim, true, awake);
  assert.ok(prompt.includes(line) && prompt.includes('你自己现在在做的事：想事情（约 8 分钟）。'));
  const broken = innerLoopPrompt({ ...base, hearing: () => { throw new Error('x'); }, activity: () => { throw new Error('y'); } }, claim, true, awake);
  assert.equal(broken, innerLoopPrompt(base, claim, true, awake));
  assert.equal(innerLoopPrompt({ ...base, activity: () => ({ activity: 'bogus' as never, since: 0 }) }, claim, true, awake), innerLoopPrompt(base, claim, true, awake));
});
