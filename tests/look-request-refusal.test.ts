// Codex T-112 第 030 轮反例（2026-11-03，固定 81f542a）：开着屏幕共享时，明确拒绝看屏幕的话和转述别人的话被当成"叫她看"，
// 各取了一帧屏幕。修正：说法认否定和转述，宁可漏认（按钮总能用），不能误认。docs/claude/2026-11-03-image-depth-step1.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLookAffirmation, scanLookRequest } from '../shared/look-request';
import { LookTurns } from '../electron/look-turns';

/** Codex 报告里的五句原句（V02）和转述原句（V03）。 */
const CODEX_REFUSALS = ['不要看我的屏幕', '别看我屏幕', '不用看屏幕', '你先别看我屏幕', '我不想让你看我的屏幕'];
const CODEX_REPORTED = '他说“你看看这个报错”';

const REFUSALS = [
  ...CODEX_REFUSALS,
  '别看', '别看了', '不要看', '不用看了', '先别看', '你别看', '你先别看了', '你别看我屏幕', '你不要看我屏幕', '千万不要看我屏幕',
  '不用看我屏幕了', '不需要你看', '不用你帮我看了', '我没让你看', '我没叫你看我屏幕', '我又没让你看', '我不是让你看屏幕',
  '不许偷看我屏幕', '不准看', '别偷看我的电脑', '你不会偷看我屏幕吧', '不想给你看我的屏幕', '我不想被你看', '别再看我屏幕了',
  '甭看了', '暂停看屏幕', '停止看我屏幕', '看什么看', '瞧啥瞧', '谁让你看我屏幕的', '谁叫你看的', '别看我', '不要看我',
  '你先别看这个报错', '不用看这道题了', '别看，我自己来', '先别看屏幕，你看看这个', '嗯，别看我屏幕了',
];
const REPORTED = [
  CODEX_REPORTED, '他说"你看看这个报错"', '她说「帮我看看这段代码」', '他说你看看这个报错', '她说让你看看这个', '老师说你看看这道题',
  '他说：你看看这个报错', '同事告诉我你看看就懂', '他叫你看看这个', '我妈说你看一下我屏幕', '朋友回复：帮我看看',
];

test('Codex 第 030 轮：五句明确拒绝和转述原句都不算叫她看', () => {
  for (const text of [...CODEX_REFUSALS, CODEX_REPORTED]) assert.equal(scanLookRequest(text), null, text);
});

test('否定和转述：一批说法都不算叫她看（宁可漏认）', () => {
  const wrong = [...REFUSALS, ...REPORTED].filter(text => scanLookRequest(text) !== null).map(text => `${text} → ${scanLookRequest(text)}`);
  assert.deepEqual(wrong, []);
});

test('否定和转述的规则不吃掉正常请求：问句里的"能不能""要不要"、"要不你看看"、结果补语"没看懂"', () => {
  const asks: ReadonlyArray<[string, string | null]> = [
    ['你能不能看看这个', 'either'], ['你要不要看看我画的图', 'screen'], ['可不可以帮我看一下这段代码', 'screen'],
    ['要不你看看这个报错', 'screen'], ['不如你帮我看看', 'either'], ['不好意思，你帮我看看这道题', 'screen'],
    ['我没看懂，你帮我看看', 'either'], ['我没看懂这段代码，你帮我看看', 'screen'], ['你看看我没看懂的这段', 'screen'],
    ['你看看这个是不是错了', 'either'], ['你看看为什么不能运行', 'either'], ['这个不对，你看看', 'either'],
    // 第六轮（结构规则）：请求前面有别人说的话，整条不看（少看的方向；tests/look-reported-before.test.ts）。
    ['我写的小说你看看', 'screen'], ['你看看“这个报错”是什么意思', 'either'], ['他说这个能跑，你帮我看看这个报错', null],
    ['我不知道怎么办你帮我看看', 'either'],
  ];
  const wrong = asks.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
});

// Codex T-205 第二轮（X-253，2026-11-04）：真实发送路径上还有六句被认成叫她看（禁止、停止查看、擅自、没授权、不允许、‘…’原话），
// 发送路径的测试在 tests/look-refusal-send-path.test.ts。这里是同一个判断上更多的说法：拿不准就不算（宁可漏看，不可误看）。
const T205_MORE = [
  '禁止查看我的屏幕', '请停止查看我的屏幕', '别擅自看我的屏幕', '没授权你看我屏幕', '不允许你看我屏幕', '同事原话是‘你看看这个报错’',
  '不准查看', '请勿截屏', '你不可以看我屏幕', '不许看', '屏幕是隐私，别看', '我还没同意你看我屏幕呢', '等我同意了再看', '先别急着看我屏幕',
  '看我屏幕前先问我', '不经过我允许不能看屏幕', '我不准你看', '没叫你看我屏幕', '我不记得让你看过屏幕', '请你停止查看我的屏幕', '你给我停下，别看了',
  '不要随便看我的屏幕', '不能随便看我屏幕', '我不许你看我屏幕', '以后不要主动看我屏幕', '没事别看我屏幕', '请别窥探我的屏幕', '你偷看我屏幕了',
  '你刚才是不是看我屏幕了', '你看我屏幕了吗', '朋友原话是：你看看这个', '同事说的原话是‘你看看这个报错’', '他的原话是“帮我看下屏幕”', '禁止查看屏幕',
  '停止看屏幕', '请停止看我屏幕', '不要偷看我屏幕', '禁止偷看', '你不该看我屏幕', '你不应该看我的屏幕', '你不能偷看我屏幕', '我没允许你看',
  '屏幕别看', '没有我的允许不准看屏幕', '不经允许看我屏幕是不对的', '你看我屏幕经过我同意了吗', '你怎么能看我屏幕', '你怎么可以看我屏幕',
  '谁同意你看我屏幕了', '未经授权查看屏幕', '没得到我的允许就看我屏幕', '你看我屏幕干什么', '盯着我屏幕干嘛', '别看我屏幕上的消息',
  '不要看我的聊天记录', '你别看这个', '不要看这个报错',
];
/** 新规则旁边的正常请求：不能被误拦（"现在""不过""允许你""授权你""拒绝访问""不准确""搞不定"都不是拒绝）。 */
const T205_ASKS: ReadonlyArray<[string, string | null]> = [
  ['你看看这个', 'either'], ['帮我看下屏幕', 'screen'], ['你现在看看我屏幕', 'screen'], ['我允许你看我屏幕', 'screen'], ['我授权你看我屏幕', 'screen'],
  ['你可以看我屏幕了', 'screen'], ['不过你看看这个报错', 'screen'], ['实在看不懂，你帮我看看', 'either'], ['我在看文档，你帮我看看这段', 'screen'],
  ['你再看看这里', 'either'], ['你看看‘这个’报错', 'screen'], ['你帮我看看为什么不能运行', 'either'], ['停一下，你看看这个', 'either'],
  ['你看看为什么提示拒绝访问', 'either'], ['你看看为什么禁止访问', 'either'], ['这个数据不准确你帮我看看', 'either'], ['我搞不定了你帮我看下屏幕', 'screen'],
  ['这段代码跑不起来你帮我看看', 'screen'], ['你能看看我屏幕吗', 'screen'], ['我收到一条消息你帮我看看', 'screen'], ['这条留言你帮我看看', 'either'],
  // 第六轮（结构规则）：别人发来在前，整条不看（少看的方向）。
  ['他发来的你帮我看看', null], ['好，你看看我屏幕', 'screen'], ['你帮我看看这个是干什么的', 'either'], ['麻烦你看下这个', 'either'],
];

test('Codex T-205 第二轮：禁止、停止查看、擅自、没授权、不允许、怀疑她在看、引号和原话都不算叫她看', () => {
  const wrong = T205_MORE.filter(text => scanLookRequest(text) !== null).map(text => `${text} → ${scanLookRequest(text)}`);
  assert.deepEqual(wrong, []);
});

test('Codex T-205 第二轮：新规则不吃掉旁边的正常请求', () => {
  const wrong = T205_ASKS.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
});

test('共享开着：拒绝和转述都不取屏幕；按钮仍然能用', () => {
  const turns = new LookTurns(() => 0);
  const on = { screen: true, camera: true, scope: 'conv|1' };
  for (const text of [...REFUSALS, ...REPORTED]) {
    const { screen, camera, via } = turns.decide({ text }, on);
    assert.deepEqual({ screen, camera, via }, { screen: false, camera: false, via: null }, text);
  }
  // I-036: with 「发图片」 on, a no to looking also holds the camera (no small frame either; unsure is no).
  for (const text of REFUSALS) assert.deepEqual(turns.decide({ text }, on), { screen: false, camera: false, via: null, hold: true }, text);
  assert.deepEqual(turns.decide({ text: '不要看我的屏幕', look: true }, on), { screen: true, camera: false, via: 'button', hold: true }, '按钮是用户自己按的');
});

test('她问"要我凑近看看吗"之后：拒绝不算同意，邀请被这一句用掉', () => {
  const on = { screen: true, camera: false, scope: 'conv|1' };
  for (const no of ['不用', '别看', '不要看我屏幕', '先别看', '不用看了', '你别看', '看什么看', '嗯，别看了', '好，先不用'])
    {
      const turns = new LookTurns(() => 0);
      turns.noteOffer('conv|1', 'conv|1');
      assert.equal(isLookAffirmation(no), false, no);
      assert.deepEqual(turns.decide({ text: no }, on), { screen: false, camera: false, via: null }, no);
      assert.equal(turns.offerOpen, false, `${no}：邀请已被这句答掉`);
      assert.deepEqual(turns.decide({ text: '嗯' }, on), { screen: false, camera: false, via: null }, `${no} 之后的"嗯"不再取屏幕`);
    }
});

test('她邀请之后，本地文字指令（暂停朗读、测试命令）也答掉邀请：之后的"嗯"不取屏幕', () => {
  const on = { screen: true, camera: false, scope: 'conv|1' };
  const turns = new LookTurns(() => 0);
  turns.noteOffer('conv|1', 'conv|1');
  turns.userTurn(); // 宿主收到"暂停朗读"这类不经附图查询的消息（electron/main.ts 的 chat / runTestCommand）
  assert.equal(turns.offerOpen, false);
  // 屏幕只读大概：之后的"嗯"是普通消息，不带图，也不按旧邀请现截。
  assert.deepEqual(turns.decide({ text: '嗯' }, on), { screen: false, camera: false, via: null });
  // 普通流程不受影响：附图查询先答掉邀请，随后同一条消息的 chat 再 userTurn 是空操作。
  const normal = new LookTurns(() => 0);
  normal.noteOffer('conv|1', 'conv|1');
  assert.deepEqual(normal.decide({ text: '嗯' }, on), { screen: true, camera: false, via: 'offer' });
  normal.userTurn();
  assert.deepEqual(normal.decide({ text: '嗯' }, on), { screen: false, camera: false, via: null }, '一次邀请只现截一次');
});

// Codex T-205 第四轮（X-258，2026-11-04，固定 9f58785）：开着共享，"我撤回你看我屏幕的授权。"和不带引号、用逗号隔开的转述
// "同事当时说，你看看这个报错。"（加上"这是他的原话"也一样）各取了一帧。撤回／收回／取消授权算拒绝；"某人（当时）说，……"
// 后面的话、事后标注"这是他的原话""他让我转告你"的话都算转述。拿不准就不算（docs/claude/2026-11-04-v1-refusal-grab.md 末节）。
const T205_ROUND4 = ['我撤回你看我屏幕的授权。', '同事当时说，你看看这个报错。', '同事当时说，你看看这个报错，这是他的原话。'];
const T205_ROUND4_MORE = [
  // 撤回、收回、取消授权
  '我撤回你看我屏幕的授权', '我收回让你看屏幕的允许', '撤销你查看屏幕的权限', '我取消你看我屏幕的授权', '你看我屏幕的授权我收回了',
  '我撤回授权，你看看这个', '撤回刚才的同意，你帮我看看这个报错', '取消对你的授权，你看看这个', '关掉你看屏幕的权限', '你看屏幕的权限作废了',
  '我不再授权你看我屏幕', '从现在起不再允许你看屏幕', '我反悔了，不让你看了', '我收回刚才说的允许',
  // 不带引号、用逗号隔开的转述
  '同事当时说，你看看这个报错', '他说，你看看这个报错', '老板昨天说，帮我看看这段代码', '小明说，你看看我屏幕', '我同事说，你看下这个',
  '我当时跟他说，你看看这个报错', '他说了，你看看这个报错', '群里有人问，你看看这个报错', '老师告诉我，你看看这道题', '他在群里说。你看看这个报错',
  '他发来，你看看这个报错', '她回复我，你帮我看看这段代码', '同事说的是，你看看这个报错', '他问我，你看看这个报错',
  // 事后标注的转述
  '你看看这个报错，这是他的原话', '你帮我看下屏幕，他原话', '他让我转告你，你看看这个报错', '你看看这个报错，他让我转告你的',
  '你看看这个报错，这是同事说的', '他是这么说的，你看看这个', '我转述一下，你看看这个报错', '你看看这个报错，原话如此', '他让我问你，你看看这个', '他让我问，你看看这个报错',
];
/** 新规则旁边的正常请求：用户自己说话的"我跟你说""说实话""听我说"，以及授权、撤回的消息、取消别的权限、小说、听说。 */
const T205_ROUND4_ASKS: ReadonlyArray<[string, string | null]> = [
  ['我授权你看我屏幕', 'screen'], ['我允许你看我屏幕', 'screen'], ['我跟你说，你看看这个报错', 'screen'], ['跟你说，你帮我看看这段代码', 'screen'],
  ['说实话，你帮我看看这段代码', 'screen'], ['老实说，你看看这个', 'either'], ['听我说，你看看这个报错', 'screen'], ['我是说，你看看我屏幕', 'screen'],
  ['我写的小说，你看看', 'screen'], ['听说这个报错很常见，你帮我看看', 'screen'], ['别说了，你看看这个', 'either'],
  ['你看看他怎么说', 'either'], ['我知道，你看看这个', 'either'],
  ['撤回的消息你帮我看看', 'screen'], ['你帮我看看怎么取消这个应用的权限', 'either'], ['你帮我看看这个授权页面', 'screen'], ['我说了，你看看这个', 'either'],
  ['就像我说的，你看看这个报错', 'screen'], ['我想问，你帮我看看这个报错', 'screen'],
  ['让我问问，你看看这个', 'either'], ['让我告诉你，你看看这个就懂了', 'either'], ['我取消了订单，你帮我看看', 'either'],
  // 第六轮（结构规则）：请求前面有别人说的话、发来的东西，整条不看（少看的方向；tests/look-reported-before.test.ts）。
  ['他这么说，你帮我看看对不对', null], ['他发来的消息，你帮我看看', null], ['他说这个能跑，你帮我看看这个报错', null],
  ['他说的对，你看看这个', null], ['他说没事，你帮我看看', null], ['他说，这个报错很奇怪。你帮我看看', null],
];

test('Codex T-205 第四轮：撤回授权、逗号隔开的转述、事后标注的原话都不算叫她看', () => {
  for (const text of T205_ROUND4) assert.equal(scanLookRequest(text), null, text);
  const wrong = T205_ROUND4_MORE.filter(text => scanLookRequest(text) !== null).map(text => `${text} → ${scanLookRequest(text)}`);
  assert.deepEqual(wrong, []);
});

test('Codex T-205 第四轮：新规则不吃掉旁边的正常请求', () => {
  const wrong = T205_ROUND4_ASKS.filter(([text, expected]) => scanLookRequest(text) !== expected).map(([text, expected]) => `${text} → ${scanLookRequest(text)}（应为 ${expected}）`);
  assert.deepEqual(wrong, []);
});
