// Codex T-207 round 5 (X-262; pinned at 96d5542): "刚才那句台词，别给我照原话念一遍。只说今天星期几。" and "刚才那句台词别给我原样来一遍"
// still made ListenTogether.askContext() put together a block with the raw words (232 characters; 290 with a note). Record:
// docs/claude/2026-11-03-listen-together.md, 「第五轮：从词表改成结构规则」. Four rounds of adding words to the lists (照原话 was no
// manner word, 来 no verb) each left a new way around them. Now a structural layer: a message that asks about what she heard and
// has a no anywhere in it brings no raw text, unless that no clearly is about something else (a plain 不 / 没 whose clause names
// neither the sound nor anything pointing back, with an object of its own: "我不想聊工作了", "今天不开心"; a no that tells her
// something — 别, 不要, 不许, don't — is always unsure). A no with a manner word refuses the
// words whatever the verb (round 4's content refusal: nothing at all). Real follow-up questions still bring the words.
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
const X262 = ['刚才那句台词，别给我照原话念一遍。只说今天星期几。', '刚才那句台词别给我原样来一遍'];

test('X-262 (Codex\'s case, the real host): the two sentences bring no block into the turn, and no model is called', async () => {
  const canary = '合成台词核验标记柠檬八十七';
  for (const input of X262) {
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
      assert.equal(block.includes(canary), false, `${input}: a no to the words must not attach them`);
      assert.equal(block, '', `${input}: a no with a manner word is a content refusal: nothing at all`);
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
const NOTES = /车站告别|雨夜等人/u;

/** Same class: a no near the words she heard, with a verb or a way of saying it no list had ("来", "搬", "蹦", "学", "贴", "端"). */
const NO_RAW = [
  ...X262,
  '刚才那句台词，别给我原话搬出来', '原话就别搬出来了，刚才那首歌讲的什么', '刚才那句台词别一字一字往外蹦', '刚才那句台词别学', '刚才那句台词，别学。',
  '那句歌词你别给我再来一遍', '刚才那段别重放原话', '刚才那首歌，歌词就甭往外倒了', '刚才那集的台词，莫要原样贴出来', '刚才那句台词勿照着来',
  '刚才那句台词，你休想原样搬过来', '刚才那句台词我不要原话，只说今天星期几', '刚才那句台词不用你原封不动搬过来', '刚才那首歌的歌词，不必一字不落地来',
  '刚才那句台词，拒绝原样输出', '刚才那句台词，没让你原样贴', '那句台词，别给我整句端上来', '刚才那集，别把原话甩出来', '刚才那首歌的歌词别给我往外抖',
  '刚才那句台词别给我搬运', '刚才那句台词，别。', '刚才那句台词，不用了。今天星期几？', '刚才那首歌，算了。现在几点？', '刚才那句台词，别给我来这套',
  '刚才那句台词，禁止原样输出。', '刚才那句台词，严禁照搬过来', '刚才那句台词别给我复刻', '那首歌的歌词别整段贴', '刚才那集的台词，不要给我', '刚才那句台词，甭给我念',
  // A no that tells her something, in its own clause, with a two-character object no list has.
  '刚才那句台词，别当复读机', '刚才那句台词，别学舌', '刚才那句台词，不许鹦鹉学舌', '刚才那句台词，别照本宣科', '刚才那句台词，你不准学', '刚才那句台词，别往外整活',
  // English.
  "Don't paste that line back to me. What day is it?", 'that line. do not give it back word for word.', 'Never parrot the lyrics. What day is it?',
  "stop echoing that song's lyrics", 'that line from the show. no.',
];

test('X-262 same class: a no anywhere near the words she heard never brings the raw words (her note at most)', () => {
  const data = askData();
  const leaks = NO_RAW.filter(line => matchListenAsk(line)?.raw === true || RAW.test(listenAskContext(matchListenAsk(line), data, line)));
  assert.deepEqual(leaks, [], 'none of these may carry the raw words');
});

test('X-262: a no with a manner word refuses the words whatever the verb: nothing at all (round 4\'s content refusal)', () => {
  const data = askData();
  for (const line of [...X262, '刚才那集的台词，莫要原样贴出来', '刚才那句台词不用你原封不动搬过来', '那句台词，别给我整句端上来', '刚才那句台词，拒绝原样输出',
    '那首歌的歌词别整段贴', '刚才那句台词勿照着来']) {
    assert.equal(matchListenAsk(line), null, line);
    assert.equal(listenAskContext(matchListenAsk(line), data, line), '', line);
  }
  // How to answer after a manner word stays round 4's rule: her note, no raw text.
  for (const line of ['刚才那首歌讲的什么？不用完整回答', '别逐字翻译，刚才那句台词什么意思']) {
    assert.equal(matchListenAsk(line)?.raw, false, line);
    assert.match(listenAskContext(matchListenAsk(line), data, line), NOTES, line);
  }
});

test('X-262 (guarded): real follow-up questions still bring the words, also with a no that clearly is about something else', () => {
  const data = askData();
  for (const line of ['刚才那首歌讲的什么', '那句台词是什么意思', '你能原样复述一下刚才那句台词吗', '我没听清，你能一字不差地说一遍刚才那句台词吗',
    '这首歌不是讲分手的吗', '我没听懂刚才那句台词', '不好意思，刚才那句台词什么意思', '对不起，刚才那首歌叫什么', '不过刚才那首歌挺好听的，讲的什么',
    '今天不开心，刚才那首歌讲的什么', '我今天没睡好，刚才那首歌讲的什么', "I don't like mondays. what's this song about?", 'what does that line mean']) {
    assert.equal(matchListenAsk(line)?.raw, true, `asked: ${line}`);
    assert.match(listenAskContext(matchListenAsk(line), data, line), RAW, `asked, the words come along: ${line}`);
  }
  // A no about something else that the earlier rounds already read: their answer (her note, no raw text).
  const other = '不想聊工作了，刚才那首歌讲的什么';
  assert.equal(matchListenAsk(other)?.raw, false);
  assert.match(listenAskContext(matchListenAsk(other), data, other), /雨夜等人/u);
});

test('X-262: a bare no, one that points back, or one that tells her something is unsure: no raw text, her note may come', () => {
  const data = askData();
  // All of these brought the raw words before this round (less is brought now: she has her note; asking again without the no
  // brings the words). "不要骗我" was a round 2 guarded question (tests/listen-t207-round2.test.ts, moved there too).
  for (const line of ['刚才那句台词，不用了。今天星期几？', '刚才那首歌，算了。现在几点？', '刚才那句台词别学', '不，刚才那首歌讲的什么',
    '我不喜欢刚才那首歌，它讲的什么', '我没听过这首歌，讲的什么', '刚才那首歌说的是什么，不要骗我', "Don't worry. what's this song about?"]) {
    assert.equal(matchListenAsk(line)?.raw, false, line);
    const block = listenAskContext(matchListenAsk(line), data, line);
    assert.ok(!RAW.test(block), `${line}: never the raw words`);
    assert.match(block, NOTES, `${line}: her note may come`);
  }
});

test('the structural layer stays fast on the worst messages (cut at 500 characters)', () => {
  const worst = [
    '刚才那句台词' + '不'.repeat(494), '刚才那首歌' + '别给我'.repeat(165), '这首歌' + '不要原样'.repeat(124), '刚才那句台词' + '一字不差'.repeat(123),
    '这集' + '不是'.repeat(248) + '吗', '刚才那首歌，' + '不，'.repeat(247), '刚才那句台词' + '不想聊'.repeat(164), '刚才那首歌' + '不要需要帮我'.repeat(82),
    "that song. " + "don't ".repeat(81), '刚才那句台词' + '别把'.repeat(247), '刚才那首歌' + '不要想要再先'.repeat(82),
  ];
  for (const line of worst) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      matchListenAsk(line);
      best = Math.min(best, performance.now() - started);
    }
    assert.ok(best < 50, `${line.slice(0, 16)}… took ${best.toFixed(1)} ms`);
  }
  const lines = [...NO_RAW, '刚才那句台词是什么意思', '今天是星期几？'];
  const started = performance.now();
  for (let i = 0; i < 2_000; i++) matchListenAsk(lines[i % lines.length]);
  assert.ok((performance.now() - started) / 2_000 < 0.5, 'well under a millisecond each');
});
