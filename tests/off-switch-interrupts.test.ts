// I-221 (2026-11-26, docs/claude/2026-11-26-off-switch-interrupts.md): turning 「发图片」 or 屏幕共享 OFF while she was speaking stopped her at once
// and emptied the chat page ("新对话已开始"); turning them on did not. The user's rule: only the user cutting in (a new message, a real spoken
// barge-in), the stop button and read-aloud off stop her. A sense going off takes effect for the next turn; the reply in flight finishes and
// stays on the page. Privacy: from the moment a sense is off no new frame is taken or sent, and what she was shown goes at once.
//
// Real: the host wiring's own mediaChanged / sightOff / clearVisionContext / refreshVisionContext / captureSharedCamera / forgetCallFrames and the
// setVisionOptions handler (evaluated from their text, tests/helpers/wiring-source.ts), MediaRuntime, the gate that writes the journal row
// (SettleWhenQuiet), the companion window's own applyRuntime (src/wiring/senses-wiring.ts, evaluated from its text) and its clear rule
// (src/brain/clear-after-reply.ts), PersistentClaudeChat with the real perception rule. Fake: Claude Code (tests/helpers/fake-claude-stream.ts),
// the captures, the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { MediaRuntime, callGlancesRevoked, cameraImagesRevoked, type CameraPolicy } from '../electron/senses/media-runtime';
import { visionContextChange, visionContextKey } from '../electron/senses/vision-context';
import { SettleWhenQuiet } from '../electron/voice/settle-when-quiet';
import { ReadCancelCauses } from '../electron/voice/read-cancel-cause';
import { ReadingJournal } from '../electron/memory/journal/extras';
import { createAwayVision } from '../shared/foundation/step-away';
import { acceptVisionOptionsPatch } from '../shared/senses';
import { clearAfterReply } from '../src/brain/clear-after-reply';
import type { RuntimeState } from '../shared/foundation/runtime-state';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { perceptionTurnState } from '../shared/brain/perception-rule';
import type { ChatMessage } from '../shared/foundation/chat';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { WIRING_PRELUDE, wiringFunction, wiringHandler } from './helpers/wiring-source';

const ROOT = path.resolve(import.meta.dirname, '..');
const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7, 7]).toString('base64');
const run = <T>(body: string, env: Record<string, unknown>): T => {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
};

/** One top-level function of a renderer wiring file, as its text (the `export` dropped). */
function rendererFunction(file: string, name: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = ast.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.equal(found.length, 1, `${name} in ${file}`);
  return found[0].getText(ast).replace(/^export\s+/, '');
}

// ---------------------------------------------------------------- the host: a sense going off, through the real mediaChanged

function host() {
  const log: string[] = [];
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  let busy: 'replying' | 'speaking' | null = null, tick: (() => void) | null = null;
  const rows: string[] = [];
  const gate = new SettleWhenQuiet({ busy: () => busy, note: (what, during) => rows.push(`${what}/${during}`), every: (_ms, step) => { tick = step; return () => { tick = null; }; } });
  const chat = new AbortController(); // her reply in flight (the host's pending chat task)
  const sent: Array<[string, unknown]> = [];
  const snapshots = { state: { enabled: false }, configure: (value: { sharing: boolean }) => { log.push(`screenSnapshots.sharing=${value.sharing}`); }, setOptions() {} };
  const env: Record<string, unknown> = {
    // no-pet-ok: the wiring's own name for her companion window (needs.pet)
    exiting: false, store: {}, pet: { getBounds: () => ({}) }, companion: { mood: { get: () => ({ token: 'mood-a' }) } },
    pending: new Map([['reply-1', { kind: 'chat', controller: chat }]]),
    speechScope: () => 'conv-1', onScreen: () => true, screen: { getDisplayMatching: () => ({ id: 7 }) }, awayVision: createAwayVision(),
    media, visionContextKey, visionContextChange, cameraImagesRevoked, callGlancesRevoked,
    waitsForHer: (what: 'sight-off') => gate.waitsFor(what),
    proactiveSpeechGate: { setScope() {} }, refreshVisualSelfContext() {}, screenSnapshots: snapshots,
    cancelProactiveVision: (_inputOnly: boolean, keepLine: boolean) => { log.push(`cancelProactiveVision keepLine=${keepLine}`); },
    selfLook: { cancel: () => log.push('selfLook.cancel'), mediaChanged: () => log.push('selfLook.mediaChanged') },
    surprisePreviewHost: { invalidate() {} }, languageAuthoring: { invalidate() {} }, visualAuthoring: { invalidate() {} }, bodyAuthoring: { invalidate() {} },
    visualSelfRuntime: { clear() {}, beginCapture: () => null, completeCapture() {} },
    lookAttachments: { abort: () => log.push('lookAttachments.abort') }, lookTurns: { clear: () => log.push('lookTurns.clear') },
    claudeChat: { forgetFrames: () => log.push('claudeChat.forgetFrames') },
    cameraSamples: { request: async () => { log.push('cameraSamples.request'); return { source: 'camera', dataUrl: jpeg(9) }; } },
    revokeVoice() {}, asrTask: null, screenGlance: { setSharing() {} }, poseSensing: null, faceCheck: null, cameraGlance: { reset: () => log.push('cameraGlance.reset') },
    cameraEye: { images() {} }, relayCameraHeld() {}, see: { smallScreens: { forget: () => log.push('smallScreens.forget') } }, localAsr: null, voiceRoute: { engine: 'local' },
    broadcast: (channel: string, payload?: unknown) => { sent.push([channel, payload ?? null]); }, publishVisionState() {}, publishSenses() {}, voiceCall: { check() {} },
  };
  const fns = run<{ mediaChanged(previous: RuntimeState): void; refresh(): string; capture(owner: number): Promise<unknown>; setVisionOptions(sender: number, value: unknown): unknown }>(
    `let visionGeneration = 0, visionContextIdentity = '', visualSelfIdentity = '', visualSelfScreenSourceId = null, visualSelfCameraOwnerId = null;
let proactiveVisionEnabled = true, visionStatus = '';
const visionState = () => ({ proactiveVision: proactiveVisionEnabled });
${wiringFunction('forgetCallFrames')}\n${wiringFunction('clearVisionContext')}\n${wiringFunction('sightOff')}\n${wiringFunction('clearMoodScope')}
${wiringFunction('refreshVisionContext')}\n${wiringFunction('mediaChanged')}\n${wiringFunction('captureSharedCamera')}
const setVisionOptions = ${wiringHandler('setVisionOptions')};
return { mediaChanged, refresh: refreshVisionContext, capture: (owner) => captureSharedCamera(owner, new AbortController().signal), setVisionOptions };`, { ...env, acceptVisionOptionsPatch });
  /** The user flips a switch in the control window: the host's MediaRuntime changes and mediaChanged follows (electron/wiring/senses-look-wiring.ts). */
  const flip = (patch: Partial<RuntimeState>) => { const previous = { ...media.state }; media.update(patch, 'controls'); log.length = 0; sent.length = 0; fns.mediaChanged(previous); };
  return { media, fns, log, sent, rows, chat, flip, setBusy: (value: typeof busy) => { busy = value; }, quietTick: () => tick?.() };
}
const cleared = (sent: Array<[string, unknown]>) => sent.filter(([channel]) => channel === 'desk:vision-context-cleared').map(([, payload]) => payload);
const runtimeSent = (sent: Array<[string, unknown]>) => sent.filter(([channel]) => channel === 'desk:runtime').map(([, payload]) => payload as RuntimeState).at(-1)!;

// ---------------------------------------------------------------- the companion window: its own applyRuntime and its clear handler

function companionWindow(initial: RuntimeState) {
  const calls: string[] = [];
  const quiet = new Proxy({}, { get: () => () => {} });
  const env = {
    // no-pet-ok: the renderer wiring's own names for her window (applyRuntime reads them)
    isPet: true, petUI: { applyRuntime() {} }, mediaInput: { applyRuntime: async () => {} }, screenSharingOptions: null, lookButton: null, lookMeButton: null,
    clearChat: (...args: unknown[]) => { calls.push(`clearChat(${args.join(', ')})`); }, $: () => null, text() {}, uiText: (s: string) => s, uiTemplate: () => '', quiet,
  };
  const page = run<{ apply(next: RuntimeState): void }>(`let runtime = initial, visionRuntime = {};
${ts.transpileModule(rendererFunction('src/wiring/senses-wiring.ts', 'applyRuntime'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
return { apply: applyRuntime };`, { ...env, initial });
  /** The page's onVisionContextCleared handler (src/wiring/senses-wiring.ts): clearAfterReply with her reply in flight. */
  const hostCleared = (payload: unknown) => clearAfterReply(payload, { active: () => 'reply-1', clear: () => calls.push('clearChat(false, false, true)'),
    keep: () => calls.push('provisional look line dropped'), every: () => () => {} });
  return { calls, apply: page.apply, hostCleared };
}

for (const [name, on, off] of [
  ['「发图片」', { cameraImages: true }, { cameraImages: false }],
  ['屏幕共享', { screenSharing: true }, { screenSharing: false }],
] as const) {
  test(`${name} turned off while she replies: her reply goes on, the page keeps everything, the journal says so (fails before I-221)`, () => {
    const h = host();
    h.flip(on); h.fns.refresh();
    const before = { ...h.media.state };
    h.setBusy('replying');
    h.flip(off);
    const page = companionWindow(before);
    page.apply(runtimeSent(h.sent)); // the host's desk:runtime broadcast reaches the page
    for (const payload of cleared(h.sent)) page.hostCleared(payload); // and its desk:vision-context-cleared
    assert.deepEqual(page.calls.filter(call => call.startsWith('clearChat')), [], `the page is not cleared and her reply is not stopped: ${page.calls}`);
    assert.deepEqual(cleared(h.sent), [{ keepConversation: true }], 'the host asks the page to keep the conversation');
    assert.equal(h.chat.signal.aborted, false, 'the host does not abort her reply in flight');
    assert.ok(h.log.includes('cancelProactiveVision keepLine=true'), 'a look line she is saying goes on');
    assert.deepEqual(h.rows, ['sight-off/replying'], 'one journal row: the change waited for her next reply, nothing was interrupted');
  });
}

test('the privacy steps run at once when a sense goes off, busy or quiet: no new frame, the kept frame and the call\'s small frames go', async () => {
  for (const busy of ['replying', null] as const) {
    const h = host();
    h.flip({ cameraImages: true, screenSharing: true }); h.fns.refresh();
    h.media.publishCamera('controls', jpeg(1));
    assert.ok(h.media.cameraAttachment(), 'a kept camera frame before');
    h.setBusy(busy);
    h.flip({ cameraImages: false, screenSharing: false });
    for (const step of ['lookAttachments.abort', 'lookTurns.clear', 'selfLook.cancel', 'selfLook.mediaChanged', 'claudeChat.forgetFrames', 'smallScreens.forget', 'cameraGlance.reset', 'screenSnapshots.sharing=false'])
      assert.ok(h.log.includes(step), `${step} runs at once (busy=${busy}): ${h.log}`);
    assert.equal(h.media.cameraAttachment(), null, 'the kept camera frame is gone at once');
    assert.equal(h.media.sharesCameraFrames(), false);
    h.log.length = 0;
    assert.equal(await h.fns.capture(1), null, 'no new camera frame can be taken after the switch');
    assert.ok(!h.log.includes('cameraSamples.request'), 'the camera is not even asked');
    assert.deepEqual(cleared(h.sent), [{ keepConversation: true }], `the page keeps the conversation (busy=${busy})`);
  }
  // Only the screen off, 「发图片」 still on: what she was shown goes too (the camera frame kept from before is not offered again).
  const h = host();
  h.flip({ cameraImages: true, screenSharing: true }); h.fns.refresh();
  h.media.publishCamera('controls', jpeg(2));
  h.setBusy('replying');
  h.flip({ screenSharing: false });
  assert.equal(h.media.sharesCameraFrames(), true, '「发图片」 is still on');
  assert.equal(h.media.cameraAttachment(), null, 'the frame kept before the switch went with what she was shown');
});

test('a second switch-off in a later reply writes its own journal row (the busy stretch ends when she is quiet)', () => {
  const h = host();
  h.flip({ cameraImages: true }); h.fns.refresh(); h.setBusy('replying');
  h.flip({ cameraImages: false });
  h.setBusy(null); h.quietTick(); // her reply ends
  h.flip({ screenSharing: true }); h.fns.refresh(); h.setBusy('speaking');
  h.flip({ screenSharing: false });
  assert.deepEqual(h.rows, ['sight-off/replying', 'sight-off/speaking'], 'story 2 of the tester\'s walk wrote no row before');
});

test('her own looking (主动看) turned off clears what she was shown and keeps the page', () => {
  const h = host();
  h.flip({ screenSharing: true }); h.fns.refresh(); h.setBusy('replying');
  h.sent.length = 0;
  h.fns.setVisionOptions(1, { proactiveVision: false });
  assert.deepEqual(cleared(h.sent), [{ keepConversation: true }], 'before I-221 this was a full clear: the page cleared and her reply stopped');
  const page = companionWindow({ ...h.media.state });
  page.hostCleared(cleared(h.sent)[0]);
  assert.deepEqual(page.calls, ['provisional look line dropped']);
});

test('what still clears the page: another conversation or window (a switch of context), and a step away\'s camera release after her reply', () => {
  const h = host();
  h.flip({ screenSharing: true }); h.fns.refresh();
  const page = companionWindow({ ...h.media.state });
  page.hostCleared(undefined); // another conversation: at once
  page.hostCleared({ afterReply: true }); // I-174 9b: after her reply (the fake timer never fires here)
  assert.deepEqual(page.calls, ['clearChat(false, false, true)']);
});

// ---------------------------------------------------------------- the session: the real perception rule, a sense off mid-turn

test('the host session: 「发图片」 and 屏幕共享 going off in the middle of a turn neither end nor replace it; the next turn is told she cannot see', async t => {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {} });
  t.after(async () => { chat.dispose(); await claude.cleanup(); });
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ cameraImages: true, screenSharing: true }, 'controls');
  const messages: ChatMessage[] = [];
  const base = '你是测试角色小桃。';
  let n = 0;
  const say = async (text: string, during?: () => void) => {
    messages.push({ role: 'user', content: text });
    const window = [...messages];
    const sight = () => JSON.stringify(perceptionTurnState(media.state, [], text)); // read where the message is written, like the wiring's onceLines
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(base, window); },
      imageDataUrls: [], replyId: `r${++n}`, session: { key: 'conv-1', basePersona: base, get persona() { return `${base}\n\n${sight()}`; }, messages: window, data: () => null } };
    let started!: () => void;
    const firstDelta = new Promise<void>(resolve => { started = resolve; });
    const streamed = chat.stream(task, new AbortController().signal, type => { if (type === 'delta') started(); });
    if (during) { await firstDelta; during(); await claude.release(text.split('#hold:')[1]); } // she is mid-reply when the switches go off
    const result = await streamed;
    messages.push({ role: 'assistant', content: result.output });
    return result;
  };
  await say('你好');
  const first = await say('讲个故事 #hold:story', () => {
    const previous = { ...media.state };
    media.update({ cameraImages: false, screenSharing: false }, 'controls');
    assert.ok(cameraImagesRevoked(previous, media.state) && callGlancesRevoked(previous, media.state));
    chat.forgetFrames(); // what clearVisionContext does to her process (the rest of it is the window and look state above)
  });
  assert.equal(first.superseded, false, 'the turn was not replaced');
  assert.match(first.output, /讲个故事/, 'the whole reply came');
  await say('还在吗');
  const inputs = await claude.inputs();
  const pids = new Set(inputs.map(input => input.pid));
  assert.equal(pids.size, 1, 'one process for all three turns: nothing restarted her mid-conversation');
  const prompts = inputs.filter(input => input.user !== undefined).map(input => input.prompt ?? '');
  assert.match(prompts[1], /"camera":"frames"/, 'the turn under way was written while she could see');
  assert.match(prompts[2], /"camera":"off"/, 'the next turn is told the camera is off');
  assert.match(prompts[2], /"screen":false/, 'and the screen');
});

// ---------------------------------------------------------------- the journal's "who cut the reading" (the walk's two traces: 'window', 'superseded')

test('a reading cut by the window says the window\'s own reason, not a cause noted earlier with nothing to cancel', () => {
  const causes = new ReadCancelCauses();
  const rows: Array<{ type: string; cancelBy?: string }> = [];
  const timers = { set: () => 0, clear() {} };
  const reading = new ReadingJournal({ record: (input: { type: string }) => { rows.push(input); }, accepting: () => true } as never, () => 'c', timers, undefined, causes);
  const env = {
    journalExtras: { readCancel: causes }, completedReplySpeech: { identity: () => null, cancelReply() {} }, speechRuntime: { cancelReply() {} },
    replySpeechStyles: { cancel() {} }, windows: () => [], unbound: null, suspendAmbientSpeech() {},
  };
  const cancelCompletedReply = run<(id?: string, by?: string) => boolean>(`${wiringFunction('noteReadCancel')}\n${wiringFunction('cancelCompletedReply')}\nreturn cancelCompletedReply;`, env);
  cancelCompletedReply(undefined, 'window'); // the companion window's new page at start-up (electron/wiring/stage-cleanup-wiring.ts, its new-document step)
  cancelCompletedReply(undefined, 'superseded'); // a new message (clearReplySpeech): nothing of the host's was being read
  const seg = (index: number, outcome: 'ended' | 'cancelled', cancelBy?: 'stop') => ({ kind: 'reply' as const, provider: 'system' as const, segmentIndex: index, textLength: 9, outcome,
    t: index === 0 ? { request: 1, playbackStart: 30 } : {}, ...(cancelBy ? { cancelBy } : {}) });
  reading.segment(seg(0, 'ended')); reading.segment(seg(1, 'ended')); reading.segment(seg(2, 'cancelled', 'stop')); // the window stopped her (stop button)
  reading.flush();
  assert.equal(rows.find(row => row.type === 'reading-time')?.cancelBy, 'stop', 'before I-221 the row named the stale start-up note');
  cancelCompletedReply('reply-9', 'stop'); // the stop button's cancel for a reply id: noted (it may be one of the host's)
  assert.equal(causes.take(), 'stop');
});
