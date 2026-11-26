// 边说边演第 3 步，窗口这边（src/brain/speech-beats-view.ts）：拍子按顺序、在对的进度交给舞台（假时钟、假定时器）；
// 只演不说按间隔演；新回复、停止、出错时没演的作废；聊天页的灰色小字和她历史里的字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBeatsView } from '../src/brain/speech-beats-view';
import { SPEECH_BEAT_TIMING } from '../shared/behaviors/speech-beats/knobs';
import type { StreamEvent } from '../shared/brain/stream-event';

function world(pacing: 'voice' | 'shown' = 'shown', companion = true) {
  let now = 0;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  const played: { word: string; at: number }[] = [];
  const view = new SpeechBeatsView({
    now: () => now,
    setTimer: (run, ms) => { const id = next++; timers.push({ at: now + ms, run, id }); return id; },
    clearTimer: id => { const i = timers.findIndex(timer => timer.id === id); if (i >= 0) timers.splice(i, 1); },
    ...(companion ? { perform: (word: string) => { played.push({ word, at: now }); } } : {}),
    pacing: () => pacing,
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > until) break;
      timers.shift(); now = due.at; due.run();
    }
    now = until;
  };
  const beats = (id: string, list: { word: string; at: number }[]): StreamEvent => ({ id, kind: 'chat', type: 'beats', text: '', speechBeats: { beats: list as never } });
  const final = (id: string, value: { performanceOnly: boolean; line: string; history: string | null }): StreamEvent => ({ id, kind: 'chat', type: 'beats', text: '', speechBeats: { final: value } });
  return { view, played, advance, beats, final, words: () => played.map(play => play.word), now: () => now };
}

test('read-aloud off: beats reach the stage in order as the bubble shows their sentences', () => {
  const w = world('shown');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'smile-warm', at: 0 }]));
  assert.deepEqual(w.words(), [], 'nothing shown yet');
  w.view.shown('r1', '今', '今天起得好早。');
  assert.deepEqual(w.words(), ['smile-warm']);
  w.view.receive(w.beats('r1', [{ word: 'tilt', at: 7 }]));
  w.advance(2000);
  w.view.shown('r1', '今天起得好早。', '今天起得好早。昨晚睡得好吗？');
  assert.deepEqual(w.words(), ['smile-warm'], 'the second sentence is not shown yet');
  w.view.shown('r1', '今天起得好早。昨', '今天起得好早。昨晚睡得好吗？');
  assert.deepEqual(w.words(), ['smile-warm', 'tilt']);
});

test('read-aloud on: a beat waits for the reading of its sentence (the voice output’s cue), not the bubble', () => {
  const w = world('voice');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'smile-warm', at: 0 }, { word: 'pout', at: 7 }]));
  w.view.shown('r1', '今天起得好早。才没有呢。', '今天起得好早。才没有呢。');
  w.view.done('r1', 12);
  assert.deepEqual(w.words(), []);
  w.view.voiced({ kind: 'start', key: 'r1#0', text: '今天起得好早。', voiced: true });
  assert.deepEqual(w.words(), ['smile-warm']);
  w.view.voiced({ kind: 'start', key: 'other#0', text: '才没有呢。', voiced: true });
  w.view.voiced({ kind: 'start', key: 'r1#shown', text: '才没有呢。', voiced: false });
  assert.deepEqual(w.words(), ['smile-warm'], 'another reply’s cue and the bubble’s own cue do not move it');
  w.advance(1500);
  w.view.voiced({ kind: 'start', key: 'r1#1', text: '才没有呢。', voiced: true });
  assert.deepEqual(w.words(), ['smile-warm', 'pout']);
});

test('performance-only: the beats play in order about 0.6–1.2 s apart, on timers', () => {
  const w = world('voice');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'shy', at: 0 }, { word: 'hand-cheek', at: 0 }]));
  w.view.receive(w.final('r1', { performanceOnly: true, line: '（害羞地笑了，手放到脸边）', history: '⟦shy⟧⟦hand-cheek⟧' }));
  w.view.done('r1', 0);
  assert.deepEqual(w.words(), ['shy']);
  w.advance(SPEECH_BEAT_TIMING.performanceGapMs);
  assert.deepEqual(w.played, [{ word: 'shy', at: 0 }, { word: 'hand-cheek', at: SPEECH_BEAT_TIMING.performanceGapMs }]);
  assert.equal(w.view.performed('r1'), '（害羞地笑了，手放到脸边）');
  assert.equal(w.view.historyText('r1', ''), '⟦shy⟧⟦hand-cheek⟧');
});

test('a new reply, a stop or an error drops what did not play; a late event of an old reply is never performed', () => {
  const w = world('shown');
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'shy', at: 0 }, { word: 'v', at: 3 }]));
  w.view.receive(w.final('r1', { performanceOnly: true, line: 'x', history: null }));
  assert.deepEqual(w.words(), ['shy']);
  w.view.begin('r2');
  w.advance(5000);
  assert.deepEqual(w.words(), ['shy'], 'r1’s second beat is dropped by r2');
  w.view.receive(w.beats('r1', [{ word: 'laugh', at: 0 }]));
  w.view.shown('r1', '哈哈', '哈哈');
  assert.deepEqual(w.words(), ['shy'], 'late beats of r1');
  w.view.receive(w.beats('r2', [{ word: 'pout', at: 2 }]));
  w.view.cancel();
  w.view.shown('r2', '才没有', '才没有');
  w.view.begin('r3');
  w.view.receive(w.beats('r3', [{ word: 'tilt', at: 1 }]));
  w.view.cancel('r3');
  w.view.shown('r3', '好呀', '好呀');
  assert.deepEqual(w.words(), ['shy']);
});

test('the control window keeps the grey line and her history words, and performs nothing', () => {
  const w = world('shown', false);
  w.view.begin('r1');
  w.view.receive(w.beats('r1', [{ word: 'smile-warm', at: 0 }]));
  w.view.shown('r1', '早', '早');
  w.view.receive(w.final('r1', { performanceOnly: false, line: '', history: '⟦smile-warm⟧早' }));
  assert.deepEqual(w.played, []);
  assert.equal(w.view.historyText('r1', '早'), '⟦smile-warm⟧早');
  assert.equal(w.view.performed('r1'), null);
  assert.equal(w.view.historyText('no-final', '原样'), '原样', 'no final: the reply as shown');
  w.view.receive(w.final('r2', { performanceOnly: true, line: '（害羞地笑了）', history: null }));
  assert.equal(w.view.historyText('r2', ''), '', 'off: a performance-only turn stays out of her history');
  assert.equal(w.view.performed('r2'), '（害羞地笑了）');
});
