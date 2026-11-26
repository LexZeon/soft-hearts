/**
 * I-085 第 3 步 文字为主，细看才附图 (plan section 5 option B: "选 B（我推荐）：她的第一个字每句快约 0.9 秒，语音通话
 * 也更快；代价是她平时看到的是一句总结，细节少一点。可以"). With 和她一起看 or 「发图片」 on, an
 * ordinary message carries text (the watch descriptions with their age, her own recent look's line with its age, or a plain "no
 * recent look"), and a frame only when it is needed. The send path is built the way electron/main.ts builds it, from the real
 * LookTurns, LookAttachments, chat validation, self-look host and perception line; frames, haiku, the clock and Claude are fakes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { LookTurns } from '../electron/senses/look-turns';
import { LookAttachments } from '../electron/senses/look-attachments';
import { CloserLook, curiosityFrom } from '../electron/senses/look-closer';
import { textFirstTurn } from '../electron/brain/text-first-turn';
import { validateChatRequest } from '../electron/settings/validation';
import { lookHint, turnAttachments } from '../src/senses/look-send';
import {
  CAMERA_HELD_LINE, CAMERA_NO_RECENT_LINE, CAMERA_RECENT_LINE, CURIOUS_SCREEN_LINE, GLANCE_LINE, PERCEPTION_LINE_MAX, SCREEN_LOOK_LINE,
  perceptionTurnLine, perceptionTurnState, watchTextLine,
} from '../shared/brain/perception-rule';
import { scanLookRequest, scanWatchPointing } from '../shared/senses/look-request';
import { curiousCloserLook, lookTurnRow, type WatchSight } from '../shared/brain/text-first';
import { TEXT_FIRST_KNOBS, type TextFirstKnobs } from '../shared/behaviors/text-first/knobs';
import { createSelfLook } from '../electron/initiative/self-look/wiring';
import type { SelfLookMoodInput } from '../shared/initiative/self-look';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiText } from '../src/foundation/ui-language';
import { WatchSession } from '../electron/senses/watch-notes/session';
import { WatchNotesStore } from '../electron/senses/watch-notes/store';
import { ScreenshotCache } from '../electron/senses/watch-notes/screenshots';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import { PersistentClaudeChat, type ClaudeTimingInfo, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { appendReplyHistory, outgoingChatMessages } from '../src/brain/reply-history';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/foundation/mood';
import type { MoodView } from '../shared/mood/mood-runtime';

const SEC = 1_000, MIN = 60_000;
const SCREEN = 'data:image/jpeg;base64,/9j/screenAA==';
const CLEAR = 'data:image/jpeg;base64,/9j/clearAAAA';
const SMALL = 'data:image/jpeg;base64,/9j/smallAAAA';
const SEEN = '他靠在椅子上，在笑';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

interface RigOptions { screen?: boolean; listen?: boolean; camera?: boolean; textFirst?: boolean; curiosity?: number | null; sight?: WatchSight | null; knobs?: TextFirstKnobs }

/** The chat send path of electron/main.ts: sharedAttachments → chat validation → admit → her own look's line → the text-first facts → the perception line. */
function rig(options: RigOptions = {}) {
  const s = { now: 10_000_000, screen: options.screen ?? false, listen: options.listen ?? false, camera: options.camera ?? false, held: false,
    curiosity: options.curiosity ?? 0, sight: options.sight === undefined ? null : options.sight, selfLook: true };
  const captures = { screen: 0, camera: 0, curious: 0 };
  const turns = new LookTurns(() => s.now);
  const lookState = () => ({ screen: s.screen, camera: s.camera, scope: 's', screenOpening: 1, cameraHeld: s.held });
  const closer = new CloserLook({ curiosity: () => s.curiosity, sight: () => s.sight, clock: () => s.now, knobs: options.knobs });
  const look = new LookAttachments(turns, {
    noteActivity() {}, state: lookState, sharesCameraFrames: () => s.camera, revision: () => 0, generation: () => 0, opening: () => 1,
    captureScreen: async () => { captures.screen++; return { source: 'screen', dataUrl: SCREEN }; },
    captureCamera: async () => { captures.camera++; return { source: 'camera', dataUrl: CLEAR }; },
    watchingTogether: () => s.screen && s.listen,
    curious: () => { captures.curious++; return closer.claim(); },
    glance: () => ({ source: 'camera', dataUrl: SMALL }),
    holdCamera: held => { s.held = held; },
    ...(options.textFirst === undefined ? {} : { textFirst: () => options.textFirst! }),
  });
  // Her own look (I-085 step 1), the real host with a fake haiku and clock; she wants to look (bored, the user quiet for 40 minutes).
  const mood: SelfLookMoodInput = { values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, boredom: 100, longing: 0, fatigue: { F: 0.25, phase: 'awake' } };
  const selfLook = createSelfLook({
    enabled: () => s.selfLook, camera: () => ({ frames: s.camera, held: s.held }), characterId: () => 'gene', conversationId: () => 'c1', mood: () => null,
    present: () => true, typing: () => false, idleSeconds: () => null, capture: async () => SMALL,
    ports: { mood: () => mood, lastInteractionAt: () => s.now - 40 * MIN, clock: () => s.now, timers: { set: () => ({}), clear: () => {} }, ask: async () => SEEN, log: () => {} },
  });
  const turnsSent: { images: string[]; line: string; row: ReturnType<typeof textFirstTurn>['row']; via: string | null }[] = [];
  let id = 0;
  async function send(content: string, button: boolean | 'me' = false) {
    const attachments = turnAttachments([], await look.request(lookHint(content, button)));
    const request = validateChatRequest({ id: `t${++id}`, messages: [{ role: 'user', content }], attachments });
    const frames = look.admit(request.attachments); request.attachments = frames.current();
    const selfSeen = selfLook.hint(content, request.attachments, frames.cameraGlance());
    const first = textFirstTurn({ textFirst: look.textFirst, watching: look.watching, screenHeld: turns.refusedIn(lookState()), sight: s.sight, now: s.now,
      frames, cameraOn: s.camera, cameraHeld: s.held, selfSeen });
    const sight = perceptionTurnState({ screenSharing: s.screen, cameraSharing: s.camera, cameraImages: s.camera, cameraHeld: s.held }, request.attachments, content,
      { cameraGlance: frames.cameraGlance(), ...first.glance });
    const entry = { images: request.attachments.map(item => item.dataUrl), line: perceptionTurnLine(sight) + selfSeen, row: first.row, via: frames.screenVia() ?? frames.cameraVia() };
    turnsSent.push(entry);
    return entry;
  }
  /** She takes her own look now (the minute clock's tick), so a fresh line is kept. */
  const selfLookNow = async () => { selfLook.host.tick(); await flush(); };
  return { s, look, turns, closer, captures, send, selfLook, selfLookNow, turnsSent, advance: (ms: number) => { s.now += ms; } };
}

// ---------------------------------------------------------------- 和她一起看

test('和她一起看 (text first, the default): an ordinary message carries the description line with its age and no frame', async () => {
  assert.equal(TEXT_FIRST_KNOBS.enabled, true, 'the user chose B');
  const r = rig({ screen: true, listen: true, sight: { at: 10_000_000 - 45 * SEC, clear: true } });
  for (const words of ['看着好馋', '哈哈哈', '他俩要在一起了吧']) {
    const turn = await r.send(words);
    assert.deepEqual(turn.images, [], words);
    assert.ok(turn.line.includes(watchTextLine(45 * SEC)), turn.line);
    assert.match(turn.line, /最新一条是45 秒前的/u);
    assert.doesNotMatch(turn.line, /本轮附了画面/u);
    assert.deepEqual(turn.row, { screen: 'text' });
  }
  assert.equal(r.captures.screen, 0, 'nothing captured for an ordinary message');
  r.s.sight = null;
  assert.match((await r.send('嗯嗯')).line, /也还没有画面描述/u, 'no description yet: she says so instead of guessing');
});

test('和她一起看: "你看这个", "这是谁", "屏幕上那个…" carry one screen frame; "别看" carries neither frame nor description, and keeps holding', async () => {
  const r = rig({ screen: true, listen: true, sight: { at: 10_000_000 - 30 * SEC, clear: true } });
  for (const words of ['你看这个', '这是谁', '这个人是谁啊', '屏幕上那个是什么', '画面里这个女生好眼熟', '这是哪部剧']) {
    const turn = await r.send(words);
    assert.deepEqual(turn.images, [SCREEN], words);
    assert.ok(turn.line.includes(SCREEN_LOOK_LINE), turn.line);
    assert.doesNotMatch(turn.line, /画面描述/u, 'a frame turn does not also say "only descriptions"');
    assert.deepEqual(turn.row, { screen: 'frame', why: 'asked' }, words);
  }
  const before = r.captures.screen;
  for (const words of ['别看', '不要看我的屏幕', '别看了，这是谁不重要']) {
    const turn = await r.send(words);
    assert.deepEqual(turn.images, [], words);
    assert.doesNotMatch(turn.line, /画面描述|一起看/u, `${words}: no description line either`);
    assert.deepEqual(turn.row, { screen: 'held' }, words);
  }
  const after = await r.send('这是谁');
  assert.deepEqual(after.images, [], 'the no keeps holding: pointing does not lift it');
  assert.doesNotMatch(after.line, /画面描述/u);
  assert.equal(r.captures.screen, before, 'nothing captured while held');
  const lifted = await r.send('你看看这个');
  assert.deepEqual(lifted.images, [SCREEN], 'asking her to look lifts it, as before');
});

test('the pointing words: only while watching together, never a no, someone else\'s words or the filler "那什么"', () => {
  for (const words of ['这是谁', '这个人是谁', '那个女的叫什么', '这谁啊', '这是啥', '这是哪部剧', '屏幕上那个是什么', '画面里这个人好眼熟', '视频里的人是谁', '你知道这是谁吗'])
    assert.equal(scanWatchPointing(words), true, words);
  for (const words of ['那什么，我想问你个事', '这是谁的错', '那是什么时候的事', '别看，这是谁不重要', '不要看我的屏幕，屏幕上有隐私', '禁止查看我的屏幕，这是什么不重要',
    '他说“这是谁”', '今天好累', '你是不是在看我屏幕', '', 'x'.repeat(4001)])
    assert.equal(scanWatchPointing(words), false, words);
  // Screen sharing alone (no 一起听): 屏幕只读大概 stays — "这是谁" takes nothing, as before (scanLookRequest is unchanged).
  assert.equal(scanLookRequest('这是谁'), null);
});

test('screen sharing alone (no 一起听) stays rough only: no frame, no description line, no closer look asked', async () => {
  const r = rig({ screen: true, listen: false, curiosity: 1, sight: null });
  for (const words of ['这是谁', '看着好馋']) {
    const turn = await r.send(words);
    assert.deepEqual(turn.images, []);
    assert.doesNotMatch(turn.line, /画面描述/u);
    assert.equal(turn.row, null, 'no row: neither 一起看 nor 「发图片」');
  }
  assert.equal(r.captures.curious, 0, 'her closer look is only asked while watching together');
});

// ---------------------------------------------------------------- 她特别好奇时凑近看一眼

test('curious closer look: only very curious, only when the latest description is stale or unclear, at most once per 10 minutes', () => {
  const now = 100 * MIN, k = TEXT_FIRST_KNOBS;
  const ask = (curiosity: number | null, sight: WatchSight | null, lastAt: number | null = null) => curiousCloserLook({ curiosity, sight, now, lastAt });
  assert.equal(ask(0.8, { at: now - 3 * MIN, clear: true }), true, 'stale (3 minutes)');
  assert.equal(ask(0.8, { at: now - 30 * SEC, clear: false }), true, 'fresh but unclear');
  assert.equal(ask(0.8, null), true, 'no description at all');
  assert.equal(ask(0.8, { at: now - 30 * SEC, clear: true }), false, 'fresh and clear: the text is enough');
  assert.equal(ask(0.8, { at: now - k.curious.staleMs + SEC, clear: true }), false, 'just under the stale line');
  assert.equal(ask(k.curious.minRise - 0.01, null), false, 'not curious enough');
  assert.equal(ask(null, null), false, 'mood unknown');
  assert.equal(ask(0.8, null, now - 9 * MIN), false, 'looked closer 9 minutes ago');
  assert.equal(ask(0.8, null, now - 10 * MIN), true, '10 minutes later');
  assert.equal(curiousCloserLook({ curiosity: 1, sight: null, now, lastAt: null }, { ...k, curious: { ...k.curious, enabled: false } }), false, 'the knob off');
});

test('curious closer look in the send path: one screen frame marked curious, then not again for 10 minutes; never while held', async () => {
  const r = rig({ screen: true, listen: true, curiosity: 0.9, sight: { at: 10_000_000 - 5 * MIN, clear: true } });
  const first = await r.send('嗯嗯');
  assert.deepEqual(first.images, [SCREEN]);
  assert.ok(first.line.includes(CURIOUS_SCREEN_LINE), first.line);
  assert.doesNotMatch(first.line, /用户叫你看屏幕/u, 'nobody asked her: the line does not say so');
  assert.deepEqual(first.row, { screen: 'frame', why: 'curious' });
  r.advance(9 * MIN);
  assert.deepEqual((await r.send('好看')).images, [], '9 minutes later: text');
  r.advance(MIN);
  assert.deepEqual((await r.send('好看')).images, [SCREEN], '10 minutes later: again');
  r.advance(11 * MIN);
  await r.send('别看我屏幕');
  const asked = r.captures.curious;
  r.advance(11 * MIN);
  assert.deepEqual((await r.send('好看')).images, [], 'a no holds her closer look too');
  assert.equal(r.captures.curious, asked, 'not even asked while held');
  // Low curiosity: never.
  const calm = rig({ screen: true, listen: true, curiosity: 0.1, sight: null });
  assert.deepEqual((await calm.send('嗯嗯')).images, []);
});

test('curiosity is read from her mood the way her own look reads D (above the card baseline)', () => {
  const snapshot = getMoodSnapshot(createMoodState(0), 0);
  const view = (D: number) => ({ snapshot: { ...snapshot, values: { ...snapshot.values, D } }, parameters: { ...DEFAULT_MOOD_PARAMETERS, baseline: { ...DEFAULT_MOOD_PARAMETERS.baseline, D: 50 } } }) as unknown as MoodView;
  assert.equal(curiosityFrom(null), null);
  assert.equal(curiosityFrom(view(50)), 0);
  assert.ok((curiosityFrom(view(95)) ?? 0) > curiosityFrom(view(70))!);
});

// ---------------------------------------------------------------- 「发图片」

test('「发图片」 (text first): an ordinary message carries her fresh look\'s line with its age on each message until it expires, else "no recent look"; no frame', async () => {
  const r = rig({ camera: true });
  const none = await r.send('今天好累');
  assert.deepEqual(none.images, [], 'no small picture any more');
  assert.ok(none.line.includes(CAMERA_NO_RECENT_LINE), none.line);
  assert.doesNotMatch(none.line, /【你自己看了一眼】/u);
  assert.deepEqual(none.row, { camera: 'none' });
  await r.selfLookNow();
  r.advance(3 * MIN);
  const fresh = await r.send('晚上吃什么');
  assert.deepEqual(fresh.images, []);
  assert.ok(fresh.line.includes(CAMERA_RECENT_LINE), fresh.line);
  assert.match(fresh.line, /【你自己看了一眼】3 分钟前你自己用摄像头看了用户一眼：他靠在椅子上，在笑。/u);
  assert.deepEqual(fresh.row, { camera: 'text' });
  r.advance(4 * MIN);
  assert.match((await r.send('嗯')).line, /【你自己看了一眼】7 分钟前/u, 'again on the next message, with its new age');
  r.advance(3 * MIN);
  const expired = await r.send('嗯');
  assert.doesNotMatch(expired.line, /【你自己看了一眼】/u, 'expired after 10 minutes');
  assert.ok(expired.line.includes(CAMERA_NO_RECENT_LINE));
  assert.equal(r.captures.camera, 0, 'no clear frame taken for ordinary messages');
});

test('「发图片」: asking, a question about looks, the button and a yes to her offer still carry one clear frame', async () => {
  const r = rig({ camera: true });
  await r.selfLookNow();
  const cases: [string, boolean | 'me', string][] = [['你看看我', false, 'asked'], ['评价下我的穿搭', false, 'appearance'], ['', 'me', 'button']];
  for (const [words, button, why] of cases) {
    const turn = await r.send(words, button);
    assert.deepEqual(turn.images, [CLEAR], words);
    assert.match(turn.line, /本轮附了画面/u);
    assert.doesNotMatch(turn.line, /【你自己看了一眼】/u, 'a clear picture replaces her older line');
    assert.deepEqual(turn.row, { camera: 'frame', why }, words);
  }
  r.turns.noteOffer('s', 's', 'camera');
  const yes = await r.send('好呀');
  assert.deepEqual(yes.images, [CLEAR]);
  assert.deepEqual(yes.row, { camera: 'frame', why: 'offer' });
});

test('「发图片」: "别看我" carries no frame and no look-derived text; later messages too, until she is asked to look', async () => {
  const r = rig({ camera: true });
  await r.selfLookNow();
  const no = await r.send('别看我');
  assert.deepEqual(no.images, []);
  assert.doesNotMatch(no.line, /【你自己看了一眼】/u);
  assert.deepEqual(no.row, { camera: 'held' });
  const later = await r.send('今天吃什么');
  assert.deepEqual(later.images, []);
  assert.ok(later.line.includes(CAMERA_HELD_LINE), later.line);
  assert.doesNotMatch(later.line, /【你自己看了一眼】|最近也没看到/u);
  assert.equal(r.selfLook.host.holding, false, 'the line she had is gone');
  assert.deepEqual((await r.send('你看看我')).images, [CLEAR], 'asking lifts it');
});

test('both on: one row for the turn, the screen part and the camera part; every line stays under the ceiling', async () => {
  const r = rig({ screen: true, listen: true, camera: true, sight: { at: 10_000_000 - 2 * MIN - SEC, clear: true } });
  await r.selfLookNow();
  const turn = await r.send('哈哈');
  assert.deepEqual(turn.images, []);
  assert.deepEqual(turn.row, { screen: 'text', camera: 'text' });
  const lines = [watchTextLine(null), watchTextLine(5 * SEC), watchTextLine(59 * MIN)];
  for (const watch of lines) for (const camera of [CAMERA_RECENT_LINE, CAMERA_NO_RECENT_LINE, CAMERA_HELD_LINE])
    assert.ok((watch + camera).length + '【此刻的感知】'.length <= PERCEPTION_LINE_MAX, watch + camera);
  assert.ok((CURIOUS_SCREEN_LINE + CAMERA_NO_RECENT_LINE).length + 7 <= PERCEPTION_LINE_MAX);
});

test('text first off (the knob, the undo path): the old behaviour — every message of 一起看 takes a frame, 「发图片」 a small one, no text lines', async () => {
  const r = rig({ screen: true, listen: true, camera: true, textFirst: false, sight: { at: 10_000_000, clear: true } });
  const turn = await r.send('看着好馋');
  assert.deepEqual(turn.images.sort(), [SCREEN, SMALL].sort());
  assert.ok(turn.line.includes(GLANCE_LINE));
  assert.doesNotMatch(turn.line, /画面描述|最近也没看到/u);
  assert.equal(turn.row, null);
});

// ---------------------------------------------------------------- the newest description (electron/senses/watch-notes/session.ts)

test('WatchSession.sight: the newest description\'s capture time, unclear when it said nothing; null when not watching or after a refusal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-text-first-'));
  try {
    let clock = 2_000_000_000_000, answer = JSON.stringify({ description: '两个人在雨里吵架', keywords: [] }), thumb = 10;
    const conditions = { watch: true, screen: true };
    const notes = new WatchNotesStore(directory), screenshots = new ScreenshotCache(directory, () => clock);
    const session = new WatchSession({ now: () => clock, characterId: () => 'gene', conditions: () => conditions,
      capture: async () => 'data:image/jpeg;base64,X', prepare: url => ({ thumb: new Uint8Array(576).fill(thumb), picture: url }),
      describe: async () => answer, summarize: async () => '', notes, screenshots });
    const round = async () => { clock += 10 * SEC; await session.tick(); await session.settled(); };
    assert.equal(session.sight('gene'), null, 'nothing yet');
    await round();
    const taken = clock;
    assert.deepEqual(session.sight('gene'), { at: taken, clear: true });
    assert.equal(session.sight('other'), null, 'another character');
    answer = JSON.stringify({ description: '', keywords: [] }); thumb = 200;
    await round();
    assert.deepEqual(session.sight('gene'), { at: clock, clear: false }, 'an empty description is unclear');
    session.refuse();
    assert.equal(session.sight('gene'), null, 'a refusal forgets it');
    conditions.watch = false;
    assert.equal(session.sight('gene'), null, 'not watching together');
    session.dispose();
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// ---------------------------------------------------------------- the journal row

test('journal look-turn: closed words only; a reason only with a picture; English has no Chinese left', () => {
  assert.equal(lookTurnRow({ watching: false, screenHeld: false, screenFrame: null, watchText: false, cameraOn: false, cameraHeld: false, cameraFrame: null, selfText: false }), null);
  assert.deepEqual(lookTurnRow({ watching: true, screenHeld: false, screenFrame: 'curious', watchText: true, cameraOn: true, cameraHeld: false, cameraFrame: null, selfText: true }),
    { screen: 'frame', camera: 'text', why: 'curious' });
  assert.deepEqual(lookTurnRow({ watching: false, screenHeld: false, screenFrame: null, watchText: false, cameraOn: true, cameraHeld: false, cameraFrame: 'photo', selfText: false }),
    { camera: 'frame', why: 'button' });
  const ok = (input: object) => buildJournalEntry({ type: 'look-turn', characterId: 'gene', ...input }, 1_000);
  assert.ok(ok({ screen: 'text' }));
  assert.ok(ok({ camera: 'frame', why: 'offer' }));
  for (const bad of [{}, { screen: 'seen' }, { screen: 'text', why: 'asked' }, { camera: 'frame', why: SEEN }, { screen: SEEN }])
    assert.equal(ok(bad), null, JSON.stringify(bad));
  const smuggled = ok({ screen: 'text', text: SEEN, line: SEEN })!;
  assert.ok(!JSON.stringify(smuggled).includes('椅子'));
  const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
  assert.match(describeJournalEntry(ok({ screen: 'frame', camera: 'text', why: 'curious' })!, plain), /这一轮附了画面（一起看：附了画面，摄像头：用文字，她好奇凑近看了一眼）$/u);
  try {
    setUiLanguage('en');
    for (const input of [{ screen: 'text' }, { screen: 'held', camera: 'none' }, { screen: 'frame', why: 'curious' }, { camera: 'frame', why: 'appearance' }, { camera: 'frame', why: 'asked' }, { camera: 'frame', why: 'button' }, { camera: 'frame', why: 'offer' }]) {
      const english = describeJournalEntry(ok(input)!, uiText);
      assert.ok(!/[一-鿿]/u.test(english), english);
    }
  } finally { setUiLanguage('zh-CN'); }
});

// ---------------------------------------------------------------- the warm process (the reason for B)

const fakeClaude = `
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0, buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function handle(message) {
  if (message.type !== "user") return;
  turn++;
  const text = "第" + turn + "轮回复。";
  if (turn === 1) out({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  out({ type: "assistant", message: { id: "m" + turn, role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
}
`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQ0lEQVR4AcXBAQEAAAiDMKR/5xuD7RgjJDGJSUxiEpOYxCQmMYlJTGISk5jEJCYxiUlMYhKTmMQkJjGJSUxiEpOYxB4v5AI+g+yDOgAAAABJRU5ErkJggg==';

test('a text-only perception turn keeps the warm process (reuse: warm, image: false); a pointed-at frame retires it as before', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-text-first-claude-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, fakeClaude);
  const infos: ClaudeTimingInfo[] = [];
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => true, interruptGraceMs: 300, log: () => {}, timing: { dispatched: (_id, info) => infos.push(info), firstDelta: () => {} } });
  const r = rig({ screen: true, listen: true, camera: true, sight: { at: 10_000_000 - 40 * SEC, clear: true } });
  // The frames the host took become the turn's pictures (a real frame is a PNG here: the fake Claude only needs a valid image).
  const persona = '你是测试角色小桃，说话温柔。';
  let history: ChatMessage[] = [{ role: 'assistant', content: '你好呀' }];
  const send = async (text: string) => {
    const turn = await r.send(text);
    const user: ChatMessage = { role: 'user', content: text };
    const messages = outgoingChatMessages(history, user);
    const composed = `${persona}\n\n${turn.line}`;
    const task: CompanionClaudeTask = { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false,
      get prompt() { return buildCodexChatPrompt(composed, messages); }, imageDataUrls: turn.images.map(() => PNG), replyId: `r${history.length}`,
      session: { key: 'conversation-1', basePersona: persona, persona: composed, messages, data: () => null } };
    const { output } = await chat.stream(task, new AbortController().signal, () => {});
    history = appendReplyHistory(history, user, output);
    return turn;
  };
  try {
    await r.selfLookNow();
    for (const words of ['看着好馋', '哈哈哈', '他俩要在一起了吧', '嗯嗯']) assert.deepEqual((await send(words)).images, [], words);
    assert.deepEqual(infos.map(info => info.reuse), ['first', 'warm', 'warm', 'warm'], 'text lines change every turn and the process stays warm');
    assert.deepEqual(infos.map(info => info.image === true), [false, false, false, false]);
    assert.deepEqual((await send('这是谁')).images, [SCREEN]);
    await send('好吧');
    assert.deepEqual(infos.slice(4).map(info => [info.reuse, info.image === true]), [['warm', true], ['image', false]], 'the picture turn retires the process; the next one says why');
  } finally {
    chat.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
