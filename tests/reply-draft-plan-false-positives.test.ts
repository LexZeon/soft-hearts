// 2026-11-04 (docs/claude/2026-11-04-plan-filter-false-positives.md): the plan-block filter (reply-draft-guard.ts, "plan
// blocks") cut ordinary replies. Codex T-207 round 6 found these with synthetic text on 656ee87:
//   * P01–P04: a label line whose words merely mention a user and a reply ("计划：这位用户可以给对方回复一封道歉信…"), or that
//     holds inline code or a line in curly single quotes, vanished whole;
//   * P07: a plan whose label arrived alone ("笔记" + "：…") left that label as a complete, non-empty reply;
//   * P11: a reply glued to a plan line was cut away with the plan because its second sentence said "回复";
//   * P15/P17: a label line held to its end ("计划：今天先去散步") was lost when the stream ended without the private tail.
// Every sentence below is synthetic (most are the report's own); none is a recorded reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { ReplyDraftGuard } from '../electron/reply-draft-guard';
import { CompanionService } from '../electron/companion';

function chunkings(text: string): string[][] {
  const pieces = (sizes: (i: number) => number) => { const out: string[] = []; for (let i = 0, n = 0; i < text.length; n++) { const size = Math.max(1, sizes(n)); out.push(text.slice(i, i + size)); i += size; } return out; };
  let seed = 4207;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return [[text], pieces(() => 1), pieces(() => 3), pieces(() => 1 + Math.floor(random() * 7)), pieces(() => 1 + Math.floor(random() * 25)), pieces(() => 2), pieces(() => 1 + Math.floor(random() * 60))];
}
const CHUNKINGS = [0, 1, 2, 3, 4, 5, 6];
const byChunking = (chunking: number) => (text: string) => chunkings(text)[chunking];
const tail = (p: MoodReplyProtocol) => `\n${p.start}{"context":"positive","delta":{"O":1},"reason":"测试","confidence":0.9,"gesture":"none"}${p.end}`;

/** One reply through the real protocol (garbage filter, draft filter, tail) in a Chinese chat. */
function play(raw: string, stream: (text: string) => string[], options: { withTail?: boolean; allowAppraisal?: boolean } = {}) {
  const increments: string[] = [];
  const protocol = new MoodReplyProtocol(text => { increments.push(text); }, { settingProposal: { instruction: null }, chineseChat: true });
  const chunks = stream(options.withTail === false ? raw : raw + tail(protocol));
  for (const chunk of chunks) protocol.push(chunk);
  const appraisal = protocol.finish(options.allowAppraisal ?? true);
  return { shown: increments.join(''), protocol, appraisal, first: chunks[0] };
}

const PLAN = '笔记：用户今天散步了，她应该用轻一点的语气回应（short reply）。';
const PLAN_WORDS = /用户|语气|short|reply|应该/u;

// ------------------------------------------------------------------ P01–P04: ordinary label lines stay whole

const ORDINARY: Array<{ name: string; raw: string }> = [
  { name: 'P01 a plan the user asked for, about a user who replies to someone', raw: '计划：这位用户可以给对方回复一封道歉信，她明天会亲手送出去。' },
  { name: 'P02 steps about reply permissions', raw: '步骤：管理员可以修改用户的回复权限；普通账号只能查看。' },
  { name: 'P03 inline code', raw: '代码：`const reply = user.context`' },
  { name: 'P04 a line in curly single quotes', raw: '引用：‘用户可以回复她的评论，语气不必那么客气。’' },
  { name: 'P04 with the reply after the quoted line', raw: '引用：‘用户可以回复她的评论，语气不必那么客气。’\n\n这句我也觉得挺好的。' },
  { name: 'P05 corner quotes (already kept)', raw: '引用：『用户可以回复她的评论，语气不必那么客气。』' },
  { name: 'P06 a plain plan for the day (already kept)', raw: '计划：先吃饭，再散步。' },
  { name: 'a mostly-English line in inline code', raw: '命令：`git reply --user context --persona`' },
];
for (const ordinary of ORDINARY) {
  test(`plan filter, ordinary: ${ordinary.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(ordinary.raw, byChunking(chunking));
      assert.equal(played.shown, ordinary.raw, `chunking ${chunking}`);
      assert.deepEqual(played.protocol.draftDrops(), [], `no drops, chunking ${chunking}`);
      assert.equal(played.appraisal?.context, 'positive', `chunking ${chunking}`);
    }
  });
}

// What the narrower "how to answer" cue must still catch: real-looking plans that say 回复/回应 bare.
const STILL_PLANS: Array<{ name: string; raw: string; reply: string }> = [
  { name: 'the report\'s plan, the reply on the next line', raw: `${PLAN}\n嗯，我也想出去走走。`, reply: '嗯，我也想出去走走。' },
  { name: '"回复温柔些"', raw: '笔记：用户今天加班到很晚，她需要被安慰，回复温柔些。\n\n辛苦啦，先喝口热水吧。', reply: '辛苦啦，先喝口热水吧。' },
  { name: '"回应她一句就好" with an English note', raw: '想法：用户说想出去走走（walk），回应她一句就好，不要说教。\n\n好呀，我陪你。', reply: '好呀，我陪你。' },
  { name: '"简短回复。" at the end', raw: '分析：对方今天心情不好（low mood），她不想多说，简短回复。\n\n我在呢。', reply: '我在呢。' },
];
for (const plan of STILL_PLANS) {
  test(`plan filter, still a plan: ${plan.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(plan.raw, byChunking(chunking));
      const where = `chunking ${chunking}: ${JSON.stringify(played.shown)}`;
      assert.doesNotMatch(played.shown, PLAN_WORDS, where);
      assert.ok(played.shown.endsWith(plan.reply), where);
      if (/[:：]/u.test(played.first)) assert.equal(played.shown, plan.reply, where);
    }
  });
}

// ------------------------------------------------------------------ P07: only the label's first characters were shown

test('plan filter: a plan whose label arrived before its colon, and nothing else, is an emptied reply (not a complete "笔记")', () => {
  const splits = [['笔记', PLAN.slice(2)], ['笔', PLAN.slice(1)], ['笔记', '：', PLAN.slice(3)], ['笔', '记', PLAN.slice(2)]];
  // The private tail after it, whole or cut inside its marker ("\n<", "\n<s", "\n<sh-stat" + the rest), and with no tail at all.
  for (const [chunks, cut, withTail] of splits.flatMap(chunks => [[chunks, 0, true], [chunks, 2, true], [chunks, 3, true], [chunks, 9, true], [chunks, 0, false]] as const)) {
    const played = play(PLAN, text => { const rest = text.slice(PLAN.length); return [...chunks, ...(cut ? [rest.slice(0, cut), rest.slice(cut)] : rest ? [rest] : [])]; }, { withTail });
    const where = `${JSON.stringify(chunks.slice(0, 2))}, tail cut at ${cut}, ${withTail ? 'with' : 'without'} tail`;
    // Already on screen before the colon showed what follows (a first chunk goes out at once); nothing of the plan after it.
    assert.ok(played.shown.length <= 2 && '笔记'.startsWith(played.shown), `${where}: ${JSON.stringify(played.shown)}`);
    assert.equal(played.protocol.emptiedByFilter(), true, where);
    assert.ok(played.protocol.draftDrops().length >= 1, where);
  }
});
test('plan filter: the same label residue in front of a real reply is not an emptied reply', () => {
  // (The two characters stay in front of it: a first chunk goes out before anything shows that a colon follows.)
  const played = play(`${PLAN}\n嗯，我也想出去走走。`, text => ['笔记', text.slice(2)]);
  assert.equal(played.shown, '笔记嗯，我也想出去走走。');
  assert.equal(played.protocol.emptiedByFilter(), false);
  assert.equal(played.appraisal?.context, 'positive');
});
test('plan filter: an older mixed plan behind a first character shown alone ("嘘" + English plan) is an emptied reply too', () => {
  // "按" itself waits for its next chunk (it can begin "按人设"); "嘘" goes out at once.
  const played = play('嘘 by the user\'s words, keep it short and agree to play.', text => ['嘘', text.slice(1)]);
  assert.equal(played.shown, '嘘');
  assert.equal(played.protocol.emptiedByFilter(), true);
});

// ------------------------------------------------------------------ P11: a reply glued to the plan keeps its later sentences

const GLUED: Array<{ name: string; reply: string }> = [
  { name: 'P11 the second sentence says "回复"', reply: '嗯，我也想出去走走。你说的回复我看到了。' },
  { name: 'the second sentence names "对方" and is said to you', reply: '嗯，我也想出去走走。对方那么说，你也别往心里去。' },
  { name: 'the reply quotes "回应要轻一点" back', reply: '嗯，我也想出去走走。你说的“回应要轻一点”我记住啦。' },
];
for (const glued of GLUED) {
  test(`plan filter, glued reply: ${glued.name}`, () => {
    for (const chunking of CHUNKINGS) {
      const played = play(PLAN + glued.reply, byChunking(chunking));
      const where = `chunking ${chunking}: ${JSON.stringify(played.shown)}`;
      assert.ok(played.shown.endsWith(glued.reply), where);
      if (/[:：]/u.test(played.first)) assert.equal(played.shown, glued.reply, where);
      else assert.ok('笔记'.startsWith(played.shown.slice(0, played.shown.length - glued.reply.length)), where);
      assert.equal(played.protocol.emptiedByFilter(), false, where);
    }
  });
}
test('plan filter, glued reply: a plan sentence behind the reply\'s first sentence still takes the whole line', () => {
  for (const chunking of [0, 2, 4]) {
    const played = play(`${PLAN}嗯，我也想出去走走。回复要短一点，别说教。`, byChunking(chunking));
    assert.ok(played.shown.length <= 2 && '笔记'.startsWith(played.shown), `chunking ${chunking}: ${JSON.stringify(played.shown)}`);
    assert.equal(played.protocol.emptiedByFilter(), true, `chunking ${chunking}`);
  }
});

// ------------------------------------------------------------------ P15/P17: a held label line when the stream ends without its tail

test('plan filter: a label line still held when the reply ends is handed on (stopped, or finished without a tail)', () => {
  const raw = '计划：今天先去散步';
  for (const chunking of CHUNKINGS) {
    for (const allowAppraisal of [false, true]) {
      const played = play(raw, byChunking(chunking), { withTail: false, allowAppraisal });
      assert.equal(played.shown, raw, `chunking ${chunking}, ${allowAppraisal ? 'complete' : 'stopped'}`);
      assert.equal(played.protocol.emptiedByFilter(), false);
      assert.deepEqual(played.protocol.draftDrops(), []);
    }
  }
});
test('plan filter: the guard itself hands the held line on at finish()', () => {
  for (const chunks of [['计划：今天先去散步'], ['计', '划：今天先去散步'], ['计划', '：今天', '先去散步'], ['计划：', '今天先去散步']]) {
    const guard = new ReplyDraftGuard([], { chinese: true });
    let out = '';
    for (const chunk of chunks) out += guard.push(chunk);
    out += guard.finish();
    assert.equal(out, '计划：今天先去散步', JSON.stringify(chunks));
    assert.deepEqual(guard.dropped, []);
  }
});

// ------------------------------------------------------------------ the host side (the real CompanionService, its archive)

async function withService(run: (service: CompanionService) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-plan-false-positive-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://plan-false-positive.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
const marker = (persona: string) => persona.match(/<sh-state-[a-f0-9]+>/)![0];

async function chat(service: CompanionService, id: string, chunks: string[], end: { status: 'complete' | 'stopped'; withTail: boolean }) {
  const shown: string[] = [];
  const turn = await service.begin(id, '给我一个例子。', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
  const start = marker(turn.persona);
  for (const chunk of chunks) turn.push('delta', chunk);
  if (end.withTail) turn.push('delta', `\n${start}{"context":"positive","delta":{"O":2},"confidence":0.9}${start.replace('<', '</')}`);
  await turn.finish(end.status);
  const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
  const assistant = record.messages.find(message => message.role === 'assistant' && message.turnId === id)!;
  return { shown: shown.join(''), turn, archive: [assistant.content, assistant.status] };
}

test('host: an ordinary label line about a user\'s reply is shown and archived whole (P01)', async () => {
  await withService(async service => {
    const raw = '计划：这位用户可以给对方回复一封道歉信，她明天会亲手送出去。';
    const { shown, turn, archive } = await chat(service, 'p01', [raw], { status: 'complete', withTail: true });
    assert.equal(shown, raw);
    assert.deepEqual(archive, [raw, 'complete']);
    assert.equal(turn.emptyReply?.(), false);
  });
});
test('host: a held label line is archived when the reply is stopped (P15) or ends without a tail (P17)', async () => {
  await withService(async service => {
    const stopped = await chat(service, 'p15', ['计划：今天先去散步'], { status: 'stopped', withTail: false });
    assert.deepEqual(stopped.archive, ['计划：今天先去散步', 'stopped']);
    const complete = await chat(service, 'p17', ['计划：今天先去散步'], { status: 'complete', withTail: false });
    assert.equal(complete.shown, '计划：今天先去散步');
    assert.deepEqual(complete.archive, ['计划：今天先去散步', 'complete']);
    assert.equal(complete.turn.emptyReply?.(), false);
  });
});
test('host: only the label\'s first characters left of a plan (P07): the emptied-reply path, a failed archive, no mood', async () => {
  await withService(async service => {
    const { turn, archive } = await chat(service, 'p07', ['笔记', PLAN.slice(2)], { status: 'complete', withTail: true });
    assert.equal(turn.emptyReply?.(), true, 'the host answers with a line of her own');
    // The two characters went out before the colon showed what follows; they stay in the archive, which is marked failed.
    assert.deepEqual(archive, ['笔记', 'error']);
    assert.equal(turn.speechMood(), null);
    assert.equal(service.mood.get().snapshot.values.O, 50, 'the tail of an emptied reply moves no mood');
  });
});
test('host: a reply glued to the plan keeps its second sentence (P11)', async () => {
  await withService(async service => {
    const reply = '嗯，我也想出去走走。你说的回复我看到了。';
    const { shown, archive, turn } = await chat(service, 'p11', [PLAN + reply], { status: 'complete', withTail: true });
    assert.equal(shown, reply);
    assert.deepEqual(archive, [reply, 'complete']);
    assert.equal(turn.emptyReply?.(), false);
  });
});
