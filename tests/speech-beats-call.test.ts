// 边说边演 in a call, the window side and the Unbound side (docs/claude/2026-11-20-speech-beats-leftovers.md). The host side (the call leg's events, the
// persona line, the file) is in tests/i091-call-step4.test.ts. Here: a call's 'beats' event becomes the stream event typed chat already takes, the
// window plays each beat when the call's own reading (fake cues, a fake clock) reaches its sentence, an interruption drops what was not played, the
// control window does not perform, and her Unbound bubble gets the same beats (it performs every word; the old stage only face and gaze).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBeatsView, beatsStreamEvent } from '../src/brain/speech-beats-view';
import { voiceReplyBubbleEvent } from '../electron/unbound/voice-bubble';
import type { SpeechBeatsEvent } from '../shared/behaviors/speech-beats/interface';

function window(companion = true) {
  let now = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  const played: string[] = [];
  const view = new SpeechBeatsView({
    now: () => now, setTimer: (run, ms) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clearTimer: id => { const i = timers.findIndex(timer => timer.id === id); if (i >= 0) timers.splice(i, 1); },
    ...(companion ? { perform: (word: string) => { played.push(word); } } : {}), pacing: () => 'voice', // a call reads aloud
  });
  /** What the chat wiring does with a voice-conversation event (src/wiring/voice-chat-wiring.ts receiveVoiceConversation). */
  const receive = (event: { type: string; replyId: string; speechBeats?: SpeechBeatsEvent }) => { const stream = beatsStreamEvent(event); if (stream) view.receive(stream); };
  const advance = (ms: number) => { const until = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const due = timers[0]; if (!due || due.at > until) break; timers.shift(); now = due.at; due.run(); } now = until; };
  return { view, played, receive, advance };
}

test('beatsStreamEvent: a call\'s beats event is the stream event typed chat takes; nothing else is', () => {
  const speechBeats: SpeechBeatsEvent = { beats: [{ word: 'shy', at: 0 }] };
  assert.deepEqual(beatsStreamEvent({ type: 'beats', replyId: 'r1', speechBeats }), { id: 'r1', kind: 'chat', type: 'beats', text: '', speechBeats });
  for (const bad of [{ type: 'delta', replyId: 'r1', speechBeats }, { type: 'beats', replyId: '', speechBeats }, { type: 'beats', replyId: 'r1' }, { type: 'beats', replyId: 'r1', speechBeats: 'x' }, { type: 'beats', speechBeats }])
    assert.equal(beatsStreamEvent(bad as never), null, JSON.stringify(bad));
});

test('a call: each beat plays when her reading reaches its sentence (not before, not twice); the reading of another reply moves nothing', () => {
  const w = window();
  w.view.begin('r1');
  w.receive({ type: 'beats', replyId: 'r1', speechBeats: { beats: [{ word: 'smile-warm', at: 0 }] } });
  w.view.shown('r1', '好呀，我在。', '好呀，我在。');
  assert.deepEqual(w.played, [], 'the words are on screen, her voice has not reached them');
  w.view.voiced({ kind: 'start', key: 'r1#0', text: '好呀，我在。', voiced: true });
  assert.deepEqual(w.played, ['smile-warm']);
  w.receive({ type: 'beats', replyId: 'r1', speechBeats: { beats: [{ word: 'tilt', at: 6 }] } });
  w.view.shown('r1', '好呀，我在。你慢慢说。', '好呀，我在。你慢慢说。');
  w.view.voiced({ kind: 'start', key: 'other#0', text: '你慢慢说。', voiced: true });
  w.advance(500);
  assert.deepEqual(w.played, ['smile-warm'], 'another reply\'s cue does not move it');
  w.view.voiced({ kind: 'start', key: 'r1#1', text: '你慢慢说。', voiced: true });
  w.view.voiced({ kind: 'start', key: 'r1#1', text: '你慢慢说。', voiced: true });
  assert.deepEqual(w.played, ['smile-warm', 'tilt'], 'once');
});

test('a call interrupted (the user spoke) or stopped: what was not played is dropped, the rest of her reading brings nothing', () => {
  const w = window();
  w.view.begin('r1');
  w.receive({ type: 'beats', replyId: 'r1', speechBeats: { beats: [{ word: 'smile-warm', at: 0 }, { word: 'tilt', at: 6 }] } });
  w.view.shown('r1', '好呀，我在。你慢慢说。', '好呀，我在。你慢慢说。');
  w.view.voiced({ kind: 'start', key: 'r1#0', text: '好呀，我在。', voiced: true });
  w.view.cancel('r1'); // desk:voice-conversation 'cancelled' / an error terminal → the chat wiring's error stream event
  w.view.voiced({ kind: 'start', key: 'r1#1', text: '你慢慢说。', voiced: true });
  w.advance(5000);
  assert.deepEqual(w.played, ['smile-warm']);
  // The next reply starts clean.
  w.view.begin('r2');
  w.receive({ type: 'beats', replyId: 'r2', speechBeats: { beats: [{ word: 'shy', at: 0 }] } });
  w.view.shown('r2', '嗯。', '嗯。');
  w.view.voiced({ kind: 'start', key: 'r2#0', text: '嗯。', voiced: true });
  assert.deepEqual(w.played, ['smile-warm', 'shy']);
});

test('the control window does not perform a call\'s beats; it only keeps the final (the grey line)', () => {
  const w = window(false);
  w.view.begin('r1');
  w.receive({ type: 'beats', replyId: 'r1', speechBeats: { beats: [{ word: 'shy', at: 0 }] } });
  w.receive({ type: 'beats', replyId: 'r1', speechBeats: { final: { performanceOnly: true, line: '（害羞）', history: '' } } });
  w.view.voiced({ kind: 'start', key: 'r1#0', text: '嗯。', voiced: true });
  w.advance(3000);
  assert.deepEqual(w.played, []);
  assert.equal(w.view.performed('r1'), '（害羞）');
});

test('her Unbound bubble gets a call\'s beats as they are (no text); the other voice events stay what they were', () => {
  const speechBeats: SpeechBeatsEvent = { beats: [{ word: 'v', at: 0 }] };
  assert.deepEqual(voiceReplyBubbleEvent('desk:voice-conversation', { type: 'beats', groupId: 'g', replyId: 'r1', speechBeats }), { id: 'r1', kind: 'chat', type: 'beats', text: '', speechBeats });
  assert.equal(voiceReplyBubbleEvent('desk:stream', { type: 'beats', replyId: 'r1', speechBeats }), null, 'only the voice channel');
  assert.equal(voiceReplyBubbleEvent('desk:voice-conversation', { type: 'beats', replyId: 'bad id', speechBeats }), null, 'a reply id of the known shape');
  assert.equal(voiceReplyBubbleEvent('desk:voice-conversation', { type: 'beats', replyId: 'r1' }), null);
  assert.deepEqual(voiceReplyBubbleEvent('desk:voice-conversation', { type: 'delta', replyId: 'r1', text: '好' }), { id: 'r1', kind: 'chat', type: 'delta', text: '好' });
});

test('the wiring: a call\'s beats event is handed to the same receive as typed chat, only for a reply this window started; the host gives the voice host the same turn, switch and file', async () => {
  const { readFile } = await import('node:fs/promises');
  const renderer = await readFile('src/wiring/voice-chat-wiring.ts', 'utf8');
  assert.match(renderer, /if \(event\.type === 'beats'\) \{ const stream = beatsStreamEvent\(event\); if \(stream && voiceReplyIds\.has\(event\.replyId\)\) onStream\(stream\); return; \}/);
  const host = await readFile('electron/wiring/senses-voice-input-wiring.ts', 'utf8');
  assert.match(host, /speechBeats: \{ begin: \(on, send\) => speechBeatsFor\(needs\.store\.directory\)\.begin\(on, send\), enabled: \(\) => gateEnabled\('speechBeats'\),/);
  assert.match(host, /record: \(scope, replyId, outcome\) => \{ void speechBeatsFor\(needs\.store\.directory\)\.archive\.record\(scope as never, replyId, outcome\); \}/);
  const voice = await readFile('src/wiring/voice-wiring.ts', 'utf8');
  assert.match(voice, /onReplySpeechCancelled\(id => \{\n  speechBeats\(\)\.cancel\(id\);/, 'her reading of the reply was cancelled (she was talked over): the beats that were not played are dropped');
});
