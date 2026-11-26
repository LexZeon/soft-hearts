/**
 * I-084 看看我更聪明 (plan option 1 "可以"). Synthetic phrases only, no
 * real chat; fake frames, fake haiku, no camera.
 *
 * What it pins: with 「发图片」 on, a question about the user's own looks takes one clear picture without a look verb ("老婆评价下我的穿搭"),
 * mood questions and the old negatives do not; nothing changes with 「发图片」 off and a "别看" still holds; her per-turn line says plainly
 * when there is no picture of the user (and why, when held), also on a turn that carries a screen picture; her "要我看看你吗？" opens a
 * camera offer that a short yes answers; 「让她看看我」 shows only with 「发图片」 on and takes one clear picture; the experience journal
 * gets one closed line per turn; I-040's judgment names looks and reports what became of the camera.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookOfferTarget, scanLookRequest, withheldLook } from '../shared/senses/look-request';
import { LookTurns, validateLookHint, type LookOfferView } from '../electron/senses/look-turns';
import { LookAttachments, type LookAttachmentPorts } from '../electron/senses/look-attachments';
import {
  CAMERA_HELD_LINE, CAMERA_MISSED_LINE, CAMERA_NONE_LINE, GLANCE_LINE, PERCEPTION_LINE_MAX, SCREEN_LOOK_LINE, SENSING_OFF_LINE,
  lookOfferFor, perceptionTurnLine, perceptionTurnState, type PerceptionTurn,
} from '../shared/brain/perception-rule';
import { LOOK_ME_LABEL, LOOK_ME_MESSAGE, LookButton, lookButtonContent, lookButtonShown } from '../src/senses/LookButton';
import { lookHint } from '../src/senses/look-send';
import { CameraLookJournal, CAMERA_LOOK_OPEN_MAX } from '../electron/senses/camera-look-journal';
import { cameraLookFirst, cameraLookLater, type CameraLookLine } from '../shared/senses/camera-look';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/foundation/ui-copy.journal.en';
import { SenseRouterHost, type SenseRouterPorts } from '../electron/senses/sense-router/host';
import { senseBlock, type SenseOn } from '../shared/senses/sense-router';
import type { SenseCameraResult } from '../shared/senses/camera-look';
import type { Attachment } from '../shared/foundation/chat';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts' (wiring rewrite step 4c: with electron/wiring/*.ts).
import { wiringSource } from './helpers/wiring-source';
import { rendererSource as readRendererSource } from './helpers/renderer-source'; // overhaul step 5: src/main.ts and src/wiring/*.ts

// ---------------------------------------------------------------- 1a. by meaning (local rules, synchronous)

/** The user's own looks, no look verb needed (the plan's list, and "老婆评价下我的穿搭" from the evening). */
const LOOKS = [
  '老婆评价下我的穿搭', '评价一下我的穿搭', '帮我点评下我的发型', '给我的穿搭打个分', '帮我参谋下今天的穿搭', '老婆看看我的新发型',
  '我今天这身怎么样', '我这件好看吗', '我这套帅吗', '我穿得怎么样', '我今天穿得好看吗', '我的穿搭怎么样？', '我的发型如何', '我这个造型可以吗',
  '我好看吗', '我帅吗', '我美吗', '我今天好看吗', '我帅不帅', '我这身好不好看', '你觉得我这身怎么样', '你觉得我穿得好看吗', '你觉得我今天好看吗',
  '我穿这个好看吗', '我今天看起来怎么样', '宝贝，我这身衣服怎么样？', '我的妆怎么样', '点评一下我今天的妆',
];
/** Not a request for the camera: mood, the user looking, teasing, a no, someone else's words, a thing on the screen. */
const NOT_LOOKS = [
  '我今天怎么样', '你觉得我今天怎么样', '我今天心情怎么样', '我这样做对吗', '我这样怎么样', '我好累啊', '今天好累',
  '我看看', '我看看我的穿搭', '你看看你', '你看看你的样子', '你的穿搭好看', '你好看吗',
  '别看我', '别评价我的穿搭', '不用看我的穿搭',
  '他说评价下我的穿搭', '我朋友问我这身怎么样', '同事说：我这身怎么样', '“我好看吗”他问',
  '评价下这件衣服', '评价下我的代码', '评价下我的穿搭照片', '我的穿搭视频怎么样', '我老婆的穿搭怎么样', '我的头发掉了好多', '我的发型师怎么样',
];

test('by meaning: the user\'s own looks ask for the camera; mood, teasing, a no, reported words and screen things do not', () => {
  for (const text of LOOKS) assert.equal(scanLookRequest(text, { appearance: true }), 'camera', text);
  for (const text of NOT_LOOKS) assert.notEqual(scanLookRequest(text, { appearance: true }), 'camera', text);
  // Without the option (「发图片」 off): exactly the rule before; none of the verb-less ones asks anything.
  for (const text of ['老婆评价下我的穿搭', '我今天这身怎么样', '我好看吗', '你觉得我穿得好看吗', '帮我参谋下今天的穿搭'])
    assert.equal(scanLookRequest(text), null, text);
  // A no in the same message still governs ("别看" and a no to the look), and withheldLook is unchanged.
  assert.equal(scanLookRequest('别看我，评价下我的穿搭', { appearance: true }), null);
  assert.equal(withheldLook('老婆评价下我的穿搭'), null);
  // A long message is not read (unsure is no), and nothing here is slow: 2,000 runs of the whole list in well under a second.
  assert.equal(scanLookRequest('我好看吗'.repeat(1001), { appearance: true }), null);
  const started = performance.now();
  for (let i = 0; i < 50; i++) for (const text of [...LOOKS, ...NOT_LOOKS]) scanLookRequest(text, { appearance: true });
  assert.ok(performance.now() - started < 1_000, 'synchronous and quick');
});

const CAMERA = { screen: false, camera: true, scope: 's' };
const BOTH = { screen: true, camera: true, scope: 's' };

test('LookTurns: with 「发图片」 on a looks question takes one clear picture (via its meaning); off, held, or not one: no clear picture', () => {
  const turns = new LookTurns();
  assert.deepEqual(turns.decide({ text: '老婆评价下我的穿搭' }, CAMERA), { screen: false, camera: true, via: 'appearance' });
  assert.deepEqual(turns.decide({ text: '老婆评价下我的穿搭' }, BOTH), { screen: false, camera: true, via: 'appearance' }, 'never the screen');
  assert.deepEqual(turns.decide({ text: '我今天怎么样' }, CAMERA), { screen: false, camera: false, via: null, glance: true }, 'a mood question: the small picture only');
  // 「发图片」 off (camera off, or 「姿势识别」 only): nothing at all, as before.
  assert.deepEqual(turns.decide({ text: '老婆评价下我的穿搭' }, { screen: false, camera: false, scope: 's' }), { screen: false, camera: false, via: null });
  assert.deepEqual(turns.decide({ text: '老婆评价下我的穿搭' }, { screen: true, camera: false, scope: 's' }), { screen: false, camera: false, via: null });
  // A "别看" holds: a looks question does not lift it (only asking her to look, the button or a yes to her offer does).
  assert.deepEqual(turns.decide({ text: '老婆评价下我的穿搭' }, { ...CAMERA, cameraHeld: true }), { screen: false, camera: false, via: null });
  assert.deepEqual(turns.decide({ text: '你看看我' }, { ...CAMERA, cameraHeld: true }), { screen: false, camera: true, via: 'words', hold: false });
  // The words still win where they ask: "你看看我今天的发型" is 'words', as before.
  assert.deepEqual(turns.decide({ text: '你看看我今天的发型' }, CAMERA), { screen: false, camera: true, via: 'words' });
});

// ---------------------------------------------------------------- 3. 「让她看看我」

test('「让她看看我」: the hint carries lookAtMe; the host takes one clear picture only with 「发图片」 on, and it lifts a "别看"', () => {
  assert.deepEqual(lookHint('这身怎么样', 'me'), { text: '这身怎么样', lookAtMe: true });
  assert.deepEqual(lookHint('x', true), { text: 'x', look: true });
  assert.deepEqual(lookHint('x', false), { text: 'x' });
  assert.deepEqual(validateLookHint({ text: 'x', lookAtMe: true }), { text: 'x', lookAtMe: true });
  assert.deepEqual(validateLookHint({ text: 'x', lookAtMe: false }), { text: 'x' });
  assert.throws(() => validateLookHint({ text: 'x', lookAtMe: 'yes' }));
  assert.throws(() => validateLookHint({ text: 'x', lookAt: true }));
  const turns = new LookTurns();
  assert.deepEqual(turns.decide({ text: '这身怎么样', lookAtMe: true }, CAMERA), { screen: false, camera: true, via: 'button' });
  assert.deepEqual(turns.decide({ text: '今天好累', lookAtMe: true }, BOTH), { screen: false, camera: true, via: 'button' }, 'the camera, not the screen');
  assert.deepEqual(turns.decide({ lookAtMe: true }, { screen: true, camera: false, scope: 's' }), { screen: false, camera: false, via: null }, '「发图片」 off: nothing');
  assert.deepEqual(turns.decide({ text: '', lookAtMe: true }, { ...CAMERA, cameraHeld: true }), { screen: false, camera: true, via: 'button', hold: false });
});

class Node {
  children: Node[] = []; parentElement: Node | null = null; hidden = false; title = ''; type = ''; id = ''; className = '';
  textContent = ''; innerHTML = ''; onclick: (() => void) | null = null; attributes = new Map<string, string>();
  append(...nodes: Node[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  insertBefore(node: Node, before: Node) { node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
}
function dom(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Node() } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); });
}

test('「让她看看我」 button: shows only while 「发图片」 is on (not for 「姿势识别」 alone or screen sharing); empty box sends "你看看我。"', t => {
  dom(t);
  const form = new Node(), send = new Node();
  form.append(send);
  let looks = 0;
  const button = new LookButton(form as unknown as HTMLElement, send as unknown as Element, true, () => { looks++; }, 'me');
  const element = button.element as unknown as Node;
  assert.equal(element.id, 'pet-look-me');
  assert.deepEqual(form.children, [element, send]);
  assert.equal(element.attributes.get('aria-label'), LOOK_ME_LABEL);
  assert.equal(element.hidden, true);
  button.update({ screenSharing: true, cameraSharing: true, cameraImages: false });
  assert.equal(element.hidden, true, 'screen sharing and 「姿势识别」 alone: hidden');
  element.onclick?.(); assert.equal(looks, 0);
  button.update({ screenSharing: false, cameraSharing: true, cameraImages: true });
  assert.equal(element.hidden, false);
  element.onclick?.(); assert.equal(looks, 1);
  button.update({ screenSharing: false, cameraSharing: false, cameraImages: false });
  assert.equal(element.hidden, true);
  button.dispose();
  // The screen button is unchanged.
  assert.equal(lookButtonShown('screen', { screenSharing: true }), true);
  assert.equal(lookButtonShown('screen', { screenSharing: false, cameraSharing: true, cameraImages: true }), false);
  assert.equal(lookButtonContent('  ', 'me'), LOOK_ME_MESSAGE);
  assert.equal(lookButtonContent(' 这身呢 ', 'me'), '这身呢');
  assert.equal(scanLookRequest(LOOK_ME_MESSAGE), 'camera', 'its default words ask for the camera on their own too');
  // English copy exists for both words.
  const en = readFileSync(new URL('../shared/foundation/ui-copy.en.ts', import.meta.url), 'utf8');
  assert.match(en, /'让她看看我': 'Let her see me', '你看看我。': 'Take a look at me.'/u);
});

/** LookAttachments with fake ports, as electron/main.ts wires them: a clear frame per capture, a ready small one. */
function attachments(state: { screen: boolean; camera: boolean; cameraHeld?: boolean }) {
  const counts = { camera: 0, screen: 0, glance: 0 };
  const held: boolean[] = [];
  const ports: LookAttachmentPorts = {
    noteActivity: () => {}, state: () => ({ ...state, scope: 's' }), sharesCameraFrames: () => state.camera, revision: () => 1, generation: () => 1,
    opening: () => 1,
    captureScreen: async () => { counts.screen++; return { source: 'screen', dataUrl: `data:image/jpeg;base64,U0NSRUVO${counts.screen}` }; },
    captureCamera: async () => { counts.camera++; return { source: 'camera', dataUrl: `data:image/jpeg;base64,Q0xFQVI${counts.camera}` }; },
    glance: () => { counts.glance++; return { source: 'camera', dataUrl: 'data:image/jpeg;base64,U01BTEw=' }; },
    holdCamera: value => { held.push(value); state.cameraHeld = value; },
  };
  return { host: new LookAttachments(new LookTurns(), ports), counts, held };
}

test('send path: the button and a looks question each take one clear picture, and the turn knows how it was asked for', async () => {
  const { host, counts } = attachments({ screen: false, camera: true });
  const button = await host.request(lookHint('', 'me'));
  assert.equal(counts.camera, 1);
  assert.equal(host.admit(button).cameraVia(), 'button');
  const meant = await host.request({ text: '老婆评价下我的穿搭' });
  assert.equal(counts.camera, 2);
  const frames = host.admit(meant);
  assert.equal(frames.cameraVia(), 'appearance');
  assert.equal(frames.cameraGlance(), false);
  const plain = await host.request({ text: '今天好累' });
  assert.equal(counts.camera, 2, 'an ordinary message never captures');
  assert.equal(host.admit(plain).cameraVia(), null, 'the small picture is not a clear look');
  const words = await host.request({ text: '你看看我' });
  assert.equal(host.admit(words).cameraVia(), 'words');
  const photo: Attachment = { source: 'camera', dataUrl: 'data:image/jpeg;base64,UEhPVE8=' };
  assert.equal(host.admit([photo]).cameraVia(), 'photo', 'a snapshot the user took by hand');
  // 「发图片」 off: the button takes nothing.
  const off = attachments({ screen: true, camera: false });
  assert.deepEqual(await off.host.request(lookHint('', 'me')), []);
  assert.equal(off.counts.camera + off.counts.screen + off.counts.glance, 0);
});

test('send path: held by "别看", a looks question captures nothing and stays held; the button lifts it', async () => {
  const { host, counts, held } = attachments({ screen: false, camera: true, cameraHeld: true });
  assert.deepEqual(await host.request({ text: '老婆评价下我的穿搭' }), []);
  assert.equal(counts.camera + counts.glance, 0);
  assert.deepEqual(held, []);
  const button = await host.request(lookHint('', 'me'));
  assert.equal(button.length, 1);
  assert.deepEqual(held, [false]);
});

// ---------------------------------------------------------------- 2. the per-turn line tells the truth

const RUNTIME = { screenSharing: false, cameraSharing: true, cameraLocal: false, cameraImages: true };
const line = (turn: PerceptionTurn) => perceptionTurnLine(turn);

test('her line: 「发图片」 on and no picture of the user says so (and why when held), also beside a screen picture; off: as before', () => {
  const none = perceptionTurnState(RUNTIME, [], '今天好累');
  assert.equal(line(none), '【此刻的感知】你看不到用户的屏幕。' + CAMERA_NONE_LINE);
  const held = perceptionTurnState({ ...RUNTIME, cameraHeld: true }, [], '老婆评价下我的穿搭');
  assert.equal(held.asked, null, 'held: a looks question is not read as asking');
  assert.equal(line(held), '【此刻的感知】你看不到用户的屏幕。' + CAMERA_HELD_LINE);
  // The evening's case: a screen picture went (和她一起看), 「发图片」 on, no picture of the user — before, not a word about the camera.
  const screen = perceptionTurnState({ ...RUNTIME, screenSharing: true }, [{ source: 'screen' }], '老婆评价下我的穿搭');
  assert.equal(line(screen), '【此刻的感知】' + SCREEN_LOOK_LINE + CAMERA_MISSED_LINE);
  const screenOnly = perceptionTurnState({ ...RUNTIME, screenSharing: true }, [{ source: 'screen' }], '你看看这个报错');
  assert.equal(line(screenOnly), '【此刻的感知】' + SCREEN_LOOK_LINE + CAMERA_NONE_LINE);
  // A clear picture of the user: the look line; the small one: unchanged.
  const clear = perceptionTurnState(RUNTIME, [{ source: 'camera' }], '老婆评价下我的穿搭');
  assert.equal(clear.asked, 'camera');
  assert.match(line(clear), /用户叫你看摄像头，本轮附了画面/u);
  assert.ok(line(perceptionTurnState(RUNTIME, [{ source: 'camera' }], '好累', { cameraGlance: true })).endsWith(GLANCE_LINE));
  // Asked, and no picture came.
  assert.equal(line(perceptionTurnState(RUNTIME, [], '你看看我')), '【此刻的感知】你看不到用户的屏幕。' + CAMERA_MISSED_LINE);
  // 「发图片」 off: byte for byte the old lines (a looks question is not read at all).
  const off = { screenSharing: false, cameraSharing: false, cameraLocal: false, cameraImages: false };
  assert.equal(line(perceptionTurnState(off, [], '老婆评价下我的穿搭')), '【此刻的感知】' + SENSING_OFF_LINE);
  assert.equal(line(perceptionTurnState({ ...off, cameraSharing: true, cameraLocal: true }, [], '老婆评价下我的穿搭')), '【此刻的感知】你看不到用户的屏幕。摄像头只在用户电脑上识别，你看不到画面。');
  assert.equal(line(perceptionTurnState({ ...off, screenSharing: true }, [{ source: 'screen' }], '你看看这个')), '【此刻的感知】' + SCREEN_LOOK_LINE);
  for (const turn of [none, held, screen, screenOnly]) assert.ok(line(turn).length <= PERCEPTION_LINE_MAX);
});

test('her line\'s length: what I-084 adds per turn, in characters (reported in the record)', () => {
  const before = {
    noPicture: '摄像头开着，但这一轮你没看画面；想看要用户叫你。',
    screenPicture: '',
  };
  const after = { noPicture: CAMERA_NONE_LINE, held: CAMERA_HELD_LINE, screenPicture: CAMERA_NONE_LINE };
  assert.equal(after.noPicture.length - before.noPicture.length, 1, '「发图片」 on, no picture: one character more');
  assert.equal(after.screenPicture.length - before.screenPicture.length, 25, 'a screen picture with 「发图片」 on: 25 more (the only real growth)');
  assert.equal(after.held.length - before.noPicture.length, -3, 'held: three fewer');
});

// ---------------------------------------------------------------- her offer

test('her "要我看看你吗？" opens a camera offer (no pet prompt); a short yes takes one clear picture; other words close it', () => {
  assert.equal(lookOfferTarget('要我看看你吗？'), 'camera');
  assert.equal(lookOfferTarget('诶，要不要我看一下你今天的样子？'), 'camera');
  assert.equal(lookOfferTarget('要我凑近看看吗？'), 'either');
  assert.equal(lookOfferTarget('要我看看你的屏幕吗？'), 'screen');
  assert.equal(lookOfferTarget('我看不到你呢。'), null);
  const turn = (over: Partial<PerceptionTurn>): PerceptionTurn => ({ screen: false, camera: 'frames', attached: { screen: false, camera: false }, asked: null, ...over });
  assert.equal(lookOfferFor(turn({}), 'camera'), 'camera');
  assert.equal(lookOfferFor(turn({}), 'either'), 'camera');
  assert.equal(lookOfferFor(turn({ screen: true }), 'either'), 'screen', 'unsaid goes to the screen first, as before');
  assert.equal(lookOfferFor(turn({ attached: { screen: false, camera: true }, glance: true }), 'camera'), 'camera', 'only the small picture: she may offer');
  assert.equal(lookOfferFor(turn({ attached: { screen: false, camera: true } }), 'camera'), null, 'she already had a clear one');
  assert.equal(lookOfferFor(turn({ camera: 'local' }), 'camera'), null, '「姿势识别」 alone: no picture to offer');
  assert.equal(lookOfferFor(turn({ camera: 'off' }), 'camera'), null);
  assert.equal(lookOfferFor(turn({}), null), null);

  const told: (LookOfferView | null)[] = [];
  let now = 1_000;
  const turns = new LookTurns(() => now, view => told.push(view));
  turns.noteOffer('s', 's', 'camera');
  assert.deepEqual(told, [], 'the pet prompt is about the screen: not shown for a camera offer');
  assert.equal(turns.offerOpen, true);
  assert.deepEqual(turns.decide({ text: '嗯' }, CAMERA), { screen: false, camera: true, via: 'offer' });
  assert.deepEqual(turns.decide({ text: '嗯' }, CAMERA), { screen: false, camera: false, via: null, glance: true }, 'answered once only');
  turns.noteOffer('s', 's', 'camera');
  assert.deepEqual(turns.decide({ text: '不用啦' }, CAMERA), { screen: false, camera: false, via: null, glance: true });
  turns.noteOffer('s', 's', 'camera');
  assert.deepEqual(turns.decide({ text: '嗯' }, { ...CAMERA, camera: false }), { screen: false, camera: false, via: null }, '「发图片」 turned off meanwhile');
  turns.noteOffer('s', 's', 'camera');
  now += 11 * 60_000;
  assert.deepEqual(turns.decide({ text: '嗯' }, CAMERA), { screen: false, camera: false, via: null, glance: true }, 'expired');
  // A held 「发图片」: her offer and the user's yes are a yes to looking (the hold lifts, as with "看看我").
  turns.noteOffer('s', 's', 'camera');
  assert.deepEqual(turns.decide({ text: '好' }, { ...CAMERA, cameraHeld: true }), { screen: false, camera: true, via: 'offer', hold: false });
  // The screen offer is unchanged: the prompt shows, and a decline by id works only for it.
  turns.noteOffer('s', 's');
  assert.equal(told.filter(Boolean).length, 1);
  assert.deepEqual(turns.decide({ text: '嗯' }, BOTH), { screen: true, camera: false, via: 'offer', glance: true });
  turns.noteOffer('s', 's', 'camera');
  assert.equal(turns.decline('anything', BOTH), false);
});

// ---------------------------------------------------------------- 4. the experience journal

test('journal line: closed words only; clear says how, none/small say why, later says neither; anything else is no line', () => {
  const at = Date.UTC(2026, 10, 11, 11, 2, 0);
  const ok = (input: object) => buildJournalEntry({ type: 'camera-look', characterId: 'gene', ...input }, at);
  assert.ok(ok({ seen: 'clear', via: 'appearance' }));
  assert.ok(ok({ seen: 'later' }));
  assert.ok(ok({ seen: 'none', why: 'judge-no' }));
  assert.ok(ok({ seen: 'small', why: 'cut-short' }));
  for (const bad of [{ seen: 'clear' }, { seen: 'clear', via: 'appearance', why: 'held' }, { seen: 'none' }, { seen: 'none', why: '老婆评价下我的穿搭' },
    { seen: 'later', why: 'held' }, { seen: 'looked' }, { seen: 'none', why: 'held', via: 'words' }])
    assert.equal(ok(bad), null, JSON.stringify(bad));
  const smuggled = ok({ seen: 'none', why: 'held', text: '老婆评价下我的穿搭', picture: 'data:image/jpeg;base64,QQ==' })!;
  assert.doesNotMatch(JSON.stringify(smuggled), /穿搭|base64/u);
  const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
  const text = (input: object) => describeJournalEntry(ok(input)!, plain).replace(/^\d\d:\d\d /u, ''); // the clock is local time
  assert.equal(text({ seen: 'none', why: 'judge-no' }), '这一轮她没看到你（她判断这句不用看）');
  assert.equal(text({ seen: 'clear', via: 'appearance' }), '这一轮她看清了你（你问到自己的样子）');
  assert.equal(text({ seen: 'later' }), '她回完话又看了你一眼');
  for (const word of ['这一轮她没看到你', '她判断这句不用看', '你问到自己的样子', '她回完话又看了你一眼', '没等她判断完或看完，这一轮就过去了', '这句要不要看，没判断出来'])
    assert.ok(ENGLISH_JOURNAL_UI_COPY[word], word);
});

test('journal: one line per turn with 「发图片」 on — right away when the reply settles it, after her own look otherwise; none when off', () => {
  const lines: CameraLookLine[] = [];
  const journal = new CameraLookJournal(line => lines.push(line));
  const base = { frames: true, via: null, small: false, held: false, screenSharing: false, text: '今天好累' };
  journal.turn('a', { ...base, frames: false }, true);
  assert.deepEqual(lines, [], '「发图片」 off: no line');
  journal.turn('b', { ...base, via: 'appearance', text: '老婆评价下我的穿搭' }, true);
  journal.turn('c', { ...base, held: true }, true);
  journal.turn('d', { ...base, text: '老婆评价下我的穿搭' }, true); // asked by its meaning, and no frame came
  assert.deepEqual(lines, [{ seen: 'clear', via: 'appearance' }, { seen: 'none', why: 'held' }, { seen: 'none', why: 'no-frame' }]);
  journal.turn('e', { ...base, small: true }, true);
  assert.equal(journal.waiting, 1);
  journal.sensed('e', 'judge-no');
  journal.turn('f', base, true); journal.sensed('f', 'seen');
  journal.turn('g', base, false);
  journal.sensed('zzz', 'seen'); // unknown: nothing
  assert.deepEqual(lines.slice(3), [{ seen: 'small', why: 'judge-no' }, { seen: 'later' }, { seen: 'none', why: 'not-asked' }]);
  for (let i = 0; i <= CAMERA_LOOK_OPEN_MAX; i++) journal.turn(`o${i}`, base, true);
  assert.equal(journal.waiting, CAMERA_LOOK_OPEN_MAX);
  assert.deepEqual(lines.at(-1), { seen: 'none', why: 'cut-short' }, 'the oldest open turn is written as cut short');
  // The pure parts.
  assert.deepEqual(cameraLookFirst({ via: null, small: false, held: false, asked: false }), { waits: { small: false } });
  for (const [result, why] of [['judge-no', 'judge-no'], ['no-judgment', 'no-judgment'], ['off', 'no-frame'], ['cut-short', 'cut-short'], ['failed', 'look-failed'], ['untaken', 'not-asked']] as const)
    assert.deepEqual(cameraLookLater(false, result), { seen: 'none', why });
});

// ---------------------------------------------------------------- 1b. the I-040 judgment

class Clock {
  now = 0; private timers: { at: number; fn: () => void; id: number }[] = []; private next = 0;
  readonly api = { set: (fn: () => void, ms: number) => { const id = ++this.next; this.timers.push({ at: this.now + Math.max(0, ms), fn, id }); return id; },
    clear: (id: unknown) => { this.timers = this.timers.filter(t => t.id !== id); } };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift(); this.now = Math.max(this.now, due.at); due.fn();
    }
    this.now = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function router(options: { judge?: string; frame?: string | null; on?: Partial<SenseOn>; enabled?: boolean } = {}) {
  const clock = new Clock();
  const results: [string, SenseCameraResult][] = [];
  const state = { free: true };
  const ports: SenseRouterPorts = {
    enabled: () => options.enabled ?? true, on: () => ({ camera: true, screen: false, transcript: false, ...options.on }), identity: () => 'i', conversation: () => 'c',
    capture: async () => options.frame === undefined ? 'data:image/jpeg;base64,RkFLRQ==' : options.frame,
    heard: () => null,
    ask: async (_prompt, system) => system.includes('感知判定员') ? options.judge ?? '{"senses":["camera"]}' : '他穿着一件蓝色衬衫。',
    line: async () => JSON.stringify({ text: '这身蓝衬衫挺精神的' }),
    character: () => ({ id: 'heroine', persona: 'p', language: '' }), mood: () => '', free: () => state.free,
    publish: () => true, speechStyle: () => {}, archive: async () => {},
    cameraLook: (id, result) => results.push([id, result]),
    clock: () => clock.now, timers: clock.api, createId: () => 'x',
  };
  const host = new SenseRouterHost(ports);
  return { host, clock, results, state };
}

test('I-040: the judgment\'s camera words name looks; each turn it took reports what became of the camera, once', async () => {
  const block = senseBlock({ camera: true, screen: false, transcript: false });
  assert.match(block, /穿搭发型、好不好看/u);
  assert.match(block, /手里拿给她看的/u);

  // Judged not needed.
  const no = router({ judge: '{"senses":[]}' });
  assert.equal(no.host.userTurn('m1', '今天好累', { merged: false }), true);
  no.host.firstChar('m1'); await no.clock.advance(100);
  no.host.replyDone('m1', true, '辛苦啦'); await no.clock.advance(100);
  assert.deepEqual(no.results, [['m1', 'judge-no']]);

  // Needed, looked, her line said.
  const seen = router();
  seen.host.userTurn('m1', '老婆评价下我的穿搭', { merged: false });
  seen.host.firstChar('m1'); await seen.clock.advance(100);
  seen.host.replyDone('m1', true, '嗯？'); await seen.clock.advance(300);
  seen.host.done(true, { id: 'sense-x', shown: true }); await seen.clock.advance(100);
  assert.deepEqual(seen.results, [['m1', 'seen']]);

  // The user typed and sent the next message before her line could show (the evening's likely case): cut short.
  const cut = router();
  cut.state.free = false;
  cut.host.userTurn('m1', '老婆评价下我的穿搭', { merged: false });
  cut.host.firstChar('m1'); await cut.clock.advance(100);
  cut.host.replyDone('m1', true, '我只看得到屏幕'); await cut.clock.advance(5_000);
  cut.host.userTurn('m2', '我不是开了摄像头发图片么', { merged: false });
  assert.deepEqual(cut.results, [['m1', 'cut-short']]);

  // Superseded before any judgment; no frame came; the camera off or held by this message; no usable judgment.
  const early = router();
  early.host.userTurn('m1', '我这身怎么样', { merged: false });
  early.host.userTurn('m2', '好吧', { merged: false });
  assert.deepEqual(early.results, [['m1', 'cut-short']]);
  const noFrame = router({ frame: null });
  noFrame.host.userTurn('m1', '我这身怎么样', { merged: false }); noFrame.host.firstChar('m1'); await noFrame.clock.advance(100);
  noFrame.host.replyDone('m1', true, '嗯'); await noFrame.clock.advance(100);
  assert.deepEqual(noFrame.results, [['m1', 'failed']]);
  const held = router({ on: { screen: true, transcript: true } }); // something left on that this message does not hold
  held.host.userTurn('m1', '别看我', { merged: false }); held.host.firstChar('m1'); await held.clock.advance(100);
  held.host.replyDone('m1', true, '好'); await held.clock.advance(100);
  assert.deepEqual(held.results, [['m1', 'off']]);
  const junk = router({ judge: 'not json' });
  junk.host.userTurn('m1', '我这身怎么样', { merged: false }); junk.host.firstChar('m1'); await junk.clock.advance(100);
  junk.host.replyDone('m1', true, '嗯'); await junk.clock.advance(100);
  assert.deepEqual(junk.results, [['m1', 'no-judgment']]);

  // Not taken (feature off): userTurn says so, and nothing is reported.
  const off = router({ enabled: false });
  assert.equal(off.host.userTurn('m1', '我这身怎么样', { merged: false }), false);
  assert.deepEqual(off.results, []);
});

// ---------------------------------------------------------------- the wiring (hot files: only lines that connect)

test('wiring: main.ts writes the journal line per chat turn and opens the camera offer; the windows get 「让她看看我」', () => {
  const main = wiringSource();
  assert.match(main, /const cameraLookJournal = new CameraLookJournal\(line => \{ appJournal\.record\(\{ type: 'camera-look', characterId: journalCharacterId\(\), \.\.\.line \}\); \}\);/u);
  assert.match(main, /cameraLook: \(id, result, detail\) => cameraLookJournal\.sensed\(id, result, detail\),/u);
  assert.match(main, /const sensed = senseRouter\.userTurn\(request\.id, request\.messages\.at\(-1\)\?\.content, reactions\.host\.asking\(request\.id\), turnFrames\.asked\(\), request\.messages\);/u);
  assert.match(main, /cameraLookJournal\.turn\(request\.id, \{ frames: media\.sharesCameraFrames\(\), via: turnFrames\.cameraVia\(\), small: turnFrames\.cameraGlance\(\), held: media\.state\.cameraHeld === true/u);
  assert.match(main, /const offerTo = turn\.lookOffer\?\.\(\) \? lookOfferFor\(sight, lookOfferTarget\(voiceContextBody\)\) : null;/u);
  assert.match(main, /if \(offerTo\) lookTurns\.noteOffer\(sightScope, lookScope\(\), offerTo\);/u);
  const renderer = readRendererSource();
  assert.match(renderer, /input\.value = lookButtonContent\(input\.value, 'me'\); void sendChat\(true, 'me'\);/u);
  assert.match(renderer, /lookButton\?\.update\(next\); lookMeButton\?\.update\(next\);/u);
  assert.match(renderer, /const shared = await timed\('look', window\.desktop\.sharedAttachments\(lookHint\(content, look\)\)\);/u); // 2026-11-22: the wait is timed (src/brain/send-guard.ts)
});
