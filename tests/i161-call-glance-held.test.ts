// I-161 A (= 按推荐就行): in a call, the small 「发图片」 frames stay
// in the warm Claude process until hang-up instead of retiring it after every picture sentence; "别看", a switch off, a cleared vision
// context or hang-up drops them all at once (the process is replaced: Claude Code cannot drop one picture). The privacy gates tested here:
//  - frames never cross calls; "别看" and a switch off drop them before anything more is written to that process;
//  - only small frames of a call segment stay: a frame the user asked for, a typed turn's picture, a turn outside a call retire as before;
//  - nothing is written to disk by the app, and nothing outside the Claude Code child (the host's objects, logs, timing) keeps a frame.
// Real: PersistentClaudeChat, ClaudeChatProcess, the voice host, LookAttachments/LookTurns, MediaRuntime, CameraGlance, the segment look.
// Fake: Claude Code (tests/helpers/fake-claude-stream.ts, which logs each message's picture data per process). No camera, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { VOICE_CALL_SPOKEN_STYLE } from '../shared/voice/voice-call';
import { CALL_PAST_GLANCES_NONE_EN, CALL_PAST_GLANCES_NONE_ZH, CALL_PAST_GLANCES_NOW_EN, CALL_PAST_GLANCES_NOW_ZH, callFrameNote, callPastGlancesNote } from '../shared/brain/call-frame-note';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { callGlanceKnobs, glancesMustGo, HeldGlances, keepsGlances, readGlanceMark } from '../electron/brain/call-glances';
import { CompanionService } from '../electron/brain/companion';
import { VoiceChatHost } from '../electron/voice/voice-chat-host';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments } from '../electron/senses/look-attachments';
import { CameraGlance } from '../electron/senses/camera-glance';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { voiceLegLook } from '../electron/senses/voice-look';
import { encodeWav } from '../src/senses/MediaInput';
import { fakeClaudeStream } from './helpers/fake-claude-stream';

/** A valid JPEG data URL (the session checks the bytes); `n` makes each frame different. */
const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7, 7]).toString('base64');
const data = (url: string) => url.slice(url.indexOf(',') + 1);
const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('timed out waiting'); await wait(10); }
}
const PAST_NOW = '\n（PAST-NOW）', PAST_NONE = '\n（PAST-NONE）';

// ---------------------------------------------------------------- pure rules

test('the rule: small frames stay only in a call, only when every picture is a small frame, within the cap, and while each may still be seen', () => {
  const knobs = { stays: true, cap: 3 };
  const base = { frames: 1, glanceOnly: true, inCall: true, held: undefined, call: 1, knobs };
  assert.equal(keepsGlances(base), true);
  assert.equal(keepsGlances({ ...base, glanceOnly: false }), false, 'a frame the user asked for retires the process');
  assert.equal(keepsGlances({ ...base, inCall: false }), false, 'outside a call: one frame, one sentence, as before');
  assert.equal(keepsGlances({ ...base, knobs: { stays: false, cap: 3 } }), false, 'the knob off: as before');
  assert.equal(keepsGlances({ ...base, frames: 0 }), false);
  const held = new HeldGlances(1); held.add(3, () => true);
  assert.equal(keepsGlances({ ...base, held }), false, 'the cap');
  const other = new HeldGlances(0); other.add(1, () => true);
  assert.equal(keepsGlances({ ...base, held: other }), false, 'frames of another call');
  let seen = true;
  const live = new HeldGlances(1); live.add(1, () => seen);
  assert.equal(glancesMustGo(live, true, 1), false);
  assert.equal(glancesMustGo(live, false, 1), true, 'hang-up');
  assert.equal(glancesMustGo(live, true, 2), true, 'another call began');
  seen = false; assert.equal(glancesMustGo(live, true, 1), true, '"别看" or a switch off');
  seen = true; assert.equal(glancesMustGo(live, true, 1), true, 'latched: a later "你看看我" does not bring them back');
  const forgotten = new HeldGlances(1); forgotten.add(1, () => true); forgotten.forget();
  assert.equal(glancesMustGo(forgotten, true, 1), true);
  assert.equal(glancesMustGo(undefined, false, 1), false, 'nothing held: nothing to drop');
  const throwing = new HeldGlances(1); throwing.add(1, () => { throw Error('x'); });
  assert.equal(glancesMustGo(throwing, true, 1), true, 'a failing check counts as "may not be seen"');
  assert.deepEqual(readGlanceMark(undefined).only, false, 'typed chat: no mark');
  assert.equal(readGlanceMark({ glanceOnly: () => { throw Error('x'); }, still: () => () => true, past: () => '' }).only, false);
});

test('the past line: in her language, one for a sentence with a new small frame and one without', () => {
  assert.equal(callPastGlancesNote(true, 'zh-CN'), CALL_PAST_GLANCES_NOW_ZH);
  assert.equal(callPastGlancesNote(false, null), CALL_PAST_GLANCES_NONE_ZH);
  assert.equal(callPastGlancesNote(true, 'en'), CALL_PAST_GLANCES_NOW_EN);
  assert.equal(callPastGlancesNote(false, 'en'), CALL_PAST_GLANCES_NONE_EN);
  for (const line of [CALL_PAST_GLANCES_NOW_EN, CALL_PAST_GLANCES_NONE_EN]) assert.ok(!/[一-鿿]/.test(line));
  const knobs = callGlanceKnobs(); // shared/senses/call-look.ts
  assert.equal(typeof knobs.stays, 'boolean'); assert.ok(knobs.cap >= 1 && knobs.cap <= 90, 'under the API limit of 100 pictures a request');
});

// ---------------------------------------------------------------- which turns count as "only small frames" (the look side)

function lookKit() {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true, cameraImages: true, screenSharing: true }, 'controls');
  let shots = 0;
  const glanceKeeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const look = new LookAttachments(new LookTurns(() => 0), {
    noteActivity() {}, state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
      screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true }),
    sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => 0, opening: source => media.openings[source],
    captureScreen: async () => ({ source: 'screen', dataUrl: jpeg(200 + ++shots) }), captureCamera: async () => ({ source: 'camera', dataUrl: jpeg(150 + ++shots) }),
    glance: () => glanceKeeper.take(), seenCamera: () => glanceKeeper.seen(), holdCamera: held => { media.holdCamera(held); }, textFirst: () => true,
  });
  media.publishCamera('controls', jpeg(1));
  const turn = async (text: string) => look.admit(await look.request({ text }, { glanceEveryTurn: true }));
  const leg = async (text: string) => { const value = voiceLegLook({ request: (hint, opts) => look.request(hint, opts), admit: frames => look.admit(frames), note: () => '', glanceEveryTurn: true }, text); await value.ready; return value; };
  return { media, look, turn, leg };
}

test('only small frames count: a clear frame the user asked for, the screen, or a hand-attached snapshot do not; the check follows "别看", a switch, the context', async () => {
  const k = lookKit();
  const plain = await k.turn('你好呀');
  assert.equal(plain.glanceOnly(), true);
  assert.equal(plain.glanceStill()(), true);
  const asked = await k.turn('你看看我');
  assert.equal(asked.glanceOnly(), false, 'a clear camera frame the user asked for');
  assert.equal(asked.glanceStill()(), false, 'and it has no small frame to keep');
  const screen = await k.turn('看我屏幕');
  assert.equal(screen.glanceOnly(), false, 'a screen frame');
  assert.equal(k.look.admit([{ source: 'camera', dataUrl: jpeg(9) }]).glanceOnly(), false, 'a snapshot attached by hand');
  const held = await k.turn('你好呀');
  const still = held.glanceStill();
  k.media.holdCamera(true); // "别看"
  assert.equal(still(), false);
  k.media.holdCamera(false);
  const cleared = await k.turn('你好呀'), clearedStill = cleared.glanceStill();
  k.look.abort(); // a cleared vision context
  assert.equal(clearedStill(), false);
  const off = await k.turn('你好呀'), offStill = off.glanceStill();
  k.media.update({ cameraImages: false }, 'controls');
  assert.equal(offStill(), false, '「发图片」 off');
  // The voice segment's own view (electron/senses/voice-look.ts), what the call's session reads.
  const k2 = lookKit();
  const small = await k2.leg('今天好累'), clear = await k2.leg('你看看我');
  assert.equal(small.glanceOnly(), true);
  assert.equal(clear.glanceOnly(), false, 'a segment that asked her to look');
  const kept = small.glanceStill();
  small.drop();
  assert.equal(small.glanceOnly(), false, 'an ended segment marks nothing');
  assert.equal(kept(), true, 'a check taken before the segment ended still answers (it holds no picture)');
});

// ---------------------------------------------------------------- the session (PersistentClaudeChat), call by call

async function session(extra: { stays?: boolean; cap?: number } = {}) {
  const claude = await fakeClaudeStream();
  const infos: ClaudeTimingInfo[] = [], logs: string[] = [];
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'i161a-temp-'));
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => true, interruptGraceMs: 300, log: line => logs.push(line),
    callMaxTurns: 50, callGlances: { stays: extra.stays ?? true, cap: extra.cap ?? 40 },
    timing: { dispatched: (_id, info) => infos.push(info), firstDelta() {} } });
  const messages: ChatMessage[] = [];
  let n = 0;
  /** One sentence. `glance`: the voice host's mark (small frames only, and whether they may still be seen); none: a typed turn. */
  const task = (text: string, images: string[], glance?: { only: boolean; still: () => boolean } | null): CompanionClaudeTask => {
    messages.push({ role: 'user', content: text });
    const window = [...messages], base = '你是测试角色小桃，说话温柔。', composed = `${base}\n\n当前心情：平静。`;
    return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(composed, window); },
      imageDataUrls: images, imageTemporaryRoot: temporary, replyId: `r${++n}`,
      session: { key: 'call', basePersona: base, persona: composed, messages: window, data: () => null },
      ...(glance ? { callGlance: { glanceOnly: () => glance.only, still: () => glance.still, past: (now: boolean) => now ? PAST_NOW : PAST_NONE } } : {}) };
  };
  const finish = async (pending: Promise<{ output: string }>) => { const { output } = await pending; messages.push({ role: 'assistant', content: output }); };
  const say = (text: string, images: string[] = [], glance?: { only: boolean; still: () => boolean } | null) =>
    finish(chat.stream(task(text, images, glance), new AbortController().signal, () => {}));
  const start = (text: string, images: string[] = [], glance?: { only: boolean; still: () => boolean } | null) =>
    finish(chat.stream(task(text, images, glance), new AbortController().signal, () => {}));
  /** The process a sentence was written to, the pictures that message carried, and its private text. */
  const row = async (text: string) => {
    const found = (await claude.inputs()).find(input => input.user === text);
    assert.ok(found, `written: ${text}`);
    return found!;
  };
  const picturesOf = async (pid: number) => (await claude.inputs()).filter(input => input.pid === pid).flatMap(input => input.images ?? []);
  const dispose = async () => { chat.dispose(); await claude.cleanup(); await rm(temporary, { recursive: true, force: true }); };
  return { chat, claude, infos, logs, temporary, say, start, row, picturesOf, dispose };
}
const small = (still: () => boolean = () => true) => ({ only: true, still });

test('in a call, sentences with only a small frame stay on one warm process: each frame goes once, with its sentence; the line says which is now', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    for (let i = 1; i <= 4; i++) await s.say(`第${i}句`, [jpeg(i)], small());
    await s.say('第5句', [], small()); // a call segment that has no new frame (the mark is there, no picture)
    const rows = await Promise.all([1, 2, 3, 4, 5].map(i => s.row(`第${i}句`)));
    assert.equal(new Set(rows.map(row => row.pid)).size, 1, 'one process for the whole stretch (before I-161 A: a new one after every picture)');
    assert.deepEqual(rows.map(row => row.images), [[data(jpeg(1))], [data(jpeg(2))], [data(jpeg(3))], [data(jpeg(4))], []], 'each frame once, with its own sentence');
    assert.ok(!rows[0].prompt!.includes('PAST-'), 'nothing held yet: no line');
    assert.ok(rows.slice(1, 4).every(row => row.prompt!.includes('PAST-NOW')));
    assert.ok(rows[4].prompt!.includes('PAST-NONE'), 'a sentence without a new frame is told the held ones are past');
    assert.deepEqual(s.infos.slice(1).map(info => info.reuse), ['warm', 'warm', 'warm', 'warm']);
  } finally { await s.dispose(); }
});

test('"别看" (a frame may no longer be seen; no signal pushed): the next sentence goes to a new process that never got the old frames', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    let seen = true;
    await s.say('第1句', [jpeg(1)], small(() => seen));
    await s.say('第2句', [jpeg(2)], small(() => seen));
    const old = (await s.row('第1句')).pid;
    seen = false; // the user said "别看" (LookAttachments: the camera is held)
    await s.say('别看我');
    const next = await s.row('别看我');
    assert.notEqual(next.pid, old, 'written to a new process');
    assert.deepEqual(await s.picturesOf(next.pid), [], 'the new process never received a picture');
    assert.ok(!next.prompt!.includes('PAST-'), 'and holds none, so no line');
    assert.equal(s.infos.at(-1)!.reuse, 'image');
    await until(() => !alive(old));
  } finally { await s.dispose(); }
});

test('forgetFrames while she is idle replaces the process at once, before any next sentence', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    await s.say('第1句', [jpeg(1)], small());
    const old = (await s.row('第1句')).pid;
    s.chat.forgetFrames(); // electron/wiring/senses-look-wiring.ts: "别看", a switch off, a cleared vision context
    await until(() => !alive(old));
    await s.say('第2句');
    assert.deepEqual(await s.picturesOf((await s.row('第2句')).pid), []);
  } finally { await s.dispose(); }
});

test('forgetFrames during a reply: that reply finishes, then the process is replaced before the next sentence', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    await s.say('第1句', [jpeg(1)], small());
    const running = s.start('#hold:a 第2句', [jpeg(2)], small());
    await until(async () => (await s.claude.users()).some(text => text.includes('#hold:a')));
    s.chat.forgetFrames();
    await s.claude.release('a');
    await running;
    const old = (await s.row('第1句')).pid;
    await until(() => !alive(old));
    await s.say('第3句');
    const next = await s.row('第3句');
    assert.notEqual(next.pid, old);
    assert.deepEqual(await s.picturesOf(next.pid), []);
  } finally { await s.dispose(); }
});

test('hang-up drops them at once; the next call never sees them', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    await s.say('第1句', [jpeg(1)], small());
    await s.say('第2句', [jpeg(2)], small());
    const old = (await s.row('第1句')).pid;
    s.chat.holdWarm(false);
    await until(() => !alive(old));
    s.chat.holdWarm(true);
    await s.say('新电话');
    const next = await s.row('新电话');
    assert.notEqual(next.pid, old);
    assert.deepEqual(await s.picturesOf(next.pid), []);
  } finally { await s.dispose(); }
});

test('hang-up while a reply is running, and a new call before it ends: the frames still do not cross into the new call', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    await s.say('第1句', [jpeg(1)], small());
    const running = s.start('#hold:b 第2句', [jpeg(2)], small());
    await until(async () => (await s.claude.users()).some(text => text.includes('#hold:b')));
    s.chat.holdWarm(false);
    s.chat.holdWarm(true); // a new call starts before that reply ends
    await s.claude.release('b');
    await running;
    await s.say('新电话');
    const old = (await s.row('第1句')).pid, next = await s.row('新电话');
    assert.notEqual(next.pid, old);
    assert.deepEqual(await s.picturesOf(next.pid), []);
  } finally { await s.dispose(); }
});

test('as before: a frame the user asked for, a typed picture, a picture outside a call, the knob off, or past the cap retires the process after its sentence', async () => {
  const cases: Array<{ name: string; extra?: { stays?: boolean; cap?: number }; call: boolean; before?: number; glance: { only: boolean; still: () => boolean } | null }> = [
    { name: 'asked for ("你看看我")', call: true, glance: { only: false, still: () => true } },
    { name: 'typed chat (no mark)', call: true, glance: null },
    { name: 'outside a call', call: false, glance: small() },
    { name: 'the knob off', extra: { stays: false }, call: true, glance: small() },
    { name: 'past the cap', extra: { cap: 2 }, call: true, before: 2, glance: small() },
  ];
  for (const item of cases) {
    const s = await session(item.extra);
    try {
      if (item.call) s.chat.holdWarm(true);
      for (let i = 0; i < (item.before ?? 0); i++) await s.say(`前${i}`, [jpeg(50 + i)], small());
      await s.say('带图', [jpeg(9)], item.glance);
      await s.say('下一句');
      const pictured = await s.row('带图'), next = await s.row('下一句');
      assert.notEqual(next.pid, pictured.pid, item.name);
      assert.deepEqual(await s.picturesOf(next.pid), [], item.name);
      assert.equal(s.infos.at(-1)!.reuse, 'image', item.name);
    } finally { await s.dispose(); }
  }
});

test('nothing on disk, nothing outside the Claude Code child: no session file, no picture file, no frame in the host\'s objects, logs or timing', async () => {
  const s = await session();
  try {
    s.chat.holdWarm(true);
    const frames = [jpeg(1), jpeg(2), jpeg(3)];
    for (const [i, frame] of frames.entries()) await s.say(`第${i + 1}句`, [frame], small());
    const spawns = await s.claude.spawns();
    assert.ok(spawns.every(spawn => spawn.args.includes('--no-session-persistence')), 'Claude Code keeps no session file');
    assert.deepEqual(await readdir(s.temporary), [], 'the app wrote no picture file');
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (value: unknown, where: string, depth: number): void => {
      if (depth > 8 || value === null || seen.has(value)) return;
      if (typeof value === 'string') { if (frames.some(frame => value.includes(data(frame)))) found.push(where); return; }
      if (typeof value !== 'object') return;
      seen.add(value);
      const name = (value as object).constructor?.name ?? '';
      if (/ChildProcess|Socket|Pipe|Stream|Readable|Writable|Timeout|Immediate/.test(name)) return; // the conduit to the child itself
      for (const key of Object.keys(value as object)) walk((value as Record<string, unknown>)[key], `${where}.${key}`, depth + 1);
      if (value instanceof Map) for (const [key, entry] of value) walk(entry, `${where}[${String(key)}]`, depth + 1);
    };
    walk(s.chat, 'chat', 0);
    assert.deepEqual(found, [], 'no frame kept by the host after it was written');
    assert.ok(![...s.logs, JSON.stringify(s.infos)].some(line => frames.some(frame => line.includes(data(frame)))), 'logs and timing carry no picture');
  } finally { await s.dispose(); }
});

// ---------------------------------------------------------------- the whole call path: voice host, look rules, session

async function call(options: { language?: 'zh-CN' | 'en' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i161a-call-'));
  const service = new CompanionService(directory, () => {});
  await service.load();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.provider.kind = 'claude'; settings.provider.model = 'haiku';
  await service.context('fixture-character', settings.provider, '公开原创角色');
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true }, 'controls');
  let generation = 0, cameraShots = 0;
  const glanceKeeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => false, signal: () => null, opening: () => media.openings.camera });
  const look = new LookAttachments(new LookTurns(() => 0), {
    noteActivity: () => { generation++; },
    state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
      screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true }),
    sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => generation, opening: source => media.openings[source],
    captureScreen: async () => null,
    captureCamera: async () => { cameraShots++; return media.sharesCameraFrames() && !media.state.cameraHeld ? { source: 'camera', dataUrl: jpeg(100 + cameraShots) } : null; },
    glance: () => glanceKeeper.take(), seenCamera: () => glanceKeeper.seen(),
    holdCamera: held => { media.holdCamera(held); }, // no push to the session here: the check before each write must hold on its own
    textFirst: () => true,
  });
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script],
    provider: () => ({ kind: 'claude', model: 'haiku' }), chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, callMaxTurns: 50 });
  const pending = new Set<string>(), asr: string[] = [];
  let done = 0;
  const host = new VoiceChatHost({
    broadcast() {}, memoryChanged() {}, windowVisible: () => true, media: () => media.state, turnOffVoiceInput() {},
    speechScope: () => 'scope', settings: () => settings,
    companion: () => ({ beginVoiceGroup: (...args: Parameters<CompanionService['beginVoiceGroup']>) => service.beginVoiceGroup(...args) }),
    ambient: () => null, reserveChat: id => { if (pending.size) return false; pending.add(id); return true; }, releaseChat: id => { pending.delete(id); },
    userTurn() {}, activityChanged() {}, cancelProactive() {}, callStyle: () => VOICE_CALL_SPOKEN_STYLE,
    claude: { stream: async (...args: Parameters<PersistentClaudeChat['stream']>) => { try { return await chat.stream(...args); } finally { done++; } },
      regroup: (ids, shown) => chat.regroup(ids, shown) },
    languageProfile: () => null, chatDirectory: () => directory, tempDirectory: () => directory,
    transcribe: async () => asr.shift() ?? '', stopReading() {}, prepareSpeech() {},
    // As electron/wiring/senses-voice-input-wiring.ts wires it, with the every-sentence small frame on (the switch the user decides later).
    look: text => voiceLegLook({ request: (hint, opts) => look.request(hint, opts), admit: frames => look.admit(frames),
      note: frames => callFrameNote(frames, options.language), past: now => callPastGlancesNote(now, options.language), glanceEveryTurn: true }, text),
  });
  const binding = host.open(77, 'controls');
  let seq = 0;
  const say = async (text: string) => {
    asr.push(text);
    const before = done;
    host.pipeline.submit(77, { captureSessionId: binding.captureSessionId, captureSeq: ++seq, wav: encodeWav(new Float32Array(4096).fill(0.1)) });
    host.pipeline.finishSpeaking(77, binding.captureSessionId);
    const began = Date.now();
    for (let i = 0; i < 2000 && done === before; i++) await wait();
    assert.ok(done > before, 'answered: ' + text);
    if (process.env.I161A_TIMING) console.log(text, Date.now() - began);
    for (let i = 0; i < 400 && pending.size; i++) await wait();
    await host.drain();
  };
  const row = async (text: string) => {
    const found = (await claude.inputs()).find(input => input.user !== undefined && input.user.includes(text));
    assert.ok(found, `written: ${text}`);
    return found!;
  };
  const picturesOf = async (pid: number) => (await claude.inputs()).filter(input => input.pid === pid).flatMap(input => input.images ?? []);
  const dispose = async () => { host.dispose(); await host.drain(); chat.dispose(); await service.flush(); await claude.cleanup(); await rm(directory, { recursive: true, force: true }); };
  return { media, chat, say, row, picturesOf, dispose, keepSmall: (n: number) => media.publishCamera('controls', jpeg(n)), shots: () => cameraShots };
}

test('the call path: small frames stay on one process sentence after sentence; "别看我" goes to a new process with no old frame; "你看看我" still retires', async () => {
  const h = await call();
  try {
    h.chat.holdWarm(true);
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    await h.say('你好呀');
    h.keepSmall(2);
    await h.say('今天好累');
    const first = await h.row('你好呀'), second = await h.row('今天好累');
    assert.equal(second.pid, first.pid, 'the warm process continues after a small frame');
    assert.deepEqual([first.images, second.images], [[data(jpeg(1))], [data(jpeg(2))]]);
    assert.ok(second.prompt!.includes(CALL_PAST_GLANCES_NOW_ZH));
    await h.say('别看我');
    const no = await h.row('别看我');
    assert.notEqual(no.pid, first.pid, '"别看": written to a new process');
    assert.deepEqual(await h.picturesOf(no.pid), [], 'which never got the old small frames');
    await h.say('你看看我');
    const asked = await h.row('你看看我');
    assert.deepEqual(asked.images, [data(jpeg(101))], 'a clear frame the user asked for');
    await h.say('好看吗');
    const after = await h.row('好看吗');
    assert.notEqual(after.pid, asked.pid, 'a frame the user asked for still retires the process after its sentence');
    assert.deepEqual(await h.picturesOf(after.pid), []);
  } finally { await h.dispose(); }
});

test('the call path: 「发图片」 turned off mid-call (no push) and hang-up: nothing held goes on', async () => {
  const h = await call({ language: 'en' });
  try {
    h.chat.holdWarm(true);
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(1);
    await h.say('你好呀');
    h.media.update({ cameraImages: false }, 'controls'); // a new opening: the held frame's ticket check fails
    await h.say('今天好累');
    const first = await h.row('你好呀'), second = await h.row('今天好累');
    assert.notEqual(second.pid, first.pid);
    assert.deepEqual(await h.picturesOf(second.pid), []);
    assert.ok(!second.prompt!.includes(CALL_PAST_GLANCES_NONE_EN), 'a new process holds nothing: no line');
    h.media.update({ cameraImages: true }, 'controls');
    h.keepSmall(3);
    await h.say('再来');
    assert.ok((await h.row('再来')).prompt!.includes('\n【此刻的感知】'), 'small frames come back with the switch');
    h.chat.holdWarm(false);
    h.chat.holdWarm(true);
    h.keepSmall(4);
    await h.say('新电话');
    const fresh = await h.row('新电话');
    assert.notEqual(fresh.pid, (await h.row('再来')).pid, 'hang-up: a new call starts on a process without them');
    assert.deepEqual(await h.picturesOf(fresh.pid), [data(jpeg(4))], 'only the new call\'s own small frame');
  } finally { await h.dispose(); }
});
