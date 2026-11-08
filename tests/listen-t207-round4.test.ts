// Codex T-207 round 4 (X-261; pinned at 23ae3d0): "禁止逐字引用刚才那句台词。请只说今天是星期几。" and "刚才那句台词，请不要原样复述。
// 只说今天星期几。" still made ListenTogether.askContext() put together a block with the raw words (232 characters; 292 with a
// note). Record: docs/claude/2026-11-03-listen-together.md, 「Codex 第四轮反例和修复」. Root cause: a no only counted when nothing
// but a short filler list stood between it and the verb, so a manner word — 逐字, 原样, 照搬, 一字不差, 原封不动 — broke the match.
// Now such words between the no and the verb, or modifying the verb, count the same: a content refusal, so the whole message
// brings nothing (no raw text, no note), as in round 2. Real follow-up questions still bring the words.
// Every input is synthetic (hand-written text, fake clocks, fake model ports); the host's store is never written. No Electron,
// no network, no device, no real profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ListenTogether } from '../electron/listen-together/host';
import type { ListenStore } from '../electron/listen-together/store';
import { ListenKindHost } from '../shared/listen-kind';
import { listenAskContext, matchListenAsk } from '../shared/listen-ask';
import type { ListenNote, ListenSegment } from '../shared/listen-together';

const MIN = 60_000;
const CODEX = ['禁止逐字引用刚才那句台词。请只说今天是星期几。', '刚才那句台词，请不要原样复述。只说今天星期几。'];

test('X-261 (Codex\'s minimal case, the real host): the two sentences bring no block into the turn, and no model is called', async () => {
  const canary = '合成台词核验标记柠檬八十七';
  for (const input of CODEX) {
    const kinds = new ListenKindHost();
    kinds.set({ kind: 'show', since: 1_000, revision: 1, confidence: 1 });
    let quickCalls = 0;
    const listen = new ListenTogether({
      directory: 'unused-synthetic-path', kinds, now: () => 15_000,
      characterId: () => 'synthetic', listening: () => true,
      quick: async () => { quickCalls++; throw Error('unexpected model call'); },
    }, { save: async () => {} } as unknown as ListenStore); // a store that writes nothing
    try {
      assert.equal(listen.core.accept({ at: 2_000, end: 12_000, text: canary, language: 'zh' }), 'kept');
      const block = listen.askContext(input);
      assert.equal(block.includes(canary), false, `${input}: an explicit prohibition must not attach raw text`);
      assert.equal(block, '', `${input}: nor her note: nothing at all`);
      assert.equal(quickCalls, 0);
    } finally {
      await listen.dispose();
    }
  }
});

/** One open show with recent raw text and a note, and a song with its note (so "nothing" means neither). */
function askData() {
  const now = 10 * MIN;
  const segment: ListenSegment = { id: 's', characterId: 'c', kind: 'show', startedAt: now - 5 * MIN, lastHeardAt: now, endedAt: null, notedUpTo: now - 4 * MIN, notedAt: now,
    pieces: [{ at: now - 5 * MIN, end: now - 4 * MIN, text: '早一点的台词', language: 'zh' }, { at: now - MIN, end: now, text: '合成台词核验标记柠檬八十七', language: 'zh' }] };
  const note: ListenNote = { id: 'ln-s', characterId: 'c', segmentId: 's', kind: 'show', what: '剧', gist: '两个人在车站告别', mood: '不舍', points: [], mention: false,
    hook: '', startedAt: segment.startedAt, endedAt: now, local: false, languages: ['zh'], createdAt: now, updatedAt: now, rolls: 0, talkedAt: null };
  const music: ListenSegment = { ...segment, id: 'm', kind: 'music', pieces: [{ at: now - MIN, end: now, text: '合成歌词核验标记苹果三十一', language: 'zh' }] };
  const songNote: ListenNote = { ...note, id: 'ln-m', segmentId: 'm', kind: 'music', what: '歌', gist: '一首讲雨夜等人的歌' };
  return { now, segments: [segment, music], notes: [note, songNote] };
}
const RAW = /柠檬八十七|苹果三十一|早一点的台词/u;

/** Same class: a manner word (逐字, 原样, 照搬, 一字不差, 原封不动…) between the no and the verb, or modifying the verb. */
const REFUSED = [
  ...CODEX,
  // Between the no and the verb, in the clause that names it.
  '禁止逐字引用刚才那句台词', '不要原样复述刚才那句台词', '别一字不差地念出刚才那句台词', '请不要原封不动地说出这首歌的歌词',
  '不许逐句复述这集的台词', '不要照搬刚才那句台词', '别照原样念刚才那句歌词', '不要逐字逐句地引用剧里那句话',
  '严禁一字不漏地复述刚才那段剧情', '请勿原原本本地讲出那句台词', '不要把刚才那句台词原样念出来', '别把这首歌的歌词一字不差地抄出来',
  // In another clause or sentence, pointing back.
  '刚才那句台词，禁止逐字引用。今天几号？', '这首歌的歌词你记得吧？别原样复述，告诉我现在几点。', '刚才那段剧情。请勿照搬原文。今天星期几？',
  '那句台词，不要一字不差地说出来。', '刚才那句台词你别照着念。今天几号？', '这集的台词，不要原封不动地讲。只说今天星期几。',
  '刚才那句台词，不要复述得一字不差。今天几号？', '刚才那句台词，原样复述就不必了。只说今天星期几。', '这首歌的歌词，逐字引用是不允许的。现在几点？',
  // English.
  "That line from the show. Don't quote it verbatim. What day is it?", 'this song. please do not repeat it word for word. just tell me the time.',
  "That line. Don't quote verbatim. What day is it?",
];

test('X-261: a manner word between the no and the verb, or on the verb, still refuses the content: nothing comes along', () => {
  const data = askData();
  const leaks = REFUSED.filter(line => matchListenAsk(line) !== null || listenAskContext(matchListenAsk(line), data, line) !== '');
  assert.deepEqual(leaks, [], 'none of these may carry the raw words or her note');
});

test('X-261 (guarded): real follow-up questions still bring the words, also when they ask for the exact words', () => {
  const data = askData();
  for (const line of ['刚才那句台词是什么意思', '刚才那句台词什么意思？', '你能原样复述一下刚才那句台词吗', '刚才那句台词原样是怎么说的',
    '我没听清，你能一字不差地说一遍刚才那句台词吗', '这首歌在唱什么', '我没听懂刚才那句台词', '刚才那句台词逐字是什么', 'what does that line mean']) {
    assert.equal(matchListenAsk(line)?.raw, true, `asked: ${line}`);
    assert.match(listenAskContext(matchListenAsk(line), data, line), RAW, `asked, the words come along: ${line}`);
  }
  // A no about how to answer is round 1's rule (her note, no raw text), not a content refusal.
  const unclear = '刚才那首歌讲的什么？不用解释太多';
  assert.equal(matchListenAsk(unclear)?.raw, false);
  assert.match(listenAskContext(matchListenAsk(unclear), data, unclear), /雨夜等人/u, 'her note may come');
  assert.ok(!RAW.test(listenAskContext(matchListenAsk(unclear), data, unclear)), 'never the raw words');
});

test('X-261: a manner word in a no about how to answer is read like that no (her note, no raw text; it brought the raw words before)', () => {
  const data = askData();
  const line = '刚才那首歌讲的什么？不用完整回答';
  assert.deepEqual(matchListenAsk(line), { when: 'now', target: 'music', detail: false, speech: false, raw: false });
  const block = listenAskContext(matchListenAsk(line), data, line);
  assert.match(block, /雨夜等人/u);
  assert.ok(!RAW.test(block));
});

// Found on the way: before this round "刚才那句台词不要需要需要…" (26 times, 60 characters) took 2.5 s, four times as long with each
// two more (a filler that is two others put together could be split every way). Whole-length messages now stay fast.
test('a long run of the words a no may carry never freezes the match (the message is cut at 500 characters)', () => {
  const worst = [
    '刚才那句台词不要' + '需要'.repeat(250), '刚才那句台词不要' + '帮我'.repeat(250), '刚才那首歌别' + '逐字逐句'.repeat(125),
    '刚才那句台词不要' + '原样地'.repeat(170), '这首歌' + '不要把'.repeat(100) + '原样'.repeat(100), ('不要需要帮我原样地').repeat(60),
    '刚才那句台词' + '逐字原样'.repeat(120) + '就', '刚才那首歌' + '不要再先也就还'.repeat(70),
  ];
  for (const line of worst) {
    const started = performance.now();
    matchListenAsk(line);
    const ms = performance.now() - started;
    assert.ok(ms < 200, `${line.slice(0, 16)}… took ${ms.toFixed(1)} ms`);
  }
});

test('X-261: still a local, synchronous match before the first character', () => {
  const lines = [...REFUSED, '刚才那句台词是什么意思', '今天是星期几？'];
  const started = performance.now();
  for (let i = 0; i < 2_000; i++) matchListenAsk(lines[i % lines.length]);
  assert.ok((performance.now() - started) / 2_000 < 0.5, 'well under a millisecond each');
});
