// Three coverage gaps in the voice wiring that the 4b mutation check found (docs/claude/2026-11-16-wiring-step-4b.md "留下的" 3;
// docs/claude/2026-11-16-wiring-test-gaps.md). Each test evaluates the real function or handler text from electron/wiring/voice-wiring.ts
// (through tests/helpers/wiring-source.ts) against small stand-ins, and fails when its one check is removed.
// Reads as text (test-affected selects this test through the helper): 'electron/main.ts', 'electron/wiring/voice-wiring.ts'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { wiringFunction, wiringHandler } from './helpers/wiring-source';

const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const evaluate = (code: string, env: Record<string, unknown>) => new Function(...Object.keys(env), compile(code))(...Object.values(env));
const SEGMENT = { replyId: 'reply', index: 0, visibleText: 'a' };

// (a) Switching character clears the reply speech: the sentence being read is cancelled too, not only the plan forgotten.
test('clearReplySpeech cancels the sentence being read, then clears the plan and the styles', () => {
  const calls: string[] = [];
  const completedReplySpeech = {
    identity: () => ({ owner: 8, id: 'reply' }),
    cancel: (owner: number, id: string) => calls.push(`plan.cancel ${owner} ${id}`),
    cancelReply: () => calls.push('plan.cancelReply'),
    clear: () => calls.push('plan.clear'),
  };
  const speechRuntime = { cancelReply: (owner: number, id: string) => calls.push(`runtime.cancelReply ${owner} ${id}`) };
  const replySpeechStyles = { cancel: (id: string) => calls.push(`styles.cancel ${id}`), clear: () => calls.push('styles.clear') };
  const win = { webContents: { send: (channel: string, id: string) => calls.push(`send ${channel} ${id}`) } };
  const clear = evaluate(`${wiringFunction('cancelCompletedReply')}\n${wiringFunction('clearReplySpeech')}\nreturn clearReplySpeech;`,
    { completedReplySpeech, speechRuntime, replySpeechStyles, windows: () => [win], suspendAmbientSpeech: () => calls.push('suspend') }) as () => void;
  clear();
  assert.ok(calls.includes('runtime.cancelReply 8 reply'), 'the speech runtime is told to stop the sentence being read: ' + calls.join(' | '));
  assert.ok(calls.includes('plan.cancel 8 reply'));
  assert.ok(calls.includes('send desk:reply-speech-cancelled reply'), 'the windows are told it was cancelled');
  assert.ok(calls.includes('plan.clear') && calls.includes('styles.clear'));
  assert.ok(calls.indexOf('runtime.cancelReply 8 reply') < calls.indexOf('plan.clear'), 'cancelled before the plan is forgotten');
});

// (b) An ordinary (not prefix) segment is synthesised only after the reply bubble was confirmed shown.
function synthesizeFixture(shown: boolean) {
  const calls: string[] = [];
  const completedReplySpeech = {
    isOrdinary: () => true, approvedSegment: () => SEGMENT, prefixMode: () => false, fullPresentationText: () => 'full text',
    authorizeCloud: () => calls.push('authorizeCloud'),
  };
  const speechRuntime = { speak: async () => { calls.push('speak'); } };
  const env = { store: { current: { voice: { enabled: true } } }, textMemorialHost: null, completedReplySpeech, speechScope: () => 'scope', petReply: { isPresentationCurrent: () => shown },
    speechRuntime, syncFatigueActivity: () => {}, cancelCompletedReply: () => {}, withCompletedPrefixProof: async () => false };
  const synth = evaluate(`return (${wiringHandler('synthesizeSpeech')});`, env) as (sender: number, id: string, text: string, context: unknown) => Promise<void>;
  return { calls, synth };
}
test('an ordinary segment is not synthesised until the reply bubble was confirmed shown', async () => {
  const hidden = synthesizeFixture(false);
  await assert.rejects(hidden.synth(8, 'id', 'text', { replyId: 'reply', segmentIndex: 0 }), /尚未确认显示/);
  assert.deepEqual(hidden.calls, [], 'no cloud authorisation and no synthesis for a bubble not confirmed shown');
  const shown = synthesizeFixture(true);
  await shown.synth(8, 'id', 'text', { replyId: 'reply', segmentIndex: 0 });
  assert.deepEqual(shown.calls, ['authorizeCloud', 'speak'], 'and a confirmed one reads');
});

// (c) The prefix proof commits only while the read-aloud switch is on.
function prefixFixture(enabled: boolean) {
  const calls: string[] = [];
  const full = 'candidate text';
  const surface = { waitForCompletedPrefix: async (_full: unknown, _end: number, _signal: unknown, _remaining: number, commit: (text: string) => boolean) => commit(full), isCompletedPrefixCurrent: () => true };
  const completedReplySpeech = {
    fullPresentationText: () => full, presentationSignal: () => new AbortController().signal, prefixMode: () => true, presentationRemaining: () => 0,
    ownsLease: () => true, approvePresentation: () => true, proofEnd: (_o: number, _i: string, _s: string, lease: { visibleText: string }) => lease.visibleText.length,
  };
  const env = { needs: { store: { current: { voice: { enabled } } } }, completedReplySpeech, replySurface: () => surface, speechScope: () => 'scope' };
  const proof = evaluate(`${wiringFunction('withCompletedPrefixProof')}\nreturn withCompletedPrefixProof;`, env) as
    (owner: number, id: string, scope: string, segment: typeof SEGMENT, commit: () => boolean) => Promise<boolean>;
  return { calls, run: () => proof(8, 'reply', 'scope', SEGMENT, () => { calls.push('commit'); return true; }) };
}
test('the prefix proof is not committed while the read-aloud switch is off', async () => {
  const off = prefixFixture(false);
  assert.equal(await off.run(), false);
  assert.deepEqual(off.calls, [], 'the commit (synthesis or playback lease) does not run with read-aloud off');
  const on = prefixFixture(true);
  assert.equal(await on.run(), true);
  assert.deepEqual(on.calls, ['commit'], 'with it on the commit runs');
});

// (d) Four more voice gaps the mutation lists kept as knownGap (docs/claude/2026-11-16-dev-tools-size-mutate.md): V4 and V5 (the prefix
// proof re-checks the reply surface and the words in the bubble at the moment of committing), V8 (read-aloud off: no ordinary reply is
// synthesised) and V14 (read-aloud off: no feeding cue is synthesised).
function prefixProof(options: { swapSurface?: boolean; bubbleCurrent?: boolean }) {
  const calls: string[] = [];
  const full = 'candidate text';
  let current: Record<string, unknown>;
  const first = { waitForCompletedPrefix: async (_full: unknown, _end: number, _signal: unknown, _remaining: number, commit: (text: string) => boolean) => {
    if (options.swapSurface) current = { ...first }; // the reply surface moved on (another window or a new bubble) while the proof was waited for
    return commit(full);
  }, isCompletedPrefixCurrent: () => options.bubbleCurrent !== false };
  current = first;
  const completedReplySpeech = { fullPresentationText: () => full, presentationSignal: () => new AbortController().signal, prefixMode: () => true,
    presentationRemaining: () => 0, ownsLease: () => true, approvePresentation: () => true, proofEnd: (_o: number, _i: string, _s: string, lease: { visibleText: string }) => lease.visibleText.length };
  const env = { needs: { store: { current: { voice: { enabled: true } } } }, completedReplySpeech, replySurface: () => current, speechScope: () => 'scope' };
  const proof = evaluate(`${wiringFunction('withCompletedPrefixProof')}\nreturn withCompletedPrefixProof;`, env) as
    (owner: number, id: string, scope: string, segment: typeof SEGMENT, commit: () => boolean) => Promise<boolean>;
  return { calls, run: () => proof(8, 'reply', 'scope', SEGMENT, () => { calls.push('commit'); return true; }) };
}
test('the prefix proof is not committed when the reply surface is no longer the one it waited on', async () => {
  const swapped = prefixProof({ swapSurface: true });
  assert.equal(await swapped.run(), false);
  assert.deepEqual(swapped.calls, [], 'a different reply surface: no synthesis or playback lease');
  const same = prefixProof({});
  assert.equal(await same.run(), true);
  assert.deepEqual(same.calls, ['commit']);
});
test('the prefix proof is not committed when the words in the bubble are no longer this segment', async () => {
  const stale = prefixProof({ bubbleCurrent: false });
  assert.equal(await stale.run(), false);
  assert.deepEqual(stale.calls, [], 'the bubble no longer shows this prefix: nothing is committed');
});

test('read-aloud off: an ordinary reply segment is not synthesised, with the bubble shown and the segment approved', async () => {
  // The speech runtime has no read-aloud check of its own (electron/voice/speech-runtime.ts only validates the request and the config),
  // so this line is the one gate on this path: removing it would send the text to the paid voice with the switch off.
  const calls: string[] = [];
  const completedReplySpeech = { isOrdinary: () => true, approvedSegment: () => SEGMENT, prefixMode: () => false, fullPresentationText: () => 'full text',
    authorizeCloud: () => calls.push('authorizeCloud') };
  const make = (enabled: boolean) => evaluate(`return (${wiringHandler('synthesizeSpeech')});`, { store: { current: { voice: { enabled } } }, textMemorialHost: null, completedReplySpeech,
    speechScope: () => 'scope', petReply: { isPresentationCurrent: () => true }, speechRuntime: { speak: async () => { calls.push('speak'); } },
    syncFatigueActivity: () => {}, cancelCompletedReply: () => {}, withCompletedPrefixProof: async () => false }) as
    (sender: number, id: string, text: string, context: unknown) => Promise<void>;
  await assert.rejects(make(false)(8, 'id', 'text', { replyId: 'reply', segmentIndex: 0 }), /自动朗读已关闭/);
  assert.deepEqual(calls, [], 'no authorisation and no synthesis');
  await make(true)(8, 'id', 'text', { replyId: 'reply', segmentIndex: 0 });
  assert.deepEqual(calls, ['authorizeCloud', 'speak']);
});

test('read-aloud off: no feeding cue is synthesised', async () => {
  const asked: unknown[] = [];
  const make = (enabled: boolean) => evaluate(`return (${wiringHandler('synthesizeFeedCue')});`, { store: { current: { voice: { enabled }, tts: {}, model: null } },
    feedCueSynth: { clip: (kind: unknown) => { asked.push(kind); return { clip: kind }; } }, characterCards: { getActive: () => ({ id: 'her' }) },
    effectiveTtsConfig: () => ({ provider: 'system' }), characterTtsConfig: () => ({ provider: 'system' }), DEFAULT_TTS_CONFIG: {}, structuredClone }) as (sender: number, kind: string) => unknown;
  assert.equal(await make(false)(1, 'cookie'), null);
  assert.deepEqual(asked, [], 'the cue maker is never asked with read-aloud off');
  assert.deepEqual(await make(true)(1, 'cookie'), { clip: 'cookie' });
  assert.deepEqual(asked, ['cookie']);
});
