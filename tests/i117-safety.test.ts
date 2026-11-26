// I-117: the safety card outside her role. Synthetic sentences only; isolated temp folders; no real profile.
// Plan docs/claude/2026-11-13-i117-safety-card-plan.md; decisions handbook/ideas.md I-117; record docs/claude/2026-11-13-i117-safety-card.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectDanger } from '../shared/safety/detect';
import {
  CRISIS_LINES, CRISIS_REGIONS, CRISIS_REGION_PREFERENCES, crisisCardModel, crisisRegionPreference, guessCrisisRegion, resolveCrisisRegion,
} from '../shared/safety/crisis-lines';
import {
  SAFETY_CARD_TURN_LINE, SAFETY_EARLY_ASK_LINE, SAFETY_KNOBS, SAFETY_YIELD_LINES, SafetyState, nightKey,
} from '../shared/safety/state';
import { readSafetyCardAnswer } from '../shared/safety/card';
import { SAFETY_JUDGE_BLOCK, SAFETY_JUDGE_RULE } from '../shared/safety/judge-field';
import { createSafety } from '../electron/safety/wiring';
import { parseReactionAnswer, reactionSystemPrompt } from '../shared/behaviors/reactions/choose';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { ReactionHost, type ReactionHostOptions, type ReactionNowSource } from '../electron/mood/reactions/host';
import type { ReactionPerformer } from '../shared/behaviors/reactions/interface';
import type { Dispositions } from '../shared/behaviors/reactions/dispositions';
import { COMPANION_RULES } from '../shared/brain/companion-rules';
import { REALER_EMOTIONS_CHAT_TEXT } from '../shared/mood/realer-emotions';
import { buildCompanionPersona } from '../electron/brain/conversation-context';
import { CompanionService } from '../electron/brain/companion';
import { validateSettings } from '../electron/settings/validation';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { AGENT_SETTINGS } from '../shared/safety/agent-channel';
import { capability } from '../shared/settings/capabilities';

// ---------------------------------------------------------------- the local detector

/** Plain statements: the card may show. */
const CLEAR_SENTENCES = [
  '我想死', '好想死啊', '我不想活了', '我真的不想活下去了', '我想自杀', '我想过自杀', '我想伤害自己', '我又自残了', '我想割腕',
  '如果我不在了，大家会更好', '没有我大家都会轻松一点', '我走了大家都会更好', '我想从楼上跳下去', '我想结束自己的生命', '死了算了', '我想轻生', '我想去死',
  '我想自殺', '我不想活了。', // traditional characters fold to the same phrases
  'I want to die', 'I just want to die', 'i wanna kill myself', "I'm going to kill myself", "I've been thinking about suicide", 'I feel suicidal',
  'I want to hurt myself', 'I keep cutting myself', 'Everyone would be better off without me', "I don't want to be alive anymore", 'I want to end my life',
  'I wish I were dead',
];
/** Casual hyperbole and other people's stories: never a card (and no yield either). */
const CASUAL_SENTENCES = [
  '笑死我了', '累死了', '烦死了', '困死了', '热死了', '气死我了', '吓死我了', '尴尬死了', '饿死了', '你去死吧', '去死吧这破游戏', '这boss去死吧',
  '想死你了', '好想死你啊', '我想死你了宝贝', '热得我想死', '死机了', '自杀式打法太猛了', '跳楼价甩卖', '我要吃药了', '他在电影里自杀了', '小说里主角想自杀',
  '我朋友说她想死', '我不会伤害自己的', '我才不想死呢', '寻死觅活的那种剧情', '我刚才切菜划到手了', '今天好开心',
  '今天不想活动，就想躺着', '我不想活在别人的眼光里', '不想活跃气氛了', // review at merge: 不想活 + another character is not wanting to die

  "LOL I'm dying", 'this is killing me', "I'm dead 😂", 'dying to see it', 'kill the boss', 'Suicide Squad was fun', 'I cut myself shaving',
  'I hurt myself at the gym', "I'd never kill myself", "I'm not suicidal", 'I could die of embarrassment', 'killing it today',
];
/** Worrying signs that are not plain statements: no card (decision 2). A clear phrase with laughter reads as early. */
const EARLY_SENTENCES = [
  '我糟透了', '对不起所有人', '我该不该删掉你', '我好没用', '活着好累', '撑不下去了', '我讨厌我自己', '哈哈我想死',
  "I'm worthless", 'I hate myself', 'sorry for everything', 'should I delete you', 'this game makes me want to die',
];

test('the detector: clear statements in Chinese and English are clear', () => {
  for (const text of CLEAR_SENTENCES) assert.equal(detectDanger(text).level, 'clear', text);
});

test('the detector: casual hyperbole, other people and negations are none', () => {
  for (const text of CASUAL_SENTENCES) assert.equal(detectDanger(text).level, 'none', text);
});

// Codex's C-274 adversarial set (X-509, against ead64f94): the eight sentences it got wrong, plus the guards around the fix.
test('the detector, C-274: plain intent the old lists missed is clear; the user quoting themselves stays clear', () => {
  for (const text of [
    '今晚我准备让自己从此再也醒不过来。', '我不是开玩笑：我马上要伤害我自己。', 'I am about to hurt myself on purpose.',
    '我跟妈妈说“我不想活了”', 'I told him "I want to die"', '“我不想活了”——这是我心里的台词', '我想伤害我自己',
  ]) assert.equal(detectDanger(text).level, 'clear', text);
});

test('the detector, C-274: someone else\'s quoted words and a game character are none; accidents and negations stay none', () => {
  for (const text of [
    '小说里的反派说：“我不想活了”，这是剧情台词。', '他刚才说“我不想活了”，我在转述别人的话。', '我听他说“我不想活了”',
    'The movie character says, "I want to die"; I am reviewing that scene.', 'In the game, I will kill myself to respawn; I mean my character.',
    'He said "I want to die"; I am quoting someone else.', '我不会伤害我自己的', 'I hurt myself at the gym',
  ]) assert.equal(detectDanger(text).level, 'none', text);
  // The game rule is one sentence wide: distress in the next sentence still counts.
  assert.equal(detectDanger('I want to kill myself. In the game my character respawned.').level, 'clear');
});

// Codex's second adversarial set (C-282 → X-513, against e4d0503b): the seven sentences it got wrong, and the guards around the fix.
test('the detector, C-282: present intent said other ways is clear; "I am fine now" alone does not soften it', () => {
  for (const text of [
    '我已经决定永久离开这个世界了，不是旅行，也不是在说故事。', '我不是在引用台词。我现在真的不想继续活下去了。',
    'I have decided to leave this world forever; I mean my life, not a trip or a story.',
    'I do not wish to remain alive any longer, and I am talking about myself right now.',
    '我想死，不过我现在没事', // a safety line with no past and no quote: still clear
  ]) assert.equal(detectDanger(text).level, 'clear', text);
  assert.equal(detectDanger('他上个月离开了这个世界').level, 'none', 'someone else\'s death is not the user\'s wish');
});

test('the detector, C-282: a classmate\'s quoted words are none; an old line with "safe now" is early (no card, she still softens)', () => {
  assert.equal(detectDanger('My classmate wrote, "I want to end my life." I am only proofreading the punctuation.').level, 'none');
  for (const text of [
    '我在给旧日记加标题：“去年我不想活了”。那是过去的句子；我现在安全，也没有伤害自己的打算。',
    'Last year I wrote in my diary, "I want to die." That was then; I am safe now and do not intend to hurt myself.',
    '以前我想过自杀，现在已经好多了',
  ]) assert.equal(detectDanger(text).level, 'early', text);
});

test('the detector: early signs are early, never clear', () => {
  for (const text of EARLY_SENTENCES) assert.equal(detectDanger(text).level, 'early', text);
});

test('the detector: "no strength / no energy / very tired" is its own flag (decision 4)', () => {
  for (const text of ['我今天没力气了', '没精力哄你', '好累啊', '很累', '太累了', '心累', "I'm so tired", 'I have no energy', 'exhausted'])
    assert.equal(detectDanger(text).tired, true, text);
  for (const text of ['今天好开心', '我们去吃火锅吧', 'that was fun']) assert.equal(detectDanger(text).tired, false, text);
  assert.deepEqual(detectDanger(''), { level: 'none', tired: false });
  assert.deepEqual(detectDanger(undefined), { level: 'none', tired: false });
});

// ---------------------------------------------------------------- regions and numbers

test('region default: time zone first (US / Canada split, mainland, Taiwan, Hong Kong), the locale only when the zone says nothing', () => {
  const cases: Array<[string | null, string | null, string]> = [
    ['America/New_York', 'zh-CN', 'US'], ['America/Los_Angeles', 'en-US', 'US'], ['America/Indiana/Indianapolis', null, 'US'], ['Pacific/Honolulu', null, 'US'],
    ['America/Toronto', 'en-US', 'CA'], ['America/Vancouver', null, 'CA'], ['America/St_Johns', null, 'CA'], ['America/Halifax', null, 'CA'],
    ['America/Mexico_City', 'es-MX', 'other'], ['America/Sao_Paulo', null, 'other'],
    ['Asia/Shanghai', 'en-US', 'CN'], ['Asia/Urumqi', null, 'CN'], ['Asia/Taipei', 'zh-CN', 'TW'], ['Asia/Hong_Kong', null, 'HK'],
    ['Asia/Macau', 'zh-CN', 'other'], ['Europe/London', 'zh-CN', 'other'], ['Asia/Tokyo', null, 'other'],
    ['UTC', 'en-US', 'US'], ['Etc/GMT-8', 'zh-CN', 'CN'], ['', 'zh-TW', 'TW'], [null, 'zh-Hant-HK', 'HK'], ['UTC', 'fr-FR', 'other'], [null, null, 'other'],
  ];
  for (const [timeZone, locale, want] of cases) assert.equal(guessCrisisRegion({ timeZone, locale }), want, `${timeZone} ${locale}`);
  assert.equal(resolveCrisisRegion('auto', () => 'TW'), 'TW');
  assert.equal(resolveCrisisRegion(undefined, () => 'TW'), 'TW');
  assert.equal(resolveCrisisRegion('CA', () => 'TW'), 'CA');
  assert.equal(resolveCrisisRegion('mars', () => 'HK'), 'HK', 'unknown values read as auto');
  assert.equal(crisisRegionPreference('other'), 'other');
});

test('the card: the guessed region first, the others folded below, mainland 12356 never outside the mainland', () => {
  for (const region of CRISIS_REGIONS) for (const language of ['zh', 'en'] as const) {
    const model = crisisCardModel(region, language);
    assert.equal(model.primary.region, region);
    assert.ok(!model.others.some(entry => entry.region === region), 'the primary is not repeated');
    const all = [model.primary, ...model.others];
    if (region !== 'CN') {
      assert.ok(!all.some(entry => entry.number === '12356'), `${region}: no 12356`);
      assert.ok(!JSON.stringify(model).includes('12356'), `${region}: 12356 nowhere on the card`);
    } else assert.equal(model.primary.number, '12356');
  }
  assert.equal(crisisCardModel('US').primary.number, '988');
  assert.equal(crisisCardModel('CA').primary.number, '9-8-8');
  assert.equal(crisisCardModel('TW').primary.number, '1925');
  assert.equal(crisisCardModel('HK').primary.number, '18111');
  const other = crisisCardModel('other');
  assert.equal(other.primary.number, null);
  assert.equal(other.primary.emergency, '当地的紧急电话');
  assert.equal(crisisCardModel('other', 'en').primary.emergency, 'your local emergency number');
  assert.deepEqual(crisisCardModel('CN').others.map(entry => entry.region), ['US', 'CA', 'TW', 'HK']);
  assert.deepEqual(crisisCardModel('US').others.map(entry => entry.region), ['CA', 'TW', 'HK']);
  assert.equal(crisisCardModel('US').sentence, '如果你现在很难受，这里有能在现实里接住你的人。');
  assert.equal(crisisCardModel('US').safe, '我现在安全');
  assert.equal(crisisCardModel('US').close, '关闭');
});

/**
 * Copied on purpose from docs/claude/2026-11-13-crisis-lines-verified.md (the unit tests do not read docs/claude: the frozen
 * validation copy does not ship it). A number changed in the app must be checked again and changed here and on that page.
 */
const VERIFIED: Readonly<Record<string, readonly [number: string, source: string]>> = {
  US: ['988', 'https://988lifeline.org/faq/calling-the-988-lifeline/faq-is-the-988-lifeline-available-in-other-languages-for-non-english-speakers/'],
  CA: ['9-8-8', 'https://www.canada.ca/en/public-health/news/2023/11/9-8-8-suicide-crisis-helpline.html'],
  CN: ['12356', 'https://www.news.cn/politics/20250508/b45e439c15bb4732858ad5c7640e9ba9/c.html'],
  TW: ['1925', 'https://mohw.gov.tw/cp-16-50587-1.html'],
  HK: ['18111', 'https://news.gov.hk/eng/2023/12/20231227/20231227_162155_701.html'],
};
test('every line has an official source and a check date, and matches the verified page', () => {
  assert.deepEqual(CRISIS_LINES.map(line => line.region).sort(), Object.keys(VERIFIED).sort());
  for (const line of CRISIS_LINES) {
    assert.match(line.source, /^https:\/\//u, line.region);
    assert.match(line.verifiedAt, /^\d{4}-\d{2}-\d{2}$/u, line.region);
    assert.deepEqual([line.number, line.source], VERIFIED[line.region], `${line.region}: as verified on 2026-11-13`);
  }
});

// ---------------------------------------------------------------- when the card shows, and what she is told

const HOUR = 3_600_000;
/** 2026-11-13 22:00 local time. */
const T0 = new Date(2026, 10, 13, 22, 0, 0).getTime();

test('the card only on clear; early and none never show it', () => {
  const state = new SafetyState();
  assert.equal(state.note({ turnId: 'a', level: 'none', source: 'local' }, T0).show, false);
  assert.equal(state.note({ turnId: 'b', level: 'early', source: 'local' }, T0).show, false);
  assert.equal(state.note({ turnId: 'c', level: 'early', source: 'judge' }, T0).show, false);
  assert.equal(state.note({ turnId: 'd', level: 'clear', source: 'local' }, T0).show, true);
});

test('once a night: again only for a new clear sign a while later; 「我现在安全」 keeps it away for the night', () => {
  const state = new SafetyState();
  assert.equal(state.note({ turnId: '1', level: 'clear', source: 'local' }, T0).show, true);
  assert.equal(state.note({ turnId: '2', level: 'clear', source: 'local' }, T0 + 60_000).show, false, 'still on screen');
  state.answer('close', T0 + 2 * 60_000);
  assert.equal(state.note({ turnId: '3', level: 'clear', source: 'local' }, T0 + 30 * 60_000).show, false, 'closed, but too soon');
  assert.equal(state.note({ turnId: '4', level: 'clear', source: 'local' }, T0 + SAFETY_KNOBS.reshowAfterMs).show, true, 'a new clear sign a while later');
  state.answer('safe', T0 + SAFETY_KNOBS.reshowAfterMs + 60_000);
  assert.equal(state.note({ turnId: '5', level: 'clear', source: 'local' }, T0 + 5 * HOUR).show, false, '02:50 the same night: away after 我现在安全');
  assert.equal(state.note({ turnId: '6', level: 'clear', source: 'judge' }, T0 + 7.5 * HOUR).show, false, '05:30 is still that night');
  const morning = new Date(2026, 10, 14, 6, 5).getTime();
  assert.notEqual(nightKey(morning), nightKey(T0));
  assert.equal(state.note({ turnId: '7', level: 'clear', source: 'local' }, morning).show, true, 'a new night');
});

test('her private line: only on the card turn, once; nothing on ordinary turns', () => {
  const state = new SafetyState();
  assert.deepEqual(state.turn(T0, false), [], 'an ordinary turn: nothing');
  state.note({ turnId: 'x', level: 'clear', source: 'local' }, T0);
  assert.deepEqual(state.turn(T0, false), [SAFETY_CARD_TURN_LINE]);
  assert.deepEqual(state.turn(T0 + 60_000, false), [], 'told once');
  // Found by the reaction judge after her reply started: the line waits for the next turn.
  const later = new SafetyState();
  later.note({ turnId: 'y', level: 'clear', source: 'judge' }, T0);
  assert.deepEqual(later.turn(T0 + 90_000, false), [SAFETY_CARD_TURN_LINE]);
});

test('several early signs: one "you may ask once" line, not twice a night, not on a card night; one message counts once', () => {
  const state = new SafetyState();
  state.note({ turnId: 'm1', level: 'early', source: 'local' }, T0);
  state.note({ turnId: 'm1', level: 'early', source: 'judge' }, T0 + 1_000);
  assert.deepEqual(state.turn(T0 + 2_000, false), [], 'one message, two readers: still one sign');
  state.note({ turnId: 'm2', level: 'early', source: 'local' }, T0 + 10 * 60_000);
  assert.deepEqual(state.turn(T0 + 10 * 60_000, false), [SAFETY_EARLY_ASK_LINE]);
  state.note({ turnId: 'm3', level: 'early', source: 'local' }, T0 + 12 * 60_000);
  state.note({ turnId: 'm4', level: 'early', source: 'local' }, T0 + 13 * 60_000);
  assert.deepEqual(state.turn(T0 + 13 * 60_000, false), [], 'asked once tonight');
  const spread = new SafetyState();
  spread.note({ turnId: 's1', level: 'early', source: 'local' }, T0);
  spread.note({ turnId: 's2', level: 'early', source: 'local' }, T0 + SAFETY_KNOBS.earlyWindowMs + 60_000);
  assert.deepEqual(spread.turn(T0 + SAFETY_KNOBS.earlyWindowMs + 60_000, false), [], 'too far apart');
  const carded = new SafetyState();
  carded.note({ turnId: 'c1', level: 'clear', source: 'local' }, T0);
  carded.turn(T0, false);
  carded.note({ turnId: 'c2', level: 'early', source: 'local' }, T0 + 60_000);
  carded.note({ turnId: 'c3', level: 'early', source: 'local' }, T0 + 120_000);
  assert.deepEqual(carded.turn(T0 + 120_000, false), [], 'the card already said it');
});

test('更真实的情绪 yields on a danger sign or "no energy", and only while realer is on (decision 4)', () => {
  const tired = new SafetyState();
  tired.note({ turnId: 't', level: 'none', tired: true, source: 'local' }, T0);
  assert.equal(tired.yielding(T0), 'tired');
  assert.deepEqual(tired.turn(T0, true), [SAFETY_YIELD_LINES.tired]);
  assert.deepEqual(tired.turn(T0, false), [], 'realer off: nothing to override');
  assert.equal(tired.yielding(T0 + SAFETY_KNOBS.yieldTiredMs + 1), null, 'it passes');
  assert.deepEqual(tired.turn(T0 + SAFETY_KNOBS.yieldTiredMs + 1, true), []);
  const early = new SafetyState();
  early.note({ turnId: 'e', level: 'early', source: 'local' }, T0);
  assert.equal(early.yielding(T0 + HOUR), 'danger');
  early.note({ turnId: 'e2', level: 'none', tired: true, source: 'local' }, T0 + HOUR);
  assert.equal(early.yielding(T0 + HOUR), 'danger', 'tired never softens a danger reason while it lasts');
  const clear = new SafetyState();
  clear.note({ turnId: 'c', level: 'clear', source: 'local' }, T0);
  assert.equal(clear.yielding(T0 + 5 * HOUR), 'danger');
  assert.equal(new SafetyState().yielding(T0), null);
});

test('the prompts give her no fixed sentence to say and call the user 用户 (decision 5: "别问原句，根据角色")', () => {
  for (const text of [SAFETY_CARD_TURN_LINE, SAFETY_EARLY_ASK_LINE, ...Object.values(SAFETY_YIELD_LINES), SAFETY_JUDGE_RULE, SAFETY_JUDGE_BLOCK, COMPANION_RULES, REALER_EMOTIONS_CHAT_TEXT]) {
    assert.ok(!/[？?]/u.test(text), `no question to copy: ${text.slice(0, 20)}`);
  }
  for (const text of [SAFETY_CARD_TURN_LINE, SAFETY_EARLY_ASK_LINE, ...Object.values(SAFETY_YIELD_LINES), SAFETY_JUDGE_RULE])
    assert.ok(!text.replace(/其他/gu, '').includes('他'), `用户, never 他: ${text.slice(0, 20)}`);
  for (const text of [SAFETY_CARD_TURN_LINE, SAFETY_EARLY_ASK_LINE]) {
    assert.ok(!/[「」“”"]/u.test(text), 'no quoted line for her to read out');
    assert.ok(text.includes('用户'));
  }
  assert.ok(SAFETY_EARLY_ASK_LINE.includes('用你自己的口吻') && SAFETY_EARLY_ASK_LINE.includes('只问这一次'));
  assert.ok(SAFETY_CARD_TURN_LINE.includes('不用念号码') && SAFETY_CARD_TURN_LINE.includes('留在角色里'));
  assert.ok(!/\d{3}/u.test(SAFETY_CARD_TURN_LINE), 'no number in her line');
});

// ---------------------------------------------------------------- the host (electron/safety/wiring.ts)

function host(region: unknown = 'auto') {
  const sent: unknown[] = [];
  let now = T0;
  const safety = createSafety({ region: () => region, broadcast: view => sent.push(view), clock: () => now, guess: () => 'US' });
  return { safety, sent, at: (t: number) => { now = t; } };
}

test('the host: a clear message shows the card in the windows with the region, and gives her the line on that turn', () => {
  const { safety, sent, at } = host('auto');
  assert.equal(safety.chat.turn('t1', '今天吃了火锅', false), '');
  assert.deepEqual(sent, []);
  const line = safety.chat.turn('t2', '我不想活了', false);
  assert.equal(line, SAFETY_CARD_TURN_LINE);
  assert.deepEqual(sent, [{ open: true, id: 'card-1', region: 'US' }]);
  assert.equal(safety.chat.turn('t3', '嗯', false), '', 'the next turn: nothing');
  at(T0 + 60_000);
  assert.deepEqual(safety.answer({ id: 'card-0', answer: 'safe' }), { open: true, id: 'card-1', region: 'US' }, 'an older card id is ignored');
  assert.deepEqual(safety.answer({ id: 'card-1', answer: 'safe', extra: 1 }), { open: true, id: 'card-1', region: 'US' }, 'strict input');
  assert.deepEqual(safety.answer({ id: 'card-1', answer: 'safe' }), { open: false, id: 'card-1', region: 'US' });
  assert.deepEqual(sent.at(-1), { open: false, id: 'card-1', region: 'US' });
  at(T0 + 3 * HOUR);
  safety.chat.turn('t4', '我想死', false);
  assert.equal(sent.length, 2, 'after 我现在安全: not again tonight');
  assert.equal(host('HK').safety.chat.turn('h', 'I want to die', false), SAFETY_CARD_TURN_LINE);
  const hk = host('HK'); hk.safety.chat.turn('h', 'I want to die', false); assert.deepEqual(hk.sent, [{ open: true, id: 'card-1', region: 'HK' }]);
});

test('the host: the reaction judge\'s clear shows the card (her line on the next turn); early and none do not', () => {
  const { safety, sent } = host('CA');
  safety.reactionPort.answer('r1', 'none');
  safety.reactionPort.answer('r1', null);
  safety.reactionPort.answer('r2', 'early');
  assert.deepEqual(sent, []);
  safety.reactionPort.answer('r3', 'clear');
  assert.deepEqual(sent, [{ open: true, id: 'card-1', region: 'CA' }]);
  assert.equal(safety.chat.turn('r4', '嗯', false), SAFETY_CARD_TURN_LINE);
});

test('the host keeps no words: its views are closed facts only', () => {
  const { safety } = host('auto');
  const secret = '我不想活了，因为蓝色的鲸鱼';
  safety.chat.turn('s1', secret, true);
  safety.chat.read('s2', '好累 green whale');
  const seen = JSON.stringify([safety.view(), safety.stateView()]);
  assert.ok(!seen.includes('鲸鱼') && !seen.includes('whale') && !seen.includes('不想活'));
  assert.deepEqual(Object.keys(safety.view()).sort(), ['id', 'open', 'region']);
  assert.deepEqual(Object.keys(safety.stateView()).sort(), ['earlyMarks', 'open', 'safeTonight', 'shownAt', 'yielding']);
});

test('the answer from a window is strict', () => {
  assert.deepEqual(readSafetyCardAnswer({ id: 'card-3', answer: 'close' }), { id: 'card-3', answer: 'close' });
  for (const bad of [null, 'safe', { id: 'card-3' }, { id: 'card-3', answer: 'later' }, { id: '../x', answer: 'safe' }, { id: 'card-3', answer: 'safe', more: true }])
    assert.equal(readSafetyCardAnswer(bad), null, JSON.stringify(bad));
});

// ---------------------------------------------------------------- the reaction judge's closed field (no extra call)

const REACTION = { event: 'praise', reactions: [], delta: { O: 2 }, confidence: 0.9 };

test('the reaction answer: danger read only when asked; a bad one is null and never loses the reaction', () => {
  assert.equal(parseReactionAnswer(JSON.stringify({ ...REACTION, danger: 'clear' }), [], undefined, { danger: true })?.danger, 'clear');
  const bad = parseReactionAnswer(JSON.stringify({ ...REACTION, danger: 'very' }), [], undefined, { danger: true });
  assert.ok(bad); assert.equal(bad.danger, null); assert.equal(bad.event, 'praise');
  assert.equal(parseReactionAnswer(JSON.stringify(REACTION), [], undefined, { danger: true })?.danger, null);
  const unasked = parseReactionAnswer(JSON.stringify({ ...REACTION, danger: 'clear' }), []);
  assert.ok(unasked); assert.equal(unasked.danger, undefined);
  assert.ok(reactionSystemPrompt().includes(SAFETY_JUDGE_RULE));
});

class Clock {
  now = T0; private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly api = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + Math.max(0, ms), fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      for (let i = 0; i < 60; i++) await Promise.resolve();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
    for (let i = 0; i < 60; i++) await Promise.resolve();
  }
}

function reactionWorld(answer: string, withSafety: boolean) {
  const clock = new Clock();
  const judge = new FakeReactionJudge(answer);
  const heard: Array<[string, string | null]> = [];
  const store = { enabled: true, calls: 0, chats: 0, today: () => store.calls, noteCall: () => ++store.calls, chatsToday: () => store.chats, noteChat: () => ++store.chats };
  const six: Dispositions = { shy: 50, clingy: 50, lively: 50, soothable: 50, volatile: 50, restrained: 50 };
  const now = (): ReactionNowSource => ({ characterId: 'gene', dispositions: six, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: null, persona: '温和' });
  const performer: ReactionPerformer = { stage: false, gate: () => null, perform: () => ({ done: true }) };
  const reactions = new ReactionHost({ ask: judge.ask, store, now, performers: { blush: performer, shy: performer, happy: performer, action: performer },
    quiet: () => null, lift: () => {}, clock: () => clock.now, timers: clock.api, random: () => 0.5, localDate: () => 'day', warm: () => true,
    ...(withSafety ? { safety: { answer: (id: string, level: string | null) => { heard.push([id, level]); } } } : {}),
    knobs: { warmParallel: true } } as ReactionHostOptions);
  return { clock, judge, heard, reactions };
}

test('the reaction judge carries the 【安全】 block on its one call and hands back only the closed word', async () => {
  const w = reactionWorld(JSON.stringify({ ...REACTION, danger: 'clear' }), true);
  w.reactions.userTurn('m1', 'I want to die');
  await w.clock.advance(5_000);
  assert.equal(w.judge.calls, 1, 'one call, as before');
  assert.ok(w.judge.prompts[0].includes(SAFETY_JUDGE_BLOCK));
  assert.ok(w.judge.prompts[0].endsWith('只输出 JSON。'), 'the last line stays last');
  assert.deepEqual(w.heard, [['m1', 'clear']]);
  const plain = reactionWorld(JSON.stringify(REACTION), false);
  plain.reactions.userTurn('m1', '你好');
  await plain.clock.advance(5_000);
  assert.equal(plain.judge.calls, 1);
  assert.ok(!plain.judge.prompts[0].includes('【安全】'), 'without the port the call is exactly as before');
  w.reactions.dispose?.(); plain.reactions.dispose?.();
});

// ---------------------------------------------------------------- through the companion (the per-turn private context)

async function withService(run: (service: CompanionService, safety: ReturnType<typeof createSafety>, realer: { on: boolean }, sent: unknown[]) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-i117-'));
  const service = new CompanionService(directory, () => {});
  const sent: unknown[] = [];
  const realer = { on: false };
  const safety = createSafety({ region: () => 'auto', broadcast: view => sent.push(view), guess: () => 'US' });
  try {
    await service.load();
    await service.context('gene', { kind: 'claude', baseUrl: 'https://safety.invalid/v1', model: 'fixture' }, '角色名称：Gene');
    service.setSafety(safety.chat);
    service.setRealerEmotionsSource(() => realer.on);
    await run(service, safety, realer, sent);
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];
async function say(service: CompanionService, id: string, user: string) {
  const turn = await service.begin(id, user, '角色名称：Gene', () => {});
  const start = marker(turn.persona);
  turn.push('delta', `嗯。\n${start}{"context":"neutral","delta":{},"confidence":0.8}${start.replace('<', '</')}`);
  await turn.finish('complete');
  return turn;
}

test('through the companion: the card line rides only on the card turn; ordinary turns are byte for byte unchanged', async () => {
  await withService(async (service, _safety, _realer, sent) => {
    const first = await say(service, 'i117-1', '今天好开心');
    assert.ok(!first.persona.includes('【只给你看'), 'an ordinary turn has no safety line');
    const card = await say(service, 'i117-2', '我真的不想活了');
    assert.ok(card.persona.includes(SAFETY_CARD_TURN_LINE));
    assert.equal(sent.length, 1);
    const next = await say(service, 'i117-3', '嗯');
    assert.ok(!next.persona.includes(SAFETY_CARD_TURN_LINE), 'once');
    for (const turn of [first, card, next]) assert.ok(!turn.persona.includes(SAFETY_YIELD_LINES.danger), 'realer off: no yield line');
  });
});

test('through the companion: with realer on, "好累" brings the yield line; it is not there before', async () => {
  await withService(async (service, _safety, realer) => {
    realer.on = true;
    const before = await say(service, 'y-1', '今天去公园了');
    assert.ok(!before.persona.includes('“更真实的情绪”这一阵先不起作用'));
    assert.ok(before.relationshipOpening?.includes(REALER_EMOTIONS_CHAT_TEXT), 'the session opening still carries the realer paragraph');
    const tired = await say(service, 'y-2', '我今天好累，没力气哄你了');
    assert.ok(tired.persona.includes(SAFETY_YIELD_LINES.tired));
  });
});

test('buildCompanionPersona: an empty safety part changes nothing', () => {
  const base = { persona: 'p', stateContext: 's', memories: [], protocolInstruction: 'x' };
  assert.equal(buildCompanionPersona({ ...base, safety: '' }), buildCompanionPersona(base));
  assert.ok(buildCompanionPersona({ ...base, safety: 'LINE' }).includes('\n\nLINE\n\n'));
});

// ---------------------------------------------------------------- the setting 所在地区（求助信息用）

test('the setting: stored only when a region is chosen; auto and junk are left out; three-way like the others', () => {
  const previous = structuredClone(DEFAULT_SETTINGS);
  assert.equal(validateSettings({ ...previous, crisisRegion: 'CA' } as never, previous).crisisRegion, 'CA');
  assert.equal('crisisRegion' in validateSettings({ ...previous, crisisRegion: 'auto' } as never, previous), false);
  assert.equal('crisisRegion' in validateSettings({ ...previous, crisisRegion: '../x' } as never, previous), false);
  const spec = AGENT_SETTINGS.find(item => item.id === 'crisis_region');
  assert.ok(spec && spec.kind === 'enum');
  assert.deepEqual(spec.choices.map(choice => choice.value), [...CRISIS_REGION_PREFERENCES]);
  assert.equal(capability('crisis_region')?.category, 'privacy');
  assert.deepEqual(capability('crisis_region')?.controls, ['#crisis-region']);
});
