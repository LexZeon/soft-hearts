// Wiring rewrite step 5b (docs/claude/2026-11-17-wiring-step-5b.md): what the app does before it quits is two ordered lists electron/main.ts
// gives (wireQuit, electron/wiring/quit-wiring.ts): every part's quit step on each before-quit, then once the flush steps. The wiring golden
// pins the lists' text; this runs them: the real lists and every step's actual text (tests/helpers/wiring-source.ts quitStepsSource), with
// every part's object logging what it is asked. A step skipped or moved, a flush step run before the chats in flight had their time, the
// quit not held while the stores flush, or the flush run twice: the logs below change.
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { quitStepsSource } from './helpers/wiring-source';

const QUIT = quitStepsSource();
const CODE = ts.transpileModule(`let fatigueActivityReady = true, moodTimer = 1;\n${QUIT.source}\nreturn { exiting: () => exiting, ready: () => fatigueActivityReady, clock: () => moodTimer };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

/** A part's object: any property is another such object, any call is logged (with its string arguments) and returns a settled promise. */
function recorder(log: string[], name: string): unknown {
  return new Proxy(function () { /* a callable target */ }, {
    get: (_target, prop) => typeof prop === 'symbol' ? undefined : prop === 'then' ? undefined : recorder(log, `${name}.${prop}`),
    apply: (_target, _this, args: unknown[]) => { log.push([name, ...args.filter(a => typeof a === 'string')].join(' ')); return Promise.resolve(); },
  });
}

function fixture(options: { chatSettlesAfterMs?: number } = {}) {
  const log: string[] = [];
  const quitListeners: ((event: { preventDefault(): void }) => void)[] = [];
  const app = { on: (event: string, listener: (event: { preventDefault(): void }) => void) => { assert.equal(event, 'before-quit'); quitListeners.push(listener); },
    quit: () => { log.push('app.quit'); }, getVersion: () => '9.9.9' };
  let settling: ReturnType<typeof setTimeout> | null = null; // the provider settles once, however often it is aborted
  const pending = new Map<string, { kind: string; controller: { abort(): void } }>([
    ['chat', { kind: 'chat', controller: { abort: () => { log.push('task.abort chat'); if (options.chatSettlesAfterMs !== undefined && !settling) settling = setTimeout(() => { pending.delete('chat'); log.push('chat settled'); }, options.chatSettlesAfterMs); } } }],
  ]);
  const names = ['appJournal', 'appSession', 'localAsr', 'faceCheck', 'singleEmojiCues', 'singleEmojiWindow', 'companionCommands', 'userProfileSource',
    'diaryWriter', 'herNote', 'movingMemory', 'reviewWriter', 'userProfileManagement', 'textMemorialHost', 'r20ProactiveOffers', 'petWindowDrag', 'petPresentation',
    'unboundEntry', 'unbound', 'unboundTyping', 'unboundCards', 'controlAwake', 'fatigueActivity', 'speechPlaybackActivity', 'clearVisionContext', 'screen', 'stopSystemAudio', 'speechRuntime',
    'codexTasks', 'petReply', 'motionLibrary', 'asrTask', 'voiceCall', 'voiceHost', 'media', 'mediaChanged', 'proactiveVision', 'innerLoopHost', 'keepsake',
    'specialDay', 'proactiveSpeechGate', 'screenSnapshots', 'screenGlance', 'visualSelfRuntime', 'cameraSamples', 'claudeChat', 'chatOutage', 'rps', 'moduleRouter',
    'pauseTalk', 'feeding', 'give', 'hands', 'moodJudge', 'reactions', 'userActivity', 'companion', 'memoryNotes', 'semantic', 'upcoming', 'watchTogether',
    'textInvitationMemory', 'journalExtras', 'userProfiles', 'globalShortcut', 'tray'];
  const env: Record<string, unknown> = Object.fromEntries(names.map(name => [name, recorder(log, name)]));
  Object.assign(env, {
    app, pending, buildCommit: 'abc', journalCharacterId: () => 'her', companionCommandExpiry: null, refreshVisionContext: () => '', clearInterval: () => log.push('clock.stop'),
    poseQuit: { hold: () => { log.push('pose.hold'); return false; } },
    conversionQuit: { hold: () => { log.push('conversion.hold'); return false; }, ended: async () => { log.push('conversion.ended'); } },
    settleWithin: async (p: unknown) => { await p; log.push('settled'); }, console,
    // The worker that starts and ends Claude Code has started every taskkill asked of it (electron/brain/claude-launch), after the chats.
    claudeLaunchesSettled: async (limitMs: number) => { log.push(`claudeLaunches.settled ${limitMs >= 250 ? 'within' : 'no'} limit`); return true; },
  });
  const api = new Function(...Object.keys(env), CODE)(...Object.values(env)) as { exiting(): boolean; ready(): boolean; clock(): unknown };
  assert.equal(quitListeners.length, 1, 'one before-quit listener');
  const quit = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; quitListeners[0](event); return event.prevented; };
  return { log, take: () => log.splice(0), quit, api };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

const QUIT_STEPS = [
  'appSession.stop', 'appJournal.appQuitting 9.9.9 abc her', 'pose.hold', 'conversion.hold', 'localAsr.dispose', 'faceCheck.host.dispose',
  'singleEmojiCues.dispose', 'singleEmojiWindow.dispose', 'companionCommands.invalidate', 'userProfileSource.clear', 'diaryWriter.dispose',
  'herNote.writer.dispose', 'movingMemory.handoff.dispose', 'reviewWriter.dispose', 'userProfileManagement.dispose', 'textMemorialHost.dispose',
  'r20ProactiveOffers.dispose', 'petWindowDrag.cancel', 'petPresentation.dispose', 'unboundEntry.quit', 'unbound.quit', 'unboundTyping.quit', 'unboundCards.quit', 'controlAwake.releaseAll',
  'fatigueActivity.dispose', 'speechPlaybackActivity.dispose', 'clock.stop', 'clearVisionContext', 'screen.removeListener display-removed',
  'screen.removeListener display-metrics-changed', 'stopSystemAudio', 'speechRuntime.stop', 'codexTasks.close', 'petReply.dispose', 'motionLibrary.cancel',
  'asrTask.controller.abort', 'voiceCall.dispose', 'voiceHost.dispose', 'media.reset', 'mediaChanged', 'proactiveVision.dispose', 'innerLoopHost.loop.dispose',
  'keepsake.dispose', 'specialDay.dispose', 'proactiveSpeechGate.dispose', 'screenSnapshots.dispose', 'screenGlance.dispose', 'visualSelfRuntime.dispose',
  'cameraSamples.cancel', 'task.abort chat', 'claudeChat.dispose', 'chatOutage.dispose', 'rps.dispose', 'moduleRouter.dispose', 'pauseTalk.dispose',
  'feeding.dispose', 'give.dispose', 'hands.dispose', 'moodJudge.dispose', 'reactions.dispose', 'userActivity.flush', 'globalShortcut.unregisterAll', 'tray.destroy',
];
const FLUSH = ['claudeLaunches.settled within limit', 'conversion.ended', 'companion.flush', 'memoryNotes.dispose', 'semantic.recall.flush', 'semantic.host.dispose', 'upcoming.dispose',
  'watchTogether.dispose', 'textInvitationMemory.flush', 'journalExtras.reading.flush', 'appJournal.flush', 'userProfiles.settled', 'settled', 'app.quit'];

test('before quitting: every part\'s step in the list\'s order; the quit is held while the stores flush, then the app quits once', async () => {
  const f = fixture({ chatSettlesAfterMs: 0 });
  assert.equal(f.quit(), true, 'the first before-quit is held for the flush');
  assert.deepEqual(f.take(), QUIT_STEPS);
  assert.equal(f.api.exiting(), true);
  assert.equal(f.api.ready(), false, 'sleep entry closed');
  assert.equal(f.api.clock(), null, 'the clock stopped');
  await until(() => f.log.includes('app.quit'));
  assert.deepEqual(f.take(), ['chat settled', ...FLUSH], 'the chat in flight settles before anything flushes');
  assert.equal(f.quit(), false, 'the second before-quit (from app.quit) is not held');
  assert.deepEqual(f.take(), QUIT_STEPS.filter(line => line !== 'clock.stop' && line !== 'task.abort chat'), 'the quit steps run again (the clock is stopped, the chat gone); the flush does not');
});

test('the flush waits for a chat in flight before her conversation and the stores are written', async () => {
  const f = fixture({ chatSettlesAfterMs: 120 });
  f.quit(); f.take();
  assert.equal(f.quit(), true, 'a before-quit while flushing is held too');
  assert.ok(!f.take().some(line => FLUSH.includes(line)), 'and starts no second flush');
  await until(() => f.log.includes('app.quit'));
  const log = f.take();
  assert.deepEqual(log, ['chat settled', ...FLUSH]);
});

test('the lists: the quit steps end with the flush hold and the shell; the flush starts with the chats and ends with the stores', () => {
  assert.deepEqual(QUIT.steps.slice(-2), ['holdForFlush', 'releaseShell']);
  assert.equal(QUIT.steps[0], 'noteQuitting', 'the journal\'s stop line is written first, synchronously');
  assert.deepEqual([QUIT.flush[0], QUIT.flush.at(-1)], ['waitForChats', 'flushMemoryStores']);
});
