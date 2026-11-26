// I-166.
// What is tested here, the privacy gates first:
//  - a small frame per sense only while that sense is on; "别看" (and a no it cannot read) holds it; the senses start off;
//  - her hidden marker is filtered everywhere (never shown, archived, read), and a missed one is still dropped by the speech-beat filter;
//  - the closer look: a clear frame only while the sense is on; it goes to the SAME warm process as a continuation; the reply and the
//    continuation are one reply (one turn, finished once); a newer message, a stop, "别看" or the switch off cancel it and nothing revives;
//  - small frames stay in the warm process outside calls too (up to the cap); "别看" still replaces the process before anything more is written;
//  - the haiku look judgment no longer gets camera or screen; the chat self-look is skipped when a small camera frame went.
// Real: PersistentClaudeChat, ClaudeChatProcess, LookAttachments/LookTurns, MediaRuntime, CameraGlance, LookContinuation, the chat turn's wiring.
// Fake: Claude Code (tests/helpers/fake-claude-stream.ts), the captures. No camera, no screen, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import type { ChatMessage } from '../shared/foundation/chat';
import { LookMarkerFilter, stripLookMarkers, LOOK_MARKER } from '../shared/senses/see-and-say/marker';
import { chatSelfLookWanted, closerLookNote, judgedSenses, seeAndSayLine } from '../shared/senses/see-and-say/words';
import { SEE_AND_SAY } from '../shared/senses/see-and-say/knobs';
import { filterSpeechBeats } from '../shared/behaviors/speech-beats/choose';
import { perceptionTurnLine, perceptionTurnState, SCREEN_SMALL_LINE, GLANCE_LINE } from '../shared/brain/perception-rule';
import { callFrameNote } from '../shared/brain/call-frame-note';
import { buildJournalEntry } from '../shared/memory/journal';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { glancesMustGo, HeldGlances, keepsGlances, OUTSIDE_CALL } from '../electron/brain/call-glances';
import { LookContinuation, lookStream, type CloserLookEntry, type ContinuableChat } from '../electron/brain/look-continuation';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments } from '../electron/senses/look-attachments';
import { CameraGlance } from '../electron/senses/camera-glance';
import { SmallScreenFrames } from '../electron/senses/small-frames';
import { MediaRuntime, type CameraPolicy } from '../electron/senses/media-runtime';
import { seeAndSay, wireSeeAndSay } from '../electron/wiring/see-and-say-wiring';
import { fakeClaudeStream } from './helpers/fake-claude-stream';
import { chatWorld, settle } from './helpers/chat-world';

const jpeg = (n: number) => 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224, n, 7, 7, 7, 7]).toString('base64');
const data = (url: string) => url.slice(url.indexOf(',') + 1);
const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the marker

test('the marker leaves the stream wherever it is split, only look markers are taken, and a missed one is still dropped downstream', () => {
  assert.deepEqual(stripLookMarkers('嗯？让我看看⟦look-camera⟧').marks, ['camera']);
  assert.equal(stripLookMarkers('嗯？让我看看⟦look-camera⟧').text, '嗯？让我看看');
  for (const spelling of ['⟦look:screen⟧', '⟦LOOK-SCREEN⟧', '⟦look screen⟧']) assert.deepEqual(stripLookMarkers(`a${spelling}b`), { text: 'ab', marks: ['screen'], at: [1] });
  const filter = new LookMarkerFilter();
  const chunks = ['好', '⟦lo', 'ok-ca', 'mera⟧', '……', '⟦tilt⟧', '嗯'].map(chunk => filter.push(chunk));
  const tail = filter.end();
  assert.equal(chunks.map(chunk => chunk.text).join('') + tail.text, '好……⟦tilt⟧嗯', 'a speech-beat marker is handed on unchanged');
  assert.deepEqual(chunks.flatMap(chunk => chunk.marks), ['camera']);
  assert.equal(stripLookMarkers('⟦look-ca').text, '⟦look-ca', 'an unclosed one goes on, for the speech-beat filter to drop');
  assert.equal(filterSpeechBeats('看看⟦look-camera⟧好').text, '看看好', 'belt and braces: the speech-beat filter drops a look marker whole');
  assert.equal(filterSpeechBeats('看看⟦look-ca').text, '看看', 'and an unclosed one');
  assert.equal(stripLookMarkers('⟦look-sky⟧').text, '⟦look-sky⟧', 'a sense that does not exist is not a look');
  assert.equal(LOOK_MARKER.camera, '⟦look-camera⟧');
});

test('her paragraph: only while a sense gives pictures, in her card language, naming only the markers of senses that are on', () => {
  assert.equal(seeAndSayLine({ camera: false, screen: false }, 'zh-CN'), '');
  const zh = seeAndSayLine({ camera: true, screen: false }, 'zh-CN');
  assert.ok(zh.includes('⟦look-camera⟧') && !zh.includes('⟦look-screen⟧') && zh.includes('说多少由你'));
  const en = seeAndSayLine({ camera: true, screen: true }, 'en');
  assert.ok(en.includes('⟦look-camera⟧ or ⟦look-screen⟧') && !/[一-鿿]/u.test(en));
  assert.ok(zh.length < 130, `short (R28; I-168 added one clause about "别看"): ${zh.length}`);
  assert.ok(!/[一-鿿]/u.test(closerLookNote('screen', false, 'en')));
  assert.ok(closerLookNote('camera', true, 'zh-CN').includes('不是用户在说话'));
});

test('the haiku look judgment no longer gets camera or screen (hearing stays); the chat self-look is skipped after a small camera frame', () => {
  assert.deepEqual(judgedSenses({ camera: true, screen: true, transcript: true }), { camera: false, screen: false, transcript: true });
  assert.deepEqual(judgedSenses({ camera: true, screen: true, transcript: false }, { haikuLook: true }), { camera: true, screen: true, transcript: false });
  assert.equal(SEE_AND_SAY.haikuLook, false, 'the shipped knob (I-166 "不需要haiku")');
  // The app's sense router reads its senses through that rule (electron/wiring/initiative-look-wiring.ts; read as text: 'electron/wiring/initiative-look-wiring.ts').
  assert.match(readFileSync('electron/wiring/initiative-look-wiring.ts', 'utf8'), /\n\s*on: \(\) => judgedSenses\(\{ camera:/);
  // Voice input and calls go through the same closer look (and its marker filter) as typed chat (read as text: 'electron/wiring/senses-voice-input-wiring.ts').
  assert.match(readFileSync('electron/wiring/senses-voice-input-wiring.ts', 'utf8'), /claude: \{ stream: \(task, signal, emit, control\) => \(seeAndSay \? seeAndSay\.stream\(claudeChat\)\(task, signal, emit, control\)/);
  assert.equal(chatSelfLookWanted(true, true), false, 'a fresh small frame: no second look');
  assert.equal(chatSelfLookWanted(true, false), true, 'no small frame: her own look as before');
  assert.equal(chatSelfLookWanted(false, false), false);
});

// ---------------------------------------------------------------- small frames per sense (LookAttachments)

function lookKit(over: { seeAndSay?: boolean; screen?: boolean; camera?: boolean; kept?: boolean; fresh?: () => Promise<{ source: 'camera'; dataUrl: string } | null>; smallWaitMs?: number } = {}) {
  const policy: CameraPolicy = { mode: () => 'share', blocked: () => 'needs-component' };
  const media = new MediaRuntime(undefined, policy);
  media.update({ voiceInput: true, cameraImages: over.camera !== false, screenSharing: over.screen !== false }, 'controls');
  let shots = 0; const captured: string[] = [], smallCalls: string[] = [], journal: { camera: boolean; screen: boolean }[] = [];
  const turns = new LookTurns(() => 0);
  const keeper = new CameraGlance({ frame: () => media.cameraAttachment(), poseOn: () => true, signal: () => null, opening: () => media.openings.camera });
  const state = () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `c|${media.revision}`,
    screenOpening: media.openings.screen, cameraHeld: media.state.cameraHeld === true });
  const look = new LookAttachments(turns, {
    noteActivity() {}, state, sharesCameraFrames: () => media.sharesCameraFrames(), revision: () => media.revision, generation: () => 0, opening: source => media.openings[source],
    captureScreen: async () => { captured.push('screen'); return { source: 'screen', dataUrl: jpeg(200 + ++shots) }; }, captureCamera: async () => { captured.push('camera'); return { source: 'camera', dataUrl: jpeg(150 + ++shots) }; },
    glance: everyTurn => keeper.take(everyTurn), seenCamera: () => keeper.seen(), holdCamera: held => { media.holdCamera(held); }, textFirst: () => true,
    seeAndSay: () => over.seeAndSay !== false, smallWaitMs: () => over.smallWaitMs ?? 200,
    smallScreen: async () => { smallCalls.push('screen'); return { source: 'screen', dataUrl: jpeg(90) }; },
    freshGlance: over.fresh ?? (async () => { smallCalls.push('fresh'); return { source: 'camera', dataUrl: jpeg(91) }; }),
    smallFrames: senses => journal.push(senses),
  });
  if (over.kept !== false && over.camera !== false) media.publishCamera('controls', jpeg(1));
  const turn = async (text: string) => look.admit(await look.request({ text }));
  return { media, look, turns, turn, smallCalls, journal, state, captured };
}

test('every turn carries a small frame from each sense that is on, and only from those (the senses start off)', async () => {
  const both = lookKit();
  const frames = await both.turn('今天好累');
  assert.deepEqual(frames.current().map(frame => frame.source).sort(), ['camera', 'screen']);
  assert.equal(frames.glanceOnly(), true, 'both small: the warm process may keep them');
  assert.equal(frames.screenGlance(), true);
  assert.equal(frames.screenVia(), null, 'the small screen frame is not a look');
  assert.equal(frames.asked().length, 0, 'nor something the user asked for');
  assert.deepEqual(both.journal.at(-1), { camera: true, screen: true });
  const cameraOnly = lookKit({ screen: false });
  assert.deepEqual((await cameraOnly.turn('嗨')).current().map(frame => frame.source), ['camera']);
  assert.ok(!cameraOnly.smallCalls.includes('screen'), 'sharing off: the screen is never asked');
  const screenOnly = lookKit({ camera: false });
  assert.deepEqual((await screenOnly.turn('嗨')).current().map(frame => frame.source), ['screen']);
  const none = lookKit({ camera: false, screen: false });
  assert.deepEqual((await none.turn('嗨')).current(), [], 'a window with its senses off: nothing at all');
  assert.deepEqual(none.smallCalls, []);
  const old = lookKit({ seeAndSay: false });
  assert.deepEqual((await old.turn('嗨')).current(), [], 'the knob off: text first as before (no small frames on a typed turn)');
});

test('"别看" holds the small frames: the camera\'s and the screen\'s, also for the turns after it; a no it cannot read takes none', async () => {
  const k = lookKit();
  const refused = await k.turn('别看我');
  assert.ok(!refused.current().some(frame => frame.source === 'camera'), 'the camera holds');
  const screenNo = await k.turn('别看我屏幕');
  assert.ok(!screenNo.current().some(frame => frame.source === 'screen'), 'the screen holds');
  const after = await k.turn('今天吃了面');
  assert.deepEqual(after.current(), [], 'both still held on the next turn');
  const back = await k.turn('你看看我');
  assert.ok(back.current().some(frame => frame.source === 'camera' && !back.cameraGlance()), 'asked again: a clear one up front (the fast path)');
  // A frame taken, then "别看" before it is written: dropped where Claude would get it.
  const k2 = lookKit();
  const turn = await k2.turn('嗨');
  k2.media.holdCamera(true);
  assert.ok(!turn.current().some(frame => frame.source === 'camera'), 'a "别看" after the frame was taken drops it');
  k2.media.update({ screenSharing: false }, 'controls');
  assert.deepEqual(turn.current(), [], 'sharing off drops the screen\'s');
});

test('out in full-screen the kept camera frame is stale: one is taken now and shrunk; a frame that is not ready does not hold the turn', async () => {
  const stale = lookKit({ kept: false, screen: false });
  const turn = await stale.turn('嗨');
  assert.deepEqual(stale.smallCalls, ['fresh']);
  assert.equal(turn.current()[0]?.dataUrl, jpeg(91));
  assert.equal(turn.cameraGlance(), true, 'and it counts as the small frame');
  const slow = lookKit({ kept: false, screen: false, smallWaitMs: 20, fresh: () => new Promise(resolve => setTimeout(() => resolve({ source: 'camera', dataUrl: jpeg(92) }), 500)) });
  const started = Date.now();
  const late = await slow.turn('嗨');
  assert.ok(Date.now() - started < 400, 'waited at most smallWaitMs');
  assert.deepEqual(late.current(), [], 'this turn goes without it');
});

test('her closer look\'s clear frame: only while that sense is on and not held; a "别看" or a switch off after it was taken empties it', async () => {
  const k = lookKit();
  const camera = await k.look.closer('camera', new AbortController().signal);
  assert.ok(camera && camera.dataUrls().length === 1);
  k.media.holdCamera(true);
  assert.deepEqual(camera!.dataUrls(), [], '"别看" after it was taken');
  const before = k.captured.length;
  assert.equal(await k.look.closer('camera', new AbortController().signal), null, 'held: nothing is taken');
  assert.equal(k.captured.length, before, 'not even captured');
  const screen = await k.look.closer('screen', new AbortController().signal);
  assert.ok(screen && screen.dataUrls().length === 1);
  k.media.update({ screenSharing: false }, 'controls');
  assert.deepEqual(screen!.dataUrls(), [], 'sharing off after it was taken');
  const beforeOff = k.captured.length;
  assert.equal(await k.look.closer('screen', new AbortController().signal), null, 'off: nothing is taken');
  assert.equal(k.captured.length, beforeOff, 'not even captured');
  const k2 = lookKit();
  await k2.turn('别看我屏幕');
  assert.equal(await k2.look.closer('screen', new AbortController().signal), null, 'the screen\'s "别看" holds her closer look too');
});

test('the screen\'s small frame: taken on typing and reused while fresh, forgotten when its key changes, nothing taken without a key', async () => {
  let key = 'k1', now = 0, takes = 0;
  const frames = new SmallScreenFrames({ capture: async () => `${jpeg(++takes)}`, key: () => key, now: () => now, freshMs: () => 1000 });
  frames.prefetch();
  await wait();
  const first = await frames.take(new AbortController().signal);
  assert.equal(takes, 1, 'the typing capture is reused');
  assert.equal(first?.dataUrl, jpeg(1));
  now = 2000;
  await frames.take(new AbortController().signal);
  assert.equal(takes, 2, 'stale: taken again');
  key = 'k2';
  const other = await frames.take(new AbortController().signal);
  assert.equal(takes, 3, 'another opening or a "别看": the kept one is never used');
  assert.equal(other?.dataUrl, jpeg(3));
  key = '';
  assert.equal(await frames.take(new AbortController().signal), null, 'sharing off or held: nothing is taken');
  assert.equal(takes, 3);
});

test('her turn line says the small screen picture is not a look and its text is unreadable; a voice segment says the same', () => {
  const runtime = { screenSharing: true, cameraSharing: true, cameraImages: true };
  const both = perceptionTurnState(runtime, [{ source: 'screen' }, { source: 'camera' }], '嗨', { cameraGlance: true, screenSmall: true });
  const line = perceptionTurnLine(both);
  assert.ok(line.includes(SCREEN_SMALL_LINE) && line.includes(GLANCE_LINE), line);
  assert.ok(!line.includes('用户叫你看屏幕'), 'never "the user asked you to look"');
  assert.equal(callFrameNote({ screen: true, camera: false, glance: true, missed: false, screenSmall: true }, 'zh-CN').includes(SCREEN_SMALL_LINE), true);
});

// ---------------------------------------------------------------- the warm process keeps small frames outside calls

test('outside a call, small frames stay in the warm process (up to the cap); "别看" replaces it before anything more is written', () => {
  const knobs = { stays: true, cap: 4, outside: true };
  const base = { frames: 2, glanceOnly: true, inCall: false, held: undefined, call: 0, knobs };
  assert.equal(keepsGlances(base), true);
  assert.equal(keepsGlances({ ...base, knobs: { stays: true, cap: 4 } }), false, 'without the knob: as before');
  const held = new HeldGlances(OUTSIDE_CALL); held.add(2, () => true, OUTSIDE_CALL);
  assert.equal(keepsGlances({ ...base, held }), true, 'two more fit');
  held.add(2, () => true, OUTSIDE_CALL);
  assert.equal(keepsGlances({ ...base, held }), false, 'the cap');
  let seen = true;
  const live = new HeldGlances(OUTSIDE_CALL); live.add(1, () => seen, OUTSIDE_CALL);
  assert.equal(glancesMustGo(live, false, 0), false);
  assert.equal(glancesMustGo(live, true, 3), false, 'a call may start on them');
  seen = false;
  assert.equal(glancesMustGo(live, false, 0), true, '"别看" or a switch off');
  const joined = new HeldGlances(OUTSIDE_CALL); joined.add(1, () => true, OUTSIDE_CALL);
  assert.equal(keepsGlances({ ...base, inCall: true, call: 3, held: joined }), true, 'a call frame may join them');
  joined.add(1, () => true, 3);
  assert.equal(joined.call, 3, 'and then they belong to that call');
  assert.equal(glancesMustGo(joined, false, 3), true, 'so hang-up drops them all');
});

async function session() {
  const claude = await fakeClaudeStream();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [claude.script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, callGlances: { stays: true, cap: 6, outside: true } });
  const messages: ChatMessage[] = [];
  let n = 0;
  const task = (text: string, images: string[], still?: () => boolean): CompanionClaudeTask => {
    messages.push({ role: 'user', content: text });
    const window = [...messages], base = '你是测试角色小桃。';
    return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(base, window); },
      imageDataUrls: images, replyId: `r${++n}`, session: { key: 'typed', basePersona: base, persona: base, messages: window, data: () => null },
      ...(still ? { callGlance: { glanceOnly: () => true, still: () => still, past: () => '' } } : {}) };
  };
  const pidOf = async (text: string) => (await claude.inputs()).find(input => input.user === text)?.pid;
  return { claude, chat, messages, task, pidOf, dispose: async () => { chat.dispose(); await claude.cleanup(); } };
}

test('typed turns with small frames stay on one warm process; a "别看" in between starts a new one that never sees the old frames', async () => {
  const s = await session();
  try {
    let seen = true;
    for (const [index, text] of ['一', '二', '三'].entries()) {
      const { output } = await s.chat.stream(s.task(text, [jpeg(index + 1), jpeg(index + 11)], () => seen), new AbortController().signal, () => {});
      s.messages.push({ role: 'assistant', content: output });
    }
    const pids = await Promise.all(['一', '二', '三'].map(s.pidOf));
    assert.equal(new Set(pids).size, 1, `one warm process for three picture turns: ${pids}`);
    seen = false; // "别看"
    const { output } = await s.chat.stream(s.task('四', []), new AbortController().signal, () => {});
    s.messages.push({ role: 'assistant', content: output });
    const fourth = await s.pidOf('四');
    assert.notEqual(fourth, pids[0], 'a new process');
    const pictures = (await s.claude.inputs()).filter(input => input.pid === fourth).flatMap(input => input.images ?? []);
    assert.deepEqual(pictures, [], 'with none of the old frames');
  } finally { await s.dispose(); }
});

// ---------------------------------------------------------------- the closer look (LookContinuation + the real session)

function continuationKit(s: Awaited<ReturnType<typeof session>>, over: { on?: () => boolean; capture?: (signal: AbortSignal) => Promise<{ dataUrls(): string[] } | null>; timeoutMs?: number } = {}) {
  const entries: CloserLookEntry[] = [];
  const look = new LookContinuation({ senses: () => ({ camera: over.on ? over.on() : true, screen: false }), capture: async (_sense, signal) => over.capture ? over.capture(signal) : { dataUrls: () => [jpeg(77)] },
    note: (sense, seen, off) => `CONTINUE-${sense}-${off ? 'off' : seen ? 'seen' : 'missed'}`, journal: entry => entries.push(entry), knobs: { closerLook: true, closerTimeoutMs: over.timeoutMs ?? 2000, dots: '……' } });
  const run = async (text: string, signal = new AbortController().signal, control?: Parameters<LookContinuation['stream']>[4]) => {
    let shown = '';
    const outcome = await look.stream(s.chat, s.task(text, []), signal, (type, delta) => { if (type === 'delta') shown += delta; }, control);
    s.messages.push({ role: 'assistant', content: shown });
    return { outcome, shown };
  };
  return { look, entries, run };
}

test('her marker: a clear frame goes to the SAME warm process as a continuation, into the same reply; the marker is never shown', async () => {
  const s = await session();
  try {
    const k = continuationKit(s);
    const { shown, outcome } = await k.run('看看我今天⟦look-camera⟧');
    assert.ok(!shown.includes('⟦') && !shown.includes('look-camera'), shown);
    assert.ok(shown.startsWith('好哒，看看我今天……'), shown);
    assert.ok(shown.includes('好哒，CONTINUE-camera-seen'), 'her continuation streams into the same reply');
    assert.ok(!shown.includes('<sh-state') || shown.indexOf('<sh-state') > shown.indexOf('CONTINUE'), 'the first part\'s tail after the marker is held back');
    assert.equal(outcome.superseded, false);
    const inputs = (await s.claude.inputs()).filter(input => input.user !== undefined);
    assert.equal(inputs.at(-1)?.user, 'CONTINUE-camera-seen');
    assert.equal(inputs.at(-1)?.pid, inputs.at(-2)?.pid, 'the same warm process');
    assert.deepEqual(inputs.at(-1)?.images, [data(jpeg(77))], 'with the clear frame');
    assert.deepEqual(k.entries.map(entry => entry.outcome), ['taken']);
    assert.ok(typeof k.entries[0].ms === 'number');
    // A clear frame retires the process afterwards (as any clear frame); the next turn still lines up and goes out.
    const next = await s.chat.stream(s.task('然后呢', []), new AbortController().signal, () => {});
    assert.ok(next.output.includes('然后呢'));
  } finally { await s.dispose(); }
});

test('the sense off: no continuation, her reply ends as she wrote it; a timeout: she goes on without a picture', async () => {
  const s = await session();
  try {
    const off = continuationKit(s, { on: () => false });
    const { shown } = await off.run('你看⟦look-camera⟧');
    assert.deepEqual(off.entries.map(entry => entry.outcome), ['off']);
    assert.ok(!shown.includes('CONTINUE') && !shown.includes('……'), shown);
    assert.ok(shown.includes('<sh-state') || shown.endsWith('你看'), 'the held rest goes out');
    const slow = continuationKit(s, { capture: signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 30 });
    const late = await slow.run('再看⟦look-camera⟧');
    assert.ok(late.shown.includes('CONTINUE-camera-missed'), late.shown);
    assert.deepEqual(slow.entries.map(entry => [entry.outcome, entry.why]), [['failed', 'timeout']]);
    const last = (await s.claude.inputs()).filter(input => input.user !== undefined).at(-1);
    assert.deepEqual(last?.images, [], 'no picture went');
  } finally { await s.dispose(); }
});

test('"别看" while she waits, a newer message (supersede) or a stop cancel it; a frame that comes later never revives it', async () => {
  const s = await session();
  try {
    let on = true, resolveLate: ((value: { dataUrls(): string[] }) => void) | null = null;
    const held = continuationKit(s, { on: () => on, capture: () => new Promise(resolve => { on = false; resolve({ dataUrls: () => [jpeg(5)] }); }) });
    const a = await held.run('看⟦look-camera⟧');
    assert.deepEqual(held.entries.map(entry => [entry.outcome, entry.why]), [['cancelled', 'held']]);
    assert.ok(!a.shown.includes('CONTINUE'));
    const before = (await s.claude.users()).length;
    let cut: (() => boolean) | null = null;
    const superseded = continuationKit(s, { capture: () => new Promise(resolve => { resolveLate = resolve; queueMicrotask(() => { cut?.(); }); }) });
    const b = await superseded.run('看⟦look-camera⟧', new AbortController().signal, { started: supersede => { cut = supersede; } });
    assert.equal(b.outcome.superseded, true);
    assert.deepEqual(superseded.entries.map(entry => [entry.outcome, entry.why]), [['cancelled', 'superseded']]);
    resolveLate!({ dataUrls: () => [jpeg(6)] }); // the frame arrives after the cut
    await wait(50);
    assert.equal((await s.claude.users()).length, before + 1, 'only her first part was written; no continuation, now or later');
    const controller = new AbortController();
    const stopped = continuationKit(s, { capture: () => new Promise(() => { controller.abort(); }) });
    await assert.rejects(stopped.run('看⟦look-camera⟧', controller.signal));
    assert.deepEqual(stopped.entries.map(entry => [entry.outcome, entry.why]), [['cancelled', 'stopped']]);
    assert.equal((await s.claude.users()).length, before + 2);
  } finally { await s.dispose(); }
});

test('a marker in her continuation is never shown and never starts a second look (one closer look per message)', async () => {
  let continued = 0;
  const chat = { stream: async (_task: CompanionClaudeTask, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => { emit('delta', 'a⟦look-camera⟧'); return { superseded: false, output: '' }; },
    continueReply: async (_task: CompanionClaudeTask, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => { continued++; emit('delta', 'b⟦look-'); emit('delta', 'screen⟧c'); return { superseded: false, output: '' }; } };
  const look = new LookContinuation({ senses: () => ({ camera: true, screen: true }), capture: async () => ({ dataUrls: () => [jpeg(1)] }), note: () => 'N' });
  let shown = '';
  await look.stream(chat, {} as CompanionClaudeTask, new AbortController().signal, (_type, text) => { shown += text; });
  assert.equal(shown, 'a……bc');
  assert.equal(continued, 1);
});

test('the session continues only the newest turn, and never a process holding small frames that may no longer be seen', async () => {
  const s = await session();
  try {
    let seen = true;
    const first = s.task('一', [jpeg(1)], () => seen);
    const { output } = await s.chat.stream(first, new AbortController().signal, () => {});
    s.messages.push({ role: 'assistant', content: output });
    const more = (replyId: string) => ({ ...first, replyId, imageDataUrls: [], prompt: 'MORE', callGlance: undefined }) as CompanionClaudeTask;
    assert.equal(await s.chat.continueReply(more('r-other'), new AbortController().signal, () => {}), null, 'another turn: nothing to continue');
    seen = false; // "别看"
    assert.equal(await s.chat.continueReply(more(first.replyId!), new AbortController().signal, () => {}), null, 'held frames may not be seen: not written to');
    assert.ok(!(await s.claude.users()).includes('MORE'));
  } finally { await s.dispose(); }
});

test('no warm process to continue: the held rest of her reply goes out instead, nothing else is sent', async () => {
  const chat = { stream: async (_task: CompanionClaudeTask, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => { emit('delta', '好⟦look-screen⟧<tail>'); return { superseded: false, output: '' }; },
    continueReply: async () => null };
  const entries: CloserLookEntry[] = [];
  const look = new LookContinuation({ senses: () => ({ camera: false, screen: true }), capture: async () => ({ dataUrls: () => [jpeg(1)] }), note: () => 'N', journal: entry => entries.push(entry) });
  let shown = '';
  await look.stream(chat, {} as CompanionClaudeTask, new AbortController().signal, (_type, text) => { shown += text; });
  assert.equal(shown, '好……<tail>');
  assert.deepEqual(entries.map(entry => [entry.outcome, entry.why]), [['cancelled', 'no-process']]);
});

// ---------------------------------------------------------------- the chat turn (wiring): one reply, archived once

test('in the chat turn the continuation is part of the same reply: finished once, its marker never reaches her turn', async () => {
  const look = new LookContinuation({ senses: () => ({ camera: true, screen: false }), capture: async () => ({ dataUrls: () => [jpeg(1)] }), note: (_s, seen) => `NOTE-${seen}`,
    knobs: { closerLook: true, closerTimeoutMs: 500, dots: '……' } });
  const world = chatWorld({ stream: ['我看看', '⟦look-ca', 'mera⟧'], continuation: ['你在笑'], seeAndSay: { continuation: look, line: () => '\nSEE', stream: (chat: ContinuableChat) => lookStream(chat, { continuation: look }), glanceMark: (frames: { glanceOnly(): boolean; glanceStill(): () => boolean }) => ({ glanceOnly: () => frames.glanceOnly(), still: () => frames.glanceStill(), past: () => '' }) } });
  world.send('r1', '你看我');
  await settle(() => world.settled('r1'), 'the turn ended');
  assert.deepEqual(world.finishes, ['complete'], 'one reply, finished (archived) once');
  const pushed = world.log.filter(line => line.startsWith('push delta')).map(line => line.slice('push delta '.length)).join('');
  assert.equal(pushed, '我看看……你在笑');
  assert.ok(world.log.some(line => line.startsWith('continue images=1 prompt=NOTE-true')));
  assert.ok(String((world.tasks[0] as { prompt: string }).prompt).includes('SEE'), 'her paragraph is in the turn');
  const mark = (world.tasks[0] as { callGlance?: { glanceOnly(): boolean; still(): () => boolean } }).callGlance;
  assert.equal(mark?.glanceOnly(), false, 'the turn\'s small frames decide (none here)');
  assert.equal(mark?.still()(), false, 'and their check is the turn\'s own (a "别看" drops them)');
  // Superseded by a newer message: the turn is stopped, the continuation never runs.
  const stopping = chatWorld({ stream: ['看⟦look-camera⟧'], continuation: ['不该出现'], hold: true, seeAndSay: { continuation: look, line: () => '', stream: (chat: ContinuableChat) => lookStream(chat, { continuation: look }), glanceMark: () => undefined } });
  stopping.send('r2', '你看我');
  await wait(20);
  stopping.cancel(1, 'r2');
  stopping.release();
  await settle(() => stopping.settled('r2'), 'stopped');
  assert.ok(!stopping.log.some(line => line.startsWith('continue')), 'a stopped turn never continues');
  assert.deepEqual(stopping.finishes, ['stopped']);
});

test('the app\'s wiring: a typed turn\'s mark asks the turn\'s own checks; her paragraph and closer look follow the senses; journal words are closed', async () => {
  const k = lookKit();
  const journal: unknown[] = [];
  let senses = { camera: true, screen: false };
  const see = wireSeeAndSay({ seeing: () => senses, screenKey: () => 'k', thumbnail: async () => null, sampleCamera: async () => null, fromDataURL: () => { throw new Error('no image here'); }, language: () => 'zh-CN', journal: entry => journal.push(entry) });
  const part = see.finish(k.look);
  const frames = await k.turn('嗨');
  const mark = part.glanceMark(frames);
  assert.equal(mark.glanceOnly(), true);
  const still = mark.still();
  assert.equal(still(), true);
  k.media.holdCamera(true);
  assert.equal(still(), false, '"别看": the frames the warm process holds must go');
  assert.ok(part.line().includes('⟦look-camera⟧'));
  senses = { camera: false, screen: false };
  assert.equal(part.line(), '', 'nothing on: no paragraph');
  assert.equal(seeAndSay, part, 'the live binding the chat turn and the voice host read');
});

test('journal lines take closed words and a bounded number only', () => {
  assert.ok(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'frames', camera: true, screen: false }, 0));
  assert.ok(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'camera', outcome: 'failed', why: 'timeout', ms: 4000 }, 0));
  assert.equal(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'closer', sense: 'camera', outcome: 'saw your face' }, 0), null);
  assert.equal(buildJournalEntry({ type: 'see-and-say', characterId: 'c', event: 'frames', camera: 'yes', screen: false }, 0), null);
});
