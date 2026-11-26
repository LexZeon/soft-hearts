// 边说边演第 1 步：词表、标记解析、流式过滤、灰色小字（shared/behaviors/speech-beats/；方案 docs/claude/2026-11-19-per-reply-choreo-plan.md）。
// 最要紧的一条：标记从不漏进给人看、给人听的字里，不管它被拆成几段流进来、写坏了还是没闭合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEECH_BEAT_MEANINGS, SPEECH_BEAT_SHOWCASE, SpeechBeatFilter, describeBeats, filterSpeechBeats, isCloseBeatWord, isSpeechBeatWord, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_WORDS, type SpeechBeatSummary } from '../shared/behaviors/speech-beats/interface';
import { SPEECH_BEAT_KNOBS } from '../shared/behaviors/speech-beats/knobs';
import { SHOWCASE_BLINK_STYLES, SHOWCASE_EXPRESSIONS, SHOWCASE_GLANCES, SHOWCASE_KINDS } from '../shared/unbound/showcase';

const streamed = (pieces: readonly string[]): { summary: SpeechBeatSummary; outputs: string[] } => {
  const filter = new SpeechBeatFilter();
  const outputs = pieces.map(piece => filter.push(piece).text);
  outputs.push(filter.end().text);
  return { summary: filter.summary(), outputs };
};
const leaks = (text: string) => /[⟦⟧]/u.test(text) || SPEECH_BEAT_WORDS.some(word => text.includes(word));

test('markers come out of the text and become beats at the place they were written', () => {
  const result = filterSpeechBeats('⟦smile-warm⟧今天起得好早。⟦tilt⟧昨晚睡得好吗？');
  assert.equal(result.text, '今天起得好早。昨晚睡得好吗？');
  assert.deepEqual(result.beats, [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 7 }]);
  assert.equal(result.performanceOnly, false);
  assert.equal(result.dropped, 0);
});

test('a marker split across stream chunks, at every possible place, is still removed and gives the same beats', () => {
  const whole = '你来啦。⟦look-you⟧⟦smile-warm⟧我等了好久。⟦pout⟧才没有想你呢⟦lean-in⟧。';
  const once = filterSpeechBeats(whole);
  assert.equal(once.text, '你来啦。我等了好久。才没有想你呢。');
  for (let cut = 0; cut <= whole.length; cut += 1) {
    const { summary, outputs } = streamed([whole.slice(0, cut), whole.slice(cut)]);
    assert.deepEqual(summary, once, `cut at ${cut}`);
    for (const output of outputs) assert.ok(!leaks(output), `cut at ${cut} leaked ${JSON.stringify(output)}`);
  }
  const { summary, outputs } = streamed(Array.from(whole));
  assert.deepEqual(summary, once);
  assert.ok(outputs.every(output => !leaks(output)));
});

test('a reply that is only markers is a performance without words, described in a grey line', () => {
  const only = filterSpeechBeats('⟦shy⟧⟦hand-cheek⟧');
  assert.equal(only.text, '');
  assert.equal(only.performanceOnly, true);
  assert.equal(describeBeats(only.beats), '（害羞地笑了，手放到脸边）');
  assert.equal(filterSpeechBeats('⟦shy⟧……').performanceOnly, true, 'punctuation alone is still no words');
  assert.equal(filterSpeechBeats('⟦shy⟧嗯').performanceOnly, false);
  assert.equal(filterSpeechBeats('⟦shy⟧🙈').performanceOnly, false, 'an emoji is something to show');
  assert.equal(filterSpeechBeats('⟦shy⟧3').performanceOnly, false);
  assert.equal(filterSpeechBeats('……').performanceOnly, false, 'no beats: an ordinary reply');
});

test('her own bracket with a word outside the vocabulary is dropped whole, never shown', () => {
  const result = filterSpeechBeats('⟦dance⟧好呀⟦⟧！');
  assert.equal(result.text, '好呀！');
  assert.deepEqual(result.beats, []);
  assert.equal(result.dropped, 2);
});

test('an unclosed ⟦ loses itself and the English right after it; the words after that stay', () => {
  assert.equal(filterSpeechBeats('好呀⟦smi').text, '好呀');
  assert.equal(filterSpeechBeats('⟦smile今天好').text, '今天好');
  const long = filterSpeechBeats(`⟦${'a'.repeat(30)}好`);
  assert.ok(!/[⟦⟧]/u.test(long.text));
  assert.ok(long.text.endsWith('好'));
  assert.equal(filterSpeechBeats('好⟦').text, '好');
});

test('other brackets count only when the word inside is in the vocabulary; everything else is shown as written', () => {
  assert.deepEqual(filterSpeechBeats('【shy】好呀').beats, [{ word: 'shy', at: 0 }]);
  assert.equal(filterSpeechBeats('【shy】好呀').text, '好呀');
  assert.equal(filterSpeechBeats('〖v〗耶').text, '耶');
  assert.equal(filterSpeechBeats('[v]耶').text, '耶');
  assert.equal(filterSpeechBeats('[[laugh]]哈哈').text, '哈哈');
  for (const plain of ['【重要】记得带伞', '[注意] 别熬夜', 'array[0] 是第一个', '[ok] 好', '[]', '【】', '你看[', '【shy']) {
    const result = filterSpeechBeats(plain);
    assert.equal(result.text, plain, plain);
    assert.equal(result.beats.length, 0, plain);
  }
});

test('markers are case-insensitive and may have spaces inside', () => {
  assert.deepEqual(filterSpeechBeats('⟦Smile-Warm⟧早').beats, [{ word: 'smile-warm', at: 0 }]);
  assert.deepEqual(filterSpeechBeats('⟦ tilt ⟧早').beats, [{ word: 'tilt', at: 0 }]);
});

test('limits: at most maxBeats in a reply and maxAtOnce at one spot; the same word twice at one spot is one beat', () => {
  const many = filterSpeechBeats(Array.from({ length: SPEECH_BEAT_KNOBS.maxBeats + 4 }, (_, i) => `⟦shy⟧第${i}句。`).join(''));
  assert.equal(many.beats.length, SPEECH_BEAT_KNOBS.maxBeats);
  assert.equal(many.dropped, 4);
  const crowded = filterSpeechBeats('⟦shy⟧⟦v⟧⟦tilt⟧⟦laugh⟧好');
  assert.equal(crowded.beats.length, SPEECH_BEAT_KNOBS.maxAtOnce);
  assert.equal(crowded.dropped, 1);
  const twice = filterSpeechBeats('⟦shy⟧⟦shy⟧好');
  assert.deepEqual(twice.beats, [{ word: 'shy', at: 0 }]);
  assert.equal(twice.dropped, 0);
});

test('after end nothing more is taken', () => {
  const filter = new SpeechBeatFilter();
  filter.push('好');
  filter.end();
  assert.deepEqual(filter.push('⟦shy⟧再说'), { text: '', beats: [] });
  assert.equal(filter.summary().text, '好');
});

test('random replies streamed in random pieces never leak a marker and match the one-shot result', () => {
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const parts = ['今天', '好呀', '。', '，', '你看', 'ok', '[注意]', '【重要】', '……', '⟦dance⟧', '⟦smi', ...SPEECH_BEAT_WORDS.map(word => `⟦${word}⟧`)];
  for (let round = 0; round < 300; round += 1) {
    const whole = Array.from({ length: 2 + rand(12) }, () => parts[rand(parts.length)]).join('');
    const once = filterSpeechBeats(whole);
    const pieces: string[] = [];
    for (let i = 0; i < whole.length;) { const step = 1 + rand(6); pieces.push(whole.slice(i, i + step)); i += step; }
    const { summary, outputs } = streamed(pieces);
    assert.deepEqual(summary, once, whole);
    assert.ok(!/[⟦⟧]/u.test(summary.text), whole);
    for (const word of SPEECH_BEAT_WORDS) assert.ok(!summary.text.includes(`⟦${word}`), whole);
    assert.equal(outputs.join(''), summary.text);
  }
});

test('every word has a meaning, a grey-line phrase and a move that is valid in the Unbound showcase vocabulary', () => {
  const extra: Readonly<Record<string, readonly string[]>> = {
    name: SHOWCASE_EXPRESSIONS, dir: SHOWCASE_GLANCES, style: SHOWCASE_BLINK_STYLES, onset: ['quick', 'slow'],
    where: ['cheek', 'chin', 'mouth', 'ear'], how: ['palm', 'back', 'fingertip'], sign: ['v', 'heart', 'point'],
  };
  for (const word of SPEECH_BEAT_WORDS) {
    assert.ok(isSpeechBeatWord(word));
    assert.ok(SPEECH_BEAT_MEANINGS[word].zh && SPEECH_BEAT_MEANINGS[word].told, word);
    if (isCloseBeatWord(word)) { assert.ok(!(word in SPEECH_BEAT_SHOWCASE), `${word}: a close moment, not a showcase beat (I-185)`); continue; }
    const move = SPEECH_BEAT_SHOWCASE[word];
    assert.ok((SHOWCASE_KINDS as readonly string[]).includes(move.kind), `${word}: ${move.kind}`);
    for (const [key, value] of Object.entries(move)) {
      if (key === 'kind') continue;
      if (typeof value === 'number') { assert.ok(Number.isFinite(value), `${word}.${key}`); continue; }
      assert.ok(extra[key]?.includes(value), `${word}.${key}=${value}`);
    }
  }
  assert.equal(isSpeechBeatWord('dance'), false);
});

test('the prompt sentence names every offered word once, shows the marker shape, and leaves the choice to her (fewer rules)', () => {
  const sentence = speechBeatSentence();
  for (const word of SPEECH_BEAT_WORDS) assert.ok(sentence.includes(word + SPEECH_BEAT_MEANINGS[word].zh), word);
  assert.ok(sentence.includes('⟦tilt⟧'));
  assert.ok(sentence.includes('怎么带由你自己决定') && sentence.includes('可以一个都没有'), 'with, without or a few: her choice');
  assert.ok(sentence.includes('一直带到后面几句'), 'one expression may span sentences');
  assert.ok(sentence.includes('可以整条只写标记'), 'only expressions is allowed outside a call');
  assert.ok(sentence.includes('不要写表外的词'), 'the one technical line stays: the program has to read her markers');
  for (const rule of ['用户问你事情时要用话回答', '同一个动作别', '认真或难过的话题', '每句可以不同']) assert.ok(!sentence.includes(rule), `the removed rule stays removed: ${rule}`);
  const fewer = speechBeatSentence(['shy', 'look-you']);
  assert.ok(fewer.includes('shy害羞') && fewer.includes('look-you看你'));
  assert.ok(!fewer.includes('hand-cheek'));
});

test('the grey line keeps each phrase once and at most describeMax of them', () => {
  const beats = filterSpeechBeats('⟦look-away-left⟧⟦look-away-right⟧⟦shy⟧嗯。⟦pout⟧⟦tilt⟧哼').beats;
  assert.equal(describeBeats(beats), '（看向一边，害羞地笑了，嘟起嘴）');
  assert.equal(describeBeats([]), '');
});
