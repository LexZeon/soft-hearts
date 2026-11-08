// Codex T-205 第四轮（X-258，2026-11-04，固定 9f58785）：宿主分不清"共享取来的帧"和"用户亲手附的快照"。
// 修之前宿主只记最近四张交出去的帧，按图片字节认：
//   1. 用实际 IPC 取五张不同的共享帧、暂留第一张，关共享后只提交第一张：第一张已被挤出记录，被当成手动快照，到了常驻后端；
//   2. 撤权后用户新附一张手动快照，字节碰巧和旧共享帧一样：被认成旧共享帧，丢了（用户亲手附的应该照发）；
//   3. 控制窗口里还没发出的手动附件，在桌宠上关掉共享后从一张变成零张（之前根本没有共享取图）：窗口收到撤权通知就清空了草稿。
// 修法：宿主给自己交出去的每一张共享帧发一个随机记号（shareTicket），窗口原样带回；宿主只认自己发过、而且还活着的记号。
// 带记号的就是共享帧，记号认不出（过期、被挤出、伪造）就丢，绝不会因为被忘了而变成手动快照；不带记号的是用户亲手附的，照发，
// 不再比字节。窗口收到撤权通知时留着用户亲手附的草稿附件。docs/claude/2026-11-04-v1-refusal-grab.md 末节。
// 这里用真实的媒体开关、宿主附图、聊天请求校验、这一轮的帧（TurnFrames）和感知行，取图口和 Claude 是假的，不开窗口、不碰屏幕。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Attachment } from '../shared/contracts';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments, SHARE_TICKETS_KEPT } from '../electron/look-attachments';
import { MediaRuntime } from '../electron/runtime';
import { validateChatRequest } from '../electron/validation';
import { draftAfterClear, lookHint, turnAttachments } from '../src/look-send';
import { perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';

const PERSONA = '你是测试角色。';

/** The host as electron/main.ts wires it; every capture is a different picture unless `bytes` fixes it. */
function host(options: { bytes?: string } = {}) {
  const media = new MediaRuntime(undefined, { mode: () => 'share' });
  let generation = 0, shots = 0;
  const frame = (source: Attachment['source']): Attachment =>
    ({ source, dataUrl: options.bytes ?? `data:image/jpeg;base64,/9j/${source}${++shots}AA==` });
  const look = new LookAttachments(new LookTurns(() => 0), {
    noteActivity: () => { generation++; },
    state: () => ({ screen: media.state.screenSharing, camera: media.sharesCameraFrames() && !!media.state.cameraOwner, scope: `conversation|${media.revision}` }),
    sharesCameraFrames: () => media.sharesCameraFrames(),
    revision: () => media.revision,
    generation: () => generation,
    opening: source => media.openings[source],
    captureScreen: async () => frame('screen'),
    captureCamera: async () => (media.sharesCameraFrames() ? frame('camera') : null),
  });
  const claude: { text: string; images: string[]; sight: string }[] = [];
  /** src/main.ts sendChat up to the chat request. */
  async function ask(content: string, manual: Attachment[] = []) {
    return { content, attachments: turnAttachments(manual, await look.request(lookHint(content, false))) };
  }
  let id = 0;
  /** electron/main.ts `chat`: the entry check, the check where the perception line is written, then the adapter reads at its write. */
  function chat(sent: { content: string; attachments: readonly Attachment[] }) {
    // Through structured clone, as over IPC: what the window holds is what the host gets back.
    const request = validateChatRequest(structuredClone({ id: `turn-${++id}`, messages: [{ role: 'user', content: sent.content }], attachments: sent.attachments }));
    const frames = look.admit(request.attachments); request.attachments = frames.current();
    request.attachments = frames.current();
    const text = request.messages.at(-1)?.content;
    const sightAgain = (left: Attachment[]) => PERSONA + '\n\n' + perceptionTurnLine(perceptionTurnState(media.state, left, text));
    const written = frames.recompose(request.attachments, sightAgain(request.attachments), sightAgain);
    claude.push({ text: sent.content, images: frames.current().map(attachment => attachment.dataUrl), sight: written.slice(PERSONA.length + 2) });
  }
  return { media, look, ask, chat, claude, last: () => claude.at(-1)! };
}

test('Codex 第四轮：取五张不同的共享帧、暂留第一张，关共享并清掉视觉上下文后只提交第一张：0 张图到 Claude，文字照常发出', async () => {
  for (const reopen of [false, true]) {
    const h = host();
    h.media.update({ screenSharing: true }, 'controls');
    const held = await h.ask('你看看我屏幕');
    for (let i = 0; i < 4; i++) await h.ask('你看看我屏幕'); // four more frames, each answered (the window would send them)
    assert.equal(held.attachments.length, 1);
    h.media.update({ screenSharing: false }, 'controls');
    h.look.abort(); // electron/main.ts mediaChanged → clearVisionContext ("收到清理通知")
    if (reopen) h.media.update({ screenSharing: true }, 'controls');
    h.chat(held);
    assert.equal(h.last().text, '你看看我屏幕', '文字照常发出');
    assert.deepEqual(h.last().images, [], reopen ? '关掉再打开之后' : '关掉之后');
    assert.doesNotMatch(h.last().sight, /附了画面/);
  }
});

test('只关共享、不清上下文，或者只清上下文：暂留的第一张也不发；共享一直开着时它照常带上（同一次开启里的帧）', async () => {
  const off = host();
  off.media.update({ screenSharing: true }, 'controls');
  const held = await off.ask('你看看我屏幕');
  for (let i = 0; i < 9; i++) await off.ask('你看看我屏幕');
  off.media.update({ screenSharing: false }, 'controls');
  off.chat(held);
  assert.deepEqual(off.last().images, []);
  const cleared = host();
  cleared.media.update({ screenSharing: true }, 'controls');
  const old = await cleared.ask('你看看我屏幕');
  for (let i = 0; i < 9; i++) await cleared.ask('你看看我屏幕');
  cleared.look.abort();
  cleared.chat(old);
  assert.deepEqual(cleared.last().images, []);
  const on = host();
  on.media.update({ screenSharing: true }, 'controls');
  const first = await on.ask('你看看我屏幕');
  for (let i = 0; i < 9; i++) await on.ask('你看看我屏幕');
  on.chat(first);
  assert.deepEqual(on.last().images, [first.attachments[0].dataUrl], '还是这次开启、上下文没变：照发');
});

test('Codex 第四轮：撤权后新附的手动快照和旧共享帧字节完全相同，照发（认来源，不认字节）', async () => {
  const bytes = 'data:image/jpeg;base64,/9j/sameBytesAA==';
  const h = host({ bytes });
  h.media.update({ screenSharing: true }, 'controls');
  const shared = await h.ask('你看看我屏幕');
  assert.equal(shared.attachments[0].dataUrl, bytes);
  h.media.update({ screenSharing: false }, 'controls');
  h.look.abort();
  h.chat(shared);
  assert.deepEqual(h.last().images, [], '旧共享帧不发');
  // 控制窗口"附屏幕快照"：宿主的 captureScreen 交回 { source, dataUrl }，没有记号。
  const manual: Attachment = { source: 'screen', dataUrl: bytes };
  const byHand = await h.ask('这是我截的图', [manual]);
  h.chat(byHand);
  assert.deepEqual(h.last().images, [bytes], '用户亲手附的一张照发');
  // 同一轮里手动快照和刚取的共享帧字节一样：各按各的来源，都发；随后关掉摄像头，共享的那张丢，手动的那张照发。
  h.media.update({ cameraSharing: true }, 'controls');
  const both = await h.ask('你看看我', [manual]);
  assert.deepEqual(both.attachments.map(a => a.source), ['screen', 'camera']);
  h.chat(both);
  assert.deepEqual(h.last().images, [bytes, bytes]);
  const again = await h.ask('你看看我', [manual]);
  h.media.update({ cameraSharing: false }, 'controls');
  h.chat(again);
  assert.deepEqual(h.last().images, [bytes], '只剩手动的那张');
});

test('记号认不出就丢，不当成手动快照：伪造、格式不对、用过一次、上一轮开启的记号都不发', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const sent = await h.ask('你看看我屏幕');
  const ticket = sent.attachments[0].shareTicket;
  assert.equal(typeof ticket, 'string', '宿主交出去的共享帧带着记号');
  assert.ok(ticket!.length >= 16, '随机记号，猜不到');
  const frame = sent.attachments[0].dataUrl;
  for (const forged of ['not-a-ticket', '', 'x'.repeat(200)]) {
    h.chat({ content: '你看看我屏幕', attachments: [{ source: 'screen', dataUrl: frame, shareTicket: forged }] });
    assert.deepEqual(h.last().images, [], `伪造的记号：${forged.slice(0, 12)}`);
  }
  h.chat({ content: '你看看我屏幕', attachments: [{ source: 'screen', dataUrl: frame, shareTicket: 7 as unknown as string }] });
  assert.deepEqual(h.last().images, [], '不是字符串的记号');
  h.chat(sent);
  assert.deepEqual(h.last().images, [frame], '真的记号：这一帧照发');
  h.chat(sent);
  assert.deepEqual(h.last().images, [], '一张共享帧只跟它那一条消息走，再发一次不算');
});

test(`内存有上限：一次开启里攒很多没发出去的帧，宿主最多记 ${SHARE_TICKETS_KEPT} 个记号（不存图），被挤掉的旧帧丢掉而不是放行；开启一结束整代作废`, async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const first = await h.ask('你看看我屏幕');
  let latest = first;
  for (let i = 0; i < SHARE_TICKETS_KEPT * 3; i++) latest = await h.ask('你看看我屏幕');
  assert.ok(h.look.outstanding <= SHARE_TICKETS_KEPT, `记着 ${h.look.outstanding} 个`);
  h.chat(first);
  assert.deepEqual(h.last().images, [], '被挤掉的最早那张：丢掉，不当成手动快照');
  h.chat(latest);
  assert.deepEqual(h.last().images, [latest.attachments[0].dataUrl], '最新的照常带上');
  for (let i = 0; i < 5; i++) await h.ask('你看看我屏幕');
  assert.ok(h.look.outstanding > 0);
  h.media.update({ screenSharing: false }, 'controls');
  h.media.update({ screenSharing: true }, 'controls');
  await h.ask('今天好累啊'); // any later request (or chat) forgets the ended opening's tickets
  assert.equal(h.look.outstanding, 0, '上一次开启的记号全部作废、不再占内存');
});

test('聊天请求校验：记号原样留下给宿主核对（不是字符串的变成认不出的空记号），没有记号的附件照旧是 { source, dataUrl }', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/AA==';
  const request = validateChatRequest({ id: 'a', messages: [{ role: 'user', content: 'x' }], attachments: [
    { source: 'screen', dataUrl, shareTicket: 'abc' }, { source: 'camera', dataUrl, shareTicket: { forged: true } },
  ] });
  assert.deepEqual(request.attachments, [{ source: 'screen', dataUrl, shareTicket: 'abc' }, { source: 'camera', dataUrl, shareTicket: '' }]);
  const manual = validateChatRequest({ id: 'b', messages: [{ role: 'user', content: 'x' }], attachments: [{ source: 'screen', dataUrl }] });
  assert.deepEqual(manual.attachments, [{ source: 'screen', dataUrl }]);
});

// ---- 3. 控制窗口的草稿附件（src/main.ts clearChat，窗口这一半的规则在 src/look-send.ts draftAfterClear）
test('Codex 第四轮：草稿里用户亲手附的快照，关共享（或清视觉上下文）时留着；新对话、换角色、重置照旧清空', () => {
  const manual: Attachment[] = [{ source: 'screen', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }, { source: 'camera', dataUrl: 'data:image/jpeg;base64,/9j/hand' }];
  assert.deepEqual(draftAfterClear(manual, true), manual);
  assert.deepEqual(draftAfterClear([...manual, { source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/x', shareTicket: 't' }], true), manual, '共享帧从不留在草稿里');
  assert.deepEqual(draftAfterClear(manual, false), []);
});

test('Codex 第四轮：草稿里有一张手动快照，从桌宠关掉共享，回控制窗口发文字：这张照发（之前根本没有共享取图）', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'pet');
  let draft: Attachment[] = [{ source: 'screen', dataUrl: 'data:image/jpeg;base64,/9j/handPicked' }];
  h.media.update({ screenSharing: false }, 'pet');
  h.look.abort();
  draft = draftAfterClear(draft, true); // the control window gets the vision-cleared and runtime notices (and the pet's clear broadcast)
  const sent = await h.ask('这个报错怎么回事', draft);
  h.chat(sent);
  assert.deepEqual(h.last().images, ['data:image/jpeg;base64,/9j/handPicked']);
});

const rendererSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const renderer = ts.createSourceFile('main.ts', rendererSource, ts.ScriptTarget.Latest, true);

test('src/main.ts：撤权和清视觉上下文的清空留着手动草稿（本窗口和收到别的窗口的广播都是），清空时只按 draftAfterClear 留', () => {
  const calls: ts.CallExpression[] = [];
  let clearChat: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'clearChat') clearChat = node;
    if (ts.isCallExpression(node) && node.expression.getText(renderer) === 'clearChat') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(renderer);
  assert.ok(clearChat?.body, 'clearChat');
  const body = clearChat.body.getText(renderer);
  assert.match(clearChat.parameters.map(p => p.getText(renderer)).join(', '), /keepDraft = false/);
  assert.match(body, /attachments = draftAfterClear\(attachments, keepDraft\);/);
  assert.doesNotMatch(body, /\battachments = \[\];/, 'clearChat 不再无条件清空草稿');
  assert.match(body, /type: 'clear'[^\n]*keepDraft/, '广播带上"留着草稿"');
  assert.match(rendererSource, /onVisionContextCleared\(\(\) => \{ clearChat\(false, false, true\);/);
  assert.match(rendererSource, /if \(visionRevoked\) clearChat\(true, false, true\);/);
  assert.match(rendererSource, /clearChat\(false, message\.greeting, message\.keepDraft === true\);/);
  // 其他清空（新对话、换角色、换模型、重置、宿主重置聊天）照旧清空草稿：只有这三处带第三个参数。
  const keeping = calls.filter(call => call.arguments.length === 3).map(call => call.getText(renderer));
  assert.deepEqual(keeping, ['clearChat(false, false, true)', 'clearChat(true, false, true)', 'clearChat(false, message.greeting, message.keepDraft === true)']);
  assert.ok(calls.length >= 10, '其余的清空都还在');
});
