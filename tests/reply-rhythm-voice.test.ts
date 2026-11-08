// F7 说话节奏 and the voice: the developer listening trial's silence (0 by default, never before the first sentence; 兜底（待定）), and R29:
// bubble pacing only moves *when* a later sentence may start speaking, never how the mouth moves. Measured with the stage's own
// frame loop (60 Hz, the same damp as MmdStage's lip sync) for the three pacings and the trial.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment } from '../shared/tts';
import { VoiceOutput } from '../src/ui/VoiceOutput';
import { SpeechOutput } from '../src/ui/speech';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { ReplyPresentationState, type ReadoutClock } from '../src/ui/reply-presentation';
import { damp } from '../src/stage/procedural';
import { flush } from './helpers/r02-audio-world';
import { pausableEngine } from './helpers/feed-pause-audio';

function systemReply(t: TestContext) {
  const e = pausableEngine(t), waits: number[] = [];
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { assert.fail('no cloud request'); }, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking: () => {}, onError: message => assert.fail(message), now: e.now,
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
    wait: async ms => { waits.push(ms); },
  });
  t.after(() => output.dispose());
  return { e, voice, output, waits };
}
async function speak(r: ReturnType<typeof systemReply>, gaps: (number | undefined)[]) {
  const pieces: ApprovedReplySpeechSegment[] = gaps.map((gap, index) => ({ replyId: 'r', index, text: `第${index + 1}句。`, visibleText: '',
    context: { replyId: 'r', segmentIndex: index }, ...(gap === undefined ? {} : { pauseBeforeMs: gap }) }));
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completedIndex) { return pieces[completedIndex === undefined ? 0 : completedIndex + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one owner'), () => true, id => r.output.openReply({ ...r.voice }, id));
  const done = queue.speak('r');
  for (let index = 0; index < pieces.length; index++) {
    await flush(); await r.e.advance(1); await flush();
    const utterance = r.e.queued[index];
    assert.ok(utterance, `sentence ${index + 1} was spoken`);
    r.e.start(utterance); await flush(); r.e.end(utterance);
  }
  await done;
}

test('the listening trial: no silence by default; with it, only before later sentences, as frozen by the host', async t => {
  const off = systemReply(t);
  await speak(off, [undefined, undefined, undefined]);
  assert.deepEqual(off.waits, [], 'default: the voice is exactly as before');
  assert.equal(off.e.queued.length, 3);
  const on = systemReply(t);
  await speak(on, [undefined, 200, 200]);
  assert.deepEqual(on.waits, [200, 200]);
  const odd = systemReply(t);
  await speak(odd, [undefined, 5_000, Number.NaN]);
  assert.deepEqual(odd.waits, [1_000], 'held to 1 s; a bad value is no silence');
});

// ---------------------------------------------------------------- R29: the mouth across pacings (frame loop)

function fakeClock() {
  let now = 0, next = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ReadoutClock = { now: () => now, set: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; }, clear: id => { timers.delete(id as unknown as number); } };
  return { clock, get now() { return now; },
    advance(ms: number) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn(); } now = end; } };
}
const REPLY = ['今天也辛苦啦。', '我一直在这儿等你呢……其实有点想你。', '晚饭吃了吗？', '对了，明天降温，记得多穿一件。', '早点休息，好不好？'];
/** When each bubble appears with this pace (a reply streamed at ~40 characters a second). */
function bubbleTimes(multiplier: number | null): number[] {
  const time = fakeClock(), s = new ReplyPresentationState(time.clock, undefined, { rhythmFallback: multiplier !== null }), shown: number[] = [];
  const raw = REPLY.join(''), ends = REPLY.map((_, i) => REPLY.slice(0, i + 1).join('').length);
  s.begin('r'); if (multiplier !== null) s.setRhythm('r', { multiplier }); s.startReadout('r', prefix => {
    for (const end of ends) if (prefix.length >= end && shown.length < ends.indexOf(end) + 1) shown.push(time.now);
  });
  for (let at = 1; at <= raw.length; at++) { s.readoutContent('r', raw.slice(0, at)); time.advance(25); }
  s.finishReadout('r', () => {}); time.advance(20_000);
  return shown;
}
/** Speaking spans: sentence k starts once its bubble is shown and sentence k−1 has ended (the host's display proof), plus the trial gap. */
function speakingSpans(shown: number[], gapMs: number): Array<[number, number]> {
  const spans: Array<[number, number]> = []; let free = 0;
  REPLY.forEach((sentence, i) => {
    const start = Math.max(shown[i], free + (i > 0 ? gapMs : 0)), end = start + Array.from(sentence).length * 180;
    spans.push([start, end]); free = end;
  });
  return spans;
}
/** MmdStage's lip sync on its fixed 60 Hz clock: the largest change of the mouth between two frames. */
function maxMouthStep(spans: Array<[number, number]>): { step: number; frames: number } {
  const dt = 1 / 60, end = spans.at(-1)![1] / 1000 + 1;
  let mouth = 0, step = 0, frames = 0;
  for (let t = 0; t < end; t += dt, frames++) {
    const ms = t * 1000, speaking = spans.some(([a, b]) => ms >= a && ms < b);
    const target = speaking ? 0.23 + Math.abs(Math.sin(t * 12)) * 0.45 : 0;
    const next = damp(mouth, target, 16, dt);
    step = Math.max(step, Math.abs(next - mouth)); mouth = next;
  }
  return { step, frames };
}

test('R29: pacing the bubbles never makes the mouth jump (60 Hz frame loop: R27, and the fallback at both ends of its range, with the trial)', t => {
  // The bound of the stage's own smoothing: one frame moves at most (1 − e^(−16/60)) of the largest possible gap (0.68).
  const bound = (1 - Math.exp(-16 / 60)) * 0.68;
  const results: Record<string, number> = {};
  // 默认 = R27 as confirmed; the others turn on the 兜底（待定） pacing at the ends of its range.
  for (const [name, multiplier, gap] of [['默认（R27）', null, 0], ['兜底·原样', 1, 0], ['兜底·只放快', 0.85, 0], ['兜底·只放慢', 1.15, 0], ['兜底·只放慢+试听停顿', 1.15, 200]] as const) {
    const shown = bubbleTimes(multiplier);
    assert.equal(shown.length, REPLY.length);
    assert.equal(shown[0], bubbleTimes(null)[0], `${name}: the first bubble appears at the same moment`);
    const { step, frames } = maxMouthStep(speakingSpans(shown, gap));
    assert.ok(frames > 60);
    assert.ok(step <= bound + 1e-9, `${name}: ${step} per frame`);
    results[name] = Math.round(step * 1000) / 1000;
    t.diagnostic(`${name}: bubbles at ${shown.join(' / ')} ms; mouth step ≤ ${results[name]} per frame (bound ${Math.round(bound * 1000) / 1000})`);
  }
  // Same largest step everywhere: the pace moves when a sentence starts, never how the mouth gets there.
  const values = Object.values(results);
  assert.ok(Math.max(...values) - Math.min(...values) <= 0.02, JSON.stringify(results));
});
