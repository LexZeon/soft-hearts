// I-174 item 3 (docs/claude/2026-11-21-i174-parity-fixes.md): her own lines are hard to interrupt too. A press, a touch, typing or her mood
// leaving 'idle' no longer end a line she is saying or showing; a message, the stop button, a clear sentence or her surface going away do.
// Evidence: dev journal 05:43:10.6Z, a 70-character line of hers cancelled with no message from you, touch clicks around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { ownLineYields, type OwnLineCause } from '../shared/behaviors/interrupt/own-line';
import { ProactiveSpeechGate } from '../electron/initiative/proactive-speech-gate';
import { InnerLoop, type InnerLoopMessage } from '../electron/initiative/inner-loop/inner-loop';
import { DEFAULT_MOOD_PARAMETERS, type MoodCue } from '../shared/foundation/mood';
import { WIRING_PRELUDE, wiringFunction } from './helpers/wiring-source';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('ownLineYields: only a clear intent ends a line she is saying', () => {
  const yields: Record<OwnLineCause, boolean> = { input: false, touch: false, mood: false, message: true, stop: true, sentence: true, surface: true };
  for (const [cause, expected] of Object.entries(yields)) assert.equal(ownLineYields(cause as OwnLineCause), expected, cause);
});

/** The host's two wiring functions as the wiring has them (electron/wiring/senses-look-wiring.ts, electron/wiring/initiative-wiring.ts). */
function host() {
  const calls: string[] = [];
  const env = {
    ownLineYields, Date, userInputUntil: 0, visionGeneration: 0, visualSelfRuntime: { cancelActive: () => calls.push('visual self') },
    cancelAmbientPlayback: () => calls.push('ambient playback stopped'), ambientComments: { interrupt: () => calls.push('ambient pending dropped') },
    syncFatigueActivity: () => {}, textMemorialHost: null, hands: { host: { cancel() {} } }, give: { host: { cancel() {} } }, r20ProactiveOffers: null,
    visionPresentation: { clear: () => calls.push('presentation cleared') }, speechRuntime: { cancelReply: (_o: number, id: string) => calls.push(`line ${id} cut`) },
    proactiveVision: { cancel: () => calls.push('look cancelled') }, cameraSamples: { cancel() {} },
    cancelReplyStyle: () => {}, broadcast: (channel: string) => calls.push(channel), proactiveSpeechGate: { cancel: () => calls.push('pending line dropped') },
  };
  const body = `let lastVisionSpeech = { owner: 7, id: 'her-line', guard: { canSpeak: () => true } };\n${wiringFunction('cancelProactiveVision')}\n${wiringFunction('noteVisionUserActivity')}\nreturn { note: noteVisionUserActivity };`;
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const api = new Function(...Object.keys(env), code)(...Object.values(env)) as { note(cause?: OwnLineCause): void };
  return { api, calls };
}

test('the host: a press, a touch or her mood moving keep the line she is saying (new things still wait); a message ends it', () => {
  for (const cause of [undefined, 'input', 'touch', 'mood'] as const) {
    const h = host(); h.api.note(cause);
    assert.ok(!h.calls.includes('line her-line cut') && !h.calls.includes('desk:vision-initiative'), `${cause}: her line goes on (before: cut)`);
    assert.ok(!h.calls.includes('ambient playback stopped'), `${cause}: a comment she is reading goes on`);
    assert.ok(h.calls.includes('pending line dropped') && h.calls.includes('look cancelled'), `${cause}: what has not started yet still waits for you`);
  }
  const h = host(); h.api.note('message');
  assert.ok(h.calls.includes('line her-line cut') && h.calls.includes('desk:vision-initiative'), 'a new message of yours: her line ends');
});

test('the inner loop: once her line is offered, a touch (input, mood not idle) does not cancel it; before it is offered it still waits', async () => {
  const state = { now: 1_000_000, current: true, holds: true };
  const gate = new ProactiveSpeechGate(() => state.now); gate.setScope('scope');
  const offered: InnerLoopMessage[] = [], records: string[] = [];
  const loop = new InnerLoop({ gate, clock: () => state.now, createId: () => 'line-1', enabled: () => true, canStart: () => true,
    current: () => state.current, holds: () => state.holds, scope: () => ({ characterId: 'gene', gateScope: 'scope' }), parameters: () => DEFAULT_MOOD_PARAMETERS,
    quiet: () => ({ asleep: false, drowsy: false, night: false, quiet: false }), prompt: () => 'prompt',
    decide: async () => ({ text: '{"action":"speak","text":"你刚才是不是戳了我一下？"}' }), realize: () => {}, releaseSpeech: () => {},
    offer: message => { offered.push(message); }, present: async () => true, presentationCurrent: () => true, cancelOffer: () => {},
    archive: async () => {}, record: entry => { records.push(entry.result); } });
  const cue: MoodCue = { id: 'touch-cue', kind: 'speech', at: state.now, until: state.now + 3_000 };
  assert.equal(loop.offerOpportunity(cue), true); await flush();
  assert.equal(offered.length, 1, 'her line is offered (her bubble is up)');
  state.current = false; // you touched her: input just now, her mood 'touched'
  loop.sweep();
  assert.deepEqual(records, [], 'not cancelled (before: cancelled by the touch)');
  assert.equal(await loop.ack('touch-cue'), true, 'she says it');
  assert.deepEqual(records, ['delivered']);
  loop.dispose(); gate.dispose();
});
