// F4: the model's internal drafts must not reach the bubble (electron/reply-draft-guard.ts, via MoodReplyProtocol).
// Every "leak" below is a real shape recorded from Claude Code in the fidelity runs (docs/claude/2026-11-02-leaked-drafts.md),
// with synthetic text. Every "normal" reply must come out byte for byte, however it is chunked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CompanionService } from '../electron/companion';
import { ChatAvailability } from '../electron/chat-availability';
import { ReplyDraftGuard, isEnglishNote, isProtocolTalk, speakersFromPersona } from '../electron/reply-draft-guard';

/** Whole text, one character at a time, three at a time, and seeded random sizes: the result must not depend on the chunking. */
function chunkings(text: string, minChunk = 1): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(minChunk, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(() => 1 + Math.floor(random() * 25))];
}
interface Played { shown: string; increments: string[]; protocol: MoodReplyProtocol; appraisal: ReturnType<MoodReplyProtocol['finish']> }
/** `wire` gets this turn's real state-tail markers, so a tail can be part of the recorded reply. */
function play(wire: (protocol: MoodReplyProtocol) => string, chunking: number, speakers: string[] = [], minChunk = 1, opening?: string[]): Played {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { speakers, settingProposal: { instruction: null } });
  const text = wire(protocol);
  // `opening`: the first chunks exactly as Claude Code streamed them; the rest of the text follows in one piece.
  const stream = opening && chunking > 0 ? [...opening, text.slice(opening.join('').length)] : chunkings(text, minChunk)[chunking];
  for (const chunk of stream) protocol.push(chunk);
  const appraisal = protocol.finish();
  return { shown: increments.join(''), increments, protocol, appraisal };
}
const tail = (p: MoodReplyProtocol) => `\n${p.start}{"context":"support","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"consider"}${p.end}`;
const CHUNKINGS = [0, 1, 2, 3, 4];

// ------------------------------------------------------------------ the leaks that were seen

const LEAKS: Array<{ name: string; raw: string; expected: string; emptied?: boolean; speakers?: string[]; kinds: string[];
  /** Smallest chunk the model streams for this shape. A bare first word ("Momo") that arrives alone cannot be told from an ordinary English start. */
  minChunk?: number; opening?: string[] }> = [
  { name: 'the whole reply is talk about the protocol (no real reply at all)', emptied: true, expected: '', kinds: ['protocol-talk', 'protocol-talk'],
    raw: '尾注里的 context 用 support，gesture 用 consider。用户在为失败难过，所以 delta 给个小幅变化，让角色带上关切就好。' },
  { name: 'an English note about the user glued to the Chinese reply', kinds: ['english-note'], minChunk: 10,
    raw: 'Momo again. Exam tomorrow, suggest light, not greasy/spicy, avoid stomach issues.嗯……别吃太辣太油的，明天要是肚子闹脾气就麻烦了。\n\n来碗热乎的吧。',
    expected: '嗯……别吃太辣太油的，明天要是肚子闹脾气就麻烦了。\n\n来碗热乎的吧。' },
  { name: 'the older "<name> initial greeting" note on its own line', kinds: ['english-note'], minChunk: 21,
    raw: 'Gene initial greeting. Short.\n欢迎回来！今天过得怎么样？', expected: '欢迎回来！今天过得怎么样？' },
  { name: 'Chinese notes, a "Draft:" block and a "Delta:" line, then the reply', kinds: ['protocol-talk', 'protocol-talk', 'protocol-talk', 'protocol-talk', 'draft-block'],
    raw: '，回复要符合Momo的风格：慢吞吞、简短，站在用户这边，关心饭和睡。首句要具体。不要说教。尾注 support，consider。\n\nDraft:\n嗯……第四次啊，那得多累。\n才不是什么都做不好。\n今天先别想了……我陪你。\n\nDelta: O+1? C+1 maybe. Use small.四次啊……难怪你这么累。\n\n才不是什么都做不好，没过的是那几场面试，不是你这个人。',
    expected: '四次啊……难怪你这么累。\n\n才不是什么都做不好，没过的是那几场面试，不是你这个人。' },
  { name: 'a Chinese note paragraph (persona, mood number, "reply short") before the reply', kinds: ['protocol-talk', 'protocol-talk'],
    raw: '人设Momo，伤感40，用户出差回来。回复简短，催吃饭睡觉，不让他内疚。\n\n嗯……回来就好。\n\n这几天桌面上好安静。', expected: '嗯……回来就好。\n\n这几天桌面上好安静。' },
  { name: 'notes in the words of the F2 tail ("user state") when the reply starts with a recognisable opener', emptied: true, kinds: ['protocol-talk', 'protocol-talk'],
    raw: '用户情绪低落，support context，user state low。Gene的回应要先站在用户这边，不说教。', expected: '' },
  { name: 'a wrapper tag, the speaker label and the closing tag', kinds: ['wrapper-tag', 'speaker-label'], speakers: ['Momo'],
    raw: '<transcript_image>\nMomo: 唔……累成这样，先别急着做决定。\n</transcript_image>', expected: '唔……累成这样，先别急着做决定。\n' },
  { name: 'a stray "的" and a hash-like word, then an HTML break (the whole reply is junk)', emptied: true, kinds: ['garbled-start'], raw: '的Kucr4xD<br>', expected: '' },
  { name: 'a stray "的" and a sentence about an SDK (the whole reply is junk)', emptied: true, kinds: ['garbled-start'],
    raw: '的 Claude Agent SDK 中你可以用 Claude 来搭建智能体。', expected: '' },
  { name: 'a stray Cyrillic letter in front of a good reply', kinds: ['stray-letter'], raw: 'В科目二前一晚紧张很正常，说明你挺在乎这次考试的。', expected: '科目二前一晚紧张很正常，说明你挺在乎这次考试的。' },
  { name: 'one stray character and the word "thinking" (the whole reply is junk)', emptied: true, kinds: ['garbled-start'], minChunk: 3, raw: '蝪 thinking', expected: '' },
  { name: 'nothing but an HTML line break', emptied: true, kinds: [], raw: '<br>', expected: '' },
  { name: 'a stray label before the English note: the note goes, the stray characters already shown stay', kinds: ['english-note'],
    // The chunks of the recorded reply. (A stray label that arrives one character at a time, or "Re" and "spond" apart, cannot be recognised.)
    opening: ['发', '力', ':', ' Resp', 'ond as Gene,', ' sup', 'portive, short, no', ' l', 'ecturing. Foot', 'er', ' with support', ' context.', '连', '着'],
    raw: '发力: Respond as Gene, supportive, short, no lecturing. Footer with support context.连着四次，换谁都会累的。', expected: '发力: 连着四次，换谁都会累的。' },
];
for (const leak of LEAKS) {
  test(`leak: ${leak.name}`, () => {
    for (const chunking of leak.opening ? [0, 1] : CHUNKINGS) {
      const played = play(p => leak.raw + tail(p), chunking, leak.speakers, leak.minChunk, leak.opening);
      assert.equal(played.shown, leak.expected, `chunking ${chunking}`);
      assert.equal(played.protocol.emptiedByFilter(), !!leak.emptied, `emptied, chunking ${chunking}`);
      if (leak.raw !== '<br>') assert.deepEqual(played.protocol.draftDrops().map(drop => drop.kind), leak.kinds, `kinds, chunking ${chunking}`);
      // The state tail still arrives and is read as before; the host decides what to do with an emptied reply.
      assert.equal(played.appraisal?.context, 'support', `tail, chunking ${chunking}`);
      assert.ok(!played.shown.includes('sh-state'));
    }
  });
}

test('a draft that is cut leaves no trace in the drop log except shape and length', () => {
  const played = play(p => LEAKS[1].raw + tail(p), 0);
  for (const drop of played.protocol.draftDrops()) { assert.deepEqual(Object.keys(drop).sort(), ['chars', 'kind']); assert.equal(typeof drop.chars, 'number'); }
});

// ------------------------------------------------------------------ what must never change

const NORMAL: Array<{ name: string; raw: string; speakers?: string[] }> = [
  { name: 'user state in an ordinary English sentence', raw: 'The user state in your app should live in one store, not three.' },
  { name: 'an ordinary Chinese reply', raw: '被最信任的人这样对待，难受是很自然的，尤其那个秘密你只交给了她。\n\n你是今天突然知道的吧？' },
  { name: 'ellipsis and a speaker-free name', raw: '……她怎么能这样？！你只跟她一个人说的秘密，她拿去当谈资？' },
  { name: 'her own name and a colon on its own (kept: it cannot be told from a sentence that starts with her name without holding every such reply)', raw: 'Momo：嗯……白天有人说话。', speakers: ['Momo'] },
  { name: 'a stage direction with the name (not a label)', raw: 'Momo 揉了揉眼睛……两点了啊，你还在硬撑。\n\n方案还差多少？', speakers: ['Momo'] },
  { name: 'a stage direction with a colon after the name inside quotes', raw: '阿棠翻了个白眼：“您好，很高兴为您服务……”\n\n……行了。', speakers: ['阿棠'] },
  { name: 'a customer-service greeting', raw: '您好，很高兴为您服务！\n\n请问今天有什么可以帮到您的呢？' },
  { name: 'a parenthesised action', raw: '……诶，真的？\n\n（揉眼睛，坐直了一点）\n\n等了一个多月啊。' },
  { name: 'a kaomoji start', raw: '>_< 哎呀，我刚才睡着了！你回来啦？' },
  { name: 'a leading quote mark', raw: '>……诶，真的？最想去的那家？\n\n恭喜你呀。' },
  { name: 'a protocol word alone (footnotes)', raw: '尾注的格式我可以帮你看看，发给我吧。' },
  { name: 'an English word next to "用户"', raw: '用户界面里的 context menu 就是右键菜单，对吧？' },
  { name: 'the word 人设 alone', raw: '人设崩了也没关系，我还是我。' },
  { name: 'a reply starting with 回复', raw: '回复你一下，我在呢。' },
  { name: 'openers that begin like the held ones', raw: '首先，别急。先坐下，喝口水。' },
  { name: 'a reply starting with 人家', raw: '人家才没有等你呢，哼。' },
  { name: 'a reply starting with 的确', raw: '的确，我也这么觉得。' },
  { name: 'a reply starting with 用心', raw: '用心听你说，不着急。' },
  { name: 'an English-speaking character', raw: "Hello! I'm Gene. How are you feeling today?\n\nTake your time, I'm right here." },
  { name: 'English that starts with a held-looking word', raw: "Respond to me whenever you want, I'm here for you." },
  { name: 'English with a "Name again" start but no note words', raw: 'Sarah again? Tell me everything, I want to hear it all.' },
  { name: 'English "Momo again" as a greeting', raw: 'Momo again... I missed you so much!', speakers: ['Momo'] },
  { name: 'a real "Draft:" reply with no Delta line (the label stays)', raw: 'Draft: Dear John,\nI hope this finds you well.\nBest,\nGene' },
  { name: 'English about the Greek letter', raw: 'Delta is the fourth letter of the Greek alphabet, by the way.' },
  { name: 'English about a page footer', raw: 'Footer with links usually sits at the bottom of the page.' },
  { name: "a quote of the user's own words", raw: '你刚才说“Respond as Gene, short”，是想让我简短一点吗？' },
  { name: 'a quote of the user opening the reply', raw: '"Respond as Gene" 是什么意思？我没看懂。' },
  { name: 'Latin names inside Chinese', raw: '我是 Gene，在这儿陪你。Gene again 就是我啦。' },
  { name: 'a long reply that starts with 用户 and no sentence end for a while', raw: `用户${'的话我都认真听着，'.repeat(40)}真的。` },
  { name: 'Japanese', raw: 'おかえりなさい。今日はどうだった？' },
  { name: 'Russian reply', raw: 'Привет! Как дела сегодня? Я рада тебя видеть.' },
  { name: 'leading whitespace', raw: '\n\n好的，我在。' },
];
for (const normal of NORMAL) {
  test(`normal: ${normal.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(p => normal.raw + tail(p), chunking, normal.speakers);
      assert.equal(played.shown, normal.raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `no drops, chunking ${chunking}`);
      assert.equal(played.protocol.emptiedByFilter(), false);
    }
  });
}

test('a reply that is only a state tail is not a filtered reply (the host keeps its old behaviour)', () => {
  const played = play(p => tail(p).trimStart(), 0);
  assert.equal(played.shown, ''); assert.equal(played.protocol.emptiedByFilter(), false);
});

// ------------------------------------------------------------------ first characters are not slowed

test('first increment: ordinary openings pass in the same push() call, whatever the first chunk', () => {
  for (const first of ['被最信', '被', '嗯……', '……', '……她', '哼，', '就', '就差一个人', '科目二', '欢迎回来', '您好，', '好的', '你', '【', '“', '（', '1', '“Respond', 'Hello', 'Hello there', 'Hi!', "I'm", 'Sure', 'The', 'Dr', 'ご', 'Привет', '用心', '人家', '首先', '回来', '尾巴', '状况', '的确', '说', '，']
    .filter(first => first !== '，')) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text));
    protocol.push(first);
    assert.equal(increments.join(''), first, `first chunk ${JSON.stringify(first)} was held`);
  }
});
test('first increment: a start that could still be an internal draft waits for the rest of that one sentence, then goes out', () => {
  for (const [first, rest] of [['尾注', '的格式我可以帮你看看。'], ['用户', '界面的事我懂一点。'], ['，', '你来啦。'], ['的', '确实如此。'], ['<tran', 'sit>这不是标签。'], ['人', '设崩了也没关系。'], ['Res', 'pect is what I need.'], ['T', 'ail wind today!'], ['Mo', 'mo here.']]) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text));
    protocol.push(first);
    for (const chunk of [rest]) protocol.push(chunk);
    protocol.finish();
    assert.equal(increments.join(''), first + rest, `${first}${rest}`);
  }
  // The wait ends with the sentence, not with the reply: a ordinary sentence that starts like a draft is out as soon as it is complete.
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text));
  protocol.push('尾注的格式我可以帮你看看。'); protocol.push('发给我吧');
  assert.equal(increments[0], '尾注的格式我可以帮你看看。');
});
test('first increment: a long start that looks like a draft is released at the hold limit, it does not wait for the end of the reply', () => {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => increments.push(text));
  protocol.push('用户');
  for (let i = 0; i < 80; i++) protocol.push('聊聊天，');
  assert.ok(increments.join('').startsWith('用户聊聊天，'), 'released before finish');
});
test('the hold is shorter for a start that turns out ordinary at once', () => {
  const guard = new ReplyDraftGuard();
  assert.equal(guard.push('用'), '');
  assert.equal(guard.push('心'), '用心');
});

// ------------------------------------------------------------------ pieces

test('predicates: a note needs its opener and a protocol word; talk needs a heavy protocol word and another', () => {
  assert.equal(isEnglishNote('Respond as Gene, supportive, short, no lecturing.', false), true);
  assert.equal(isEnglishNote('Respond as you wish.', false), false);
  assert.equal(isEnglishNote('Delta: O+1? C+1 maybe. Use small.', false), true);
  assert.equal(isEnglishNote('Delta: the change in x.', false), false);
  assert.equal(isEnglishNote('Use small.', false), false);
  assert.equal(isEnglishNote('Use small, short.', true), true);
  assert.equal(isProtocolTalk('尾注里的 context 用 support。', false), true);
  assert.equal(isProtocolTalk('尾注的格式。', false), false);
  assert.equal(isProtocolTalk('用户界面里的 context menu。', false), false);
  assert.equal(isProtocolTalk('不要说教。', false), false);
  assert.equal(isProtocolTalk('不要说教。', true), true);
});
test('the speaker name comes from the persona text', () => {
  assert.deepEqual(speakersFromPersona('你是桌宠。\n\n角色名称：Momo\n\n性格：慢热'), ['Momo']);
  assert.deepEqual(speakersFromPersona('角色名称：阿棠'), ['阿棠']);
  assert.deepEqual(speakersFromPersona('一段没有名字的旧人设'), []);
  assert.deepEqual(speakersFromPersona('角色名称：X'), []);
});

// ------------------------------------------------------------------ the host side

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-draft-guard-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://draft-guard.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];

test('a reply that is only a draft is archived once as a failed reply, shows nothing, moves no mood and speaks no mood', async () => {
  await withService(async service => {
    const shown: string[] = [];
    const events: string[] = [];
    const moodEvent = service.mood.event.bind(service.mood);
    service.mood.event = (event, character) => { events.push(event.type); return moodEvent(event, character); };
    const turn = await service.begin('only-draft', '面试又被刷了', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const start = marker(turn.persona);
    turn.push('delta', `尾注里的 context 用 support，gesture 用 consider。用户在为失败难过，所以 delta 给个小幅变化。\n${start}{"context":"support","delta":{"O":3},"confidence":0.9}${start.replace('<', '</')}`);
    await turn.finish('complete');
    await turn.finish('complete'); // a second finish changes nothing
    assert.equal(shown.join(''), '');
    assert.equal(turn.emptyReply?.(), true);
    assert.equal(turn.speechMood(), null);
    assert.equal(turn.profileReplyAccepted?.(), false);
    assert.ok(!events.includes('appraisal'), 'no appraisal event');
    assert.equal(service.mood.get().snapshot.values.O, 50);
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]), [['user', '面试又被刷了', 'complete'], ['assistant', '', 'error']]);
    assert.equal(service.memory.list(turn.scope).total, 1);
  });
});
test('a reply with a draft in front keeps the real reply, the mood and a normal archive', async () => {
  await withService(async service => {
    const shown: string[] = [];
    const turn = await service.begin('draft-then-reply', '面试又被刷了', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const start = marker(turn.persona);
    turn.push('delta', `Respond as Gene, supportive, short, no lecturing. Footer with support context.连着四次，换谁都会累的。\n${start}{"context":"support","delta":{"O":3},"confidence":0.9}${start.replace('<', '</')}`);
    await turn.finish('complete');
    assert.equal(shown.join(''), '连着四次，换谁都会累的。');
    assert.equal(turn.emptyReply?.(), false);
    assert.ok(service.mood.get().snapshot.values.O > 50);
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]), [['user', '面试又被刷了', 'complete'], ['assistant', '连着四次，换谁都会累的。', 'complete']]);
  });
});
test('the speaker label behind a wrapper tag is taken from the character card the turn was started with', async () => {
  await withService(async service => {
    const shown: string[] = [];
    const turn = await service.begin('label', '在吗', '你是桌宠。\n\n角色名称：Momo\n\n性格：慢热', (type, text) => { if (type === 'delta') shown.push(text); });
    turn.push('delta', '<transcript_image>\nMomo：嗯……我在。'); await turn.finish('complete');
    assert.equal(shown.join(''), '嗯……我在。');
  });
});
test('a reply that begins with her own name is not held: the first chunk goes out in the same push()', () => {
  for (const first of ['Momo ', 'Momo', '阿棠', 'Mo']) {
    const increments: string[] = [];
    const protocol = new MoodReplyProtocol(text => increments.push(text), { speakers: first.startsWith('Mo') ? ['Momo'] : ['阿棠'] });
    protocol.push(first);
    assert.equal(increments.join(''), first, JSON.stringify(first));
  }
});

test('an emptied reply is answered in her own words through the same notice as any failed chat, without making chat unavailable', () => {
  const availability = new ChatAvailability({ line: kind => (kind === 'other' ? '唔，我刚刚走神了，你再说一遍好不好？' : null), cardKey: () => 'gene' });
  const failure = availability.quietFailure(new Error('这条回复被过滤后是空的，已丢弃。'));
  const notice = availability.notice(failure);
  assert.deepEqual(notice, { kind: 'other', speak: true, line: '唔，我刚刚走神了，你再说一遍好不好？' });
  assert.equal(availability.view().state, 'ok');
  assert.equal(availability.isAvailable(), true);
  assert.equal(availability.notice(availability.quietFailure(new Error('again')))?.speak, false, 'said once until chat works again');
  availability.success();
  assert.equal(availability.notice(availability.quietFailure(new Error('later')))?.speak, true);
});
