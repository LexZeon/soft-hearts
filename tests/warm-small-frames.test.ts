// 2026-11-21 (docs/claude/2026-11-21-warm-small-frames.md): ordinary small frames from senses that are on stay in the warm Claude process.
// The chat acceptance's senses mode (--dry --senses, fake Claude) showed turns starting a new process with reuse reason "image" after
// turns that carried only small frames. Cause: the vision context's identity carried her mood token, which rotates when her companion
// window is hidden as she goes out into full-screen Unbound and after any 5 s gap between mood ticks; every rotation cleared the whole
// vision context (look tickets, the warm process's small frames). Now only a change of what decides seeing clears it.
// Real: LookTurns, LookAttachments, MediaRuntime, CameraGlance, PersistentClaudeChat + ClaudeChatProcess, the wiring's own refreshVisionContext
// and clearVisionContext/clearMoodScope text. Fake: Claude Code (tests/helpers/fake-claude-stream.ts), the captures. No camera, no screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import ts from 'typescript';
import type { ChatMessage } from '../shared/foundation/chat';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments, type TurnFrames } from '../electron/senses/look-attachments';
import { createAwayVision } from '../shared/foundation/step-away';
import { CameraGlance } from '../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { visionContextChange, visionContextKey, type VisionContextParts } from '../electron/senses/vision-context';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { WIRING_PRELUDE, wiringFunction } from './helpers/wiring-source';

const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7, 7]).toString('base64');

// ---------------------------------------------------------------- the rule

const parts = (over: Partial<VisionContextParts> = {}): VisionContextParts => ({ speech: 'conv-1', scope: 'conv-1:mood-a', visible: true, display: 7,
  screen: true, camera: true, cameraOwner: 'controls', ...over });

test('a rotation of her mood token alone is a mood change; anything that decides seeing is a seeing change', () => {
  const before = visionContextKey(parts());
  assert.equal(visionContextChange('', before), 'none', 'turning a sense on is not a change');
  assert.equal(visionContextChange(before, visionContextKey(parts())), 'none');
  assert.equal(visionContextChange(before, visionContextKey(parts({ scope: 'conv-1:mood-b' }))), 'mood', 'Unbound entry / a 5 s tick gap: only the token');
  for (const [what, over] of [['another conversation or character', { speech: 'conv-2', scope: 'conv-2:mood-a' }], ['her window off the screen', { visible: false }],
    ['in transition', { speech: '', scope: '' }]] as const)
    assert.equal(visionContextChange(before, visionContextKey(parts(over))), 'seeing', what);
  // 2026-11-25 (docs/claude/2026-11-25-no-interrupt.md): a source that went off or moved in the same conversation and window is 'off': it clears too, but after her reply.
  for (const [what, over] of [['another display', { display: 8 }], ['the camera in another window', { cameraOwner: 'unbound' }], ['the screen off', { screen: false }],
    ['the camera off', { camera: false }]] as const)
    assert.equal(visionContextChange(before, visionContextKey(parts(over))), 'off', what);
  assert.equal(visionContextChange(before, visionContextKey(parts({ screen: false, camera: false }))), 'off', 'every sense off');
  assert.equal(visionContextKey(parts({ screen: false, camera: false })), '');
  assert.equal(visionContextChange('synthetic-old', before), 'seeing', 'an identity this module did not make counts as seeing');
});

// ---------------------------------------------------------------- the wiring (its own text, evaluated)

function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`${WIRING_PRELUDE}\n${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env)) as T;
}

test('the wiring: a mood-only rotation keeps what she was shown (no forget, no abort, no cleared chat); a seeing change clears it all', () => {
  const log: string[] = [];
  const ping = (name: string) => () => { log.push(name); };
  let token = 'mood-a', conversation = 'conv-1';
  const env = {
    // no-pet-ok: the wiring's own name for her companion window (needs.pet)
    exiting: false, store: {}, pet: { getBounds: () => ({}) }, companion: { mood: { get: () => ({ token }) } },
    speechScope: () => conversation, onScreen: () => true, screen: { getDisplayMatching: () => ({ id: 7 }) },
    media: { state: { screenSharing: true, cameraSharing: true, cameraOwner: 'controls' }, clearCamera: ping('camera.clear') },
    proactiveSpeechGate: { setScope() {} }, refreshVisualSelfContext() {}, screenSnapshots: { configure() {} },
    cancelProactiveVision: ping('cancelProactiveVision'), selfLook: { cancel: ping('selfLook.cancel') },
    surprisePreviewHost: { invalidate() {} }, languageAuthoring: { invalidate() {} }, visualAuthoring: { invalidate() {} }, bodyAuthoring: { invalidate() {} },
    visualSelfRuntime: { clear() {} }, lookAttachments: { abort: ping('lookAttachments.abort') }, lookTurns: { clear: ping('lookTurns.clear') },
    forgetCallFrames: ping('forgetCallFrames'), broadcast: (channel: string) => { log.push(`broadcast ${channel}`); },
    visionContextKey, visionContextChange, awayVision: createAwayVision(),
  };
  const refresh = evaluate<() => string>(`let visionGeneration = 0, visionContextIdentity = '', visualSelfIdentity = '', visualSelfScreenSourceId = null, visualSelfCameraOwnerId = null;
${wiringFunction('clearMoodScope')}\n${wiringFunction('clearVisionContext')}\n${wiringFunction('refreshVisionContext')}\nreturn refreshVisionContext;`, env);
  assert.equal(refresh(), 'conv-1:mood-a');
  assert.equal(log.length, 0, 'the first context clears nothing');
  token = 'mood-b'; // her companion window hidden on the way out into full-screen Unbound
  assert.equal(refresh(), 'conv-1:mood-b', 'the scope the host reads still follows the token');
  assert.ok(log.includes('cancelProactiveVision') && log.includes('selfLook.cancel'), `her own looks under way stop: ${log}`);
  for (const kept of ['forgetCallFrames', 'lookAttachments.abort', 'camera.clear', 'lookTurns.clear', 'broadcast desk:vision-context-cleared'])
    assert.ok(!log.includes(kept), `${kept} does not run for a mood-only rotation`);
  log.length = 0;
  conversation = 'conv-2';
  refresh();
  for (const step of ['forgetCallFrames', 'lookAttachments.abort', 'camera.clear', 'lookTurns.clear', 'broadcast desk:vision-context-cleared'])
    assert.ok(log.includes(step), `${step} runs for a seeing change`);
});

test('the wiring (2026-11-25/26, only the user cutting in interrupts her): a source turned on clears nothing; one turned off drops what she was shown and keeps the page, busy or quiet', () => {
  const log: string[] = [];
  let busy = false;
  const state = { screenSharing: true, cameraSharing: false, cameraOwner: null as string | null };
  const env = {
    // no-pet-ok: the wiring's own name for her companion window (needs.pet)
    exiting: false, store: {}, pet: { getBounds: () => ({}) }, companion: { mood: { get: () => ({ token: 'mood-a' }) } },
    speechScope: () => 'conv-1', onScreen: () => true, screen: { getDisplayMatching: () => ({ id: 7 }) },
    media: { state, clearCamera() {} },
    proactiveSpeechGate: { setScope() {} }, refreshVisualSelfContext() {}, screenSnapshots: { configure() {} },
    cancelProactiveVision: (_inputOnly: boolean, keepLine: boolean) => { log.push(`cancelProactiveVision keepLine=${keepLine}`); }, selfLook: { cancel() {} },
    surprisePreviewHost: { invalidate() {} }, languageAuthoring: { invalidate() {} }, visualAuthoring: { invalidate() {} }, bodyAuthoring: { invalidate() {} },
    visualSelfRuntime: { clear() {} }, lookAttachments: { abort() {} }, lookTurns: { clear() {} }, forgetCallFrames() {},
    waitsForHer: (what: string) => { log.push(`waits ${what} busy=${busy}`); return busy; },
    broadcast: (channel: string, payload?: unknown) => { log.push(`broadcast ${channel} ${JSON.stringify(payload ?? null)}`); },
    visionContextKey, visionContextChange, awayVision: createAwayVision(),
  };
  const refresh = evaluate<() => string>(`let visionGeneration = 0, visionContextIdentity = '', visualSelfIdentity = '', visualSelfScreenSourceId = null, visualSelfCameraOwnerId = null;
${wiringFunction('clearMoodScope')}\n${wiringFunction('clearVisionContext')}\n${wiringFunction('sightOff')}\n${wiringFunction('refreshVisionContext')}\nreturn refreshVisionContext;`, env);
  refresh(); // the screen is on
  state.cameraSharing = true; state.cameraOwner = 'controls'; // 「发图片」 ticked while her reply plays
  refresh();
  assert.equal(log.length, 0, 'a source turned on clears and cancels nothing');
  busy = true; state.cameraSharing = false; state.cameraOwner = null;
  refresh();
  assert.ok(log.includes('broadcast desk:vision-context-cleared {"keepConversation":true}'), `turned off while she replies: the page keeps her reply (I-221): ${log}`);
  assert.ok(log.includes('waits sight-off busy=true'), 'the journal row while she is busy');
  assert.ok(log.includes('cancelProactiveVision keepLine=true'), 'the line she is saying goes on');
  log.length = 0; busy = false; state.screenSharing = false;
  refresh();
  assert.ok(log.includes('broadcast desk:vision-context-cleared {"keepConversation":true}'), `turned off while she is quiet: the page stays too (I-221): ${log}`);
});

// ---------------------------------------------------------------- the acceptance's turns, with the real session

function lookKit() {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ cameraImages: true, screenSharing: true }, 'controls');
  let shots = 0, kept = true;
  const turns = new LookTurns(() => 0);
  const keeper = new CameraGlance({ frame: () => (kept ? media.cameraAttachment() : null), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const state = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  const look = new LookAttachments(turns, {
    noteActivity() {}, state, sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => 0, opening: source => media.openings[source],
    captureScreen: async () => ({ source: 'screen', dataUrl: jpeg(200 + ++shots) }), captureCamera: async () => ({ source: 'camera', dataUrl: jpeg(150 + ++shots) }),
    glance: everyTurn => keeper.take(everyTurn), seenCamera: () => keeper.seen(), holdCamera: held => { media.holdCamera(held); }, textFirst: () => true,
    seeAndSay: () => true, smallWaitMs: () => 200,
    smallScreen: async () => ({ source: 'screen', dataUrl: jpeg(90 + ++shots % 50) }),
    freshGlance: async () => ({ source: 'camera', dataUrl: jpeg(40 + ++shots % 50) }), // out in full-screen: taken now and shrunk
  });
  media.publishCamera('controls', jpeg(1));
  return { media, look, turns, out: () => { kept = false; } };
}

async function world() {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, callGlances: { stays: true, cap: 40, outside: true } });
  const kit = lookKit();
  const messages: ChatMessage[] = [];
  let n = 0, key = visionContextKey(parts());
  /** The wiring's dispatch (refreshVisionContext above): a seeing change clears the look tickets and the warm process's frames. */
  const refresh = (next: VisionContextParts) => {
    const nextKey = visionContextKey(next);
    if (visionContextChange(key, nextKey) === 'seeing') { kit.look.abort(); chat.forgetFrames(); }
    key = nextKey;
  };
  /** One typed turn as electron/wiring/brain-chat-wiring.ts sends it: the turn's own frames and its glance mark. */
  const say = async (text: string) => {
    const frames: TurnFrames = kit.look.admit(await kit.look.request({ text }));
    messages.push({ role: 'user', content: text });
    const window = [...messages], base = '你是测试角色小桃。';
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(base, window); },
      get imageDataUrls() { return frames.current().map(frame => frame.dataUrl); }, replyId: `r${++n}`,
      session: { key: 'typed', basePersona: base, persona: base, messages: window, data: () => null },
      callGlance: { glanceOnly: () => frames.glanceOnly(), still: () => frames.glanceStill(), past: () => '' } };
    const { output } = await chat.stream(task, new AbortController().signal, () => {});
    messages.push({ role: 'assistant', content: output });
    return { frames: frames.current().map(frame => `${frame.source}${frames.glanceOnly() ? '-small' : '-clear'}`) };
  };
  const pidOf = async (text: string) => (await claude.inputs()).find(input => input.user === text)?.pid;
  return { claude, chat, kit, say, refresh, pidOf, dispose: async () => { chat.dispose(); await claude.cleanup(); } };
}

test('acceptance turn 9: small frames, then out into full-screen Unbound (her mood token rotates, the camera frame is taken fresh): the same warm process', async () => {
  const w = await world();
  try {
    assert.deepEqual((await w.say('今天有点累')).frames.sort(), ['camera-small', 'screen-small']);
    assert.deepEqual((await w.say('晚饭吃什么好')).frames.sort(), ['camera-small', 'screen-small']);
    w.refresh(parts({ scope: 'conv-1:mood-b' })); // her companion window hidden on the way out: mood.invalidate rotates the token
    w.kit.out(); // her window is throttled out there: the kept camera frame is stale, the small one is taken fresh
    assert.deepEqual((await w.say('你觉得我今天状态怎么样')).frames.sort(), ['camera-small', 'screen-small']);
    w.refresh(parts({ scope: 'conv-1:mood-c' })); // a 5 s gap between mood ticks rotates it again
    await w.say('我们出去走走吧');
    const pids = await Promise.all(['今天有点累', '晚饭吃什么好', '你觉得我今天状态怎么样', '我们出去走走吧'].map(w.pidOf));
    assert.equal(new Set(pids).size, 1, `one warm process across the mood rotations: ${pids}`);
  } finally { await w.dispose(); }
});

test('the privacy retires stay: another conversation, a switch off or "别看" start a new process that never sees the old frames', async () => {
  const w = await world();
  try {
    await w.say('今天有点累');
    w.refresh(parts({ speech: 'conv-2', scope: 'conv-2:mood-a' })); // a seeing change: the vision context is cleared
    await w.say('晚饭吃什么好');
    const [first, second] = await Promise.all(['今天有点累', '晚饭吃什么好'].map(w.pidOf));
    assert.notEqual(second, first, 'a cleared vision context replaces the process');
    const old = (await w.claude.inputs()).filter(input => input.pid === second).flatMap(input => input.images ?? []);
    assert.ok(!old.includes(jpeg(1)), 'the new process never got the old camera frame');
    w.kit.media.holdCamera(true); // "别看": the held frames' checks fail before anything more is written
    await w.say('嗯');
    assert.notEqual(await w.pidOf('嗯'), second, '"别看" still replaces the process');
  } finally { await w.dispose(); }
});

test('acceptance turn 2→3 was by design: a question about how the user looks takes a clear camera picture (I-084), and with keepClearFrames off (I-161 A, before I-168) a clear picture retires after use', async () => {
  const w = await world();
  try {
    assert.deepEqual((await w.say('我今天这身怎么样？')).frames.sort(), ['camera-clear', 'screen-clear'], 'the clear camera picture (and the small screen frame with it)');
    await w.say('我刚刚换的');
    const [asked, after] = await Promise.all(['我今天这身怎么样？', '我刚刚换的'].map(w.pidOf));
    assert.notEqual(after, asked, 'I-161 A: a clear frame is used once, then the process is replaced');
  } finally { await w.dispose(); }
});
