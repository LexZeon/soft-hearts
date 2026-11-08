import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MOOD_PARAMETERS, type MoodParameters } from '../shared/mood';
import {
  RPS_INVITE_RULES, chooseRpsReaction, resolveRpsStyle, rpsAnswer, rpsChatContext, rpsInviteVerdict, rpsPlainLoss, rpsPlayfulness, scanRpsRequest, type RpsInviteInput,
} from '../shared/rps-personality';
import { rpsDiaryLine, rpsExpectedHand, rpsHabits, type RpsGameRecord } from '../shared/rps-memory';
import { seeded } from './helpers/seeded';

const card = (weights: Partial<MoodParameters['weights']>, playful = 50): MoodParameters => ({ ...DEFAULT_MOOD_PARAMETERS,
  weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights }, intensity: { ...DEFAULT_MOOD_PARAMETERS.intensity, playful } });

test('chat requests: request forms count, stories, refusals and other topics do not', () => {
  for (const yes of ['来玩猜拳吧', '猜拳！', '玩猜拳', '我们来猜拳', '要不要玩石头剪刀布？', '陪我玩猜拳嘛', '再来一局猜拳', '来一把石头剪刀布', '和我猜拳好不好',
    'let\'s play rock paper scissors', 'rock paper scissors?',
    // 2026-11-04: the user's own words were missed (a trailing 来), and other everyday forms.
    '来玩一把猜拳来', '来一把猜拳啦', '玩会儿猜拳吧', '陪我玩两把猜拳', '猜拳来', '来来猜拳', '再来一局猜拳呗', '玩猜拳一下嘛'])
    assert.equal(scanRpsRequest(yes), true, yes);
  for (const no of ['我今天和朋友玩猜拳输了', '不想玩猜拳', '别猜拳了', '猜拳是什么游戏', '你会猜拳吗我很好奇这个怎么来的', '今天好累', '', '猜拳'.repeat(40),
    '昨天玩猜拳来着', '猜拳好难啊', '不来猜拳了', '猜拳来来来来来'])
    assert.equal(scanRpsRequest(no), false, no);
});

test('putting it off by her character: drowsy mostly waits, a playful card plays through more often; her own thought weighs on a cautious card', () => {
  const rate = (input: Omit<Parameters<typeof rpsAnswer>[0], 'random'>, answer: string) => {
    const random = seeded(7); let n = 0; for (let i = 0; i < 4000; i++) if (rpsAnswer({ ...input, random }) === answer) n++; return n / 4000;
  };
  const plain = DEFAULT_MOOD_PARAMETERS.weights, playful = card({ playful: 2 }).weights, cautious = card({ cautious: 1.6, playful: 0.6 }).weights;
  assert.equal(rate({ fatigue: 'awake' as any, herLife: 'company', weights: plain }, 'accept'), 1);
  const sleepyPlain = rate({ fatigue: 'drowsy', herLife: 'company', weights: plain }, 'sleepy');
  const sleepyPlayful = rate({ fatigue: 'drowsy', herLife: 'company', weights: playful }, 'sleepy');
  assert.ok(sleepyPlain > 0.7 && sleepyPlayful < sleepyPlain, `${sleepyPlain} ${sleepyPlayful}`);
  const busyPlain = rate({ fatigue: null, herLife: 'thinking', weights: plain }, 'busy');
  const busyCautious = rate({ fatigue: null, herLife: 'thinking', weights: cautious }, 'busy');
  assert.ok(busyCautious > busyPlain && busyPlain > 0.2, `${busyPlain} ${busyCautious}`);
  assert.ok(rate({ fatigue: null, herLife: 'daydream', weights: plain }, 'accept') > 0.9);
  for (const answer of ['accept', 'sleepy', 'busy'] as const) {
    const context = rpsChatContext(answer, '想事情');
    assert.match(context, /^【猜拳】用户/u); assert.doesNotMatch(context, /[他她]/u);
    // Draft-leak record 2026-11-03: it says what is going on, never a list of dos and don'ts she could copy into her reply.
    assert.doesNotMatch(context, /不要|不用|别|简短|一两句|按你的性格|不让用户内疚/u, answer);
  }
  assert.match(rpsChatContext('accept'), /三个按钮/u); assert.match(rpsChatContext('sleepy'), /不会开始游戏/u);
  // "由你来喊" made her call the count herself, mid-session, before any button was there.
  assert.doesNotMatch(rpsChatContext('accept'), /喊|由你/u);
  assert.match(rpsChatContext('accept'), /说完后/u);
});

test('inviting: only a playful mood on a playful-enough card, never quiet or absorbed, and not pestering (gaps and two a day)', () => {
  const now = 10 * 3_600_000, base: RpsInviteInput = { now, today: '2026-11-03', playfulness: 1, quiet: false, herLife: 'company', gameActive: false, invites: [], lastGameAt: null };
  assert.equal(rpsInviteVerdict(base), 'ok');
  assert.equal(rpsInviteVerdict({ ...base, quiet: true }), 'quiet');
  assert.equal(rpsInviteVerdict({ ...base, herLife: 'thinking' }), 'busy');
  assert.equal(rpsInviteVerdict({ ...base, playfulness: 0.5 }), 'mood');
  assert.equal(rpsInviteVerdict({ ...base, gameActive: true }), 'active');
  assert.equal(rpsInviteVerdict({ ...base, lastGameAt: now - 30 * 60_000 }), 'after-game');
  assert.equal(rpsInviteVerdict({ ...base, invites: [{ at: now - 3_600_000, date: '2026-11-03' }] }), 'gap');
  assert.equal(rpsInviteVerdict({ ...base, invites: [{ at: now - 5 * 3_600_000, date: '2026-11-03' }, { at: now - 3 * 3_600_000, date: '2026-11-03' }] }), 'day');
  assert.equal(rpsInviteVerdict({ ...base, invites: [{ at: now - 5 * 3_600_000, date: '2026-11-02' }, { at: now - 3 * 3_600_000, date: '2026-11-02' }] }), 'ok');
  // The card's 爱玩 weight and the current mood both matter.
  const happy = { primary: 'happy', values: { D: 70 } }, sad = { primary: 'sad', values: { D: 30 } };
  assert.ok(rpsPlayfulness(happy, card({ playful: 1 })) >= RPS_INVITE_RULES.playfulness);
  assert.ok(rpsPlayfulness(sad, card({ playful: 1 })) < RPS_INVITE_RULES.playfulness);
  assert.ok(rpsPlayfulness({ primary: 'calm' }, card({ playful: 0.5 })) < RPS_INVITE_RULES.playfulness);
  assert.ok(rpsPlayfulness({ primary: 'calm' }, card({ playful: 1.4 })) > rpsPlayfulness({ primary: 'calm' }, card({ playful: 1 })));
});

test('reactions: proud when she wins, sore or pretending to cheat when she loses, only a pleased face when she let the user win', () => {
  const style = resolveRpsStyle({ soft: 1, tease: 3 }, card({ playful: 2 }, 100));
  const r = (outcome: 'her' | 'user' | 'draw', intent: 'fair' | 'soft' | 'read', roll: number, teaseUsed = false, final: 'her' | 'user' | null = null) =>
    chooseRpsReaction({ outcome, intent, userHand: 'rock', final, teaseUsed, style, random: () => roll });
  assert.equal(r('her', 'fair', 0.5).kind, 'win-round'); assert.equal(r('her', 'fair', 0.5, false, 'her').kind, 'win-game');
  assert.equal(r('her', 'read', 0.5).kind, 'habit');
  assert.equal(r('draw', 'fair', 0.5).face, 'surprised');
  assert.deepEqual(r('user', 'soft', 0).kind, 'soft-lose');
  const tease = r('user', 'fair', 0);
  assert.equal(tease.kind, 'tease'); assert.equal(tease.tease, 'paper', 'the pretend hand beats the user\'s');
  assert.deepEqual(rpsPlainLoss('user'), { kind: 'lose-game', face: 'pout', tease: null }, 'a pretend cheat she will not say is a plain loss');
  assert.equal(r('user', 'fair', 0, true).kind, 'lose-round', 'once per match');
  assert.equal(r('user', 'fair', 0.99, false, 'user').kind, 'lose-game');
});

test('habits: the first hand of four games or one favourite hand becomes the joke; she expects it only from earlier games', () => {
  const game = (first: string, rest: string[] = []): RpsGameRecord => ({ at: 1, origin: 'user', result: 'none',
    rounds: [first, ...rest].map(user => ({ her: 'paper', user: user as any, outcome: user === 'paper' ? 'draw' : user === 'rock' ? 'her' : 'user' })) });
  assert.equal(rpsHabits([game('rock'), game('rock'), game('paper')]).habit, null, 'three games are not a habit yet');
  const habits = rpsHabits([game('rock'), game('rock'), game('rock'), game('paper')]);
  assert.deepEqual(habits.habit, { kind: 'first', hand: 'rock', times: 3, of: 4 });
  assert.equal(rpsExpectedHand(habits, 1), 'rock'); assert.equal(rpsExpectedHand(null, 1), 'rock');
  const line = rpsDiaryLine([game('rock')], habits);
  assert.match(line, /玩了猜拳/u); assert.match(line, /老是先出石头/u); assert.match(line, /meme/u); assert.doesNotMatch(line, /[他她]/u);
  assert.equal(rpsDiaryLine([], habits), '');
});

