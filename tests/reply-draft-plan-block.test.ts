// F4, 2026-11-04 (docs/claude/2026-11-04-draft-leak-plan-block.md): a plan block at the start of the reply. Seen on the
// stable build: a line "short label + colon + third-person analysis of the user and of how to answer, Chinese with English
// words and English notes in brackets", then a paragraph "English feature name + colon + an English plan (the user's words
// quoted, purpose, rule check, 'Optional; maybe include')", and the real reply glued to the plan's last sentence on the same
// line ("…Fine.……<the reply>"). All of it was shown, read aloud and archived. Every sentence below is synthetic and only
// imitates that shape; none is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 9001;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(() => 1 + Math.floor(random() * 25)), pieces(() => 2), pieces(() => 1 + Math.floor(random() * 60))];
}
const CHUNKINGS = [0, 1, 2, 3, 4, 5, 6];
const tail = (p: MoodReplyProtocol) => `\n${p.start}{"context":"positive","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"none"}${p.end}`;

function play(raw: string, stream: (text: string) => string[], options: { chineseChat?: boolean; speakers?: string[] } = {}) {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { settingProposal: { instruction: null }, speakers: options.speakers ?? [], chineseChat: options.chineseChat ?? true });
  const chunks = stream(raw + tail(protocol));
  for (const chunk of chunks) protocol.push(chunk);
  const appraisal = protocol.finish();
  return { shown: increments.join(''), increments, protocol, appraisal, first: chunks[0] };
}
const byChunking = (chunking: number) => (text: string) => chunkings(text)[chunking];

// ------------------------------------------------------------------ the pieces of the shape (synthetic)

const LABEL_LINE = (label: string, colon: string) => `${label}${colon} 用户这轮说想把今天傍晚散步的事记下来，她大概是想被好好记住（memorial context），回应要轻一点、不能直接说"已保存"，语气别太正式（no lecturing）。`;
const EN_PARAGRAPH = 'Memorial: quote "今天傍晚的风好舒服" -- purpose: keep the evening walk. Rule check: invite must include quote and purpose, end with a question mark. Optional; maybe include. Fine.';
const EN_PARAGRAPH_CN_QUOTES = 'Memorial: quote “今天傍晚的风好舒服”, purpose: keep the walk. Rule check ok, invite has both. Optional, maybe include. Fine.';
const REPLY = '……嗯，傍晚的风确实很舒服，我也喜欢听你讲散步的事。\n\n下次走到桥边，也跟我说说那边的样子吧。';
const REPLY_PLAIN = '嗯，傍晚的风确实很舒服，我也喜欢听你讲散步的事。\n\n下次走到桥边，也跟我说说那边的样子吧。';

const PLAN_WORDS = /用户|回应|语气|memorial|Memorial|purpose|Rule|quote|Optional|include|lecturing|Fine|已保存/u;

const LEAKS: Array<{ name: string; raw: string; expected: string; label?: string }> = [
  { name: 'label (two characters, half-width colon) + English paragraph + reply glued to "Fine."', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY}`, expected: REPLY },
  { name: 'label with a full-width colon', label: '想法',
    raw: `${LABEL_LINE('想法', '：')}\n${EN_PARAGRAPH}${REPLY}`, expected: REPLY },
  { name: 'one-character label', label: '注',
    raw: `${LABEL_LINE('注', ':')}\n${EN_PARAGRAPH}${REPLY}`, expected: REPLY },
  { name: 'the English paragraph quotes with Chinese quotation marks', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH_CN_QUOTES}${REPLY}`, expected: REPLY },
  { name: 'the reply glued to the plan right after an English full stop, without an ellipsis', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY_PLAIN}`, expected: REPLY_PLAIN },
  { name: 'the reply glued to the last English word by an ellipsis, no full stop', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH.replace(' Fine.', '')}`.replace(/include\.$/u, 'include') + REPLY, expected: REPLY },
  { name: 'the reply glued to the last English word with nothing in between', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH.replace(/ Fine\.$/u, ' okay fine')}${REPLY_PLAIN}`, expected: REPLY_PLAIN },
  { name: 'label line only, the reply on the next line', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n\n${REPLY}`, expected: REPLY },
  { name: 'label line only, the reply glued to it by an ellipsis', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}${REPLY}`, expected: REPLY },
  { name: 'label line only, the reply glued to it right after the Chinese full stop', label: '分析',
    raw: `${LABEL_LINE('分析', '：')}${REPLY_PLAIN}`, expected: REPLY_PLAIN },
  { name: 'a label line that starts with one English word', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':').replace('用户这轮', 'User 这轮')}\n\n${REPLY}`, expected: REPLY },
  { name: 'English paragraph only, the reply glued to it', raw: `${EN_PARAGRAPH}${REPLY}`, expected: REPLY },
  { name: 'English paragraph only, the reply on the next line', raw: `${EN_PARAGRAPH}\n\n${REPLY_PLAIN}`, expected: REPLY_PLAIN },
  { name: 'label line + English paragraph, the reply on the next line', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}\n\n${REPLY_PLAIN}`, expected: REPLY_PLAIN },
  { name: 'label line + an English plan line with no label of its own + reply glued', label: '笔记',
    raw: `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH.replace(/^Memorial: /u, 'The user wants this kept; ')}${REPLY}`, expected: REPLY },
];

for (const leak of LEAKS) {
  test(`plan block: ${leak.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(leak.raw, byChunking(chunking));
      const where = `chunking ${chunking}: ${JSON.stringify(played.shown.slice(0, 80))}`;
      assert.doesNotMatch(played.shown, PLAN_WORDS, `no word of the plan shows, ${where}`);
      // Label and colon in the same first chunk: not one character of the plan shows. A first chunk of only the label's first
      // character(s) went out before anything showed what follows; those characters (and nothing else of the plan) stay.
      if (!leak.label || /[:：]/u.test(played.first)) assert.equal(played.shown, leak.expected, where);
      else {
        assert.ok(played.shown.endsWith(leak.expected), where);
        const residue = played.shown.slice(0, played.shown.length - leak.expected.length);
        assert.ok(residue.length <= leak.label.length && leak.label.startsWith(residue), `residue ${JSON.stringify(residue)}, ${where}`);
      }
      assert.equal(played.protocol.emptiedByFilter(), false, where);
      assert.equal(played.appraisal?.context, 'positive', `the tail still counts, ${where}`);
      const drops = played.protocol.draftDrops();
      assert.ok(drops.length >= 1, where);
      for (const drop of drops) assert.deepEqual(Object.keys(drop).sort(), ['chars', 'kind'], 'shape and length only, never the text');
    }
  });
}

test('plan block: the whole reply is a plan (label line and English paragraph, nothing else): emptied, she says a line of her own', () => {
  for (const raw of [`${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}`, `${LABEL_LINE('想法', '：')}`, EN_PARAGRAPH]) {
    for (const chunking of [0, 2, 4, 6]) {
      const played = play(raw, byChunking(chunking));
      if (!/[:：]/u.test(played.first) && !/^[A-Za-z]/u.test(raw)) continue;
      assert.equal(played.shown, '', `chunking ${chunking}: ${played.shown}`);
      assert.equal(played.protocol.emptiedByFilter(), true, `chunking ${chunking}`);
    }
  }
});

test('plan block: what is cut is counted by shape and length, and adds up to exactly what was removed', () => {
  const raw = `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY}`;
  const played = play(raw, byChunking(0));
  const drops = played.protocol.draftDrops();
  assert.equal(drops.reduce((sum, drop) => sum + drop.chars, 0) + REPLY.length, raw.length, JSON.stringify(drops));
});

test('plan block: an English chat is untouched (the same text passes byte for byte)', () => {
  const raw = `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY}`;
  for (const chunking of [0, 1, 4]) {
    const played = play(raw, byChunking(chunking), { chineseChat: false });
    assert.equal(played.shown, raw, `chunking ${chunking}`);
  }
});

// ------------------------------------------------------------------ what must not change (Chinese chat)

const NORMAL: Array<{ name: string; raw: string; speakers?: string[] }> = [
  { name: 'a reminder with a label and a colon', raw: '提醒：明天降温，记得多穿一件哦。' },
  { name: 'a label, a colon and "you"', raw: '注意：你今天已经喝了三杯咖啡啦！' },
  { name: 'a conclusion said to the user', raw: '结论：你就是最棒的！\n\n别再怀疑自己啦。' },
  { name: 'someone quoted after a colon', raw: '她说：“你回复得也太慢了吧。”我觉得她不该这么说你。' },
  { name: 'role-play lines', raw: '妈妈：你吃饭了没？\n我：吃了吃了！' },
  { name: 'a numbered list', raw: '第一：先睡一觉。第二：明天再说。\n\n别想太多啦。' },
  { name: 'an English label and Chinese', raw: 'Note: 明天下雨，记得带伞哦。' },
  { name: 'an English label and a fun fact', raw: 'Fun fact: 猫咪一天要睡十几个小时呢～' },
  { name: 'her name and a colon', raw: 'Momo：嗯……白天有人说话，回到家心里也有人。', speakers: ['Momo'] },
  { name: 'a quoted line she keeps', raw: '原话：“我会一直陪着你。”这句我记住啦～' },
  { name: 'the user\'s boss quoted, words like a plan inside the quotes', raw: '原话：“用户体验第一，回复要快，不能拖（fast reply）”——你们老板真这么说的呀？' },
  { name: 'an English word and a full stop, then Chinese', raw: 'OK. 那我们开始吧，三局两胜！' },
  { name: 'an English sentence, then Chinese', raw: "Sure, let's go. 我们走到桥边再回来吧。" },
  { name: 'a colon in the middle of an ordinary first sentence', raw: '我想了想：还是先吃饭吧，吃饱了再说。' },
  { name: 'a label and an ellipsis', raw: '嗯:……四次啊，那今天肯定特别难受吧。' },
  { name: 'an ordinary reply that talks about her tone', raw: '我的语气是不是太凶了？对不起嘛，我不是那个意思。' },
  { name: 'an ordinary reply that mentions the word "memorial"', raw: '你说的 memorial 是纪念的意思吗？那我们把今天记下来吧。' },
  { name: 'a label, then an explanation with English, "她", "回复" and "不能"', raw: '笔记：她说的 context 是上下文的意思，回复的时候不能乱用哦。' },
  { name: 'the same explanation without a particle', raw: '笔记：她说的 context 是上下文的意思，回复的时候不能乱用。\n\n记住了吗？' },
  { name: 'a label, then a date with an English note in brackets', raw: '纪念：今天是我们认识的第一百天（100 days）呢～' },
  { name: 'a narrator line in a role-play', raw: '旁白：她轻轻地走过来，坐在你身边。\n\n“今天辛苦啦。”' },
  { name: 'a label and a longer tip', raw: '小贴士：晚上早点睡，明天还要上班呢，别熬夜刷手机啦。\n\n晚安～' },
];
for (const normal of NORMAL) {
  test(`plan block, normal: ${normal.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(normal.raw, byChunking(chunking), { speakers: normal.speakers });
      assert.equal(played.shown, normal.raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `no drops, chunking ${chunking}`);
    }
  });
}

// ------------------------------------------------------------------ the first character

test('plan block: an ordinary first character still goes out in the same push()', () => {
  for (const first of ['笔', '想', '注', '分', '好', '嗯', '提醒', '笔记', '……']) {
    const increments: string[] = [];
    new MoodReplyProtocol(text => increments.push(text), { chineseChat: true }).push(first);
    assert.equal(increments.join(''), first, `first chunk ${JSON.stringify(first)} was held`);
  }
});
test('plan block: a label and a colon wait only until the words after them show they are said to the user', () => {
  for (const [start, next] of [['注意：', '你今天'], ['嗯:', '……四次啊'], ['Wow: ', '你好厉害'], ['提醒：明天降温，', '记得多穿一件哦。'], ['第一：先睡一觉。', '第二：明天再说。']]) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
    protocol.push(start);
    assert.equal(increments.join(''), '', `${start} waits`);
    protocol.push(next);
    assert.equal(increments.join(''), start + next, `${start}${next} goes out with the next chunk`);
  }
});
test('plan block: label, colon and plan in the first chunk: nothing shows until the plan is cut, then only the reply', () => {
  const raw = `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY}`;
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
  const cut = raw.indexOf('Fine.') + 'Fine.'.length;
  for (const piece of ['笔记: ', raw.slice(6, 60), raw.slice(60, cut)]) { protocol.push(piece); assert.equal(increments.join(''), '', JSON.stringify(piece)); }
  protocol.push(raw.slice(cut));
  protocol.finish();
  assert.equal(increments.join(''), REPLY);
});

// ------------------------------------------------------------------ the host side

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-plan-block-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://plan-block.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];

async function chat(service: CompanionService, id: string, body: string, pieces: (text: string) => string[]) {
  const shown: string[] = [];
  const turn = await service.begin(id, '今天傍晚散步的时候风好舒服', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
  const start = marker(turn.persona);
  for (const piece of pieces(body)) turn.push('delta', piece);
  turn.push('delta', `\n${start}{"context":"positive","delta":{"O":2},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish('complete');
  return { shown: shown.join(''), turn };
}

test('host: the plan block is not shown and not archived; the reply and its mood stay', async () => {
  await withService(async service => {
    const body = `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}${REPLY}`;
    const { shown, turn } = await chat(service, 'plan-1', body, text => [text.slice(0, 4), ...chunkings(text.slice(4))[3]]);
    assert.equal(shown, REPLY, 'what the bubble and the voice get (both take the same delta events)');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
      [['user', '今天傍晚散步的时候风好舒服', 'complete'], ['assistant', REPLY, 'complete']]);
    assert.equal(turn.emptyReply?.(), false);
    assert.ok(service.mood.get().snapshot.values.O > 50, 'the tail still moved her mood');
  });
});
test('host: a reply that is nothing but the plan block is archived once as a failed reply and moves no mood', async () => {
  await withService(async service => {
    const body = `${LABEL_LINE('笔记', ':')}\n${EN_PARAGRAPH}`;
    const { shown, turn } = await chat(service, 'plan-2', body, text => [text.slice(0, 3), ...chunkings(text.slice(3))[1]]);
    assert.equal(shown, '');
    assert.equal(turn.emptyReply?.(), true, 'the host answers with a line of her own (the emptied-reply path)');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
      [['user', '今天傍晚散步的时候风好舒服', 'complete'], ['assistant', '', 'error']]);
    assert.equal(service.memory.list(turn.scope).total, 1);
    assert.equal(service.mood.get().snapshot.values.O, 50, 'the tail of an emptied reply moves no mood');
  });
});
