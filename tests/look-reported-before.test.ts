// Codex T-205 第六轮（X-263，2026-11-04，固定稳定补丁 8225ccc）：开着屏幕共享，控制窗口发「同事跟你说了声，你看看这个报错。」
// 「同事跟你说——你看看这个报错。」各取了一帧、模拟常驻进程各收到一张图，感知行写着"用户叫你看屏幕"。"了声"和破折号又绕过了词表，
// 前五轮每轮补词，每轮都有新变体。这一轮在词表之外加一条结构规则（shared/look-request.ts 的 firstReported）：请求之前（前面的分句，
// 或同一分句的前半），只要有不是用户自己的说话人说／讲／问／告诉／发／回／让我……，不管动词后面跟什么，这条消息的文字都不叫她看。
// 说话人只认"我／我们／咱"是用户自己；拿不准就是别人。按钮不读文字，照旧能用。docs/claude/2026-11-04-v1-refusal-grab.md
// 「第六轮：从词表改成结构规则」。全部是手写的合成句子，取图口和 Claude 是假的；不开窗口、不碰任何配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../shared/contracts';
import { scanLookRequest, withheldLook } from '../shared/look-request';
import { LookTurns } from '../electron/look-turns';
import { LookAttachments } from '../electron/look-attachments';
import { validateChatRequest } from '../electron/validation';
import { lookHint, turnAttachments } from '../src/look-send';
import { perceptionTurnLine, perceptionTurnState, SCREEN_LOOK_LINE, SHARING_LINE } from '../shared/perception-rule';

const X263 = ['同事跟你说了声，你看看这个报错。', '同事跟你说——你看看这个报错。'];
/** 同类：动词后面跟了声、了一句、破折号、省略号、冒号、空格、句号、直接连写；他让我、老板说过、群里有人说；没点名的"，说你看看"。 */
const REPORTED_BEFORE = [
  '同事跟你说了一句，你看看这个报错', '同事跟你说了句——你看看这个报错', '同事跟你说…你看看这个报错', '同事跟你说……你看看这个报错',
  '同事跟你说：你看看这个报错', '同事跟你说了声 你看看这个报错', '同事跟你说了声。你看看这个报错', '同事说了声你看看这个报错',
  '同事说了句你看看这个报错', '老板讲了一声——你看一下这个报错', '老板刚刚说了声～你看看这个报错', '同事说过一句…你看看这段代码',
  '有人跟你说了句——你看看这个报错', '小王跟你讲过一次，你帮我看看这个报错', '他们说——帮我看看这个报错', '老板说过，你看看这个报错',
  '老板说过你看一眼这个报错', '群里有人说，你看看这个报错', '群里有人说你帮我看看这个报错', '朋友在群里问，你帮我看下屏幕',
  '群里有人@我说你看看这个报错', '他让我找你，你看看这个报错', '他让我问你，你看看这个报错', '小王让你看看这个报错',
  '同事发来一句，你看看这个报错', '同事发了条消息，你看看这个报错', '他回我，你看看这个报错', '他喊了一声，你看看我屏幕',
  '我同事说，你看看我屏幕', '同事刚才找我，说你看看这个报错', '同事跟你说了声，过来看看这个报错', '老板跟你说了声，看看我屏幕',
  '他跟你说了声，给你看个东西', '你看看这个，同事说你再看看这个报错',
];
/** 正对照：用户自己的请求照旧（"我跟你说""我刚才说了""要我说""就像我说的"是用户自己在说；别人的话在请求之后也不影响）。 */
const OWN: ReadonlyArray<[string, string]> = [
  ['你看看这个报错', 'screen'], ['帮我看下屏幕', 'screen'], ['我跟你说，你看看这个报错', 'screen'], ['我刚才说了，你看看这个', 'either'],
  ['你看看这个，我同事也看不懂', 'either'], ['你看看这个报错，同事说他也看不懂', 'screen'], ['你帮我看看同事发的这个报错', 'screen'],
  ['跟你说，你看看这个报错', 'screen'], ['好烦，跟你说，你看看这个报错', 'screen'], ['说真的，你帮我看看这段代码', 'screen'],
  ['老实说，你看看这个报错', 'screen'], ['我问你，你看看这个', 'either'], ['我想问一下，你看看这个报错', 'screen'], ['别说了，你看看这个', 'either'],
  ['要我说，你看看这个报错', 'screen'], ['我是说，你看看这个报错', 'screen'], ['就像我说的，你看看这个报错', 'screen'], ['让我问问，你看看这个', 'either'],
  ['那我跟你说，你帮我看看这段代码', 'screen'], ['我早就跟你说过，你看看这个报错', 'screen'], ['我让你看看这个报错', 'screen'],
  ['请问你能看看这个报错吗', 'screen'], ['这个问题你帮我看看', 'screen'], ['我的小说你看看', 'either'], ['我回来了，你看看这个', 'either'],
];

test('Codex T-205 第六轮：「同事跟你说了声，……」「同事跟你说——……」不算叫她看', () => {
  for (const text of X263) assert.equal(scanLookRequest(text), null, text);
});

test('第六轮同类：请求之前有别人说、讲、问、发、回、让我……，不管后面跟什么，都不算叫她看', () => {
  const wrong = REPORTED_BEFORE.filter(text => scanLookRequest(text) !== null).map(text => `${text} → ${scanLookRequest(text)}`);
  assert.deepEqual(wrong, []);
});

test('第六轮正对照：用户自己的请求照旧取图（"我跟你说""我刚才说了""要我说"是用户自己的话；别人的话在请求后面不算）', () => {
  const wrong = OWN.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
});

// withheldLook 的分类（V1 时用来决定带不带备好的那一帧；屏幕只读大概之后只用它认"说不"）：别人的话认作 relayed，用户自己的请求不拦。
test('withheldLook：第六轮这些别人的话都认作转述或说不；用户自己的请求不拦', () => {
  const carried = [...X263, ...REPORTED_BEFORE].filter(text => withheldLook(text) === null);
  assert.deepEqual(carried, []);
  const held = OWN.map(([text]) => text).filter(text => withheldLook(text) !== null).map(text => `${text} → ${withheldLook(text)}`);
  assert.deepEqual(held, []);
});

test('第六轮的取舍（少看的方向）：别人的话在请求前面时，就算听起来是用户自己的请求，也不看', () => {
  // 以前取图的：前四、五轮的正对照里这几句，现在都不看；按钮和她问"要我凑近看看吗"后回"嗯"照样能看。
  for (const text of ['他说这个能跑，你帮我看看这个报错', '他发来的消息，你帮我看看', '他说的对，你看看这个', '他说，这个报错很奇怪。你帮我看看',
    '他跟你说了什么，你帮我看看', '这是同事发的截图，你看看', '你说的那个报错，你帮我看看']) assert.equal(scanLookRequest(text), null, text);
});

test('第六轮：按钮不读文字，写着别人的话也照旧取屏幕；共享关着不取', () => {
  const turns = new LookTurns(() => 0);
  const on = { screen: true, camera: false, scope: 'conv|1' };
  for (const text of X263) {
    // Not an ask: no frame (屏幕只读大概: an ordinary message never carries one).
    assert.deepEqual(turns.decide({ text }, on), { screen: false, camera: false, via: null }, text);
    assert.deepEqual(turns.decide({ text, look: true }, on), { screen: true, camera: false, via: 'button' }, `${text}（按钮）`);
  }
  assert.deepEqual(turns.decide({ text: '你看看这个报错', look: true }, { ...on, screen: false }), { screen: false, camera: false, via: null });
});

// The fifth round fixed an exponential regex; the structural rule is one pass over the message plus a first-hit search.
test('第六轮：最坏的长输入（4000 字重复）也很快，不会卡住', () => {
  const worst = [
    '说'.repeat(4000), '我说'.repeat(2000), '，说'.repeat(2000), '我跟你说'.repeat(1000), '我' + '跟你'.repeat(1999) + '说',
    '同事'.repeat(1990) + '说，你看看这个报错', '我早'.repeat(1990) + '说，你看看这个报错', '我说了说'.repeat(1000), '让我'.repeat(2000),
    '发了'.repeat(2000), '回我'.repeat(2000), '——'.repeat(1990) + '你看看这个报错', '你看看'.repeat(1333), '我' + '刚才也就'.repeat(999) + '说，你看看',
    '问问'.repeat(2000), '告诉'.repeat(2000), '我们说好了，'.repeat(666),
  ];
  for (const line of worst) {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      scanLookRequest(line);
      best = Math.min(best, performance.now() - started);
    }
    assert.ok(best < 50, `${line.slice(0, 12)}…（${line.length} 字）took ${best.toFixed(1)} ms`);
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
  async function send(content: string, look = false): Promise<void> {
    const shared = await host.request(lookHint(content, look));
    const request = validateChatRequest(structuredClone({ id: `turn-${++turnNumber}`, messages: [{ role: 'user', content }], attachments: turnAttachments([], shared) }));
    request.attachments = host.admit(request.attachments).current();
    turns.userTurn();
    claude.push({ images: request.attachments.map(item => item.dataUrl), sight: perceptionTurnLine(perceptionTurnState(media, request.attachments, content)) });
  }
  return { send, captures: () => captures, last: () => claude.at(-1)! };
}

test('第六轮原句走真实发送路径：开着共享 0 取图、0 张图，感知行说她没看；"我跟你说"取一张；按钮取一张', async () => {
  const path = sendPath();
  for (const text of [...X263, '老板说过，你看看这个报错', '群里有人说你帮我看看这个报错']) {
    await path.send(text);
    assert.deepEqual(path.last().images, [], `${text}：不能有图发出`);
    assert.equal(path.last().sight, '【此刻的感知】' + SHARING_LINE, text);
  }
  assert.equal(path.captures(), 0);
  await path.send('我跟你说，你看看这个报错。');
  assert.equal(path.last().images.length, 1, '用户自己的请求照旧取一张');
  assert.equal(path.last().sight, '【此刻的感知】' + SCREEN_LOOK_LINE);
  await path.send(X263[0]!, true);
  assert.equal(path.last().images.length, 1, '按钮是用户亲手按的，照旧取一张');
  assert.equal(path.captures(), 2);
});
