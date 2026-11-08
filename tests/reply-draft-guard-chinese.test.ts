// F4 again (docs/claude/2026-11-03-draft-leak-fix.md): in a Chinese chat, the model's English plans and reminders in front of
// the reply must not reach the bubble, the voice or the archive. The leaks below are paraphrases of the shapes seen on real
// Claude Code (a mixed Chinese/English plan about whose words win, a terse English reminder of a rule, English notes about the
// set-up glued to the reply); none is the recorded text. English chats and ordinary English bits of a Chinese reply are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';
import { ReplyDraftGuard, chatLooksChinese, draftFilterLine, isChineseChatNote, isChinesePlan } from '../electron/reply-draft-guard';
import { replay } from '../scripts/lib/prompt-eval-analysis';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 4242;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(() => 1 + Math.floor(random() * 25))];
}
const tail = (p: MoodReplyProtocol) => `\n${p.start}{"context":"positive","delta":{"D":1},"reason":"测试","confidence":0.9,"gesture":"upbeat"}${p.end}`;

function play(raw: string, chunking: number, options: { chineseChat?: boolean; speakers?: string[]; first?: string } = {}) {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { settingProposal: { instruction: null }, speakers: options.speakers ?? [], chineseChat: options.chineseChat ?? true });
  const text = raw + tail(protocol);
  const stream = options.first ? [options.first, text.slice(options.first.length)] : chunkings(text)[chunking];
  for (const chunk of stream) protocol.push(chunk);
  const appraisal = protocol.finish();
  return { shown: increments.join(''), increments, protocol, appraisal };
}

// ------------------------------------------------------------------ leaks (Chinese chat)

const REPLY = '好呀，来！三局两胜，我可不会让着你～';
const LEAKS: Array<{ name: string; raw: string; expected: string; kinds: string[] }> = [
  { name: 'English notes about the set-up glued to the reply on one line', kinds: ['english-note'],
    raw: `Tool notes in the setup don't apply here; reply briefly. ${REPLY}`, expected: REPLY },
  { name: 'two English note sentences on one line', kinds: ['english-note'],
    raw: `Nothing in the context needs a tool. Agree briefly.\n\n${REPLY}`, expected: REPLY },
  { name: 'an English plan paragraph whose first sentence names no rule, in front of the Chinese reply', kinds: ['english-note'],
    raw: `Her move. The user's sister skipped the dinner they planned; stay on their side first, no analysis.\n\n她怎么能放你鸽子……${REPLY}`,
    expected: `她怎么能放你鸽子……${REPLY}` },
  { name: 'an English reminder of a rule on its own line', kinds: ['english-note'],
    raw: `No announcing the winner.\n\n${REPLY}`, expected: REPLY },
  { name: 'an English plan line that agrees and keeps it short', kinds: ['english-note'],
    raw: `Agree warmly, one or two lines, save the throws for later.\n${REPLY}`, expected: REPLY },
  { name: 'a plan about the user\'s mood, then a reminder, then the reply', kinds: ['english-note', 'english-note'],
    raw: `User sounds lighter now; respond playfully, skip the old mood.\n\nNo calling the shots.\n\n${REPLY}`, expected: REPLY },
];
for (const leak of LEAKS) {
  test(`chinese chat leak: ${leak.name}`, () => {
    for (const chunking of [0, 1, 2, 3, 4]) {
      const played = play(leak.raw, chunking);
      assert.equal(played.shown, leak.expected, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops().map(drop => drop.kind), leak.kinds, `kinds, chunking ${chunking}`);
      assert.equal(played.protocol.emptiedByFilter(), false);
      assert.equal(played.appraisal?.context, 'positive', `the tail still counts, chunking ${chunking}`);
    }
  });
}

test('chinese chat leak: a few Chinese characters and an English plan, then a reminder, then the reply', () => {
  const raw = `依照 the user's latest words, not the old read… keep it brief and agree, maybe say they sound brighter.\n\nNo calling the shots.\n\n${REPLY}`;
  for (const chunking of [0, 1, 2, 3, 4]) {
    const played = play(raw, chunking);
    // The plan and the reminder never show. When the first chunk is only a character or two, those are already on screen
    // before anything shows what follows them; nothing after them is.
    assert.ok(played.shown.endsWith(REPLY), `chunking ${chunking}: ${played.shown}`);
    const residue = played.shown.slice(0, -REPLY.length);
    assert.ok(['', '依', '依照'].includes(residue), `chunking ${chunking}: residue ${JSON.stringify(residue)}`);
    assert.doesNotMatch(played.shown, /[A-Za-z]/u);
    assert.deepEqual(played.protocol.draftDrops().map(drop => drop.kind), ['mixed-note', 'english-note'], `chunking ${chunking}`);
  }
  // The whole start in the first chunk: nothing of the plan shows at all.
  assert.equal(play(raw, 0).shown, REPLY);
  assert.equal(play(raw, 0, { first: '依照 the user' }).shown, REPLY);
  assert.equal(play(raw, 0, { first: '依照 ' }).shown, REPLY);
});

test('chinese chat leak: a reply that is nothing but English notes is emptied (she says a line of her own instead)', () => {
  const played = play('Keep it short and agree to play. No calling the shots.', 0);
  assert.equal(played.shown, '');
  assert.equal(played.protocol.emptiedByFilter(), true);
});

test('english chat: the same English notes are an English reply and pass unchanged', () => {
  for (const leak of LEAKS) {
    const played = play(leak.raw.replace(REPLY, 'Sure, let us play!'), 1, { chineseChat: false });
    assert.equal(played.shown, leak.raw.replace(REPLY, 'Sure, let us play!'), leak.name);
    assert.deepEqual(played.protocol.draftDrops(), [], leak.name);
  }
});

// ------------------------------------------------------------------ what must not change (Chinese chat)

const NORMAL: Array<{ name: string; raw: string; speakers?: string[] }> = [
  { name: 'OK in front of Chinese', raw: 'OK，那我们开始吧！' },
  { name: 'her Latin name as a stage direction', raw: 'Gene 揉了揉眼睛……来就来，谁怕谁。', speakers: ['Gene'] },
  { name: 'a greeting', raw: 'Hi～今天怎么样？' },
  { name: 'an exclamation with a full-width mark', raw: 'Nice！你赢了这一局。' },
  { name: '"No way!"', raw: 'No way! 你又出布？' },
  { name: '"No crying." as comfort', raw: 'No crying. 乖，我在呢。' },
  { name: 'good night', raw: 'Good night～早点睡哦。' },
  { name: 'a playful guess', raw: 'Let me guess… 你又想出石头？' },
  { name: 'the call itself in English', raw: 'Rock, paper, scissors！来吧～' },
  { name: 'Chinese, a blank and one English word', raw: '哈哈 OK，来！' },
  { name: 'Chinese, a blank and a short English exclamation', raw: '嗯嗯 sure thing! 那我们来玩吧。' },
  { name: 'Bingo', raw: 'Bingo! 被我猜中了吧～' },
  { name: 'game on', raw: 'Game on! 三局两胜，输了不许哭。' },
  { name: 'maybe next time', raw: 'Maybe next time～今天先休息吧。' },
  { name: 'an English-speaking character answering a Chinese message', raw: "Sure, let's play! Best two out of three, okay?\n\nReady when you are." },
  { name: 'a short English greeting line before the Chinese reply', raw: 'Good morning, sunshine!\n早上好呀～今天也要加油。' },
  { name: 'her own name, alone in the first chunk', raw: 'Gene 歪了歪头……来呀，谁怕谁。', speakers: ['Gene'] },
  { name: 'English quoted in the middle of a Chinese reply', raw: '你刚才说的 "keep it short and reply" 是什么意思呀？' },
  { name: 'an ordinary Chinese reply', raw: '改了三遍还被打回来，换谁都会泄气的。\n\n先别急着改第四遍，歇一会儿也好。' },
  { name: 'a Chinese reply with a blank after a few characters', raw: '好 我们来！三局两胜。' },
  { name: 'a kaomoji start', raw: '>_< 哎呀，我刚才睡着了！' },
  { name: 'digits first', raw: '3 局 2 胜，来吧！' },
  { name: 'leading whitespace', raw: '\n\n好的，我在。' },
];
for (const normal of NORMAL) {
  test(`chinese chat normal: ${normal.name}`, () => {
    for (const chunking of [0, 1, 2, 3, 4]) {
      const played = play(normal.raw, chunking, { speakers: normal.speakers });
      assert.equal(played.shown, normal.raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `no drops, chunking ${chunking}`);
    }
  });
}

// ------------------------------------------------------------------ the first character is not slowed

test('chinese chat, first increment: a reply that starts with Chinese goes out in the same push(), whatever the first chunk', () => {
  for (const first of ['好', '嗯……', '改了三遍', '哼，', '依', '好呀', '……', '“', '（', '覆盖', '嘿嘿嘿嘿嘿', '12点']) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
    protocol.push(first);
    assert.equal(increments.join(''), first, `first chunk ${JSON.stringify(first)} was held`);
  }
});
// 2026-11-08: a lone digit is the one first chunk that waits, for the numbered plan item seen on the stable build ("1" then
// "回复……用户……"); in the 339 archived replies only that leak started with a digit. It goes out with the next chunk when that
// is not a plan word (tests/reply-draft-numbered-plan.test.ts has the plan side).
test('chinese chat, first increment: a lone digit waits one chunk, then goes out with it', () => {
  for (const [first, next] of [['1', '分钟后叫你哦'], ['3', '、2、1——开始！'], ['2', '个小时了诶']]) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
    protocol.push(first);
    assert.equal(increments.join(''), '', `${first} waits for the next chunk`);
    protocol.push(next);
    assert.equal(increments.join(''), first + next, `${first}${next} goes out with the next chunk`);
  }
});
test('chinese chat, first increment: an English start waits only until it shows whether it is one word or a sentence', () => {
  for (const [first, next] of [['OK', '，好呀'], ['Momo', ' 揉了揉眼睛'], ['Hi', '～'], ['Nice', '！']]) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true, speakers: ['Gene'] });
    protocol.push(first);
    assert.equal(increments.join(''), '', `${first} waits for the next chunk`);
    protocol.push(next);
    assert.equal(increments.join(''), first + next, `${first}${next} goes out with the next chunk`);
  }
  // Her own name is not held at all (a reply often starts "Gene 歪了歪头…").
  for (const first of ['Gene', 'Gen', 'Gene ']) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true, speakers: ['Gene'] });
    protocol.push(first);
    assert.equal(increments.join(''), first, JSON.stringify(first));
  }
  // An English sentence goes out as soon as it ends, not at the end of the reply.
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
  for (const chunk of ['Game', ' on', '! ', '三局', '两胜']) protocol.push(chunk);
  assert.equal(increments.join(''), 'Game on! 三局两胜');
});
test('english chat, first increment: unchanged (an English start goes out at once)', () => {
  for (const first of ['Hello', 'OK', 'No', 'Sure', 'Tool']) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: false });
    protocol.push(first);
    assert.equal(increments.join(''), first);
  }
});

// ------------------------------------------------------------------ Chinese notes, a label and a colon, stray symbols (2026-11-03, later reports)

// A whole reply that is a Chinese note to itself, ending with a private read of the user (paraphrase; the condition is made up).
const CN_PLAN = '又被夸了，这都第三回了。回复短一点，带点害羞，顺便自嘲一下。用户先前提过手腕酸，可以轻轻关心一句也可以不提——前面已经问过好几次，这次别再问。';
test('chinese plan: a whole reply of notes is dropped without one character on screen when its start arrives as two characters or more', () => {
  for (const first of ['又被夸', '又被夸了，', CN_PLAN]) {
    const played = play(CN_PLAN, 0, { first });
    assert.equal(played.shown, '', JSON.stringify(first));
    assert.equal(played.protocol.emptiedByFilter(), true, 'she says a line of her own instead (the host path for an emptied reply)');
  }
  for (const chunking of [0, 2]) {
    const played = play(CN_PLAN, chunking);
    assert.equal(played.shown, '', `chunking ${chunking}`);
    assert.equal(played.protocol.emptiedByFilter(), true);
  }
});
test('chinese plan: whatever the chunking, not one character of it shows (a first chunk of one character included)', () => {
  for (const chunking of [0, 1, 2, 3, 4]) {
    const played = play(CN_PLAN, chunking);
    assert.equal(played.shown, '', `chunking ${chunking}: ${played.shown}`);
    assert.equal(played.protocol.emptiedByFilter(), true, `chunking ${chunking}`);
  }
});

// docs/claude/2026-11-03-draft-first-char.md: 81% of real replies arrive one character first. A first character that can begin
// a plan (这/又/被/本/语/按; 回 already was) now waits for the next chunk instead of going out alone and taking the head with it.
// X-237's synthetic sentence and paraphrases for the other openers (none is a real reply).
const FIRST_CHAR_PLANS = [
  '这一轮回复短些，语气带点傲娇。',
  '这是第四次被夸了。回复别太长，害羞一点。',
  '又被夸了。回复短点，自嘲一下。',
  '被夸第二回了。回复一两句就好，带点撒娇。',
  '本轮回复短些，语气软一点。',
  '语气放软，回复短点，上回已经问过好几次，别再问。',
  '按人设回复短些，带点傲娇。',
];
test('chinese plan, one character first: the whole note is dropped, nothing shows, she says a line of her own', () => {
  for (const plan of FIRST_CHAR_PLANS) for (const chunking of [1, 2, 3, 4]) {
    const played = play(plan, chunking, chunking === 2 ? { first: plan[0] } : {});
    assert.equal(played.shown, '', `${plan} chunking ${chunking}`);
    assert.equal(played.protocol.emptiedByFilter(), true, `${plan} chunking ${chunking}`);
  }
});
test('chinese plan, one character first: a note in front of a real reply leaves only the reply', () => {
  const reply = '哼，才、才不是因为你夸我才开心的！';
  for (const plan of FIRST_CHAR_PLANS) for (const chunking of [1, 3]) {
    const played = play(`${plan}\n\n${reply}`, chunking);
    assert.equal(played.shown, reply, `${plan} chunking ${chunking}`);
    assert.equal(played.protocol.emptiedByFilter(), false);
    assert.equal(played.appraisal?.context, 'positive', 'the tail still counts');
  }
});
test('chinese chat, one character first: an ordinary reply that starts like a plan waits for one chunk only', () => {
  for (const [first, second, rest] of [['被', '人', '冤枉成这样，换谁都会委屈的。'], ['这', '还', '用问嘛，当然是你最重要～'], ['又', '下', '雨啦，记得带伞哦。'],
    ['本', '来', '就是你的功劳呀！'], ['语', '文', '作业写完了吗？'], ['按', '你', '说的来，我都听你的～'], ['被', '最好的朋友', '这样对待，谁都会难过的。']]) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
    protocol.push(first);
    assert.equal(increments.join(''), '', `${first} waits for the next chunk`);
    protocol.push(second);
    assert.equal(increments.join(''), first + second, `${first}${second} goes out with the next chunk`);
    protocol.push(rest);
    protocol.finish();
    assert.equal(increments.join(''), first + second + rest);
  }
  // A start that still matches after two characters ("这是" of "这是第") waits one more chunk, and no longer.
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text), { chineseChat: true });
  for (const chunk of ['这', '是']) protocol.push(chunk);
  assert.equal(increments.join(''), '');
  protocol.push('我最喜欢的歌！');
  assert.equal(increments.join(''), '这是我最喜欢的歌！');
  // Only in a Chinese chat: an English chat lets the same first character out at once, as before.
  const english: string[] = [];
  new MoodReplyProtocol(text => english.push(text), { chineseChat: false }).push('被');
  assert.deepEqual(english, ['被']);
});
test('chinese chat, one character first: a first character that begins no plan still goes out in the same push()', () => {
  for (const first of ['好', '就', '考', '科', '累', '连', '哼', '白', '辛', '她', '一', '真', '第', '（', '“']) {
    const increments: string[] = [];
    new MoodReplyProtocol(text => increments.push(text), { chineseChat: true }).push(first);
    assert.equal(increments.join(''), first, `first chunk ${JSON.stringify(first)} was held`);
  }
});
test('chinese plan: a note in front of a real reply leaves the reply', () => {
  const reply = '嘿嘿……被你这么一说，我都不知道该把脸往哪儿放了。';
  for (const chunking of [0, 2]) assert.equal(play(`被夸好几次了。回复短一点，带点害羞。\n\n${reply}`, chunking).shown, reply, `chunking ${chunking}`);
});
test('chinese plan: a later sentence about the user and how to answer is dropped, the sentences before it stay', () => {
  const played = play('嘿嘿，谢谢夸奖～\n\n用户先前提过手腕酸，可以关心一句也可以不提，已经问过好几次，别再重复。\n\n今天也要早点休息哦。', 1);
  assert.equal(played.shown, '嘿嘿，谢谢夸奖～\n\n今天也要早点休息哦。');
});

test('a short label, a colon and an English plan on the same line as the reply: the plan goes from the middle of the line', () => {
  const reply = '……诶？喜、喜欢……？\n\n你、你突然说这个干嘛啦。';
  for (const label of ['XY: ', '力度：']) {
    const raw = `${label}The user says something sweet. Answer shy and short, skip stage directions in brackets since the voice reads them. Footnote.${reply}`;
    for (const chunking of [0, 1, 2, 3, 4]) {
      const played = play(raw, chunking);
      assert.ok(played.shown.endsWith(reply), `${label} chunking ${chunking}: ${played.shown}`);
      assert.doesNotMatch(played.shown, /[A-Za-z]/u, `${label} chunking ${chunking}`);
      assert.ok(played.shown.length - reply.length <= 2, `at most the label's characters are left, ${label} chunking ${chunking}: ${played.shown}`);
    }
    assert.equal(play(raw, 0).shown, reply, `${label}: the whole start in one chunk, the label goes too`);
  }
  // The label shown one character at a time, its colon in the next chunk: the plan is still cut from the middle of the line.
  assert.equal(play(`力度：Keep it shy and short, add a footnote.${reply}`, 0, { first: '力' }).shown, `力${reply}`, 'only the first character, already shown, stays');
});
test('predicates: a Chinese note needs two cues, one of them heavy', () => {
  assert.equal(isChinesePlan('用户的事前面已经问过好几次，这次不提。', false), true);
  assert.equal(isChinesePlan('用户的事这次不提。', false), false);
  assert.equal(isChinesePlan('回复短一点，带点害羞。', false), true);
  assert.equal(isChinesePlan('我都害羞了～', true), false, 'right behind a draft, a sentence said to someone stays');
  assert.equal(isChinesePlan('带点害羞。', true), true);
});
test('a development discussion seen on the shared screen does not reach the reply through a plan', () => {
  const reply = '嗯……你们在讨论我说话的事吗？我有点好奇。';
  const raw = `Screen shows devs discussing that parentheses get read aloud; ignore that, respond briefly.\n\n${reply}`;
  for (const chunking of [0, 1, 3]) assert.equal(play(raw, chunking).shown, reply, `chunking ${chunking}`);
});
test('a stray symbol in front of the reply goes, in any chat', () => {
  for (const chineseChat of [true, false]) for (const chunking of [0, 1, 2]) {
    const played = play('ↂ……诶？真的吗？', chunking, { chineseChat });
    assert.equal(played.shown, '……诶？真的吗？', `chinese ${chineseChat}, chunking ${chunking}`);
    assert.deepEqual(played.protocol.draftDrops().map(drop => drop.kind), ['stray-symbol']);
  }
  assert.equal(play('�好呀', 0).shown, '好呀');
});

const NORMAL_LATER: Array<{ name: string; raw: string }> = [
  { name: 'praise taken shyly, with a count', raw: '又被夸啦……这都第三次了，我脸都要红了。' },
  { name: 'a start like a plan opener that is said to the user', raw: '被夸了好开心～谢谢你呀。' },
  { name: 'this is the first time', raw: '这是我第一次听你这么说呢。' },
  { name: 'her tone', raw: '语气这么认真，是遇到什么事了吗？' },
  { name: 'a later sentence that starts with 回复', raw: '嗯嗯。\n\n回复你一下：我一直都在哦。' },
  { name: 'shy words after an ordinary first sentence', raw: '才、才没有害羞！\n\n顺便说一句，你今天也很好看。' },
  { name: 'a stage direction in brackets', raw: '（把脸埋低）……谢谢你。' },
];
for (const normal of NORMAL_LATER) {
  test(`chinese chat normal (later reports): ${normal.name}`, () => {
    for (const chunking of [0, 1, 2, 3, 4]) {
      const played = play(normal.raw, chunking);
      assert.equal(played.shown, normal.raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `chunking ${chunking}`);
    }
  });
}

// ------------------------------------------------------------------ pieces

test('predicates: a Chinese-chat note needs words from two groups, or the bare "No <doing>." reminder', () => {
  assert.equal(isChineseChatNote('Keep it short and agree to play.', false), true);
  assert.equal(isChineseChatNote('No announcing the winner.', false), true);
  assert.equal(isChineseChatNote('No way!', false), false);
  assert.equal(isChineseChatNote('No kidding.', false), false);
  assert.equal(isChineseChatNote('Let me guess…', false), false);
  assert.equal(isChineseChatNote('Rock, paper, scissors!', false), false);
  assert.equal(isChineseChatNote('Good night', false), false);
  assert.equal(isChineseChatNote('Ready?', true), true, 'right behind a draft, a short English line is the rest of it');
  assert.equal(isChineseChatNote('Keep it short 好呀', false), false, 'never a line with Chinese in it');
  assert.equal(chatLooksChinese('来玩石头剪刀布吧'), true);
  assert.equal(chatLooksChinese("let's play rock paper scissors"), false);
  assert.equal(chatLooksChinese('😂😂', '角色名称：小柚'), true, 'no letters at all: the persona decides');
  assert.equal(chatLooksChinese('ok', '角色名称：小柚'), false);
});
test('the guard without the Chinese-chat option behaves as before', () => {
  const guard = new ReplyDraftGuard();
  assert.equal(guard.push('No announcing the winner.\n\n好呀'), 'No announcing the winner.\n\n好呀');
});
test('replay decides the chat language from the recorded user message, as the app does', () => {
  const raw = `Tool notes in the setup don't apply here; reply briefly. ${REPLY}`;
  const record = { chunks: [[100, raw]] as Array<[number, string]>, nonce: 'f'.repeat(32), settingOffered: false, error: null };
  assert.equal(replay({ ...record, user: '来玩石头剪刀布吧' }).visible, REPLY);
  assert.equal(replay({ ...record, user: "let's play" }).visible, raw);
  assert.equal(replay(record).visible, raw, 'an old record without the user message replays as before');
});
test('the developer-mode line has counts and shapes only', () => {
  const line = JSON.parse(draftFilterLine([{ kind: 'english-note', chars: 40 }, { kind: 'english-note', chars: 12 }, { kind: 'mixed-note', chars: 30 }], false, 1000));
  assert.deepEqual(line, { at: 1000, drops: 3, chars: 82, kinds: { 'english-note': 2, 'mixed-note': 1 }, whole: false });
});

// ------------------------------------------------------------------ the host side

async function withService(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-draft-guard-cn-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://draft-guard.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service, directory); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];
const NOTE = 'User sounds lighter now; respond playfully, skip the old mood.\n\nNo calling the shots.\n\n';

async function chat(service: CompanionService, id: string) {
  const shown: string[] = [];
  const turn = await service.begin(id, '算了不想了，来玩石头剪刀布吧！', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
  const start = marker(turn.persona);
  for (const piece of [NOTE.slice(0, 1), NOTE.slice(1, 9), NOTE.slice(9), REPLY]) turn.push('delta', piece);
  turn.push('delta', `\n${start}{"context":"positive","delta":{"D":2},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish('complete');
  return { shown: shown.join(''), turn };
}

test('host: in a Chinese chat the notes are not shown, not archived, and the reply and its mood stay', async () => {
  await withService(async service => {
    const { shown, turn } = await chat(service, 'cn-1');
    assert.equal(shown, REPLY, 'what the bubble and the voice get (both take the same delta events)');
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
      [['user', '算了不想了，来玩石头剪刀布吧！', 'complete'], ['assistant', REPLY, 'complete']]);
    assert.ok(service.mood.get().snapshot.values.D > 50, 'the tail still moved her mood');
  });
});
test('host: developer mode counts the cut pieces in dev/reply-draft-filter.jsonl (no text); otherwise nothing is written', async () => {
  await withService(async (service, directory) => {
    const file = path.join(directory, 'dev', 'reply-draft-filter.jsonl');
    await chat(service, 'cn-off');
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(readFile(file, 'utf8'), 'developer mode off: no file');
    service.mood.setDeveloperMode(true);
    await chat(service, 'cn-on');
    let text = '';
    for (let waited = 0; waited < 3000 && !text; waited += 50) {
      try { text = await readFile(file, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const lines = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'chars', 'drops', 'kinds', 'whole']);
    assert.deepEqual(lines[0].kinds, { 'english-note': 2 });
    assert.equal(lines[0].whole, false);
    assert.doesNotMatch(text, /User|lighter|shots|好呀/u, 'no text of the reply or the notes');
  });
});
test('host: X-237\'s note pushed one character at a time is not shown, not read, archived once as a failed reply, and moves no mood', async () => {
  await withService(async service => {
    const shown: string[] = [];
    const turn = await service.begin('cn-x237', '你今天好可爱呀', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const start = marker(turn.persona);
    for (const character of '这一轮回复短些，语气带点傲娇。') turn.push('delta', character);
    turn.push('delta', `\n${start}{"context":"positive","delta":{"D":2},"confidence":0.9}${start.replace('<', '</')}`);
    await turn.finish('complete');
    await turn.finish('complete'); // a second finish changes nothing
    assert.equal(shown.join(''), '', 'the bubble and the voice (both take the same delta events) get nothing');
    assert.equal(turn.emptyReply?.(), true, 'the host answers with a line of her own (the emptied-reply path)');
    assert.equal(turn.speechMood(), null);
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]),
      [['user', '你今天好可爱呀', 'complete'], ['assistant', '', 'error']]);
    assert.equal(service.memory.list(turn.scope).total, 1);
    assert.equal(service.mood.get().snapshot.values.D, 50, 'the tail of an emptied reply moves no mood');
  });
});
