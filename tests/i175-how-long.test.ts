/**
 * I-175 step 3 (docs/claude/2026-11-22-i175-part-mixer.md): "how long" in her per-reply markers. 2026-11-21: an action in a reply may also say how long it lasts;
 * plan point 4 as recommended (no suffix = today's behaviour); 11-22: keep what she writes short.
 *  - The stream filter: ⟦pout once⟧ / ⟦smile-warm line⟧ (and the backup brackets) give the word with its "how long"; a suffix split across
 *    chunks at every position; her own ⟦⟧ with an unknown suffix plays the word with the default and never shows; a backup bracket with an
 *    unknown suffix is ordinary text (shown as written, as before). 300 random replies with suffixes: one-shot = streamed, nothing leaks.
 *  - Her history writes the suffix back as she wrote it; the grey line is unchanged.
 *  - The prompt sentence gains one short clause (counted).
 *  - The stages: once = not held; line = held to this sentence's pause (the reading's next segment, or the bubble's next sentence), the
 *    beats held to the reply stay; companion window (SpeechBeatsView → stage) and full-screen (UnboundSpeechBeats).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBeatFilter, describeBeats, filterSpeechBeats, speechBeatSentence } from '../shared/behaviors/speech-beats/choose';
import { SPEECH_BEAT_WORDS } from '../shared/behaviors/speech-beats/interface';
import { speechBeatShownText, withSpeechBeatMarkers } from '../shared/behaviors/speech-beats/history';
import { SpeechBeatsView } from '../src/brain/speech-beats-view';
import { HeldBeats } from '../src/unbound/speech-beat-hold';
import { WindowStageFace } from '../src/unbound/window-mode/window-stage-face';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { REST_TARGETS } from '../src/unbound/motion/generator';

const leaks = (text: string) => /[⟦⟧]/u.test(text) || /\b(once|line|forever|soon)\b/u.test(text) || SPEECH_BEAT_WORDS.some(word => text.includes(word));
const streamed = (chunks: readonly string[]) => { const f = new SpeechBeatFilter(); const text = chunks.map(c => f.push(c).text).join('') + f.end().text; return { text, summary: f.summary() }; };

test('the suffix: once / line in every bracket; unknown in her own plays the default and never shows; unknown in a backup bracket is text', () => {
  const s = filterSpeechBeats('⟦pout once⟧哼。⟦smile-warm line⟧好吧。【shy once】嗯〖tilt line〗[[look-you once]]。[content warning]⟦laugh forever⟧哈');
  assert.equal(s.text, '哼。好吧。嗯。[content warning]哈');
  assert.deepEqual(s.beats, [{ word: 'pout', at: 0, how: 'once' }, { word: 'smile-warm', at: 2, how: 'line' }, { word: 'shy', at: 5, how: 'once' }, { word: 'tilt', at: 6, how: 'line' },
    { word: 'look-you', at: 6, how: 'once' }, { word: 'laugh', at: 24 }], 'an unknown suffix in her own bracket: the word with the default');
  assert.equal(filterSpeechBeats('【pout forever】').text, '【pout forever】', 'a backup bracket with an unknown suffix is not her marker (shown, as before)');
  assert.equal(filterSpeechBeats('⟦POUT  Once⟧哼').beats[0].how, 'once', 'case and spaces do not matter');
  assert.deepEqual(filterSpeechBeats('⟦pout⟧哼').beats, [{ word: 'pout', at: 0 }], 'no suffix: no field (today\'s beat)');
  assert.equal(filterSpeechBeats('⟦pout once line⟧哼').text, '哼', 'two suffixes: the word plays, nothing shows');
  assert.equal(filterSpeechBeats('⟦once⟧哼').text, '哼', 'a suffix alone is a broken marker: dropped, never shown');
});

test('a suffix split across chunks at every position, in every bracket, never leaks and gives the same beats as one piece', () => {
  for (const reply of ['⟦pout once⟧哼。⟦smile-warm line⟧好吧', '先【look-away-right once】看〖blink-slow line〗嗯', '[[smile-small line]]你看⟦v forever⟧耶']) {
    const whole = filterSpeechBeats(reply);
    assert.ok(!leaks(whole.text), whole.text);
    const chars = Array.from(reply);
    for (let cut = 1; cut < chars.length; cut++) for (let cut2 = cut + 1; cut2 <= chars.length; cut2 += 3) {
      const got = streamed([chars.slice(0, cut).join(''), chars.slice(cut, cut2).join(''), chars.slice(cut2).join('')]);
      assert.equal(got.text, whole.text, `${reply} cut at ${cut}/${cut2}`);
      assert.deepEqual(got.summary.beats, whole.beats);
    }
    const byChar = streamed(chars);
    assert.equal(byChar.text, whole.text);
    assert.deepEqual(byChar.summary.beats, whole.beats);
  }
});

test('300 random replies with suffixes: streamed = one piece, no marker, word or suffix ever reaches the text', () => {
  let seed = 175;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const brackets: [string, string][] = [['⟦', '⟧'], ['【', '】'], ['〖', '〗'], ['[', ']'], ['[[', ']]']];
  for (let n = 0; n < 300; n++) {
    let reply = '';
    for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) {
      const [open, close] = pick(brackets), suffix = pick(['', ' once', ' line', ...(open === '⟦' ? [' forever', ' soon'] : [])]);
      reply += open + pick(SPEECH_BEAT_WORDS) + suffix + close + pick(['好呀。', '嗯', '今天真好！', '你呢？', '']);
    }
    const whole = filterSpeechBeats(reply);
    assert.ok(!leaks(whole.text), `leak: ${reply} → ${whole.text}`);
    const chars = Array.from(reply), chunks: string[] = [];
    for (let at = 0; at < chars.length;) { const len = 1 + Math.floor(rnd() * 5); chunks.push(chars.slice(at, at + len).join('')); at += len; }
    const got = streamed(chunks);
    assert.equal(got.text, whole.text, reply);
    assert.deepEqual(got.summary.beats, whole.beats, reply);
  }
});

test('her history writes the suffix back as she wrote it, round-trips, and shows nothing; the grey line is unchanged', () => {
  const s = filterSpeechBeats('⟦pout once⟧哼。⟦smile-warm line⟧好吧。⟦tilt⟧');
  const history = withSpeechBeatMarkers(s.text, s.beats);
  assert.equal(history, '⟦pout once⟧哼。⟦smile-warm line⟧好吧。⟦tilt⟧');
  assert.deepEqual(filterSpeechBeats(history).beats, s.beats, 'reading her history back gives the same beats');
  assert.equal(speechBeatShownText(history).text, '哼。好吧。');
  assert.equal(withSpeechBeatMarkers('哼', [{ word: 'pout', at: 0, how: 'never' as never }]), '⟦pout⟧哼', 'a how outside the closed list is not written');
  const performed = filterSpeechBeats('⟦shy once⟧⟦hand-cheek line⟧');
  assert.equal(describeBeats(performed.beats), '（害羞地笑了，手放到脸边）');
  assert.deepEqual(speechBeatShownText('⟦shy once⟧⟦hand-cheek line⟧'), { text: '', performed: '（害羞地笑了，手放到脸边）' });
});

test('the prompt sentence: one short clause about once / line (≤ 40 Chinese characters added), the call form too', () => {
  const sentence = speechBeatSentence(), call = speechBeatSentence(undefined, true);
  const clause = '；后面加 once 只做一下、加 line 只带这一句，如⟦pout once⟧';
  for (const text of [sentence, call]) assert.ok(text.includes(clause) && text.includes('⟦tilt⟧'), 'the clause and the old marker shape');
  const han = (text: string) => (text.match(/\p{Script=Han}/gu) ?? []).length;
  assert.ok(han(clause) <= 40, `${han(clause)} Chinese characters added`);
  const before = sentence.replace(clause, '');
  console.log(`prompt sentence: ${Array.from(before).length} → ${Array.from(sentence).length} characters (+${Array.from(clause).length}; Chinese +${han(clause)})`);
});

// ---- the stages ------------------------------------------------------------------------------------------------------------------
function view(pacing: 'voice' | 'shown') {
  let now = 0;
  const log: string[] = [], timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  const v = new SpeechBeatsView({ now: () => now, setTimer: (run, ms) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clearTimer: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    perform: (word, span) => { log.push(`${word}:${String(span)}`); }, release: reason => { log.push(`release:${reason}`); }, pacing: () => pacing });
  const advance = (ms: number) => { const until = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const due = timers[0]; if (!due || due.at > until) break; timers.shift(); now = due.at; due.run(); } now = until; };
  return { v, log, advance };
}

test('companion window, read-aloud off: once is not held, line falls when the next sentence shows, no suffix holds to the end as before', () => {
  const { v, log, advance } = view('shown');
  const full = '今天起得好早。昨晚睡得好吗？还行。';
  v.begin('r');
  v.receive({ id: 'r', kind: 'chat', type: 'beats', text: '', speechBeats: { beats: [{ word: 'smile-warm', at: 0, how: 'line' }, { word: 'tilt', at: 0, how: 'once' }, { word: 'look-you', at: 7 }] } });
  v.shown('r', '今天', full); advance(10);
  assert.deepEqual(log, ['release:new', 'smile-warm:line', 'tilt:false'], 'line → held to the line; once → not held');
  v.shown('r', '今天起得好早。', full); advance(10);
  assert.ok(!log.includes('release:line'), 'the sentence just ended: still up');
  v.shown('r', '今天起得好早。昨', full); advance(10);
  assert.deepEqual(log.slice(3), ['look-you:true', 'release:line'], 'the next sentence shows: the line falls; the beat without a suffix rides the reply as today');
});

test('companion window, read-aloud on: a line falls when the reading starts the next segment', () => {
  const { v, log, advance } = view('voice');
  const full = '今天起得好早。昨晚睡得好吗？';
  v.begin('r');
  v.receive({ id: 'r', kind: 'chat', type: 'beats', text: '', speechBeats: { beats: [{ word: 'pout', at: 0, how: 'line' }] } });
  v.shown('r', full, full);
  v.voiced({ kind: 'start', key: 'r#0', text: '今天起得好早。', voiced: true }); advance(10);
  assert.deepEqual(log, ['release:new', 'pout:line']);
  v.voiced({ kind: 'start', key: 'r#1', text: '昨晚睡得好吗？', voiced: true }); advance(10);
  assert.deepEqual(log.slice(2), ['release:line']);
});

test('the window stage: a line release lets only the line\'s beats fall and drops nothing waiting; HeldBeats keeps the reply\'s beats', () => {
  const calls: string[] = [];
  const fake = { motions: { dropWaitingMouth: () => calls.push('drop') }, face: { speechBeatsRelease: () => calls.push('all'), speechBeatsLine: () => calls.push('line') } };
  (WindowStageFace.prototype.speechBeatsRelease as (this: unknown, r: string) => void).call(fake, 'line');
  assert.deepEqual(calls, ['line']);
  const held = new HeldBeats();
  const smile = { playedAt: 0, dur: 2.2 } as never as { playedAt: number; dur: number }, look = { playedAt: 0, dur: 1.3 } as never as { playedAt: number; dur: number };
  held.hold('smile-warm', smile as never, 0, 'line');
  held.hold('look-you', look as never, 0, true);
  held.releaseLine(1.5);
  assert.equal(smile.dur, 1.5, 'the line\'s smile falls from now');
  assert.equal(look.dur, 12, 'the look held to the reply stays up (the cap)');
  assert.equal(held.any, true);
});

test('full-screen: a line beat falls when the bubble shows the next sentence; once is its own short time', () => {
  const beats = new UnboundSpeechBeats(new ProceduralGenerator());
  const body = { sense: null, setPoseTargets() {} };
  const lens = { camera: { x: 0, y: 1.4, z: 2 }, axis: { x: 0, y: 0, z: -1 } };
  beats.receive({ id: 'r', type: 'beats', text: '', speechBeats: { beats: [{ word: 'smile-warm', at: 0, how: 'line' }] } } as never);
  beats.receive({ id: 'r', type: 'delta', text: '今天起得好早。' } as never);
  for (let k = 0; k < 30; k++) beats.frame(1 / 60, lens, { x: 0, z: 0 }, body, true);
  const performer = (beats as unknown as { performer: { beats?: unknown } | null; held: HeldBeats }).held;
  assert.equal(performer.any, true, 'held while her first sentence shows');
  beats.receive({ id: 'r', type: 'delta', text: '昨' } as never);
  beats.frame(1 / 60, lens, { x: 0, z: 0 }, body, true);
  assert.equal((beats as unknown as { held: HeldBeats }).held.any, false, 'the next sentence shows: the line falls');
  void REST_TARGETS;
});
