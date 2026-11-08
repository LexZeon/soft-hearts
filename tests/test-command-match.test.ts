/**
 * D2 / I-008 "测试：xxx" (docs/claude/2026-11-03-test-commands.md): the prefix, the local alias matching, and the registry's shape.
 * No model, no Electron.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { asksTestCommand, normalizeTestText, parseTestCommand, TEST_COMMAND_MAX_BODY } from '../shared/test-command';
import { matchTestEntry, testHelpLines } from '../electron/test-commands/match';
import { buildTestEntries } from '../electron/test-commands/entries';
import { fakeTestDeps } from './helpers/test-command-fixtures';

const { entries } = buildTestEntries(fakeTestDeps().deps);
const outcome = (body: string) => {
  const match = matchTestEntry(entries, body);
  return match.kind === 'entry' ? match.entry.id : match.kind;
};

test('the prefix: 测试 then a full-width or half-width colon, spaces allowed, only at the very start', () => {
  assert.deepEqual(parseTestCommand('测试：去忙自己的事'), { body: '去忙自己的事' });
  assert.deepEqual(parseTestCommand('测试:发呆'), { body: '发呆' });
  assert.deepEqual(parseTestCommand('  测试 ： 发呆  '), { body: '发呆' });
  assert.deepEqual(parseTestCommand('测试：'), { body: '' });
  assert.deepEqual(parseTestCommand('测试：  想\n事情 '), { body: '想 事情' });
  for (const text of ['发呆', '今天测试：发呆', '测试一下：发呆', '测试发呆', '测 试：发呆', 'test: x', '', '  ', null, undefined, 3])
    assert.equal(parseTestCommand(text), null, String(text));
  assert.equal(parseTestCommand('测试：' + '字'.repeat(TEST_COMMAND_MAX_BODY))?.body.length, TEST_COMMAND_MAX_BODY);
  assert.equal(parseTestCommand('测试：' + '字'.repeat(TEST_COMMAND_MAX_BODY + 1)), null, 'a long text is an ordinary message');
});

test('the window asks the host only in developer mode, without attachments, with the prefix (outside developer mode it is ordinary chat)', () => {
  assert.equal(asksTestCommand(true, false, '测试：发呆'), true);
  assert.equal(asksTestCommand(false, false, '测试：发呆'), false);
  assert.equal(asksTestCommand(true, true, '测试：发呆'), false);
  assert.equal(asksTestCommand(true, false, '你好'), false);
  assert.equal(asksTestCommand(true, false, undefined), false);
});

test('normalising folds width and case and drops spaces and punctuation', () => {
  assert.equal(normalizeTestText(' Ｌ２．Daydream，！ '), 'l2daydream');
  assert.equal(normalizeTestText('去忙 自己的事～'), '去忙自己的事');
});

test('the user\'s own examples match locally: 去忙自己的事, 发呆, 想事情', () => {
  assert.equal(outcome('去忙自己的事'), 'L2.rules');
  assert.equal(outcome('发呆'), 'L2.daydream');
  assert.equal(outcome('想事情'), 'L2.thinking');
});

test('near-synonyms and longer sentences match too', () => {
  const cases: [string, string][] = [
    ['让她去做自己的事吧', 'L2.rules'], ['她自己的生活', 'L2.rules'], ['让她发发呆', 'L2.daydream'], ['放空一下', 'L2.daydream'],
    ['哼个歌', 'L2.humming'], ['想想心事', 'L2.thinking'], ['打个盹', 'L2.drowsy'], ['不忙了，陪我', 'L2.company'],
    ['小动作', 'L1.motion'], ['给她一次说话时机', 'L1.speech'], ['让她主动搭话', 'L1.speech'],
    ['熟悉度设成初识', 'F3.new'], ['把熟悉度设成老朋友', 'F3.old'], ['熟悉度亲近', 'F3.close'], ['熟悉度熟起来', 'F3.warming'], ['熟悉度恢复', 'F3.reset'],
    ['已经熟悉了', 'F3.familiar'],
    ['我累了', 'F2.tired'], ['我今天好累', 'F2.tired'], ['我很烦', 'F2.annoyed'], ['我有点难过', 'F2.low'], ['我不开心', 'F2.low'], ['我很开心', 'F2.happy'],
    ['我好兴奋', 'F2.excited'], ['清除状态', 'F2.clear'],
    ['想不想跳', 'M1.rejudge'], ['让她重新判一次', 'M1.rejudge'],
    ['害羞', 'E1.shy'], ['害羞试作', 'E1.shy'], ['预览害羞', 'E1.shy'], ['不好意思', 'E1.shy'], ['惊喜', 'E1.surprise'], ['惊喜试作', 'E1.surprise'], ['吃惊', 'E1.surprise'],
    ['邀请猜拳', 'G1.invite'], ['让她邀请我猜拳', 'G1.invite'], ['来一局猜拳', 'G1.start'], ['猜拳', 'G1.start'],
    ['写日记', 'L3.diary'], ['立刻补写日记', 'L3.diary'],
    // U-012: the bare mood words are about HER mood (M1 can be tried under each), "我…" / "用户…" is about the user (F2).
    ['开心', 'MOOD.happy'], ['难过', 'MOOD.sad'], ['困了', 'MOOD.drowsy'], ['兴奋', 'MOOD.excited'], ['平静', 'MOOD.calm'], ['低落', 'MOOD.disappointed'],
    ['恢复心情', 'MOOD.reset'], ['让她开心一点', 'MOOD.happy'], ['她今天很困', 'MOOD.drowsy'], ['有点困', 'MOOD.sleepy'], ['不高兴', 'MOOD.upset'],
    ['生气', 'MOOD.upset'], ['担心', 'MOOD.concerned'], ['想念', 'MOOD.longing'], ['释然', 'MOOD.relieved'], ['紧张期待', 'MOOD.tense'], ['满足', 'MOOD.content'],
    ['我有点难过', 'F2.low'], ['我好兴奋', 'F2.excited'], ['我好开心', 'F2.happy'], ['我很不开心', 'F2.low'], ['用户很累', 'F2.tired'],
    ['犯困了', 'L2.drowsy'], ['她很开心', 'MOOD.happy'],
    ['她需要你', 'L4.lonely'], ['做噩梦', 'L4.dream'], ['今天没精神', 'L4.lowEnergy'], ['想找人说话', 'L4.chatty'], ['小需要：有点闷', 'L4.lonely'],
    // 她的动作 (T-211): her own actions; "挥手" alone stays the camera pretend (P1), "害羞" stays the E1 preview.
    ['打招呼', 'ACT.hello'], ['挥手打招呼', 'ACT.hello'], ['让她打个招呼', 'ACT.hello'], ['挥手', 'P1.wave'], ['我冲你挥手', 'P1.wave'], ['说再见', 'ACT.goodbye'],
    ['点点头', 'ACT.nod'], ['摇摇头', 'ACT.shake'], ['歪头', 'ACT.tilt'], ['凑近看', 'ACT.lean'], ['捂脸', 'ACT.coverFace'], ['捂脸害羞', 'ACT.coverFace'], ['害羞', 'E1.shy'],
    ['遮嘴笑', 'ACT.hideLaugh'], ['张开双臂', 'ACT.openArms'], ['抱抱', 'ACT.hug'], ['鼓掌', 'ACT.clap'], ['欢呼', 'ACT.cheer'], ['鞠个躬', 'ACT.bow'],
    ['道歉', 'ACT.apology'], ['比个心', 'ACT.heart'], ['动作：比心', 'ACT.heart'], ['ACT.heart', 'ACT.heart'],
    ['指一指', 'ACT.point'], ['叉腰', 'ACT.akimbo'], ['哈欠捂嘴', 'ACT.yawnCover'], ['打哈欠', 'P1.yawn'], ['拿着吃', 'ACT.eat'],
    // T-215: the face shapes.
    ['鼓腮', 'ACT.cheekPuff'], ['鼓个腮', 'ACT.cheekPuff'], ['撅嘴', 'ACT.pout'], ['嘟嘴', 'ACT.pout'], ['眨一只眼', 'ACT.wink'], ['单眼眨', 'ACT.wink'],
    ['吐舌头', 'ACT.tongue'], ['动作：吐舌头', 'ACT.tongue'],
  ];
  for (const [body, id] of cases) assert.equal(outcome(body), id, body);
});

test('full-width and half-width, case and spacing do not matter; an entry id always works', () => {
  assert.equal(outcome('Ｌ１．ｍｏｔｉｏｎ'), 'L1.motion');
  assert.equal(outcome('l2.DAYDREAM'), 'L2.daydream');
  assert.equal(outcome('L2 daydream'), 'L2.daydream');
  assert.equal(outcome(' 发 呆 '), 'L2.daydream');
  for (const entry of entries) assert.equal(outcome(entry.id), entry.id, entry.id);
  for (const entry of entries) assert.equal(outcome(entry.name), entry.id, entry.name);
});

test('a negated word is not a hit: "别发呆", "不累" do not trigger; "不开心" is the low state, not the happy one', () => {
  assert.equal(outcome('别发呆'), 'none');
  assert.equal(outcome('我不累'), 'none');
  assert.equal(outcome('我不开心'), 'F2.low');
  assert.equal(outcome('我没事'), 'F2.clear');
});

test('help words list the entries; unknown text matches nothing (the model is asked then)', () => {
  for (const body of ['', '帮助', '有哪些', '有哪些入口', '列表', '清单', 'help', 'HELP', '都有什么'])
    assert.equal(outcome(body), 'help', body);
  for (const body of ['今天天气怎么样', '随便', 'xyz', '做点什么吧']) assert.equal(outcome(body), 'none', body);
});

test('a real tie is ambiguous, never a silent pick', () => {
  const twin = [
    { id: 'X.a', name: 'a', aliases: ['苹果'], summary: '' },
    { id: 'X.b', name: 'b', aliases: ['苹果'], summary: '' },
  ];
  const exact = matchTestEntry(twin, '苹果');
  assert.equal(exact.kind, 'ambiguous');
  assert.equal(matchTestEntry(twin, '来个苹果吧').kind, 'ambiguous');
  const longer = [...twin, { id: 'X.c', name: 'c', aliases: ['青苹果'], summary: '' }];
  assert.equal((matchTestEntry(longer, '来个青苹果') as { entry: { id: string } }).entry.id, 'X.c', 'the longest alias wins');
});

test('the registry: unique ids, every alias belongs to exactly one entry, every entry has a name, a summary and aliases', () => {
  const ids = entries.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  const owner = new Map<string, string>();
  for (const entry of entries) {
    assert.ok(entry.name && entry.summary && entry.aliases.length > 0, entry.id);
    for (const alias of [entry.name, ...entry.aliases]) {
      const key = normalizeTestText(alias);
      if (owner.has(key) && owner.get(key) !== entry.id) assert.fail(`"${alias}" belongs to ${owner.get(key)} and ${entry.id}`);
      owner.set(key, entry.id);
    }
  }
});

test('the first batch is exactly these features, and nothing that deletes, sends, changes real settings or touches files', () => {
  assert.deepEqual(entries.map(entry => entry.id), [
    'L2.rules', 'L2.daydream', 'L2.humming', 'L2.thinking', 'L2.drowsy', 'L2.company', 'L1.motion', 'L1.speech',
    'F3.new', 'F3.warming', 'F3.familiar', 'F3.close', 'F3.old', 'F3.reset', 'F2.tired', 'F2.annoyed', 'F2.low', 'F2.happy', 'F2.excited', 'F2.clear',
    'MOOD.calm', 'MOOD.content', 'MOOD.close', 'MOOD.happy', 'MOOD.excited', 'MOOD.concerned', 'MOOD.disappointed', 'MOOD.upset', 'MOOD.longing',
    'MOOD.sad', 'MOOD.relieved', 'MOOD.tense', 'MOOD.drowsy', 'MOOD.sleepy', 'MOOD.asleep', 'MOOD.reset',
    'L4.lonely', 'L4.dream', 'L4.lowEnergy', 'L4.chatty', 'M1.rejudge', 'E1.surprise', 'E1.shy', 'G1.invite', 'G1.start', 'L3.diary',
    'P1.yawn', 'P1.stretch', 'P1.wave', 'P1.sat', 'P1.arrive', 'I006.busy', 'I006.pause', 'I006.video', 'I006.game', 'I006.clear',
    'ACT.hello', 'ACT.goodbye', 'ACT.nod', 'ACT.shake', 'ACT.tilt', 'ACT.lean', 'ACT.coverFace', 'ACT.hideLaugh', 'ACT.openArms', 'ACT.hug', 'ACT.clap',
    'ACT.cheer', 'ACT.bow', 'ACT.apology', 'ACT.heart', 'ACT.point', 'ACT.akimbo', 'ACT.yawnCover', 'ACT.eat',
    'ACT.cheekPuff', 'ACT.pout', 'ACT.wink', 'ACT.tongue',
  ]);
  const features = new Set(entries.map(entry => entry.id.split('.')[0]));
  assert.deepEqual([...features].sort(), ['ACT', 'E1', 'F2', 'F3', 'G1', 'I006', 'L1', 'L2', 'L3', 'L4', 'M1', 'MOOD', 'P1']);
  // L4 (她也会需要你) came onto main while this was being made: one entry per small need.
  assert.equal(features.has('L4'), true);
  const text = entries.flatMap(entry => [entry.id, entry.name, entry.summary, ...entry.aliases]).join('\n');
  for (const word of ['删除', '清空聊天', '发送消息', '发消息', '发邮件', '读取文件', '写入文件', '保存文件', '修改设置', '改设置', '密钥', '上传', '下载', '付款'])
    assert.equal(text.includes(word), false, word);
});

test('the help list has one line per entry: id, name and the one-sentence summary', () => {
  const lines = testHelpLines(entries);
  assert.equal(lines.length, entries.length);
  assert.equal(lines[0], `${entries[0].id} · ${entries[0].name}：${entries[0].summary}`);
});
