// 边说边演：回复开头标记开着时（app 默认开，electron/brain/reply-opening.ts 的 REPLY_OPENING_ENABLED），只演不说要按"真正显示出来的字"判断，
// 不能按原始流（原始流里有 <sh-open> 的字母）。用真的 SpeechBeatTurn 接真的 MoodReplyProtocol（和 companion.begin 里同样的接法），流是假的。
// docs/claude/2026-11-20-speech-beats-leftovers.md「开头标记」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { SpeechBeatTurn } from '../electron/brain/speech-beats/turn';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';

const TAIL = (p: MoodReplyProtocol) => `${p.start}{"context":"positive","delta":{"O":1},"reason":"x","confidence":0.8,"gesture":"upbeat"}${p.end}`;
const chunked = (text: string, size: number) => { const out: string[] = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
const leaks = (text: string) => /[⟦⟧]|sh-open|sh-state/u.test(text) || /\b(?:shy|tilt|hand-cheek|smile-warm)\b/u.test(text);

function run(on: boolean, opening: false | 'fixed' | 'turn', raw: (p: MoodReplyProtocol) => string, size: number) {
  const events: SpeechBeatsEvent[] = [];
  const turn = new SpeechBeatTurn(on, event => events.push(event));
  const shown: string[] = [];
  const protocol = new MoodReplyProtocol(text => { if (!text) return; turn.shown(text); shown.push(text); }, { chineseChat: true, ...(opening ? { opening } : {}), userText: '你好' });
  const push = turn.input<'delta'>((_type, text) => protocol.push(text));
  for (const piece of chunked(raw(protocol), size)) push('delta', piece);
  turn.end(push);
  protocol.finish(true);
  const text = shown.join('');
  const outcome = turn.complete(text);
  return { text, outcome, events };
}

for (const on of [true, false]) for (const opening of ['fixed', 'turn', false] as const) for (const size of [1, 3, 1000]) {
  test(`only markers after the opening marker is performance-only (beats ${on ? 'on' : 'off'}, opening ${opening}, chunks ${size})`, () => {
    const marker = (p: MoodReplyProtocol) => opening === 'fixed' ? '<sh-open>' : opening === 'turn' ? p.open : '';
    const { text, outcome, events } = run(on, opening, p => `${marker(p)}⟦shy⟧⟦hand-cheek⟧${TAIL(p)}`, size);
    assert.equal(text, '', 'no bubble text, nothing read, nothing archived');
    assert.equal(outcome.performanceOnly, true, 'it is a performance-only reply');
    assert.equal(outcome.line, '（害羞地笑了，手放到脸边）', 'the grey line');
    assert.deepEqual(outcome.beats.map(beat => beat.word), ['shy', 'hand-cheek']);
    assert.equal(outcome.history, on ? '⟦shy⟧⟦hand-cheek⟧' : null);
    for (const event of events) assert.ok(!leaks(JSON.stringify(event.final?.line ?? '')), 'no marker in the grey line');
    assert.equal(events.at(-1)?.final?.performanceOnly, true);
  });
}

test('a reply with words after the opening marker is not performance-only, and no marker letters reach what is shown', () => {
  for (const size of [1, 4, 1000]) {
    const { text, outcome } = run(true, 'fixed', p => `<sh-open>⟦shy⟧哎呀，被你夸得不好意思了。${TAIL(p)}`, size);
    assert.equal(text, '哎呀，被你夸得不好意思了。');
    assert.equal(outcome.performanceOnly, false);
    assert.equal(outcome.line, '');
    assert.ok(!leaks(text));
  }
});

test('a drafted plan before the marker is never shown, and the words after it decide', () => {
  const { text, outcome } = run(true, 'fixed', p => `这一句先接住他的夸奖，语气软一点。<sh-open>⟦shy⟧哎呀，不好意思。${TAIL(p)}`, 2);
  assert.equal(text, '哎呀，不好意思。');
  assert.equal(outcome.performanceOnly, false);
  assert.ok(!leaks(text));
});
