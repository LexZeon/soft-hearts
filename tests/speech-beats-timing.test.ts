// 边说边演第 2、3 步的纯规则：拍子挪到显示的字上（place.ts）、她历史里的写法（history.ts）、什么时候演（schedule.ts，假时钟）。
// 方案 docs/claude/2026-11-19-per-reply-choreo-plan.md；记录 docs/claude/2026-11-20-speech-beats-2-4.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBeatFilter, filterSpeechBeats } from '../shared/behaviors/speech-beats/choose';
import { SpeechBeatPlacer } from '../shared/behaviors/speech-beats/place';
import { speechBeatHistoryText, speechBeatShownText, withSpeechBeatMarkers } from '../shared/behaviors/speech-beats/history';
import { SpeechBeatSchedule } from '../shared/behaviors/speech-beats/schedule';
import { SPEECH_BEAT_TIMING } from '../shared/behaviors/speech-beats/knobs';

/** Streams `pieces` through filter → placer, with `show` turning the filtered text into what is displayed (the protocol's part). */
function placeThrough(pieces: readonly string[], show: (filtered: string) => string = text => text) {
  const filter = new SpeechBeatFilter(), placer = new SpeechBeatPlacer();
  let filtered = '', displayed = '';
  const placed: { word: string; at: number }[] = [];
  const flush = () => {
    const next = show(filtered);
    if (next.length > displayed.length) { const delta = next.slice(displayed.length); placed.push(...placer.shown(delta)); displayed = next; }
  };
  for (const piece of pieces) { const chunk = filter.push(piece); placer.input(chunk); filtered += chunk.text; flush(); }
  const last = filter.end(); placer.input(last); filtered += last.text; flush();
  placed.push(...placer.finish());
  return { placed, displayed };
}

test('beats land on the displayed text: same places when nothing is cut, also for markers split across chunks', () => {
  const whole = '⟦smile-warm⟧今天起得好早。⟦tilt⟧昨晚睡得好吗？⟦lean-in⟧';
  for (let cut = 0; cut <= whole.length; cut += 1) {
    const { placed, displayed } = placeThrough([whole.slice(0, cut), whole.slice(cut)]);
    assert.equal(displayed, '今天起得好早。昨晚睡得好吗？');
    assert.deepEqual(placed, [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 7 }, { word: 'lean-in', at: 14 }], `cut ${cut}`);
  }
});

test('a draft cut before the reply and the private tail after it move the beats with the shown words', () => {
  // The protocol shows only what follows <sh-open> and hides the tail: the beat before 你好 lands at 0 of what is shown.
  const show = (filtered: string) => { const open = filtered.indexOf('<sh-open>'); if (open < 0) return ''; const body = filtered.slice(open + 9); const tail = body.indexOf('<sh-state'); return tail < 0 ? body.replace(/<[^>]*$/u, '') : body.slice(0, tail); };
  const { placed, displayed } = placeThrough(['草稿：先想想', '<sh-open>⟦shy⟧你好呀。', '⟦v⟧耶', '<sh-state-1>{"context":"neutral"}</sh-state-1>'], show);
  assert.equal(displayed, '你好呀。耶');
  assert.deepEqual(placed, [{ word: 'shy', at: 0 }, { word: 'v', at: 4 }]);
});

test('a reply that is only markers: every beat lands at 0 when it ends', () => {
  const { placed, displayed } = placeThrough(['⟦shy⟧', '⟦hand-cheek⟧']);
  assert.equal(displayed, '');
  assert.deepEqual(placed, [{ word: 'shy', at: 0 }, { word: 'hand-cheek', at: 0 }]);
});

test('her history: on, her own words with the markers back in place; off, clean words and no performance-only turn', () => {
  const summary = filterSpeechBeats('⟦smile-warm⟧早。⟦tilt⟧吃了吗？');
  const marked = withSpeechBeatMarkers(summary.text, summary.beats);
  assert.equal(marked, '⟦smile-warm⟧早。⟦tilt⟧吃了吗？');
  assert.deepEqual(filterSpeechBeats(marked), summary, 'round trip');
  assert.equal(speechBeatHistoryText({ ...summary, on: true }), marked);
  assert.equal(speechBeatHistoryText({ ...summary, on: false }), '早。吃了吗？');
  const only = filterSpeechBeats('⟦shy⟧⟦hand-cheek⟧');
  assert.equal(speechBeatHistoryText({ ...only, on: true }), '⟦shy⟧⟦hand-cheek⟧');
  assert.equal(speechBeatHistoryText({ ...only, on: false }), null, 'off: a performance-only turn stays out of her history');
  for (const on of [true, false]) assert.ok(!/（/u.test(speechBeatHistoryText({ ...only, on }) ?? ''), 'never a bracket action written as her words');
  assert.equal(withSpeechBeatMarkers('好', [{ word: 'shy', at: 9 }, { word: 'nope' as never, at: 0 }]), '好', 'bad places and words are skipped');
});

test('shown history never shows a marker; a performance-only turn shows its grey line', () => {
  assert.deepEqual(speechBeatShownText('⟦smile-warm⟧早。⟦tilt⟧吃了吗？'), { text: '早。吃了吗？', performed: null });
  assert.deepEqual(speechBeatShownText('⟦shy⟧⟦hand-cheek⟧'), { text: '', performed: '（害羞地笑了，手放到脸边）' });
  assert.deepEqual(speechBeatShownText('平常的一句'), { text: '平常的一句', performed: null });
  assert.deepEqual(speechBeatShownText('【重要】记得带伞'), { text: '【重要】记得带伞', performed: null });
});

// ---------------------------------------------------------------- when beats play (fake clock)

const words = (plays: readonly { word: string }[]) => plays.map(play => play.word);

test('read-aloud off: a beat plays when the bubble shows its character, in order', () => {
  const s = new SpeechBeatSchedule();
  s.begin('r1', 'shown', 0);
  s.add('r1', [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 7 }], 0);
  assert.deepEqual(s.due(0), [], 'nothing shown yet');
  s.shown('r1', 1, 100);
  assert.deepEqual(words(s.due(100)), ['smile-warm']);
  s.shown('r1', 7, 2000);
  assert.deepEqual(s.due(2000), [], 'the 8th character is not shown yet');
  s.shown('r1', 8, 2600);
  assert.deepEqual(words(s.due(2600)), ['tilt']);
  assert.equal(s.dropped, 0);
});

test('read-aloud off, a fast reply: only the first few places in one burst play now, the rest a burst later (2026-11-23: never dropped); beats at one place play together', () => {
  const s = new SpeechBeatSchedule();
  s.begin('r1', 'shown', 0);
  s.add('r1', [{ word: 'look-you', at: 0 }, { word: 'smile-warm', at: 0 }, { word: 'tilt', at: 5 }, { word: 'pout', at: 9 }, { word: 'v', at: 14 }], 0);
  s.shown('r1', 20, 50);
  assert.deepEqual(words(s.due(50)), ['look-you', 'smile-warm', 'tilt'], `keeps ${SPEECH_BEAT_TIMING.burstKeep} places`);
  assert.deepEqual(s.due(50 + SPEECH_BEAT_TIMING.burstWindowMs), [], 'the rest wait for the next burst');
  assert.deepEqual(words(s.due(50 + SPEECH_BEAT_TIMING.burstWindowMs + 1)), ['pout', 'v'], 'and play then');
  assert.equal(s.dropped, 0, 'nothing she wrote is dropped');
});

test('read-aloud on: a beat waits for the reading, not for the bubble; one inside a sentence follows the reading time', () => {
  const s = new SpeechBeatSchedule();
  s.begin('r1', 'voice', 0);
  const text = '今天起得好早。昨晚睡得好吗？';
  s.add('r1', [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 7 }, { word: 'pout', at: 10 }], 0);
  s.text('r1', text);
  s.shown('r1', text.length, 100);
  s.done('r1', text.length, 100);
  assert.deepEqual(s.due(200), [], 'shown but not read yet');
  s.voiced('r1', '今天起得好早。', 500);
  assert.deepEqual(words(s.due(500)), ['smile-warm']);
  s.voiced('r1', '昨晚睡得好吗？', 3000);
  assert.deepEqual(words(s.due(3000)), ['tilt']);
  assert.deepEqual(s.due(3000 + 2 * SPEECH_BEAT_TIMING.voiceMsPerChar), [], 'pout is 3 characters in');
  assert.deepEqual(words(s.due(3000 + 3 * SPEECH_BEAT_TIMING.voiceMsPerChar)), ['pout']);
});

test('read-aloud on but this reply is never read: after the grace it follows the bubble instead', () => {
  const s = new SpeechBeatSchedule();
  s.begin('r1', 'voice', 0);
  s.add('r1', [{ word: 'smile-small', at: 0 }], 0);
  s.text('r1', '好。'); s.shown('r1', 2, 100); s.done('r1', 2, 100);
  assert.deepEqual(s.due(100 + SPEECH_BEAT_TIMING.voiceGraceMs - 1), []);
  assert.equal(s.nextAt(), 100 + SPEECH_BEAT_TIMING.voiceGraceMs);
  assert.deepEqual(words(s.due(100 + SPEECH_BEAT_TIMING.voiceGraceMs)), ['smile-small']);
});

test('performance-only: the beats play in order about 0.6–1.2 s apart, also when the reading is on', () => {
  for (const pacing of ['shown', 'voice'] as const) {
    const s = new SpeechBeatSchedule();
    s.begin('r1', pacing, 0);
    s.add('r1', [{ word: 'shy', at: 0 }, { word: 'hand-cheek', at: 0 }, { word: 'look-down', at: 0 }], 0);
    s.performanceOnly('r1', 1000);
    s.done('r1', 0, 1000); s.shown('r1', 0, 1000);
    const gap = SPEECH_BEAT_TIMING.performanceGapMs;
    assert.ok(gap >= 600 && gap <= 1200);
    assert.deepEqual(words(s.due(1000)), ['shy']);
    assert.deepEqual(s.due(1000 + gap - 1), []);
    assert.deepEqual(words(s.due(1000 + gap)), ['hand-cheek']);
    assert.deepEqual(words(s.due(1000 + 2 * gap)), ['look-down']);
    assert.equal(s.dropped, 0, pacing);
  }
});

test('a new reply, a stop, or a late beat of another reply: what was not played is dropped, never played later', () => {
  const s = new SpeechBeatSchedule();
  s.begin('r1', 'shown', 0);
  s.add('r1', [{ word: 'shy', at: 0 }, { word: 'v', at: 10 }], 0);
  s.shown('r1', 1, 10);
  assert.deepEqual(words(s.due(10)), ['shy']);
  s.begin('r2', 'shown', 20);
  assert.equal(s.dropped, 1, 'r1’s v is dropped');
  s.add('r1', [{ word: 'laugh', at: 0 }], 20);
  s.shown('r1', 50, 30);
  assert.deepEqual(s.due(30), [], 'a late beat of r1 is not taken');
  s.add('r2', [{ word: 'pout', at: 0 }], 40);
  s.cancel('r2');
  s.shown('r2', 5, 50);
  assert.deepEqual(s.due(50), []);
  s.begin('r3', 'shown', 60);
  s.add('r3', [{ word: 'tilt', at: 0 }], 60);
  assert.deepEqual(s.due(60 + SPEECH_BEAT_TIMING.staleMs + 1), [], 'too old: dropped');
});
