// 2026-11-07 (docs/claude/2026-11-07-draft-leak-cn-plan.md): a Chinese planning block in front of the reply went to the bubble
// and was read aloud: a first sentence that starts like a note to itself and names the user, a quotation of what is on the
// screen (with "你们""我" inside), labels ("回答：""规则：""Personality:"), a question to itself ("不要问昵称？"), then the reply.
// Every text below is synthetic (the shape of the leak, not its words); none is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';
import { DRAFT_FILL_LINES } from '../electron/draft-fill';
import { noteUnitBounds, withoutQuotes } from '../electron/reply-self-note';

const FIRST = '拿到一些信息：用户想看图里的菜单。';
const NOTES = '屏幕上被一个窗口挡住了大部分，后面是网页"【测评】这家店的招牌为何翻车"，底下能看到一行字"骗你们的我才不吃香菜呢。片尾音乐@某某"。所以只能看到标题和那行字。不能提别人的聊天（另一个窗口里的对话）用户没问。回答：挡住了，只看到标题和一行。可以简单评价那两句。不要问昵称？用户在说正事吗——是在聊菜单，算正事轻度，可以问也可以不问。规则：在说正事就不要问。保守不问。 评价：标题"【测评】这家店的招牌为何翻车"——带悬念。底部那句——像结尾反转梗。请用户把窗口挪开。 Personality: 不客气、熟。保持简短。';
const PLAN = FIRST + NOTES;
const REPLY = '你这窗口挡得也太严实了，我只看到两行字。一行是标题，挺会勾人的。另一行在页面底下，这种反转我还挺吃的。把前面那个窗口挪开，或者直接把菜单贴给我，我再好好挑挑。';
const REPLY_FIRST = '你这窗口挡得也太严实了，我只看到两行字。';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 1107;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(() => 1 + Math.floor(random() * 25)), pieces(() => 2), pieces(() => 1 + Math.floor(random() * 60)), pieces(() => 1 + Math.floor(random() * 4))];
}
const CHUNKINGS = [0, 1, 2, 3, 4, 5, 6, 7];

/** One reply through the real protocol (garbage filter, draft filter, private tail) in a Chinese chat. */
function play(raw: string, chunking: number, options: { withTail?: boolean; chineseChat?: boolean } = {}) {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { settingProposal: { instruction: null }, chineseChat: options.chineseChat ?? true });
  const tail = `\n${protocol.start}{"context":"positive","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"none"}${protocol.end}`;
  const chunks = chunkings(options.withTail === false ? raw : raw + tail)[chunking];
  // How many characters had arrived when the first visible character went out.
  let arrived = 0, firstAt = -1;
  for (const chunk of chunks) {
    protocol.push(chunk);
    arrived += chunk.length;
    if (firstAt < 0 && /\S/u.test(increments.join(''))) firstAt = arrived;
  }
  const appraisal = protocol.finish(true);
  if (firstAt < 0 && /\S/u.test(increments.join(''))) firstAt = Number.POSITIVE_INFINITY;
  /** The number of characters that had arrived at the first push that brought in at least `count` characters. */
  const by = (count: number): number => { let sum = 0; for (const chunk of chunks) { sum += chunk.length; if (sum >= count) return sum; } return sum; };
  return { shown: increments.join(''), protocol, appraisal, firstAt, by };
}

/** The plan goes (only as counts of protocol-talk), the reply stays whole, its first character no later than its first sentence's end. */
function assertCut(plan: string, reply: string, replyFirst: string, options: { firstChunkAtLeast?: number } = {}) {
  for (const chunking of CHUNKINGS) {
    if (chunkings(plan)[chunking][0].length < (options.firstChunkAtLeast ?? 1)) continue;
    const played = play(plan + reply, chunking);
    const where = `chunking ${chunking}`;
    assert.equal(played.shown, reply, where);
    const drops = played.protocol.draftDrops();
    assert.ok(drops.length > 0 && drops.every(drop => drop.kind === 'protocol-talk'), where);
    assert.equal(drops.reduce((sum, drop) => sum + drop.chars, 0), plan.length, `every character of the plan is counted, ${where}`);
    assert.ok(played.firstAt <= played.by(plan.length + replyFirst.length), `first character by the end of the reply's first sentence, ${where} (at ${played.firstAt})`);
    assert.equal(played.appraisal?.context, 'positive', where);
    assert.equal(played.protocol.emptiedByFilter(), false, where);
  }
}

// ------------------------------------------------------------------ the shape that leaked, and variations of it

test('cn plan block: the leaked shape loses everything up to "保持简短。", the same in every chunking', () => {
  assertCut(PLAN, REPLY, REPLY_FIRST);
});
test('cn plan block: without the opener, a first sentence that names the user and says nothing to anyone', () => {
  assertCut(PLAN.slice('拿到一些信息：'.length), REPLY, REPLY_FIRST);
});
// A first chunk "分" alone goes out at once ("分享…" begins too many replies), so only a first chunk of two or more characters is
// caught here (a known gap, see the record).
test('cn plan block: a label opener ("分析："), first chunk of two characters or more', () => {
  assertCut('分析：' + PLAN.slice('拿到一些信息：'.length), REPLY, REPLY_FIRST, { firstChunkAtLeast: 2 });
});
test('cn plan block: the notes on lines of their own', () => {
  assertCut(PLAN.replace(/。/gu, '。\n').replace(/\n /gu, '\n'), REPLY, REPLY_FIRST);
});
test('cn plan block: a quotation of two sentences, the second with "我" and no quotation mark of its own', () => {
  assertCut(PLAN.replace('"骗你们的我才不吃香菜呢。片尾音乐@某某"', '"骗你们的。我才不吃香菜呢。片尾音乐@某某"'), REPLY, REPLY_FIRST);
});
test('cn plan block: curly quotation marks', () => {
  let open = true;
  assertCut(PLAN.replace(/"/gu, () => { const mark = open ? '“' : '”'; open = !open; return mark; }), REPLY, REPLY_FIRST);
});
test('cn plan block: the notes end with a label line ("Personality: …。")', () => {
  assertCut(PLAN.slice(0, -'保持简短。'.length), REPLY, REPLY_FIRST);
});
test('cn plan block: the notes end with a directive ("保守不问。")', () => {
  assertCut(FIRST + '所以只能看到标题和那行字。保守不问。', REPLY, REPLY_FIRST);
});
test('cn plan block: the notes end with a question to itself ("不要问昵称？")', () => {
  assertCut(FIRST + '所以只能看到标题和那行字。不要问昵称？', REPLY, REPLY_FIRST);
});
test('cn plan block: a plain sentence right before the reply is the reply\'s own, and so is a reply with nothing said to anyone', () => {
  const reply = '挡住了，只看到两行。你把窗口挪开呗。';
  for (const chunking of CHUNKINGS) {
    assert.equal(play(PLAN + reply, chunking).shown, reply, `chunking ${chunking}`);
    assert.equal(play('用户问天气。今天晴，二十度，风不大。', chunking).shown, '今天晴，二十度，风不大。', `chunking ${chunking}`);
  }
});
test('cn plan block: a long plain reply behind a note is held no longer than BLOCK_CAP characters', () => {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { settingProposal: { instruction: null }, chineseChat: true });
  protocol.push('用户想听故事。');
  for (let i = 0; i < 40; i++) protocol.push('从前有座山，山上有座庙。');
  assert.equal(increments.join(''), '', 'held up to BLOCK_CAP (480 characters so far)');
  for (let i = 0; i < 20; i++) protocol.push('从前有座山，山上有座庙。');
  assert.ok(increments.join('').startsWith('从前有座山'), 'shown before the reply ends');
});
test('cn plan block: a "Draft:" block behind the notes keeps its own rule', () => {
  const raw = '，回复要短一点，站在用户这边。首句要具体。尾注 support，consider。\n\nDraft:\n嗯……第四次啊。\n\nDelta: O+1? maybe.四次啊……难怪你这么累。';
  for (const chunking of CHUNKINGS) assert.equal(play(raw, chunking).shown, '四次啊……难怪你这么累。', `chunking ${chunking}`);
});

test('cn plan block: a reply that is nothing but notes takes the emptied-reply path', () => {
  for (const chunking of CHUNKINGS) {
    const played = play(PLAN, chunking);
    assert.equal(played.shown, '', `chunking ${chunking}`);
    assert.equal(played.protocol.emptiedByFilter(), true, `chunking ${chunking}`);
  }
});
test('cn plan block, host: nothing but notes, with the fill on: one of her own lines, never the notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-cn-plan-'));
  const service = new CompanionService(directory, () => {});
  service.setDraftFill(true);
  try {
    await service.load();
    await service.context('gene', { kind: 'claude', baseUrl: 'https://cn-plan.invalid/v1', model: 'fixture' }, '角色名称：Gene');
    const shown: string[] = [];
    const turn = await service.begin('cn-plan', '帮我看看这张图里的菜单', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const start = turn.persona.match(/<sh-state-[a-f0-9]+>/)![0];
    for (const character of PLAN) turn.push('delta', character);
    turn.push('delta', `\n${start}{"context":"positive","delta":{"O":2},"confidence":0.9}${start.replace('<', '</')}`);
    await turn.finish('complete');
    const line = shown.join('');
    assert.ok(Object.values(DRAFT_FILL_LINES).some(pool => pool.includes(line)), `one of her lines: ${line}`);
    assert.equal(turn.emptyReply?.(), false);
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.ok(!JSON.stringify(record.messages).includes('用户想看'), 'the notes are not archived');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ false positives: ordinary replies pass untouched

const ORDINARY = [
  '收到！我这就去看看。',
  '用户协议我看了……其实就是常规条款，放心点同意吧。',
  '用户协议我看了，没什么坑。',
  '拿到offer了？太好了！快说说是哪家。',
  '拿到你的消息啦，刚刚在忙。',
  '拿到了。下午就去寄。',
  '回答你的问题：我觉得两种都行，看你心情。',
  '用户名已经改好了，下次登录就用新的。',
  '已经吃过啦，你呢？',
  '分享一个小发现：楼下新开了家面馆。',
  '信息量好大……让我缓缓。',
  '评价：这家店的招牌菜确实翻车了，不过甜品还行。',
  '你说的"用户"是指谁呀？',
  '规则：每人只能猜三次，猜中有奖哦！',
];
for (const raw of ORDINARY) {
  test(`cn plan block, ordinary: ${raw}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(raw, chunking);
      assert.equal(played.shown, raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `chunking ${chunking}`);
    }
  });
}
test('cn plan block: first characters — one that begins no note goes out at once; "拿" waits for one more; "拿到你" goes at "你"', () => {
  for (const [chunks, shownAfter] of [[['收'], '收'], [['分'], '分'], [['已'], '已'], [['拿'], ''], [['拿', '了'], '拿了'], [['拿到', '你'], '拿到你']] as Array<[string[], string]>) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
    for (const chunk of chunks) protocol.push(chunk);
    assert.equal(increments.join(''), shownAfter, JSON.stringify(chunks));
  }
});

// ------------------------------------------------------------------ the helpers

test('note sentences: a full stop inside a quotation does not end the sentence; quoted words do not count', () => {
  const sentence = '底下能看到一行字"骗你们的。我才不吃香菜呢。片尾"。';
  assert.equal(noteUnitBounds(sentence + '后面', false)?.end, sentence.length);
  assert.equal(noteUnitBounds('底下"骗你们的', false), null, 'an open quotation waits');
  assert.equal(noteUnitBounds('底下"骗你们的。', true)?.end, '底下"骗你们的。'.length, 'a quotation that never closes does not hide the full stop');
  assert.equal(withoutQuotes('一行字"骗你们的我才不吃"。').includes('你'), false);
  assert.equal(withoutQuotes('片尾音乐”。').includes('片尾'), false, 'the end of a quotation from before this sentence');
});
