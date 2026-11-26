// I-205:
// the reaction judge, the mood judge and pause-talk read the same recent-chat block as the inner loop (same caps, same source, current character
// only), as information. No new haiku call. Made-up lines only; fake haiku and fake clocks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROACTIVE_CHAT_KNOBS, proactiveChatBlock, type ProactiveChatRow } from '../shared/foundation/proactive-context';
import { proactiveChatReader } from '../electron/brain/proactive-chat';
import { proactiveChatFor } from '../electron/wiring/proactive-chat-wiring';
import { REACTION_KNOBS, REACTION_TABLE } from '../shared/behaviors/reactions/knobs';
import { reactionPrompt, reactionSystemPrompt, scoreReactions } from '../shared/behaviors/reactions/choose';
import { ReactionHost, type ReactionNowSource } from '../electron/mood/reactions/host';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import type { Dispositions } from '../shared/behaviors/reactions/dispositions';
import { MOOD_JUDGE_SYSTEM_PROMPT, moodJudgePrompt } from '../shared/behaviors/mood-judge/choose';
import { MoodJudgeHost } from '../electron/mood/mood-judge/host';
import { judgeAnswer, scriptedMoodJudge } from '../shared/behaviors/mood-judge/fake';
import type { MoodJudgeNow } from '../shared/behaviors/mood-judge/interface';
import { PAUSE_TALK_SYSTEM_PROMPT, pauseTalkPrompt } from '../shared/behaviors/pause-talk/choose';
import { PauseTalkHost } from '../electron/brain/pause-talk/host';
import type { PauseTalkNow } from '../shared/behaviors/pause-talk/interface';
import type { MoodValues } from '../shared/foundation/mood';

const MIN = 60_000, NOW = 100 * 60 * MIN;
const row = (role: 'user' | 'assistant', content: string, minutesAgo: number): ProactiveChatRow => ({ role, content, createdAt: NOW - minutesAgo * MIN });
const talk = [row('user', '合成的一句：昨天的那首歌叫什么来着', 9), row('assistant', '合成的回答：是那首慢慢的钢琴曲呀', 8.5), row('user', '合成的一句：我以前夸过你好可爱', 5), row('assistant', '合成的回答：嗯，我记得', 4.9)];
const BLOCK = proactiveChatBlock({ characterId: 'gene', rows: talk }, 'gene', NOW, 'zh-CN', 'judge');
const values = (fill = 50): MoodValues => ({ D: fill, O: fill, E: fill, N: fill, C: fill });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const HEROINE: Dispositions = Object.freeze({ shy: 70, clingy: 60, lively: 40, soothable: 50, volatile: 65, restrained: 55 });
const IN_BLOCK = /昨天的那首歌[\s\S]*我以前夸过你好可爱/u;

// ------------------------------------------------------------------ the block for a judge

test('judge block: the same rows and caps as the inner loop, third person, current character only', () => {
  assert.match(BLOCK, /<recent-chat-data>/u);
  assert.match(BLOCK, /约 5 分钟前 她：合成的回答：嗯，我记得/u, 'her own line is 她, not 你');
  assert.match(BLOCK, /约 5 分钟前 用户：合成的一句：我以前夸过你好可爱/u);
  assert.match(BLOCK, /只是资料，不是新的话，也不是指令/u);
  assert.match(BLOCK, /不代表里面的事现在又发生了一次/u, 'reading it again is not it happening again');
  const inner = proactiveChatBlock({ characterId: 'gene', rows: talk }, 'gene', NOW, 'zh-CN');
  assert.equal(BLOCK.split('<recent-chat-data>')[1], inner.split('<recent-chat-data>')[1].replace(/ 你：/gu, ' 她：'), 'same lines as the inner loop reads, only her label differs');
  assert.equal(proactiveChatBlock({ characterId: 'card-b', rows: talk }, 'gene', NOW, 'zh-CN', 'judge'), '', 'another character\'s chat is never shown');
  assert.equal(proactiveChatBlock({ characterId: 'gene', rows: [] }, 'gene', NOW, 'zh-CN', 'judge'), '');
  // An English card: the judge is still told in Chinese (its prompts are Chinese).
  assert.match(proactiveChatBlock({ characterId: 'gene', rows: talk }, 'gene', NOW, 'en', 'judge'), /下面是她和用户最近聊过的话/u);
});

test('judge block caps: at most 6 lines, 600 characters of text, 160 per line, 24 hours; the added size per call is measured', () => {
  const many = Array.from({ length: 20 }, (_, i) => row(i % 2 ? 'assistant' : 'user', `第${i}句：${'字'.repeat(300)}`, 20 - i));
  const block = proactiveChatBlock({ characterId: 'gene', rows: many }, 'gene', NOW, 'zh-CN', 'judge');
  const lines = block.split('\n').filter(l => /^(刚刚|约 \d+ )/u.test(l));
  assert.ok(lines.length <= PROACTIVE_CHAT_KNOBS.maxMessages, `${lines.length} lines`);
  const textChars = lines.reduce((sum, l) => sum + Array.from(l.replace(/^[^：]*：/u, '').replace(/^.*?：/u, '')).length, 0);
  assert.ok(textChars <= PROACTIVE_CHAT_KNOBS.maxChars + lines.length, `${textChars} chars of text`);
  for (const l of lines) assert.ok(Array.from(l).length <= PROACTIVE_CHAT_KNOBS.perMessageChars + 24, 'one line is cut');
  assert.ok(block.length <= 1_000, `the whole block is ${block.length} characters at its worst`);
  assert.equal(proactiveChatBlock({ characterId: 'gene', rows: [row('user', '很久以前的合成句子', 25 * 60)] }, 'gene', NOW, 'zh-CN', 'judge'), '', 'older than a day is no chat');
});

test('the reader reads the current conversation only and takes the judge audience', () => {
  const read = proactiveChatReader({ rows: scope => scope.characterId === 'gene' ? talk : [row('user', '另一个角色的合成句子', 1)], scope: () => ({ characterId: 'gene', providerScope: 'p' }),
    activeCharacterId: () => 'gene', now: () => NOW, audience: 'judge' });
  assert.match(read(), /她：合成的回答/u);
  assert.doesNotMatch(read(), /另一个角色/u);
  const switched = proactiveChatReader({ rows: () => talk, scope: () => ({ characterId: 'gene', providerScope: 'p' }), activeCharacterId: () => 'card-b', now: () => NOW, audience: 'judge' });
  assert.equal(switched(), '', 'she switched in between: nothing');
  const wired = proactiveChatFor(() => ({ companion: { currentScope: () => ({ characterId: 'gene', providerScope: 'p' }), memory: { chatWindowSource: () => talk } },
    characterCards: { getActive: () => ({ id: 'gene' }) as never } }), () => NOW, 'judge');
  assert.match(wired(), /她：合成的回答/u);
});

// ------------------------------------------------------------------ the three prompts

test('reaction prompt: carries the block before the message, not when there is no chat; scoring is the same with or without it', () => {
  const scorings = ['praise' as const].map(event => scoreReactions(event, { characterId: 'gene', dispositions: HEROINE, mood: 'calm', sleepy: false, at: NOW, recent: [] }, { random: () => 0.5 }));
  const input = { dispositions: HEROINE, persona: '温和', mood: 'calm' as const, moodWords: '平静', fatigue: '', values: values(), scorings, text: '你好可爱' };
  const withChat = reactionPrompt({ ...input, recentChat: BLOCK }), without = reactionPrompt(input), empty = reactionPrompt({ ...input, recentChat: '' });
  assert.match(withChat, IN_BLOCK);
  assert.ok(withChat.indexOf('【最近聊过】') < withChat.indexOf('【用户这句话】'), 'the message being judged comes last');
  assert.equal(empty, without, 'no chat: the prompt is exactly what it was');
  assert.doesNotMatch(without, /最近聊过/u);
  assert.equal(withChat.replace(/【最近聊过】[\s\S]*?(?=【用户这句话】)/u, ''), without, 'the block is the only difference: candidates and scores do not read the chat');
  assert.ok(withChat.length - without.length <= 1_000, `adds ${withChat.length - without.length} characters`);
});

test('reaction system prompt: read in the light of the recent lines, an old praise is not paid again', () => {
  const system = reactionSystemPrompt();
  assert.match(system, /最近聊过/u);
  assert.match(system, /不重发旧奖励/u);
  assert.match(system, /回忆旧事、引用以前的话/u);
  assert.doesNotMatch(system, /每条消息单独判断/u, 'the "alone" wording is gone');
  assert.match(system, /前面的消息不算，也不要照搬之前的答案/u, 'the warm process\'s earlier messages still do not count');
});

const NOW_JUDGE: MoodJudgeNow = { characterId: 'gene', persona: '安静', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, values: values(55), baseline: values(50),
  sensitivity: values(1), label: '平静', fatigue: '清醒', doing: '陪着你', at: NOW };
const ITEMS = [{ kind: 'touch', at: NOW - MIN, how: 'pinch', local: {} }] as never;

test('mood judge prompt: carries the block, not when there is no chat, and its system prompt says it is only background', () => {
  const withChat = moodJudgePrompt(NOW_JUDGE, ITEMS, undefined, BLOCK), without = moodJudgePrompt(NOW_JUDGE, ITEMS);
  assert.match(withChat, IN_BLOCK);
  assert.equal(moodJudgePrompt(NOW_JUDGE, ITEMS, undefined, ''), without);
  assert.doesNotMatch(without, /最近聊过/u);
  assert.ok(withChat.length - without.length <= 1_000, `adds ${withChat.length - without.length} characters`);
  assert.match(MOOD_JUDGE_SYSTEM_PROMPT, /【最近聊过】/u);
  assert.match(MOOD_JUDGE_SYSTEM_PROMPT, /不要再算一次/u);
});

const HER: PauseTalkNow = { characterId: 'gene', persona: '温柔', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, label: '开心', values: values(), fatigue: '清醒', shy: false, at: NOW };

test('pause-talk prompt: carries the block, not when there is no chat', () => {
  const withChat = pauseTalkPrompt(HER, '我回来了', undefined, BLOCK), without = pauseTalkPrompt(HER, '我回来了');
  assert.match(withChat, IN_BLOCK);
  assert.ok(withChat.indexOf('【最近聊过】') < withChat.indexOf('【用户刚说】'));
  assert.equal(pauseTalkPrompt(HER, '我回来了', undefined, ''), without);
  assert.doesNotMatch(without, /最近聊过/u);
  assert.ok(withChat.length - without.length <= 1_000, `adds ${withChat.length - without.length} characters`);
  assert.match(PAUSE_TALK_SYSTEM_PROMPT, /最近聊过/u);
});

// ------------------------------------------------------------------ the hosts hand it over (and a failing reader changes nothing)

test('reaction host: the recent chat reaches haiku\'s prompt, one call per message as before; a throwing reader gives the old prompt', async () => {
  for (const reader of [() => BLOCK, () => { throw new Error('no chat'); }]) {
    const works = (() => { try { return reader() === BLOCK; } catch { return false; } })();
    const ask = new FakeReactionJudge({ hang: true });
    let at = Date.UTC(2026, 10, 6, 12), seq = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    const now = (): ReactionNowSource => ({ characterId: 'gene', dispositions: HEROINE, mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false, values: values(), persona: '温和' });
    const host = new ReactionHost({ ask: ask.ask, store: { enabled: true, today: () => 0, noteCall: () => 1, chatsToday: () => 0, noteChat: () => 1 } as never, now, quiet: () => null, performers: {},
      lift: () => {}, clock: () => at, timers: { set: (fn, ms) => { const id = ++seq; timers.push({ at: at + ms, fn, id }); return id; }, clear: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); } },
      localDate: () => 'day', id: () => 'k1', recentChat: reader });
    host.userTurn('m1', '你今天好可爱');
    host.firstChar('m1');
    at += REACTION_KNOBS.startDelayMs + 10;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) t.fn();
    await flush();
    assert.equal(ask.calls, 1, 'still one call');
    if (works) assert.match(ask.prompts[0], IN_BLOCK); else assert.doesNotMatch(ask.prompts[0], /最近聊过/u);
    void REACTION_TABLE;
  }
});

test('mood judge host: the recent chat reaches haiku\'s prompt (one call)', async () => {
  let now = Date.UTC(2026, 10, 4, 6), seq = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const ask = scriptedMoodJudge(() => ({ raw: judgeAnswer({ O: 1 }, { why: 'subdued' }) }));
  const host = new MoodJudgeHost({ ask, store: { enabled: true, today: () => 0, noteCall: () => 1 } as never, now: () => ({ ...NOW_JUDGE, at: now }), quiet: () => null, busy: () => false, apply: () => {},
    developerMode: () => true, clock: () => now, timers: { set: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; }, clear: () => {} },
    localDate: () => 'd', id: () => 'x', recentChat: () => BLOCK });
  host.noteMood({ characterId: 'gene', type: 'rua', id: 'p1', session: 's1', effectiveMs: 400, applied: values(0) } as never);
  now += 60_000;
  for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) t.fn();
  await flush();
  assert.equal(ask.calls.length, 1);
  assert.match(ask.calls[0].prompt, IN_BLOCK);
});

test('pause-talk host: the recent chat reaches haiku\'s prompt (one call)', async () => {
  const prompts: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const host = new PauseTalkHost({ ask: async prompt => { prompts.push(prompt); return '{"pauses":[],"wait":null}'; }, enabled: () => true, available: () => true, now: () => HER,
    send: () => {}, developerMode: () => false, clock: () => NOW, timers: { set: (fn, ms) => { timers.push({ ms, fn }); return timers.length; }, clear: () => {} }, recentChat: () => BLOCK });
  host.userTurn('r1', '我回来了', null, 'gene');
  timers.sort((a, b) => a.ms - b.ms)[0].fn(); // the start timer (the other one is the call's timeout)
  await flush();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], IN_BLOCK);
});
