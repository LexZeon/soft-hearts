// Codex T-207 round 6 (pinned at 656ee87, listen-result.md): two messages that do not ask her about the line still made
// ListenTogether.askContext() put together the raw words (232 characters; 290 with a note):
// - "同事跟你说了声，刚才那句台词什么意思。请只说今天星期几。" — someone else's words, cut from their speech verb by a plain comma
//   (the reported-speech check only looked inside the clause of the words, and "跟你说" read as the user's own "你说");
// - "刚才那句台词，不当复读机" — the residual round 5 wrote down: a plain 不 with a two-character object ("当复读机") read as a no
//   about something else, though the object is a word for repeating.
// Now reported speech across a comma or colon, and a plain 不 / 没 whose clause names repeating or quoting, are unsure: no raw text
// (her note may still come, the round 1 / round 5 rule). Real follow-up questions keep their words, including the ones that open
// with "你说，" "我问你，" "话说，" "请问，".
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
const ROUND6 = ['同事跟你说了声，刚才那句台词什么意思。请只说今天星期几。', '刚才那句台词，不当复读机'];
const RAW_CANARY = '合成台词核验标记柠檬八十七';
const NOTE_CANARY = '合成笔记核验标记琥珀四十二';

/** Codex's matrix: the real host, one synthetic transcript, with and without a note on it. */
const MATRIX: { input: string; asks: boolean; nothing?: boolean }[] = [
  { input: '禁止逐字引用刚才那句台词。请只说今天是星期几。', asks: false, nothing: true },
  { input: '刚才那句台词，请不要原样复述。只说今天星期几。', asks: false, nothing: true },
  { input: '刚才那句台词，别给我照原话念一遍。只说今天星期几。', asks: false, nothing: true },
  { input: '刚才那句台词别给我原样来一遍', asks: false, nothing: true },
  { input: '刚才那句台词，不当复读机', asks: false },
  { input: '刚才那句台词什么意思？', asks: true },
  { input: '今天不开心，刚才那句台词什么意思？', asks: true },
  { input: '他问我「刚才那句台词什么意思？」。请只说今天星期几。', asks: false, nothing: true },
  { input: '同事跟你说了声，刚才那句台词什么意思。请只说今天星期几。', asks: false },
];

async function hostBlock(input: string, withNote: boolean) {
  const kinds = new ListenKindHost();
  kinds.set({ kind: 'show', since: 1_000, revision: 1, confidence: 1 });
  let quickCalls = 0;
  const listen = new ListenTogether({
    directory: 'unused-synthetic-path', kinds, now: () => 15_000,
    characterId: () => 'synthetic', listening: () => true,
    quick: async () => { quickCalls++; throw Error('unexpected model call'); },
  }, { save: async () => {} } as unknown as ListenStore); // a store that writes nothing
  try {
    assert.equal(listen.core.accept({ at: 2_000, end: 12_000, text: RAW_CANARY, language: 'zh' }), 'kept');
    if (withNote) {
      const snapshot = listen.core.snapshot();
      const segment = snapshot.segments[0]!;
      snapshot.notes = [{ id: 'ln-' + segment.id, characterId: segment.characterId, segmentId: segment.id, kind: 'show', startedAt: 1_000, endedAt: 12_000,
        local: false, languages: ['zh'], what: '剧', gist: NOTE_CANARY, mood: '平静', points: [], mention: false, hook: '', createdAt: 12_000, updatedAt: 12_000,
        rolls: 0, talkedAt: null }];
      listen.core.load(snapshot); // in memory only
      assert.equal(listen.core.notesFor('synthetic').length, 1);
    }
    return { block: listen.askContext(input), quickCalls };
  } finally {
    await listen.dispose();
  }
}

test('round 6 (Codex\'s matrix, the real host): the two messages never bring the raw words; the rest keep their earlier answers', async () => {
  for (const { input, asks, nothing } of MATRIX) {
    for (const withNote of [false, true]) {
      const { block, quickCalls } = await hostBlock(input, withNote);
      const label = `${input} (${withNote ? 'raw+note' : 'raw only'})`;
      assert.equal(quickCalls, 0, label);
      assert.equal(block.includes(NOTE_CANARY), withNote && !nothing, `${label}: her note ${withNote && !nothing ? 'comes' : 'does not come'}`);
      if (asks) assert.ok(block.includes(RAW_CANARY), `${label}: a real question brings the words`);
      else assert.equal(block.includes(RAW_CANARY), false, `${label}: not asked, so never the raw words`);
      if (!asks && (nothing || !withNote)) assert.equal(block, '', `${label}: nothing at all`);
    }
  }
  for (const input of ROUND6) assert.equal(matchListenAsk(input)?.raw, false, input);
});

/** One open show with recent raw text and a note, and a song with its note. */
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

test('round 6 same class: someone else\'s words before a comma or colon are unsure — no raw text, her note may come', () => {
  const data = askData();
  // All of these brought the raw words on 656ee87.
  for (const line of ['他说，刚才那句台词什么意思', '朋友问，刚才那首歌讲的什么', '同事跟你说了声：刚才那句台词什么意思', '老师讲了，这集演到哪了',
    '我妈问我，刚才那首歌叫什么', '有人跟你说了一句，那句歌词什么意思', '同事对你讲，这首歌在唱什么', '她问过我，刚才那句台词什么意思',
    '室友让我转告你，刚才那首歌叫什么', '同事跟你说刚才那句台词什么意思', '他们跟你说，刚才那首歌讲的什么']) {
    assert.equal(matchListenAsk(line)?.raw, false, line);
    const block = listenAskContext(matchListenAsk(line), data, line);
    assert.ok(!RAW.test(block), `${line}: never the raw words`);
    assert.match(block, NOTES, `${line}: her note may come`);
  }
});

test('round 6 same class: a plain 不 / 没 whose clause names repeating or quoting is unsure — no raw text, her note may come', () => {
  const data = askData();
  // All of these brought the raw words on 656ee87 (round 5 already read 别当复读机 / 别学舌 / 别照本宣科 this way).
  for (const line of ['刚才那句台词，不当复读机', '刚才那句台词，不做复读机', '刚才那句台词，不当鹦鹉', '刚才那首歌的歌词，不做传声筒', '那句台词，不当录音机',
    '刚才那句台词，不照本宣科']) {
    assert.equal(matchListenAsk(line)?.raw, false, line);
    const block = listenAskContext(matchListenAsk(line), data, line);
    assert.ok(!RAW.test(block), `${line}: never the raw words`);
    assert.match(block, NOTES, `${line}: her note may come`);
  }
});

test('round 6 (guarded): real questions keep their words, also after the user\'s own "你说，" "我问你，" "话说，" "请问，"', () => {
  const data = askData();
  for (const line of ['刚才那句台词什么意思？', '今天不开心，刚才那句台词什么意思？', '你说，刚才那句台词什么意思？', '我问你，刚才那首歌讲的什么',
    '跟你说，刚才那首歌真好听，讲的什么', '我跟你说，刚才那句台词什么意思', '话说，刚才那首歌讲的什么', '老实说，刚才那句台词什么意思', '请问，刚才那首歌叫什么',
    '我想问，这集演到哪了', '问一下，刚才那首歌叫什么', '顺便问，刚才那首歌叫什么', '所以说，刚才那句台词什么意思', '比如说，刚才那句台词什么意思',
    '换句话说，刚才那句台词什么意思', '你们说，刚才那首歌讲的什么', '我刚跟他说了。刚才那首歌讲的什么？', '他刚才说了什么', '不好意思，刚才那句台词什么意思',
    '我今天没睡好，刚才那首歌讲的什么', '剧里他说，那句台词什么意思']) {
    assert.equal(matchListenAsk(line)?.raw, true, `asked: ${line}`);
    assert.match(listenAskContext(matchListenAsk(line), data, line), RAW, `asked, the words come along: ${line}`);
  }
});
