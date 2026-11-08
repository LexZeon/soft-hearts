// 屏幕只读大概（I-015）。推翻上午的 V1（"共享开着每条消息带最近一帧"，原来这个文件 v1-sharing-means-look）。
// 共享开着：普通消息 0 张图，感知行只说大概（"用户大概在写代码"）或不知道；叫她看、按"给她看看屏幕"、点桌宠上的"看吧"才现截一张清楚的
// 整屏；"别看"之后连大概也不说；后台不再定时存整屏；关掉共享后什么都不读、旧的都清空。
// 取图口、前台程序读取、小模型、计时器和 Claude 都是假的（Claude 是一个 node 小脚本）；不开窗口、不碰真实屏幕、不调用真实模型、不碰任何配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Attachment } from '../shared/contracts';
import { isLookDecline, scanLookRequest, withheldLook } from '../shared/look-request';
import { DECLINE_HOLDS, LookTurns, REFUSAL_HOLDS, type LookOfferView } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { ScreenSnapshots } from '../electron/screen-snapshots';
import { ScreenGlance } from '../electron/screen-glance';
import type { ForegroundReading } from '../electron/foreground-app';
import { PersistentClaudeChat } from '../electron/claude-session';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { lookOfferContent } from '../src/ui/LookOfferPrompt';
import {
  PERCEPTION_LINE_MAX, PERCEPTION_RULE, ROUGH_UNKNOWN_LINE, SCREEN_LOOK_LINE, SHARING_LINE, perceptionTurnLine, perceptionTurnState, roughLine,
} from '../shared/perception-rule';
import { SCREEN_ACTIVITIES, type ScreenActivity } from '../shared/screen-activity';
import type { HearingNow, HerContact } from '../shared/her-state';

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** A tiny picture Claude's input check accepts (JPEG magic, canonical base64); `name` makes each one different. */
const jpeg = (name: string): Attachment =>
  ({ source: 'screen', dataUrl: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(name)]).toString('base64')}` });
const line = (activity: ScreenActivity | null | undefined) =>
  '【此刻的感知】' + (activity === undefined ? SHARING_LINE : activity === null || activity === 'other' ? ROUGH_UNKNOWN_LINE : roughLine(activity));

test('withheldLook（认"别看"的规则，照旧）：说不、撤回、问她是不是在看 → refused；别人的话 → relayed；普通话不拦', () => {
  for (const text of ['别看我屏幕', '不要看', '禁止查看我的屏幕', '没授权你看我屏幕', '我撤回你看我屏幕的授权。', '你是不是在看我屏幕', '看什么看',
    '先别看屏幕，你看看这个', '嗯，别看了', '不准你看我的屏幕'])
    assert.equal(withheldLook(text), 'refused', text);
  for (const text of ['他说‘你看看这个报错’', '同事原话：你看看这个报错', '同事跟你说了声，你看看这个报错。', '他说“别看我屏幕”', '老板说过，你看看这个报错'])
    assert.equal(withheldLook(text), 'relayed', text);
  for (const text of ['今天好累啊', '这个好看吗', '看起来不错', '我看看', '你看看你', '嗯', '好的', '我没看懂', '不用了谢谢'])
    assert.equal(withheldLook(text), null, text);
  assert.equal(withheldLook('今天'.repeat(2001)), 'unread');
  assert.equal(scanLookRequest('别看我屏幕'), null);
  assert.equal(scanLookRequest('你看看这个报错'), 'screen');
});

test('withheldLook 读每条共享开着的普通消息：最坏的长输入（4000 字以内）也很快，不卡发送', () => {
  const worst = ['不' + '需要'.repeat(1999), '不' + '帮忙着'.repeat(1333), '同事' + '跟你'.repeat(1990) + '说，你看看这个报错', '你看看'.repeat(1333),
    '说'.repeat(4000), '，说'.repeat(2000), '我们说好了，'.repeat(666), '看'.repeat(4000), '别'.repeat(4000), '“看'.repeat(2000)];
  for (const text of worst) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const started = performance.now(); withheldLook(text); best = Math.min(best, performance.now() - started); }
    assert.ok(best < 150, `${text.slice(0, 12)}…（${text.length} 字）took ${best.toFixed(1)} ms`);
  }
});

/** A fake foreground reader driven by hand (never the real foreground window). */
function fakeProbe() {
  let reading: ((value: ForegroundReading) => void) | null = null;
  return {
    probe: { starts: 0, stops: 0, start(onReading: (value: ForegroundReading) => void) { this.starts++; reading = onReading; }, stop() { this.stops++; reading = null; } },
    read: (value: ForegroundReading) => reading?.(value),
    live: () => reading !== null,
  };
}

/**
 * The host as electron/main.ts wires it now: real ScreenSnapshots (never turned on: no background frame), real LookTurns (with the
 * pet's prompt listener), real LookAttachments, real ScreenGlance with a fake foreground reader and a fake small model; fake capture.
 */
function host() {
  let now = 1_000, sequence = 0, captures = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const pending: { resolve: (frame: Attachment) => void; name: string }[] = [];
  const media = { screen: true, opening: 1 };
  const snapshots = new ScreenSnapshots({
    capture: () => { captures++; const next = deferred<Attachment>(); const name = `frame-${captures}`; pending.push({ resolve: next.resolve, name }); return next.promise; },
    clock: () => now,
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: id => { timers.delete(id as unknown as number); },
  });
  const offers: (LookOfferView | null)[] = [];
  const turns = new LookTurns(() => now, offer => offers.push(offer));
  const state = () => ({ screen: media.screen, camera: false, scope: `conv|${media.opening}`, screenOpening: media.opening });
  const reader = fakeProbe();
  const thumbnails: string[] = [];
  const glance = new ScreenGlance({
    probe: reader.probe,
    thumbnail: async () => { thumbnails.push('thumb'); return 'data:image/jpeg;base64,/9j/dGh1bWI='; },
    classify: async () => '看视频',
    mayLook: () => media.screen && !turns.refusedIn(state()),
    clock: () => now,
  });
  /** electron/main.ts mediaChanged + refreshVisionContext + clearVisionContext. */
  const share = (on: boolean) => {
    if (on !== media.screen) media.opening++;
    media.screen = on;
    if (!on && snapshots.state.enabled) snapshots.setOptions({ enabled: false });
    glance.setSharing(on);
    if (!on) turns.clear();
    snapshots.configure({ sharing: on, visible: on, sourceId: on ? '1' : null, scope: on ? `scope-${media.opening}` : '' });
  };
  const look = new LookAttachments(turns, {
    noteActivity: () => {}, state, sharesCameraFrames: () => false, revision: () => media.opening, generation: () => 1, opening: () => media.opening,
    captureScreen: signal => snapshots.sampleOnce(signal), captureCamera: async () => null,
  });
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].callback(); await flush();
    }
    now = target; await flush();
  };
  const finishCapture = async () => { const next = pending.shift()!; next.resolve(jpeg(next.name)); await flush(); return jpeg(next.name).dataUrl; };
  /** electron/main.ts roughForTurn. */
  const roughForTurn = () => media.screen && !turns.refusedIn(state()) ? glance.rough() : undefined;
  let turn = 0;
  /** sendChat → sharedAttachments → chat handler (validate, admit, userTurn, perception line); resolves once the frame (if any) is taken. */
  async function send(text: string, button = false) {
    const asked = look.request(lookHint(text, button));
    await flush();
    if (pending.length) await finishCapture();
    const shared = await asked;
    const request = validateChatRequest({ id: `turn-${++turn}`, messages: [{ role: 'user', content: text }], attachments: turnAttachments([], shared) });
    const frames = look.admit(request.attachments); request.attachments = frames.current();
    turns.userTurn();
    const rough = roughForTurn();
    const sight = perceptionTurnLine(perceptionTurnState({ screenSharing: media.screen, cameraSharing: false }, request.attachments, text, { rough }));
    return { images: request.attachments.map(item => item.dataUrl), sight, shared };
  }
  /** Her completed reply asked "要我凑近看看吗" (electron/main.ts after the turn: lookOfferAllowed && lookOffer). */
  const herOffer = () => turns.noteOffer(state().scope, state().scope);
  return { snapshots, look, turns, glance, reader, share, send, advance, herOffer, offers, state, media, thumbnails,
    captures: () => captures, timers: () => timers.size };
}

test('共享开着，普通消息 0 张图、0 次截屏，感知行只说大概；后台不定时存整屏（一分钟里 0 次截屏、0 个计时器）', async () => {
  const h = host();
  h.share(true);
  await h.advance(60_000);
  assert.equal(h.captures(), 0, 'no frame kept in the background any more');
  assert.equal(h.timers(), 0, 'no capture timer at all');
  assert.equal(h.snapshots.currentAttachment(), null);
  let result = await h.send('今天好累啊');
  assert.deepEqual(result.images, []);
  assert.equal(result.sight, line(null), 'nothing read yet: she says she does not know');
  h.reader.read({ exe: 'Code.exe' });
  result = await h.send('这个报错到底什么意思啊');
  assert.deepEqual(result.images, [], 'a message about the screen that does not ask her to look: still no picture');
  assert.equal(result.sight, line('code'));
  assert.match(result.sight, /大概在写代码/u);
  h.reader.read({ exe: 'chrome.exe' });
  assert.equal((await h.send('嘿嘿')).sight, line(null), 'a browser before any look: 不知道');
  h.glance.noteTalk(); await flush(); // the user types: one small look in the background
  assert.equal(h.thumbnails.length, 1);
  assert.equal((await h.send('嘿嘿')).sight, line('video'));
  assert.equal(h.captures(), 0, 'the small look is not a screen frame for her');
  for (const activity of SCREEN_ACTIVITIES) assert.doesNotMatch(line(activity), /附了|画面里的字/u, 'no picture is claimed');
});

test('叫她看、按"给她看看屏幕"：现截一张清楚的整屏，感知行说"用户叫你看屏幕"；之后的普通话又只说大概', async () => {
  const h = host();
  h.share(true);
  h.reader.read({ exe: 'Code.exe' });
  const asked = await h.send('你看看这个报错');
  assert.equal(asked.images.length, 1);
  assert.equal(asked.sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
  assert.equal(h.captures(), 1);
  const button = await h.send('这题怎么做', true);
  assert.equal(button.images.length, 1);
  assert.equal(h.captures(), 2);
  const after = await h.send('谢谢');
  assert.deepEqual(after.images, []);
  assert.equal(after.sight, line('code'));
});

test('说"别看"：这一句和之后都 0 张图、不说大概、不看一眼；叫她看或关掉再开共享才恢复', async () => {
  const h = host();
  h.share(true);
  h.reader.read({ exe: 'chrome.exe' });
  const no = await h.send('别看我屏幕');
  assert.deepEqual(no.images, []);
  assert.equal(no.sight, line(undefined), 'only "sharing is on, you did not look"');
  assert.equal(REFUSAL_HOLDS, true);
  h.glance.noteTalk(); await flush();
  assert.equal(h.thumbnails.length, 0, 'no small look while the no holds');
  assert.equal((await h.send('嗯')).sight, line(undefined), 'the no holds');
  assert.equal((await h.send('你看看这个')).images.length, 1, 'asking her lifts it');
  h.glance.noteTalk(); await flush();
  assert.equal(h.thumbnails.length, 1);
  assert.equal((await h.send('嗯')).sight, line('video'));
  await h.send('不要看我的屏幕');
  h.share(false); h.share(true);
  h.reader.read({ exe: 'Code.exe' });
  assert.equal((await h.send('嗯')).sight, line('code'), 'sharing off and on: a new yes');
});

test('她问"要我凑近看看吗"：桌宠收到邀请；点"看吧"像按钮一样现截一张；点"不用"关掉邀请、0 张图，之后"嗯"也不取；聊天里回"嗯"照旧算同意', async () => {
  const h = host();
  h.share(true);
  h.reader.read({ exe: 'Code.exe' });
  // 看吧 on the pet: src/main.ts sends lookOfferContent(the box) with look: true, like "给她看看屏幕".
  h.herOffer();
  assert.equal(h.offers.length, 1);
  assert.ok(h.offers[0]?.id);
  const yes = await h.send(lookOfferContent(''), true);
  assert.equal(lookOfferContent(''), '看吧。');
  assert.equal(yes.images.length, 1, '看吧: one clear frame, this turn');
  assert.equal(yes.sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
  assert.equal(h.offers.at(-1), null, 'answered: the prompt goes');
  // 不用 on the pet: preload declineLookOffer(id) → electron/main.ts → LookTurns.decline.
  h.herOffer();
  const id = h.offers.at(-1)!.id;
  assert.equal(h.turns.decline(id, h.state()), true);
  assert.equal(h.offers.at(-1), null);
  const captures = h.captures();
  const after = await h.send('嗯');
  assert.deepEqual(after.images, [], 'a later "嗯" takes nothing on the closed offer');
  assert.equal(h.captures(), captures);
  assert.equal(after.sight, DECLINE_HOLDS ? line(undefined) : line('code'), '"不用" is not "别看": she still knows roughly');
  // A yes in words still works; a short no in words is the same as 不用.
  h.herOffer();
  assert.equal((await h.send('嗯')).images.length, 1);
  h.herOffer();
  assert.equal(isLookDecline('不用了'), true);
  const declined = await h.send('不用了');
  assert.deepEqual(declined.images, []);
  assert.equal(h.turns.offerOpen, false);
});

test('关掉共享后：不读前台程序、不说大概、不看一眼；叫她看的帧已交出但没发出，也丢掉；再打开不复活', async () => {
  const h = host();
  h.share(true);
  h.reader.read({ exe: 'Code.exe' });
  h.herOffer();
  const shared = h.look.request(lookHint('你看看这个', false));
  await flush();
  const pendingCapture = h.captures();
  assert.equal(pendingCapture, 1);
  h.share(false);
  assert.equal(h.reader.live(), false, 'the reader stopped');
  assert.equal(h.reader.probe.stops, 1);
  assert.equal(h.glance.rough(), null);
  assert.equal(h.offers.at(-1), null, 'her offer (and the pet prompt) goes with sharing');
  await assert.rejects(shared, 'the frame being taken is dropped');
  const off = await h.send('今天好累');
  assert.deepEqual(off.images, []);
  assert.equal(off.sight, '【此刻的感知】你看不到用户的屏幕和摄像头画面。');
  assert.equal((await h.send('你看看这个')).images.length, 0, 'asked with sharing off: nothing');
  h.reader.read({ exe: 'vlc.exe' });
  assert.equal(h.glance.rough(), null, 'a line from the stopped reader goes nowhere');
  h.share(true);
  assert.equal(h.glance.rough(), null, 'on again: nothing from before');
  assert.equal((await h.send('嗯')).sight, line(null));
});

test('感知行：每种大概、不知道、说了别看各一行；配上听觉和触碰也是一行、不超过上限；固定提示词一个字没改', () => {
  const base = { screen: true, camera: 'off' as const, attached: { screen: false, camera: false }, asked: null };
  for (const activity of [...SCREEN_ACTIVITIES, null]) {
    const sight = perceptionTurnLine({ ...base, rough: activity });
    assert.equal(sight, line(activity));
    assert.match(sight, /没看画面/u);
    assert.match(sight, /想看清要用户叫你/u, 'she may offer to look');
  }
  assert.equal(perceptionTurnLine(base), '【此刻的感知】' + SHARING_LINE);
  // A frame attached: the rough reading is not mentioned; sharing off: nothing about it.
  assert.equal(perceptionTurnState({ screenSharing: true, cameraSharing: false }, [{ source: 'screen' }], '你看看', { rough: 'code' }).rough, undefined);
  assert.equal(perceptionTurnState({ screenSharing: false, cameraSharing: false }, [], '嗯', { rough: 'code' }).rough, undefined);
  assert.equal(PERCEPTION_RULE, '【你能感知到什么】平时你看不到用户的屏幕和摄像头画面，也听不到用户那边的声音；用户开了哪些感知、这一轮有没有附上画面，以这一轮私有上下文里的【此刻的感知】为准。只有某一轮明确附上了画面或声音资料，才算你看到、听到了。用户在不在、忙不忙，你只能从用户和你的互动（聊天、摸头、喂食）和应用告诉你的事知道，不要说成是你看见的。');
  const hearings: HearingNow[] = [];
  for (const source of [null, 'system-audio', 'microphone'] as const) for (const music of [null, 'still', 'nod', 'dance'] as const) for (const transcript of [false, true])
    hearings.push({ source, stage: source && music ? { music, always: true } : null, transcript, kind: 'show' });
  for (const activity of [...SCREEN_ACTIVITIES, null]) for (const hearing of hearings) for (const contacts of [[], ['pat', 'pinch', 'food']] as HerContact[][]) for (const say of ['full', 'brief', 'none'] as const) {
    const sight = perceptionTurnLine({ ...base, rough: activity }, { hearing, contacts, say, food: '草莓蛋糕' });
    assert.ok(sight.startsWith(line(activity)) && !sight.includes('\n') && sight.length <= PERCEPTION_LINE_MAX, `${sight.length}: ${sight}`);
  }
});

/** A fake `claude` (stream-json): logs when each user message arrives on stdin, its images and its text, then answers at once. */
const FAKE = String.raw`
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(path.join(__dirname, "spawns.log"), process.pid + "\n");
let buffer = "", turns = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  const at = Date.now();
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type !== "user") continue;
    const images = message.message.content.filter(block => block.type === "image").length;
    fs.appendFileSync(path.join(__dirname, "input.log"), JSON.stringify({ pid: process.pid, at, images }) + "\n");
    fs.appendFileSync(path.join(__dirname, "stdin.log"), line + "\n");
    turns++;
    const out = value => process.stdout.write(JSON.stringify(value) + "\n");
    out({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fake" });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "嗯嗯。" } } });
    out({ type: "assistant", message: { id: "m" + turns, role: "assistant", content: [{ type: "text", text: "嗯嗯。" }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "嗯嗯。" });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2; };

test('首字（假 Claude）：共享开着的普通消息送到 stdin 不比关着慢；0 张图、同一个热进程；程序名和窗口标题不进 Claude 收到的任何内容', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'soft-rough-session-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = path.join(dir, 'fake-claude.cjs');
  await writeFile(script, FAKE);
  const kinds: string[] = [];
  const chat = new PersistentClaudeChat({
    enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'sonnet' }),
    chattedBefore: () => true, log: () => {}, maxTurns: 100, // the app retires a session after 12 turns anyway; here only sharing could
    timing: { dispatched: (_id, info) => { kinds.push(`${info.process}:${info.sessionTurn}`); }, firstDelta: () => {} },
  });
  t.after(() => chat.dispose());
  chat.prewarm();
  const persona = '角色名称：测试\n她说话温柔。';
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  // The real pieces, as electron/main.ts wires them; the capture is slow (2 s) on purpose: nothing ordinary may wait for it.
  const secretProgram = 'SecretPlannerPro.exe', secretTitle = '机密：年终奖名单.xlsx - 窗口标题';
  let screen = false, opening = 1, captures = 0;
  const turns = new LookTurns();
  const state = () => ({ screen, camera: false, scope: `conv|${opening}`, screenOpening: opening });
  let reading: ((value: ForegroundReading) => void) | null = null;
  const asked: string[] = [];
  const glance = new ScreenGlance({
    probe: { start: onReading => { reading = onReading; }, stop: () => { reading = null; } },
    thumbnail: async () => 'data:image/jpeg;base64,/9j/dGh1bWI=', classify: async picture => { asked.push(picture); return '写东西'; },
    mayLook: () => screen && !turns.refusedIn(state()),
  });
  const look = new LookAttachments(turns, {
    noteActivity: () => {}, state, sharesCameraFrames: () => false, revision: () => opening, generation: () => 1, opening: () => opening,
    captureScreen: async () => { captures++; await new Promise(resolve => setTimeout(resolve, 2_000)); return jpeg('fresh'); }, captureCamera: async () => null,
  });
  const sent: { at: number; on: boolean }[] = [];
  async function turn(text: string) {
    const started = Date.now();
    const shared = await look.request(lookHint(text, false));
    const frames = look.admit(shared);
    turns.userTurn();
    const rough = screen && !turns.refusedIn(state()) ? glance.rough() : undefined;
    const sight = perceptionTurnLine(perceptionTurnState({ screenSharing: screen, cameraSharing: false }, frames.current(), text, { rough }));
    sent.push({ at: started, on: screen });
    const messages = [...history, { role: 'user' as const, content: text }];
    let output = '';
    await chat.stream({ kind: 'chat', model: 'sonnet', workingDirectory: dir, writable: false, prompt: `${persona}\n\n${sight}\n\n${text}`,
      imageDataUrls: frames.current().map(frame => frame.dataUrl), imageTemporaryRoot: path.join(dir, 'images'), replyId: `reply-${sent.length}`,
      session: { key: 'conversation-1', basePersona: persona, persona: `${persona}\n\n${sight}`, messages } },
    new AbortController().signal, (type, value) => { if (type === 'delta') output += value; });
    history.push({ role: 'user', content: text }, { role: 'assistant', content: output });
  }
  const setSharing = (on: boolean) => { if (on !== screen) opening++; screen = on; glance.setSharing(on); };
  await new Promise(resolve => setTimeout(resolve, 300)); // the spare the app pre-spawns when the window shows
  // Interleaved: off, on, off, on… (8 each), the reader saying a secret program is in front while on.
  const texts = ['今天好累啊', '晚上吃什么好呢', '这个报错到底什么意思', '嘿嘿', '我在写东西', '你在干嘛呀', '好困', '晚安'];
  for (const [index, text] of [...texts, ...texts].entries()) {
    setSharing(index % 2 === 1);
    if (screen) { reading!({ exe: secretProgram }); glance.noteTalk(); await flush(); }
    await turn(text);
  }
  const inputs = (await readFile(path.join(dir, 'input.log'), 'utf8')).split('\n').filter(Boolean).map(entry => JSON.parse(entry) as { pid: number; at: number; images: number });
  assert.deepEqual(inputs.map(input => input.images), new Array(16).fill(0), 'no ordinary message carried a picture, sharing on or off');
  assert.equal(captures, 0, 'no capture at all');
  assert.equal(new Set(inputs.map(input => input.pid)).size, 1, 'one warm process all along: turning sharing on and off reopens nothing');
  assert.deepEqual(kinds, ['prewarmed:1', ...Array.from({ length: 15 }, (_, i) => `warm:${i + 2}`)]);
  const delays = inputs.map((input, index) => ({ on: sent[index]!.on, ms: input.at - sent[index]!.at }));
  const on = delays.filter(entry => entry.on).map(entry => entry.ms), off = delays.filter(entry => !entry.on).map(entry => entry.ms);
  t.diagnostic(`send → stdin, sharing on: median ${median(on)} ms (${Math.min(...on)}–${Math.max(...on)}); off: median ${median(off)} ms (${Math.min(...off)}–${Math.max(...off)})`);
  assert.ok(median(on) <= median(off) + 50, `sharing on ${median(on)} ms vs off ${median(off)} ms`);
  assert.ok(Math.max(...on) < 1_000, 'never near the 2 s capture');
  // Privacy: the program's name and any title never reach what Claude got (her line says only the activity), nor the small model.
  const stdin = await readFile(path.join(dir, 'stdin.log'), 'utf8');
  assert.match(stdin, /用户大概在写东西/u, 'the rough reading did reach her');
  assert.doesNotMatch(stdin, /SecretPlanner|年终奖|窗口标题|\.exe/iu);
  assert.ok(asked.length >= 1 && asked.every(picture => picture.startsWith('data:image/jpeg;base64,')), 'the small model got only the picture');
  assert.doesNotMatch(JSON.stringify(glance.view()), /SecretPlanner/iu);
  void secretTitle; // nothing in this app reads titles: the reader's script has no call that could (tests/screen-glance.test.ts)
});

test('electron/main.ts 接线：不再保留最新一帧、不再打字时截屏；大概随共享开关；"别看"时不说大概；"不用"只收桌宠的', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /latestScreen|freshen\(|sharedFrame|unasked\(\)/u, 'the V1 kept frame is gone');
  assert.doesNotMatch(main, /screenSnapshots\.setOptions\(\{ enabled: next\.screenSharing \}\)/u, 'nothing turns the 10 s frame on');
  assert.match(main, /if \(!next\.screenSharing && screenSnapshots\.state\.enabled\) try \{ screenSnapshots\.setOptions\(\{ enabled: false \}\); \}/u);
  assert.match(main, /screenGlance\.setSharing\(next\.screenSharing\);/u);
  assert.match(main, /scopedHost\('noteChatTyping', \(\) => \{ companion\.noteTyping\(\); screenGlance\.noteTalk\(\); \}/u);
  assert.match(main, /const roughForTurn = \(\) => media\.state\.screenSharing && !lookTurns\.refusedIn\(lookState\(\)\) \? screenGlance\.rough\(\) : undefined;/u);
  // I-036: the line also learns whether the camera frame is 「发图片」's small one.
  assert.match(main, /perceptionTurnState\(media\.state, request\.attachments, request\.messages\.at\(-1\)\?\.content, \{ rough, cameraGlance: turnFrames\.cameraGlance\(\) \}\)/u);
  assert.match(main, /scopedHost\('declineLookOffer', \(sender, id: unknown\) => sender === pet\?\.webContents\.id && lookTurns\.decline\(id, lookState\(\)\), false\);/u);
  assert.match(main, /new LookTurns\(Date\.now, offer => broadcast\('desk:look-offer', offer\)\)/u);
  assert.match(main, /lookTurns\.clear\(\);/u, 'a cleared vision context (sharing off) closes her offer and the prompt');
  assert.match(main, /thumbnailSize: \{ width: 320, height: 200 \}/u, 'the glance thumbnail is small');
  assert.match(main, /quickLineWithClaude\(GLANCE_PROMPT, GLANCE_SYSTEM_PROMPT, signal, undefined, \[picture\]\)/u, 'haiku, the picture only');
  assert.match(main, /return \{ autoCapture: false, intervalSeconds/u, 'R09 stays reported as off');
});
