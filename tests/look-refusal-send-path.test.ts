// Codex T-205 第二轮（X-253，2026-11-04，固定 a9ad29f）：真实 Electron 里开着屏幕共享，发"禁止查看我的屏幕""请停止查看我的屏幕"
// "别擅自看我的屏幕""没授权你看我屏幕""不允许你看我屏幕"或"同事原话是‘你看看这个报错’"，六句各取了一帧屏幕、各有一张图到模拟 Claude。
// 根因在唯一的判断 shared/look-request.ts：这些说法不在第 030 轮补的否定和转述规则里，被认成了"叫她看"（docs/claude/2026-11-04-v1-refusal-grab.md）。
// 这里走真实发送路径：窗口这一半（src/look-send.ts，sendChat 用的就是它）→ 宿主附图（electron/look-attachments.ts，preload
// sharedAttachments 的处理）→ 宿主聊天入口（electron/validation.ts validateChatRequest，再把附件交给聊天适配器）→ 这一轮的感知行；
// 取图口和 Claude 都是假的，不开窗口、不碰真实屏幕。
// 屏幕只读大概：共享开着的普通消息一张图都不带，感知行只说"大概"（这里假的大概是"写代码"）；说不之后连大概也不说。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { LookTurns, PROACTIVE_VISION_DEFAULT } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { lookButtonContent } from '../src/ui/LookButton';
import { perceptionTurnLine, perceptionTurnState, roughLine, SCREEN_LOOK_LINE, SHARING_LINE } from '../shared/perception-rule';

/** Codex 报告里的六句原句。 */
const T205_ROUND2 = ['禁止查看我的屏幕', '请停止查看我的屏幕', '别擅自看我的屏幕', '没授权你看我屏幕', '不允许你看我屏幕', '同事原话是‘你看看这个报错’'];
/** 同类说法：拒绝、禁止、没授权、不允许、怀疑她在看、转述和引号。 */
const SIMILAR = [
  '不要看', '别看了', '我没让你看', '严禁查看我的屏幕', '禁止你看我屏幕', '不准你看我的屏幕', '不许你偷看我屏幕', '请勿查看我的屏幕',
  '请不要查看我的屏幕', '停止观看我的屏幕', '不要再查看我的屏幕了', '别私自看我电脑', '不要擅自查看屏幕', '没经过我同意就看我屏幕',
  '未经允许不要看我屏幕', '未经我同意你看我屏幕', '我没授权你查看屏幕', '没有授权你看我的屏幕', '我不同意你看我屏幕', '我拒绝你看我屏幕',
  '我不希望你看我屏幕', '我不喜欢你看我屏幕', '你无权查看我的屏幕', '你没资格看我屏幕', '谁允许你看我屏幕的', '不要截我的屏幕', '别截屏',
  '不要窥视我的屏幕', '看我屏幕是不允许的', '你敢看我屏幕试试', '你凭什么看我屏幕', '屏幕不给你看', '没让你看我屏幕，你看看这个',
  '你是不是在看我屏幕', '你在偷看我屏幕吗', '你有没有看我屏幕', '你又在看我屏幕', '你怎么又看我屏幕', '你一直盯着我屏幕干嘛', '你看了我的屏幕？',
  '干嘛看我屏幕', '看我屏幕干嘛',
];
/** Someone else's words about looking: an ordinary message (no frame; she still knows roughly what the user does). */
const RELAYED = [
  '他说‘你看看这个报错’', '同事原话是你看看这个报错', '同事原话：你看看这个报错', '他发来：你看看这个报错', '群里有人说你看看我屏幕',
  '弹幕说你看看这个', '她留言说帮我看看这段代码', '原文是〝你看看我屏幕〞', "他说'你看看这个'", '老板说的是你看一下这个报错',
];

const FRAME: Attachment = { source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' };
/** 屏幕只读大概: what the rough reading says in this test (electron/main.ts roughForTurn), unless a no holds. */
const ROUGH = '【此刻的感知】' + roughLine('code');
const HELD = '【此刻的感知】' + SHARING_LINE;

/** The send path with a fake capture port and a fake Claude: what was taken, what reached her, and in which order. */
function sendPath() {
  const media = { screenSharing: true, cameraSharing: false, revision: 1 };
  const order: string[] = [];
  let captures = 0, turnNumber = 0;
  const turns = new LookTurns(() => 0);
  const state = () => ({ screen: media.screenSharing, camera: false, scope: `conversation|${media.revision}` });
  const decide = turns.decide.bind(turns);
  turns.decide = (hint, state) => { order.push('decide'); return decide(hint, state); };
  const host = new LookAttachments(turns, {
    noteActivity: () => { order.push('activity'); },
    state: () => state(),
    sharesCameraFrames: () => false,
    revision: () => media.revision,
    generation: () => 1,
    opening: () => 1,
    captureScreen: async () => { order.push('capture'); captures++; return { ...FRAME }; },
    captureCamera: async () => { throw new Error('no camera in this test'); },
  });
  const claude: { text: string; images: string[]; sight: string }[] = [];
  /** sendChat (src/main.ts): ask the host for this turn's frames, then send the chat; the host's chat handler hands them to Claude. */
  async function send(content: string, look = false): Promise<void> {
    order.length = 0;
    const shared = await host.request(lookHint(content, look));
    const request = validateChatRequest({ id: `turn-${++turnNumber}`, messages: [{ role: 'user', content }], attachments: turnAttachments([], shared) });
    const frames = host.admit(request.attachments); request.attachments = frames.current(); // the chat handler's check (tests/look-stale-frame.test.ts)
    turns.userTurn();
    // electron/main.ts roughForTurn: sharing on and no "别看" holding.
    const rough = media.screenSharing && !turns.refusedIn(state()) ? 'code' as const : undefined;
    const sight = perceptionTurnState(media, request.attachments, request.messages.at(-1)?.content, { rough });
    claude.push({ text: content, images: request.attachments.map(attachment => attachment.dataUrl), sight: perceptionTurnLine(sight) });
  }
  return { send, media, order, claude, captures: () => captures, last: () => claude.at(-1)! };
}

// Each sentence on a fresh path (a no holds for the messages after it, which would hide a sentence that is not read as one).
test('Codex T-205 第二轮六句：开着共享，6 句都 0 取图、0 张图到 Claude；说不的五句连"大概"也不说，转述那句照常只说大概', async () => {
  for (const text of T205_ROUND2) {
    const path = sendPath();
    await path.send(text);
    assert.deepEqual(path.last().images, [], `${text}：不能有图发出`);
    assert.equal(path.captures(), 0, text);
    if (text.startsWith('同事')) { assert.equal(path.last().sight, ROUGH, text); continue; }
    assert.equal(path.last().sight, HELD, text);
    assert.deepEqual(path.order, ['activity', 'decide'], `${text}：判断说不，就走不到取图`);
    assert.equal(path.captures(), 0);
  }
});

test('同类说法（拒绝、禁止、没授权、不允许、怀疑她在看）同样 0 取图、0 张图、不说大概；转述别人的话也 0 取图、0 张图', async () => {
  const leaked: string[] = [];
  for (const text of SIMILAR) {
    const path = sendPath();
    await path.send(text);
    if (path.captures() || path.last().images.length || path.last().sight !== HELD) leaked.push(text);
  }
  assert.deepEqual(leaked, []);
  assert.ok(SIMILAR.length >= 40, '一批同类说法');
  const wrong: string[] = [];
  for (const text of RELAYED) {
    const path = sendPath();
    await path.send(text);
    if (path.captures() || path.last().images.length || path.last().sight !== ROUGH) wrong.push(text);
  }
  assert.deepEqual(wrong, []);
  assert.ok(RELAYED.length >= 10);
});

// 屏幕只读大概：共享开着，普通话 0 张图、只说大概；说不之后连大概也不说，直到再叫她看（REFUSAL_HOLDS）。
test('明确叫她看、按"给她看看屏幕"照旧现截一张；普通话 0 张图、只说大概；说不之后不说大概，再叫她看就恢复', async () => {
  const path = sendPath();
  // [text, button, images (= captures), what her line says when there is no image]
  const steps: ReadonlyArray<[string, boolean, number, string]> = [
    ['禁止查看我的屏幕', false, 0, HELD], ['谢谢', false, 0, HELD], ['你看看这个', false, 1, ''], ['谢谢', false, 0, ROUGH], ['别擅自看我的屏幕', false, 0, HELD],
    ['晚上吃什么好呢', false, 0, HELD], ['帮我看下屏幕', false, 1, ''],
    ['你帮我看看这个报错', false, 1, ''], ['你看看我屏幕，这个是什么', false, 1, ''], ['你现在看看我屏幕', false, 1, ''], ['不过你看看这个报错', false, 1, ''],
    ['晚上吃什么好呢', false, 0, ROUGH], ['我看看', false, 0, ROUGH], ['不要看我的屏幕', false, 0, HELD],
    // 按钮是用户自己按的：写着什么都现截屏幕；空着时发"你看看我的屏幕。"
    ['不要看我的屏幕', true, 1, ''], [lookButtonContent(''), true, 1, ''], ['好的', false, 0, ROUGH],
  ];
  for (const [text, look, images, line] of steps) {
    const before = path.captures();
    await path.send(text, look);
    assert.equal(path.last().images.length, images, text);
    assert.equal(path.captures() - before, images, `${text}：现截的次数`);
    if (images) assert.deepEqual(path.last().images, [FRAME.dataUrl], text);
    assert.equal(path.last().sight, images ? '【此刻的感知】' + SCREEN_LOOK_LINE : line, text);
    const captured = images > 0;
    assert.deepEqual(path.order, captured ? ['activity', 'decide', 'capture'] : ['activity', 'decide'], `${text}：先判断，后取图`);
  }
});

test('共享关着：叫她看、按按钮都不取图；格式不对的请求在取图之前就被拒', async () => {
  const path = sendPath();
  path.media.screenSharing = false;
  for (const [text, look] of [['你看看我屏幕', false], ['这题怎么做', true]] as const) {
    await path.send(text, look);
    assert.deepEqual(path.last().images, [], text);
  }
  path.media.screenSharing = true;
  const turns = new LookTurns(() => 0);
  let captures = 0;
  const host = new LookAttachments(turns, {
    noteActivity: () => {}, state: () => ({ screen: true, camera: false, scope: 's' }), sharesCameraFrames: () => false,
    revision: () => 1, generation: () => 1, opening: () => 1, captureScreen: async () => { captures++; return { ...FRAME }; }, captureCamera: async () => null,
  });
  await assert.rejects(host.request({ text: '你看看这个', extra: true }));
  await assert.rejects(host.request({ text: 1 }));
  assert.equal(captures, 0);
  assert.equal(path.captures(), 0);
});

// Codex T-205 第四轮（X-258，固定 9f58785）：桌宠聊天发"我撤回你看我屏幕的授权。"、控制窗发"同事当时说，你看看这个报错。"和
// "同事当时说，你看看这个报错，这是他的原话。"，开着共享各取了一帧、各有一张图到模拟后端。
// A take-back holds for the messages after it (no rough reading either); someone else's words are an ordinary message.
test('Codex T-205 第四轮三句：都 0 取图、0 张图；撤回授权之后连大概也不说；转述别人的话照常只说大概；明确叫她看照旧取一张', async () => {
  for (const [text, holds] of [['我撤回你看我屏幕的授权。', true], ['同事当时说，你看看这个报错。', false], ['同事当时说，你看看这个报错，这是他的原话。', false]] as const) {
    const path = sendPath();
    await path.send(text);
    assert.deepEqual(path.last().images, [], text);
    assert.equal(path.last().sight, holds ? HELD : ROUGH, text);
    assert.deepEqual(path.order, ['activity', 'decide'], `${text}：都不现截`);
    await path.send('好的');
    assert.deepEqual(path.last().images, [], `${text} 之后的"好的"`);
    assert.equal(path.last().sight, holds ? HELD : ROUGH, `${text} 之后的"好的"`);
    assert.equal(path.captures(), 0);
    await path.send('你看看这个报错');
    assert.equal(path.last().images.length, 1);
    assert.equal(path.captures(), 1);
  }
});

test('R10 主动看画面默认关，聊天发送路径不会因为共享开着就自己看', () => {
  assert.equal(PROACTIVE_VISION_DEFAULT, false);
});

test('和她一起看 (screen sharing + 一起听): an ordinary message takes one screen frame; a "别看" holds it; screen sharing alone stays rough only', async () => {
  let watching = true, captured = 0;
  const look = new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: true, camera: false, scope: 's', screenOpening: 1 }),
    sharesCameraFrames: () => false, revision: () => 0, generation: () => 0, opening: () => 1,
    captureScreen: async () => { captured++; return { source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/screenAA==' }; },
    captureCamera: async () => null, watchingTogether: () => watching });
  assert.equal((await look.request(lookHint('看着好馋', false))).length, 1, 'watching together: the screen comes along');
  assert.equal((await look.request(lookHint('别看我屏幕', false))).length, 0, 'a no holds it');
  assert.equal((await look.request(lookHint('看着好馋', false))).length, 0, 'and keeps holding');
  watching = false;
  const plain = new LookAttachments(new LookTurns(), { noteActivity() {}, state: () => ({ screen: true, camera: false, scope: 's2', screenOpening: 1 }),
    sharesCameraFrames: () => false, revision: () => 0, generation: () => 0, opening: () => 1,
    captureScreen: async () => { captured++; return { source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/screenAA==' }; },
    captureCamera: async () => null, watchingTogether: () => watching });
  assert.equal((await plain.request(lookHint('看着好馋', false))).length, 0, 'screen sharing alone: rough only, as decided on 2026-11-04');
  assert.equal(captured, 1);
});
