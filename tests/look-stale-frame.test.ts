// 关掉之后的旧帧（2026-11-04，V1 细看的边角）：宿主取好一帧交回窗口，窗口再把它放进聊天请求。这中间用户关掉了屏幕共享
// （或摄像头），修之前宿主的聊天入口照样把这张旧帧交给 Claude（本文件两路的"关掉"测试在修之前都失败：图到了 Claude）。
// 用户关掉的意思是"别看了"：关掉之后，任何一帧都不能再离开本机；关掉再打开也不能让旧帧复活。
// 这里用真实的媒体开关（electron/runtime.ts MediaRuntime）、真实的宿主附图（electron/look-attachments.ts）、真实的聊天请求校验
// （electron/validation.ts）和这一轮的感知行，按 electron/main.ts 聊天入口的顺序走一遍；取图口和 Claude 是假的，不开窗口、不碰屏幕和摄像头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Attachment } from '../shared/contracts';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { MediaRuntime } from '../electron/runtime';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { perceptionTurnLine, perceptionTurnState, SCREEN_LOOK_LINE } from '../shared/perception-rule';

const PERSONA = '你是测试角色。';

/** The host as electron/main.ts wires it; every capture is a different picture unless `same` says otherwise. */
function host(options: { same?: boolean } = {}) {
  const media = new MediaRuntime(undefined, { mode: () => 'share' }); // the old frame-sharing camera (platforms without local pose sensing)
  let generation = 0, shots = 0;
  const frame = (source: Attachment['source']): Attachment =>
    ({ source, dataUrl: `data:image/jpeg;base64,/9j/${source}${options.same ? 0 : ++shots}AA==` });
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
  /** src/main.ts sendChat up to the chat request: the host takes this turn's frames (and the user's own snapshots go along). */
  async function ask(content: string, manual: Attachment[] = []) {
    return { content, attachments: turnAttachments(manual, await look.request(lookHint(content, false))) };
  }
  let id = 0;
  /**
   * electron/main.ts `chat` handler: check at the entry, check again where the perception line is written, then the Claude adapter
   * (electron/claude-session.ts) reads the persona and the frames where it writes the message. `meanwhile` runs before that write
   * (a process start or a previous turn's drain).
   */
  function chat(sent: { content: string; attachments: Attachment[] }, meanwhile?: () => void) {
    const request = validateChatRequest({ id: `turn-${++id}`, messages: [{ role: 'user', content: sent.content }], attachments: sent.attachments });
    const frames = look.admit(request.attachments); request.attachments = frames.current();
    request.attachments = frames.current();
    const text = request.messages.at(-1)?.content;
    const sightAgain = (left: Attachment[]) => PERSONA + '\n\n' + perceptionTurnLine(perceptionTurnState(media.state, left, text));
    const persona = sightAgain(request.attachments);
    meanwhile?.();
    const written = frames.recompose(request.attachments, persona, sightAgain);
    claude.push({ text: sent.content, images: frames.current().map(attachment => attachment.dataUrl), sight: written.slice(PERSONA.length + 2) });
  }
  return { media, look, ask, chat, claude, last: () => claude.at(-1)! };
}

test('屏幕：取图返回后关掉共享再提交，0 张图到 Claude，文字照常发出，感知行照实说共享没开', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const sent = await h.ask('你看看我屏幕');
  assert.equal(sent.attachments.length, 1, '共享开着时取到了一帧');
  h.media.update({ screenSharing: false }, 'controls');
  h.chat(sent);
  assert.equal(h.claude.length, 1, '这一轮照常发出');
  assert.equal(h.last().text, '你看看我屏幕');
  assert.deepEqual(h.last().images, []);
  assert.doesNotMatch(h.last().sight, /附了画面/);
  assert.match(h.last().sight, /屏幕共享没开，你看不到画面/);
});

test('摄像头（旧的逐帧共享）：取图返回后关掉摄像头再提交，0 张图到 Claude，感知行说看不到', async () => {
  const h = host();
  h.media.update({ cameraSharing: true }, 'controls');
  const sent = await h.ask('你看看我');
  assert.deepEqual(sent.attachments.map(a => a.source), ['camera'], '摄像头开着时取到了一帧');
  h.media.update({ cameraSharing: false }, 'controls');
  h.chat(sent);
  assert.deepEqual(h.last().images, []);
  assert.doesNotMatch(h.last().sight, /附了画面/);
  assert.match(h.last().sight, /看不到摄像头画面/);
});

test('关掉再打开：旧帧不复活（屏幕、摄像头都是）；重新叫她看，新取的一帧照常带上', async () => {
  const h = host();
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  const screen = await h.ask('你看看我屏幕');
  const camera = await h.ask('你看看我');
  assert.equal(screen.attachments[0].source, 'screen');
  assert.equal(camera.attachments[0].source, 'camera');
  h.media.update({ screenSharing: false, cameraSharing: false }, 'controls');
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  h.chat(screen);
  assert.deepEqual(h.last().images, [], '屏幕旧帧');
  h.chat(camera);
  assert.deepEqual(h.last().images, [], '摄像头旧帧');
  // Camera handed to the other window and back: also a new opening.
  const before = await h.ask('你看看我');
  h.media.update({ cameraSharing: false }, 'controls'); h.media.update({ cameraSharing: true }, 'pet');
  h.chat(before);
  assert.deepEqual(h.last().images, [], '换了窗口的摄像头旧帧');
  const fresh = await h.ask('你看看我屏幕');
  h.chat(fresh);
  assert.deepEqual(h.last().images, [fresh.attachments[0].dataUrl], '这次开启期间取的新帧照常带上');
  assert.equal(h.last().sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
});

test('同样的画面在这次开启里又取了一次：照常带上（旧的那份不算数，新的算）', async () => {
  const h = host({ same: true });
  h.media.update({ screenSharing: true }, 'controls');
  const old = await h.ask('你看看我屏幕');
  h.media.update({ screenSharing: false }, 'controls'); h.media.update({ screenSharing: true }, 'controls');
  h.chat(old);
  assert.deepEqual(h.last().images, [], '只有旧的那份时不发');
  const again = await h.ask('你看看我屏幕');
  assert.equal(again.attachments[0].dataUrl, old.attachments[0].dataUrl, '同一张画面');
  h.chat(again);
  assert.equal(h.last().images.length, 1);
});

test('换了上下文（换角色、桌宠藏起来等清掉视觉上下文）：已经交回窗口的旧帧也不发', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const sent = await h.ask('你看看我屏幕');
  h.look.abort(); // electron/main.ts clearVisionContext
  h.chat(sent);
  assert.deepEqual(h.last().images, []);
  assert.match(h.last().sight, /用户开着屏幕共享，你能看，只是这一轮没看画面/);
});

test('入口检查过了、适配器写消息之前关掉共享：这一帧也不发，发出去的感知行改成没附画面', async () => {
  for (const [content, patch, words] of [
    ['你看看我屏幕', { screenSharing: false }, /屏幕共享没开/],
    ['你看看我', { cameraSharing: false }, /看不到摄像头画面/],
  ] as const) {
    const h = host();
    h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
    const sent = await h.ask(content);
    assert.equal(sent.attachments.length, 1, content);
    h.chat(sent, () => h.media.update(patch, 'controls'));
    assert.deepEqual(h.last().images, [], content);
    assert.doesNotMatch(h.last().sight, /附了画面/, content);
    assert.match(h.last().sight, words, content);
  }
});

test('正常情况：共享一直开着就照常带图（屏幕、摄像头）；别的开关变了不影响；用户亲手附的快照不受影响', async () => {
  const h = host();
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  const screen = await h.ask('你看看我屏幕');
  h.chat(screen);
  assert.deepEqual(h.last().images, [screen.attachments[0].dataUrl]);
  assert.equal(h.last().sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
  const camera = await h.ask('你看看我');
  h.chat(camera);
  assert.deepEqual(h.last().images, [camera.attachments[0].dataUrl]);
  // 语音输入开关和这两路无关（语音识别出错时宿主会自动关掉它），不能顺手丢掉屏幕帧。
  const meanwhile = await h.ask('你看看我屏幕');
  h.media.update({ voiceInput: true }, 'controls'); h.media.update({ voiceInput: false }, 'controls');
  h.chat(meanwhile);
  assert.equal(h.last().images.length, 1);
  // 控制窗口"附屏幕快照"、摄像头拍照：用户亲手选、亲手按的，和共享开关无关，关着也照发（和以前一样）。
  h.media.update({ screenSharing: false, cameraSharing: false }, 'controls');
  const manual: Attachment[] = [{ source: 'screen', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
    { source: 'camera', dataUrl: 'data:image/jpeg;base64,/9j/handpicked' }];
  const byHand = await h.ask('这是我截的图', manual);
  assert.deepEqual(byHand.attachments, manual, '没叫她看，宿主不取图');
  h.chat(byHand);
  assert.deepEqual(h.last().images, manual.map(a => a.dataUrl));
});

// ---- electron/main.ts wiring (AST, no eval): the chat handler asks at its entry and again where the perception line is
// written, and the Claude task reads the frames and the persona through the turn's frames (electron/claude-session.ts reads both
// where it writes the message; tests/claude-session.test.ts checks that).
const mainSource = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const main = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);

test('electron/main.ts：聊天入口先问一次，写感知行前再问一次，交给 Claude 的帧和人设都按这一轮的帧现读', () => {
  let handler: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === 'scopedHost' && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'chat' && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) handler = node.arguments[1];
    else ts.forEachChild(node, visit);
  };
  visit(main);
  assert.ok(handler && ts.isBlock(handler.body), 'the chat handler');
  const statements = handler.body.statements.map(statement => statement.getText(main));
  assert.equal(statements[0], 'const request = validateChatRequest(value);');
  assert.equal(statements[1], 'const turnFrames = lookAttachments.admit(request.attachments);');
  assert.equal(statements[2], 'request.attachments = turnFrames.current();');
  const body = handler.body.getText(main);
  assert.match(body, /request\.attachments = turnFrames\.current\(\);[^\n]*\n\s*const sight = perceptionTurnState\(media\.state, request\.attachments,/);
  const getters: Record<string, string> = {};
  const collect = (node: ts.Node): void => {
    if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name)) getters[node.name.text] = node.body?.getText(main) ?? '';
    ts.forEachChild(node, collect);
  };
  collect(handler);
  assert.match(getters.imageDataUrls ?? '', /turnFrames\.current\(\)\.map\(attachment => attachment\.dataUrl\)/);
  assert.match(getters.persona ?? '', /turnFrames\.recompose\(request\.attachments, settings\.persona, sightAgain\)/);
  assert.ok(!/imageDataUrls:\s*request\.attachments/.test(body), 'no frame list fixed before the adapter writes the message');
  assert.match(mainSource, /new LookAttachments\(lookTurns, \{[\s\S]{0,600}opening: source => media\.openings\[source\]/);
});
