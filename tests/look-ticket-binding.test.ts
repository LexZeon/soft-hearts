// Codex T-205 第五轮（X-260，2026-11-04，固定 de4f312）：用受控 IPC 构造聊天请求的附件，宿主的共享帧记号（shareTicket）还有三个口子：
//   1. 同一条消息里放两份带同一个记号的帧：宿主两份都收，后端收到两张同哈希的图；
//   2. 屏幕关掉再打开后，把新屏幕的记号填进旧屏幕帧：后端收到旧帧；
//   3. 屏幕一直开着、摄像头撤权后，把有效的新屏幕记号填进旧摄像头帧：后端收到旧摄像头帧。
// 根因：记号只记着"哪个来源、第几次开启、哪个上下文"，没有和那一帧的内容绑在一起；一条消息里的记号要整批看完才用掉。
// 修法：宿主发记号时同时记下那一帧图片数据的摘要（SHA-256，只存摘要不存图），入口核对时附件的来源和摘要都要和记号记下的一样，
// 否则整张丢掉（不当成手动快照）；一个记号在一条消息里也只认第一份。docs/claude/2026-11-04-v1-refusal-grab.md「Codex 第五轮反例和修复」。
// 这里用真实的媒体开关、宿主附图、聊天请求校验（经过 structuredClone，像 IPC 一样）、这一轮的帧和感知行；取图口和 Claude 是假的。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { MediaRuntime } from '../electron/runtime';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { perceptionTurnLine, perceptionTurnState } from '../shared/perception-rule';

const PERSONA = '你是测试角色。';

/** The host as electron/main.ts wires it; every capture is a different picture. */
function host() {
  const media = new MediaRuntime(undefined, { mode: () => 'share' });
  let generation = 0, shots = 0;
  const frame = (source: Attachment['source']): Attachment => ({ source, dataUrl: `data:image/jpeg;base64,/9j/${source}${++shots}AA==` });
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
  const claude: { images: Attachment[]; sight: string }[] = [];
  /** One shared frame, taken the normal way (src/main.ts sendChat → preload sharedAttachments → this host). */
  async function issue(words: string, source: Attachment['source']): Promise<Attachment> {
    const frames = await look.request(lookHint(words, false));
    const found = frames.find(item => item.source === source);
    assert.ok(found?.shareTicket, `${source} 取到一帧，带着记号`);
    return found;
  }
  let id = 0;
  /** electron/main.ts `chat` with attachments the window (or a probe on its IPC) put together: entry check, perception line, adapter read. */
  function chat(attachments: Attachment[], content = '合成记号复测') {
    const request = validateChatRequest(structuredClone({ id: `turn-${++id}`, messages: [{ role: 'user', content }], attachments }));
    const frames = look.admit(request.attachments);
    request.attachments = frames.current();
    const sightAgain = (left: Attachment[]) => PERSONA + '\n\n' + perceptionTurnLine(perceptionTurnState(media.state, left, content));
    const written = frames.recompose(request.attachments, sightAgain(request.attachments), sightAgain);
    claude.push({ images: frames.current(), sight: written.slice(PERSONA.length + 2) });
  }
  const urls = () => claude.at(-1)!.images.map(item => item.dataUrl);
  return { media, look, issue, chat, urls, last: () => claude.at(-1)! };
}

// ---- 1. 同一条消息里重复的记号
test('Codex 第五轮：同一条消息里放两份带同一个记号的帧，只认第一份（屏幕、旧的逐帧摄像头都是）', async () => {
  for (const source of ['screen', 'camera'] as const) {
    const h = host();
    h.media.update({ [`${source}Sharing`]: true }, 'controls');
    const frame = await h.issue(source === 'screen' ? '你看看我屏幕' : '你看看我', source);
    h.chat([frame, { ...frame }]);
    assert.deepEqual(h.urls(), [frame.dataUrl], `${source}：一条消息里同一个记号只带一张`);
    h.chat([frame]);
    assert.deepEqual(h.urls(), [], `${source}：记号用掉了，下一条消息再发不算`);
  }
});

test('重复的那份换了来源也不算：同一个记号贴在一张屏幕帧和一张"摄像头"帧上，只认来源和内容都对得上的第一份', async () => {
  const h = host();
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  const frame = await h.issue('你看看我屏幕', 'screen');
  h.chat([frame, { ...frame, source: 'camera' }]);
  assert.deepEqual(h.last().images, [frame], '只有屏幕那份');
  // 反过来：假的那份排在前面，用掉了记号；真的那份在同一条消息里也不再认（宁可少发）。
  const next = await h.issue('你看看我屏幕', 'screen');
  h.chat([{ ...next, source: 'camera' }, next]);
  assert.deepEqual(h.urls(), [], '第一份对不上就整张丢，第二份是重复的记号，也丢');
});

// ---- 2. 屏幕关掉再打开，把新记号填进旧帧
test('Codex 第五轮：屏幕关掉再打开后，把新屏幕的记号填进旧屏幕帧：丢掉，不当成手动快照；原样的旧帧、新帧本身照旧', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const old = await h.issue('你看看我屏幕', 'screen');
  h.media.update({ screenSharing: false }, 'controls');
  h.look.abort(); // electron/main.ts mediaChanged → clearVisionContext（"收到清理通知"）
  h.media.update({ screenSharing: true }, 'controls');
  const fresh = await h.issue('你看看我屏幕', 'screen');
  assert.notEqual(fresh.dataUrl, old.dataUrl);
  h.chat([old]);
  assert.deepEqual(h.urls(), [], '原样的旧帧：丢（第四轮已经这样）');
  h.chat([{ ...old, shareTicket: fresh.shareTicket }]);
  assert.deepEqual(h.urls(), [], '旧帧换上新记号：内容对不上，整张丢');
  assert.doesNotMatch(h.last().sight, /附了画面/, '这一轮的感知行照实说没附画面');
  // 新记号已经在上一条里用掉了；再取一张，原样发出照常带上。
  const again = await h.issue('你看看我屏幕', 'screen');
  h.chat([again]);
  assert.deepEqual(h.urls(), [again.dataUrl], '新取的一帧带着自己的记号：照发');
});

test('同一次开启里也不能换着用：B 的记号贴在 A 的图上，A、B 都不发（记号绑定的是那一帧的内容）', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const a = await h.issue('你看看我屏幕', 'screen');
  const b = await h.issue('你看看我屏幕', 'screen');
  h.chat([{ ...a, shareTicket: b.shareTicket }]);
  assert.deepEqual(h.urls(), []);
  h.chat([b]);
  assert.deepEqual(h.urls(), [], 'B 的记号已经用掉');
  h.chat([a]);
  assert.deepEqual(h.urls(), [a.dataUrl], 'A 带着自己的记号：照发');
});

// ---- 3. 摄像头撤权后，把有效的屏幕记号填进旧摄像头帧
test('Codex 第五轮：屏幕一直开着、摄像头撤权后，把有效的新屏幕记号填进旧摄像头帧：丢掉；屏幕帧本身照旧', async () => {
  const h = host();
  h.media.update({ cameraSharing: true }, 'controls');
  h.media.update({ screenSharing: true }, 'controls');
  const oldCamera = await h.issue('你看看我', 'camera');
  h.media.update({ cameraSharing: false }, 'controls');
  h.look.abort();
  const liveScreen = await h.issue('你看看我屏幕', 'screen');
  h.chat([oldCamera]);
  assert.deepEqual(h.urls(), [], '原样的旧摄像头帧：丢');
  h.chat([{ ...oldCamera, shareTicket: liveScreen.shareTicket }]);
  assert.deepEqual(h.urls(), [], '旧摄像头帧换上屏幕记号：来源和内容都对不上，整张丢');
  assert.doesNotMatch(h.last().sight, /附了/, '感知行不说附了画面');
  const screen = await h.issue('你看看我屏幕', 'screen');
  h.chat([screen]);
  assert.deepEqual(h.last().images, [screen]);
});

test('只改来源也不行：开着的屏幕帧原样带着自己的记号、却标成摄像头，整张丢（不会让她以为看到的是你本人）', async () => {
  const h = host();
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  const screen = await h.issue('你看看我屏幕', 'screen');
  h.chat([{ ...screen, source: 'camera' }]);
  assert.deepEqual(h.urls(), []);
});

test('对照：没有记号的手动快照照发，哪怕字节和一张旧共享帧一样；共享一直开着时原样的共享帧照发', async () => {
  const h = host();
  h.media.update({ screenSharing: true }, 'controls');
  const shared = await h.issue('你看看我屏幕', 'screen');
  h.chat([shared]);
  assert.deepEqual(h.urls(), [shared.dataUrl]);
  h.media.update({ screenSharing: false }, 'controls');
  h.look.abort();
  const manual: Attachment = { source: 'screen', dataUrl: shared.dataUrl };
  h.chat(turnAttachments([manual], []));
  assert.deepEqual(h.urls(), [shared.dataUrl], '用户亲手附的那张照发');
});

test('同一条消息里手动快照和共享帧各一张（窗口的正常组合）：都发；共享帧摘要对得上', async () => {
  const h = host();
  h.media.update({ screenSharing: true, cameraSharing: true }, 'controls');
  const manual: Attachment = { source: 'screen', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  const frames = await h.look.request(lookHint('你看看我', false));
  const camera = frames.find(item => item.source === 'camera')!;
  h.chat(turnAttachments([manual], [camera]));
  assert.deepEqual(h.urls(), [manual.dataUrl, camera.dataUrl]);
});
