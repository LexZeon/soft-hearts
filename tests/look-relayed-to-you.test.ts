// Codex T-205 第五轮（X-260，2026-11-04，固定 de4f312）：开着屏幕共享，控制窗口发「同事跟你说，你看看这个报错。」，取了一帧、
// 模拟常驻进程收到一张合成屏幕图，感知行写着"用户叫你看屏幕"。第四轮把"我跟你说"当成用户自己说话（不算转述），但规则只看
// 分句末尾的"跟你说"，不看是谁在说：「同事跟你说」「老板对你说」「同事让我跟你说」也被当成用户自己的话，后面的原话就成了请求。
// 修法（shared/look-request.ts）：分句以"跟你说／对你说／和你说……"结尾时，只有说话的是用户自己（前面没人，或者是"我""我们"
// "让我""听我"加上"想、先、老实"这类副词）才算用户的话；前面是别人（同事、老板、他、小王）或者"别人让我跟你说"，后面就是转述，
// 不算请求。正对照「我跟你说，你看看这个报错」照旧取图。docs/claude/2026-11-04-v1-refusal-grab.md「Codex 第五轮反例和修复」。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { scanLookRequest, withheldLook } from '../shared/look-request';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { perceptionTurnLine, perceptionTurnState, SCREEN_LOOK_LINE, SHARING_LINE } from '../shared/perception-rule';

const T205_ROUND5 = '同事跟你说，你看看这个报错。';
/** 同类：别人跟你说／对你说／和你说，别人让我跟你说。 */
const RELAYED_TO_YOU = [
  '他跟你说，你看看这个报错', '老板对你说，你看看这个报错', '同事让我跟你说，你看看这个报错', '我同事跟你说，你看看这个报错',
  '朋友和你说，你帮我看看这段代码', '老师给你说，你看看这道题', '他让我跟你讲，你看看这个报错', '妈妈叫我跟你说，你看下我屏幕',
  '领导要我跟你说，你看一下这个报错', '同事跟你说过，你看看这个报错', '他刚才跟你说，你看看这个报错', '同事想跟你说，你看看这个报错',
  '客户对你讲，你帮我看看这个页面', '同事让我跟你说一声，你看看这个报错', '老板托我跟你说，你看看这个报错', '同事跟你说。你看看这个报错',
  '小王跟你说，你看看这个报错', '他们跟你说，你看看这个', '同事跟你说了，你看看这个报错', '他跟你说一下，你看看这个报错',
  '同事让我跟你说一声你看看这个报错', '他特意让我跟你讲一句，你帮我看看这段代码', '同事跟你说一声你看看这个报错', '小王让我跟你说一声你看看这个报错',
];
/** 用户自己在说话：前面没人，或者是"我""我们""让我""听我"，加上常见的副词和开头词。 */
const OWN_WORDS_TO_YOU: ReadonlyArray<[string, string | null]> = [
  ['我跟你说，你看看这个报错', 'screen'], ['跟你说，你看看这个报错', 'screen'], ['我跟你讲，你看看这个报错', 'screen'],
  ['我想跟你说，你看看这个报错', 'screen'], ['让我跟你说，你看看这个报错', 'screen'], ['听我跟你说，你看看这个报错', 'screen'],
  ['那我跟你说，你帮我看看这段代码', 'screen'], ['哎我跟你说，你看看这个', 'either'], ['我和你说，你看看这个报错', 'screen'],
  ['我对你说，你看看我屏幕', 'screen'], ['我们跟你说，你看看这个报错', 'screen'], ['我老实跟你说，你看看这个报错', 'screen'],
  ['我早就跟你说过，你看看这个报错', 'screen'], ['我先跟你说，你看看这个报错', 'screen'], ['我偷偷跟你说，你看看这个', 'either'],
  // 第六轮（结构规则）："他跟你说了什么"是别人说在前，整条不看（少看的方向；tests/look-reported-before.test.ts）。
  ['所以我跟你说，你看看这个报错', 'screen'], ['我跟你说一下，你看看这个报错', 'screen'], ['他跟你说了什么，你帮我看看', null],
  ['我再跟你说一遍，你看看这个报错', 'screen'], ['说真的我跟你说，你看看这个报错', 'screen'],
];

test('Codex T-205 第五轮：「同事跟你说，你看看这个报错。」不算叫她看；别人跟你说、别人让我跟你说的同类说法也不算', () => {
  assert.equal(scanLookRequest(T205_ROUND5), null);
  const wrong = RELAYED_TO_YOU.filter(text => scanLookRequest(text) !== null).map(text => `${text} → ${scanLookRequest(text)}`);
  assert.deepEqual(wrong, []);
});

test('正对照：用户自己说"我跟你说""跟你说""让我跟你说"，后面的请求照旧（结果和修之前一样）', () => {
  const wrong = OWN_WORDS_TO_YOU.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
});

// withheldLook 的分类（V1 时用来决定带不带备好的那一帧；屏幕只读大概之后只用它认"说不"）：别人跟你说的认作 relayed；用户自己的话不拦。
test('withheldLook：别人跟你说、别人让我跟你说的认作转述；用户自己说的不拦', () => {
  assert.equal(withheldLook(T205_ROUND5), 'relayed');
  assert.deepEqual(RELAYED_TO_YOU.filter(text => withheldLook(text) !== 'relayed'), []);
  const wrong = OWN_WORDS_TO_YOU.filter(([text, expected]) => (withheldLook(text) === null) !== (expected !== null))
    .map(([text]) => `${text} → ${withheldLook(text)}`);
  assert.deepEqual(wrong, [], 'the own requests pass; "他跟你说了什么，你帮我看看" (someone else spoke first) is held');
});

// Found on the way: before this round "不需要需要…需要" (26 times, 53 characters) took 1.3 s, four times as long with each two more
// (a filler that is two others put together, 需要 = 需 + 要, could be split every way), the app frozen. Full-length messages now stay fast.
test('a long run of the words a no may carry never freezes the decision (up to the 4,000-character limit)', () => {
  const worst = [
    '不' + '需要'.repeat(1999), '不要' + '帮我'.repeat(1999), '别' + '偷偷'.repeat(1999), '不' + '老是'.repeat(1999), '没' + '准许'.repeat(1999),
    '不' + '帮忙着'.repeat(1333), '不' + '着急着'.repeat(1333), '不帮忙着'.repeat(1000), '我' + '早就'.repeat(1990) + '跟你说，你看看这个报错',
    '同事' + '跟你'.repeat(1990) + '说，你看看这个报错', '你' + '老是'.repeat(1999) + '看',
  ];
  for (const line of worst) {
    const started = performance.now();
    scanLookRequest(line);
    const ms = performance.now() - started;
    assert.ok(ms < 200, `${line.slice(0, 12)}… took ${ms.toFixed(1)} ms`);
  }
});

/** The real send path (window half, host attachments, chat entry check, perception line); the capture port and Claude are fakes. */
function sendPath() {
  const media = { screenSharing: true, cameraSharing: false, revision: 1 };
  let captures = 0, turnNumber = 0;
  const turns = new LookTurns(() => 0);
  const host = new LookAttachments(turns, {
    noteActivity: () => {},
    state: () => ({ screen: media.screenSharing, camera: false, scope: `conversation|${media.revision}` }),
    sharesCameraFrames: () => false,
    revision: () => media.revision,
    generation: () => 1,
    opening: () => 1,
    captureScreen: async (): Promise<Attachment> => { captures++; return { source: 'screen', dataUrl: `data:image/jpeg;base64,/9j/frame${captures}AA==` }; },
    captureCamera: async () => { throw new Error('no camera in this test'); },
  });
  const claude: { images: string[]; sight: string }[] = [];
  async function send(content: string): Promise<void> {
    const shared = await host.request(lookHint(content, false));
    const request = validateChatRequest(structuredClone({ id: `turn-${++turnNumber}`, messages: [{ role: 'user', content }], attachments: turnAttachments([], shared) }));
    request.attachments = host.admit(request.attachments).current();
    turns.userTurn();
    claude.push({ images: request.attachments.map(item => item.dataUrl), sight: perceptionTurnLine(perceptionTurnState(media, request.attachments, content)) });
  }
  return { send, captures: () => captures, last: () => claude.at(-1)! };
}

test('Codex 第五轮原句走真实发送路径：开着共享 0 取图、0 张图，感知行说她没看；换成"我跟你说"取一张', async () => {
  const path = sendPath();
  for (const text of [T205_ROUND5, '他跟你说，你看看这个报错', '老板对你说，你看看这个报错', '同事让我跟你说，你看看这个报错']) {
    await path.send(text);
    assert.deepEqual(path.last().images, [], `${text}：不能有图发出`);
    assert.equal(path.last().sight, '【此刻的感知】' + SHARING_LINE, text);
  }
  assert.equal(path.captures(), 0);
  await path.send('我跟你说，你看看这个报错。');
  assert.equal(path.last().images.length, 1, '用户自己的请求照旧取一张');
  assert.equal(path.last().sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
});
