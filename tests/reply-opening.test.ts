// I-046 只放行开头标记之后的话 (electron/reply-opening.ts, docs/claude/2026-11-07-draft-leak-envelope-plan.md). Synthetic replies only:
// the shapes below are made up after the structure of the 2026-11-07 leak (a Chinese plan with no fixed opening, the tail's fields,
// a memorial proposal's fields, a drafted "正文：", English self-talk), never a real chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { APP_REPLY_OPENING, FIXED_OPENING_MARKER, OPENING_CODE_CHARS, OPENING_SYSTEM_SENTENCE, OpeningGate, REPLY_OPENING_ENABLED, internalWords, openingCut, openingMarker, openingSentence, type OpeningMode } from '../electron/reply-opening';
import { claudeSessionSystemPrompt, sessionText } from '../electron/claude-session-prompt';
import { claudeChatSystemPrompt } from '../electron/claude';
import { CompanionService } from '../electron/companion';
import { replyCheckInput } from '../electron/journal/extras';
import { buildJournalEntry, describeJournalEntry, readJournalLine, type JournalEntry } from '../shared/journal';
import { ENGLISH_JOURNAL_UI_COPY } from '../shared/ui-copy.journal.en';
import { replay } from '../scripts/lib/prompt-eval-analysis';

const PLAN = '这轮用户在接梗，我顺着“马上就好”那个梗说。尾注填 positive，delta 给 O 加一点。纪念提议：quote 用“下雨天互道晚安要说两遍”，purpose 写留作纪念，invite 问要不要记下来。\n'
  + '正文：好呀，那我先记着。\nKeep it short, playful, no lecturing.\n';
const REPLY = '哈哈，又是“马上就好”！上次你说完这句，我可是等了整整一个小时呢～\n\n下次可不许再骗我了。';
/** A plan with none of the protocol's words: only the marker can tell it from the reply. */
const PLAIN_PLAN = '这一句先接住他的玩笑，再轻轻戳他一下，语气要软一点，别太长。';
const TAIL = '{"context":"positive","delta":{"O":2},"reason":"接梗","confidence":0.9,"gesture":"upbeat"}';

type Chunking = (text: string) => string[];
const sizes = (size: number): Chunking => text => { const out: string[] = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
const seeded = (seed: number): Chunking => text => {
  let state = seed; const out: string[] = [];
  for (let i = 0; i < text.length;) { state = (state * 1103515245 + 12345) % 2147483648; const n = 1 + (state % 9); out.push(text.slice(i, i + n)); i += n; }
  return out;
};
const CHUNKINGS: Array<[string, Chunking]> = [['whole', text => [text]], ['by char', sizes(1)], ['by 2', sizes(2)], ['by 3', sizes(3)],
  ['random 1', seeded(1)], ['random 7', seeded(7)], ['random 42', seeded(42)], ['random 2026', seeded(2026)]];

interface Played { shown: string; increments: Array<{ push: number; text: string }>; protocol: MoodReplyProtocol; appraisal: ReturnType<MoodReplyProtocol['finish']> }
/** Runs `raw(protocol)` through a protocol with the opening marker on, cut by `chunking`. */
function play(raw: (protocol: MoodReplyProtocol) => string, chunking: Chunking, options: { opening?: boolean | OpeningMode; userText?: string; family?: boolean } = {}): Played {
  const increments: Array<{ push: number; text: string }> = [];
  let push = 0;
  const protocol = new MoodReplyProtocol(text => { if (text) increments.push({ push, text }); },
    { chineseChat: true, ...(options.family !== false ? { settingProposal: { instruction: null } } : {}), ...(options.opening !== false ? { opening: options.opening ?? true } : {}), userText: options.userText ?? '接着那个梗说' });
  for (const piece of chunking(raw(protocol))) { protocol.push(piece); push++; }
  const appraisal = protocol.finish(true);
  return { shown: increments.map(item => item.text).join(''), increments, protocol, appraisal };
}
const tail = (protocol: MoodReplyProtocol) => `${protocol.start}${TAIL}${protocol.end}`;

test('the switch is off for the app (the first-character A/B did not clear 150 ms); the marker is this turn\'s code, from the tail\'s nonce', () => {
  assert.equal(REPLY_OPENING_ENABLED, false);
  assert.equal(APP_REPLY_OPENING, false);
  const protocol = new MoodReplyProtocol(() => {}, { opening: true });
  const nonce = /^<sh-state-([a-f0-9]{32})>$/u.exec(protocol.start)![1];
  assert.equal(protocol.open, `<sh-open-${nonce.slice(0, OPENING_CODE_CHARS)}>`);
  assert.equal(protocol.open, openingMarker(nonce));
  assert.notEqual(new MoodReplyProtocol(() => {}, { opening: true }).open, protocol.open, 'every turn has its own');
});

test('the protocol text: one sentence in place of "先正常回复用户。", nothing else changes, and no letter words', () => {
  const on = new MoodReplyProtocol(() => {}, { opening: true }), off = new MoodReplyProtocol(() => {});
  const norm = (text: string) => text.replace(/[a-f0-9]{32}|[a-f0-9]{8}(?=>)/gu, 'N');
  assert.ok(off.instruction().startsWith('先正常回复用户。'));
  assert.ok(on.instruction().startsWith(openingSentence(on.open)), 'the opening sentence leads');
  assert.equal(norm(on.instruction()).replace(norm(openingSentence(on.open)), ''), norm(off.instruction()).replace('先正常回复用户。', ''));
  assert.ok(on.instruction().includes(on.open));
  // 22:5x: her way of speaking must not change, so the text never says letter or envelope.
  for (const word of ['信', '封', 'letter', 'envelope', '书信', '落款']) assert.ok(!on.instruction().includes(word), word);
  // Memorial and settings turns keep their own text after it.
  const memorial = new MoodReplyProtocol(() => {}, { opening: true, textMemorial: { userText: '下雨天互道晚安要说两遍', persona: 'p', mood: 'm', context: 'c' } });
  assert.ok(memorial.instruction().startsWith(openingSentence(memorial.open)) && memorial.instruction().includes('<sh-memorial-'));
});

test('fixed mode: one marker named once by the fixed system prompts; the turn text is exactly the old one', () => {
  const fixed = new MoodReplyProtocol(() => {}, { opening: 'fixed' }), off = new MoodReplyProtocol(() => {});
  assert.equal(fixed.open, FIXED_OPENING_MARKER);
  const norm = (text: string) => text.replace(/[a-f0-9]{32}/gu, 'N');
  assert.equal(norm(fixed.instruction()), norm(off.instruction()), 'the turn text does not change');
  assert.ok(claudeSessionSystemPrompt({ opening: true }).includes(OPENING_SYSTEM_SENTENCE));
  assert.ok(!claudeSessionSystemPrompt({ opening: false }).includes('<sh-open'));
  assert.ok(claudeChatSystemPrompt({ opening: true }).includes(OPENING_SYSTEM_SENTENCE), 'the per-message path says the same');
  assert.equal(claudeSessionSystemPrompt().includes(OPENING_SYSTEM_SENTENCE), APP_REPLY_OPENING === 'fixed', 'the app default follows the switch');
  for (const word of ['信', '封', 'letter', 'envelope']) assert.ok(!OPENING_SYSTEM_SENTENCE.includes(word), word);
  for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `${PLAN}${protocol.open}${REPLY}\n${tail(protocol)}`, chunking, { opening: 'fixed' });
    assert.equal(played.shown, REPLY, name);
    assert.equal(played.protocol.replyCheck()!.marker, 'ok', name);
    const coded = play(protocol => `${PLAN}<sh-open-0123abcd>${REPLY}\n${tail(protocol)}`, chunking, { opening: 'fixed' });
    assert.equal(coded.shown, REPLY, name);
    assert.equal(coded.protocol.replyCheck()!.marker, 'foreign', `a coded marker is not this one, ${name}`);
  }
  assert.equal(sessionText(`${PLAN}<sh-open>${REPLY}`), REPLY.trim());
});

test('a plan in front of the marker is never shown, read or archived, however the stream is cut; the reply streams from the marker', () => {
  for (const plan of [PLAN, PLAIN_PLAN, PLAN + PLAIN_PLAN + '\n']) for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `${plan}${protocol.open}${REPLY}\n${tail(protocol)}`, chunking);
    const where = `${name}: ${plan.slice(0, 8)}`;
    assert.equal(played.shown, REPLY, where);
    assert.equal(played.appraisal?.context, 'positive', `the tail still counts, ${where}`);
    assert.deepEqual(played.protocol.draftDrops().map(drop => drop.kind), ['before-open'], where);
    assert.equal(played.protocol.draftDrops()[0].chars, plan.trim().length, where);
    assert.equal(played.protocol.emptiedByFilter(), false, where);
    const check = played.protocol.replyCheck()!;
    assert.deepEqual([check.marker, check.before, check.residue], ['ok', plan.trim().length, []], where);
  }
});

test('the first character after the marker goes out in the same push as the marker\'s end (no waiting for more)', () => {
  const protocol = new MoodReplyProtocol(text => shown.push(text), { opening: true, chineseChat: true, settingProposal: { instruction: null } });
  const shown: string[] = [];
  protocol.push(PLAIN_PLAN);
  assert.deepEqual(shown, [], 'nothing before the marker');
  protocol.push(protocol.open.slice(0, 5));
  protocol.push(protocol.open.slice(5) + '哈');
  assert.deepEqual(shown, ['哈'], 'the first character with the marker\'s last part');
  protocol.push('哈，又被你骗了');
  assert.equal(shown.join(''), '哈哈，又被你骗了');
});

test('blanks and line breaks right after the marker are not part of the reply; a leading <br> run still goes', () => {
  for (const [name, chunking] of CHUNKINGS) {
    assert.equal(play(protocol => `${protocol.open}\n\n  ${REPLY}\n${tail(protocol)}`, chunking).shown, REPLY, name);
    assert.equal(play(protocol => `${protocol.open}<br>\n<br>${REPLY}\n${tail(protocol)}`, chunking).shown, REPLY, name);
  }
});

test('an older turn\'s marker or one she made up does not count: nothing shows until her words are complete, never the marker', () => {
  const other = new MoodReplyProtocol(() => {}, { opening: true }).open;
  for (const fake of [other, '<sh-open-12345678>', '<sh-open-abc>']) for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `${PLAN}${fake}${REPLY}\n${tail(protocol)}`, chunking);
    const where = `${name}: ${fake}`;
    assert.ok(!played.shown.includes('sh-open'), where);
    assert.equal(played.shown, REPLY, `the protocol words and the marker cut what was in front, ${where}`);
    const pushes = chunking(`${PLAN}${fake}${REPLY}\n`).length;
    assert.ok(played.increments.every(item => item.push >= pushes - 1), `nothing went out before the tail began, ${where}`);
    const check = played.protocol.replyCheck()!;
    assert.equal(check.marker, 'foreign', where);
    assert.ok(check.rules.includes('marker'), where);
  }
  // Without any protocol word in front, a foreign marker still never shows; the plain plan in front of it is not this turn's business.
  const plain = play(protocol => `${PLAIN_PLAN}<sh-open-12345678>${REPLY}\n${tail(protocol)}`, sizes(3));
  assert.equal(plain.shown, REPLY);
});

test('no marker at all: held until the tail begins, then shown as before; an ordinary reply is byte for byte the old one', () => {
  const ordinary = ['嗯，我在呢。今天过得怎么样？', '哈哈，你又来了～\n\n不过我喜欢。', '（揉了揉眼睛）……这么晚还不睡呀？', 'OK，那就这么定了！'];
  for (const text of ordinary) for (const [name, chunking] of CHUNKINGS) {
    const on = play(protocol => `${text}\n${tail(protocol)}`, chunking);
    const off = play(protocol => `${text}\n${tail(protocol)}`, chunking, { opening: false });
    assert.equal(on.shown, off.shown, `${name}: ${text}`);
    assert.deepEqual(on.protocol.draftDrops(), off.protocol.draftDrops(), `${name}: ${text}`);
    assert.equal(on.appraisal?.context, 'positive');
    assert.equal(on.protocol.replyCheck()!.marker, 'missing');
    assert.ok(on.increments.every(item => item.push >= chunking(`${text}\n`).length - 1), `held to the tail, ${name}`);
  }
  // And with no tail at all (the stream just ended), at finish().
  const ended = play(() => '嗯，我在呢。', sizes(2));
  assert.equal(ended.shown, '嗯，我在呢。');
  assert.equal(ended.protocol.replyCheck()!.marker, 'missing');
});

test('no marker, with a plan that uses the protocol\'s own words: only her reply after it is left (the 2026-11-07 shape)', () => {
  for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `${PLAN}${REPLY}\n${tail(protocol)}`, chunking);
    assert.equal(played.shown, REPLY, name);
    const check = played.protocol.replyCheck()!;
    assert.equal(check.marker, 'missing');
    assert.deepEqual(check.rules, ['body-label', 'tail-word', 'memorial-field', 'english-line']);
    assert.deepEqual(check.residue, []);
    assert.ok(played.protocol.draftDrops().some(drop => drop.kind === 'internal-words'));
  }
  // A drafted "正文：" as the last thing she wrote is the reply itself.
  assert.equal(play(protocol => `尾注填 support。\n正文：先别急，慢慢来。\n${tail(protocol)}`, sizes(4)).shown, '先别急，慢慢来。');
  // Protocol words behind the reply go, the reply stays.
  assert.equal(play(protocol => `${REPLY}\n（尾注：context 用 positive）\n${tail(protocol)}`, sizes(5)).shown, REPLY);
  // Nothing but plan: an emptied reply (the host says one short line of her own, F4).
  const empty = play(protocol => `尾注填 support，gesture: consider。\n${tail(protocol)}`, sizes(3));
  assert.equal(empty.shown, '');
  assert.equal(empty.protocol.emptiedByFilter(), true);
});

test('a protocol word the user wrote too does not count (she may talk about the 尾注 of a thesis)', () => {
  const answer = '尾注的话，一般放在全文最后，按出现顺序编号就好。';
  const played = play(protocol => `${answer}\n${tail(protocol)}`, sizes(3), { userText: '论文的尾注应该放哪里？' });
  assert.equal(played.shown, answer);
  assert.deepEqual(played.protocol.replyCheck()!.residue, []);
  assert.deepEqual(internalWords(answer, '论文的尾注应该放哪里？'), []);
  assert.deepEqual(internalWords(answer, '在吗'), ['tail-word']);
});

test('the marker in the middle of her words: what came before it is dropped, the rest is the reply', () => {
  for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `嗯……让我想想。${protocol.open}${REPLY}\n${tail(protocol)}`, chunking);
    assert.equal(played.shown, REPLY, name);
    assert.equal(played.protocol.replyCheck()!.before, '嗯……让我想想。'.length);
  }
});

test('the marker written after her reply (nothing behind it): handled like a forgotten one, her reply is kept', () => {
  for (const [name, chunking] of CHUNKINGS) {
    const played = play(protocol => `${REPLY}\n${protocol.open}\n${tail(protocol)}`, chunking);
    assert.equal(played.shown, REPLY, name);
    assert.equal(played.protocol.replyCheck()!.marker, 'empty');
    assert.equal(played.appraisal?.context, 'positive', name);
    // A plan in front of her reply goes, her reply is never swallowed (22:5x).
    const plan = play(protocol => `${PLAN}${REPLY}${protocol.open}${tail(protocol)}`, chunking);
    assert.equal(plan.shown, REPLY, `with a plan in front, ${name}`);
  }
  // The stream ends right after the marker.
  assert.equal(play(protocol => `${REPLY}${protocol.open}`, sizes(3)).shown, REPLY);
});

test('this turn\'s marker written again, or closed, inside the reply is never shown', () => {
  for (const [name, chunking] of CHUNKINGS) {
    const closed = play(protocol => `${protocol.open}${REPLY}${protocol.open.replace('<', '</')}\n${tail(protocol)}`, chunking);
    assert.equal(closed.shown, REPLY, `closed, ${name}`);
    const again = play(protocol => `${protocol.open}哈哈。${protocol.open}${REPLY}\n${tail(protocol)}`, chunking);
    assert.equal(again.shown, `哈哈。${REPLY}`, `again, ${name}`);
  }
  // A lone "<" at the end of the reply is ordinary text.
  assert.equal(play(protocol => `${protocol.open}1 < 2，2 <`, sizes(1)).shown, '1 < 2，2 <');
});

test('nothing after the marker: the words in front of it are judged like a forgotten marker\'s (the cut, then the head filter as before)', () => {
  for (const [name, chunking] of CHUNKINGS) {
    // A plan with none of the protocol's words: exactly what the protocol without the marker would show for it.
    const played = play(protocol => `${PLAIN_PLAN}${protocol.open}\n${tail(protocol)}`, chunking);
    const before = play(protocol => `${PLAIN_PLAN}\n${tail(protocol)}`, chunking, { opening: false });
    assert.equal(played.protocol.replyCheck()!.marker, 'empty', name);
    assert.equal(played.shown, before.shown, name);
    // A plan with them and nothing of hers behind it but its drafted "正文：": the draft is what she meant to say; none of the plan
    // (its plain first sentence, its fields, its English line) reaches the window.
    const planned = play(protocol => `${PLAN}${protocol.open}${tail(protocol)}`, chunking);
    assert.equal(planned.shown, '好呀，那我先记着。', name);
    // Nothing of hers at all: an emptied reply (she says a short line of her own, F4).
    const bare = play(protocol => `这轮用户在接梗，我顺着那个梗说。尾注填 positive。\nKeep it short, playful.\n${protocol.open}${tail(protocol)}`, chunking);
    assert.equal(bare.shown, '', `${name}: ${bare.shown}`);
    assert.equal(bare.protocol.emptiedByFilter(), true, name);
  }
});

test('a turn stopped, superseded or failed before the marker shows nothing it held; after the marker, what came after it', () => {
  for (const held of [PLAIN_PLAN, PLAN, `${REPLY}`]) {
    let shown = '';
    const protocol = new MoodReplyProtocol(text => { shown += text; }, { opening: true, chineseChat: true, settingProposal: { instruction: null } });
    protocol.push(held);
    assert.equal(protocol.finish(false), null);
    assert.equal(shown, '', held.slice(0, 8));
    assert.equal(protocol.emptiedByFilter(), false, 'a stopped turn is not an emptied reply');
  }
  let shown = '';
  const protocol = new MoodReplyProtocol(text => { shown += text; }, { opening: true, chineseChat: true, settingProposal: { instruction: null } });
  protocol.push(`${PLAN}${protocol.open}哈哈，又是`);
  protocol.finish(false);
  assert.equal(shown, '哈哈，又是');
  let marked = '';
  const right = new MoodReplyProtocol(text => { marked += text; }, { opening: true, chineseChat: true });
  right.push(`${PLAN}${right.open}`);
  right.finish(false);
  assert.equal(marked, '', 'the marker came, nothing after it yet');
});

test('without the marker option nothing changes (the protocol the older tests cover)', () => {
  const played = play(protocol => `${PLAN}${REPLY}\n${tail(protocol)}`, sizes(3), { opening: false });
  assert.ok(played.shown.includes('纪念提议'), 'the old filter alone lets this shape through: the reason for I-046');
  // Only the check of what was shown runs: it names what is left, it changes nothing.
  const check = played.protocol.replyCheck()!;
  assert.equal(check.marker, 'off');
  assert.ok(check.residue.includes('memorial-field') && check.residue.includes('body-label'));
});

test('settings and memorial turns (any private marker hides the rest) keep working behind the marker', () => {
  const memorial = new MoodReplyProtocol(() => {}, { opening: true, textMemorial: { userText: '下雨天互道晚安要说两遍', persona: 'p', mood: 'm', context: 'c' } });
  let shown = '';
  const protocol = new MoodReplyProtocol(text => { shown += text; }, { opening: true, textMemorial: { userText: '下雨天互道晚安要说两遍', persona: 'p', mood: 'm', context: 'c' } });
  const memorialStart = protocol.start.replace('state', 'memorial'), memorialEnd = protocol.end.replace('state', 'memorial');
  for (const piece of sizes(4)(`${PLAN}${protocol.open}${REPLY}\n${tail(protocol)}${memorialStart}{"quote":"下雨天互道晚安要说两遍","purpose":"留作纪念","invite":"“下雨天互道晚安要说两遍”这句，要留作纪念吗？"}${memorialEnd}`)) protocol.push(piece);
  assert.equal(protocol.finish(true)?.context, 'positive');
  assert.equal(shown, REPLY);
  assert.ok(protocol.textMemorialProposal()?.includes('留作纪念'));
  assert.ok(memorial.instruction().includes(memorial.open));
});

test('the gate alone: release() hands what it holds to the tail; finish() never leaves a marker fragment', () => {
  const marker = '<sh-open-0123abcd>';
  const gate = new OpeningGate({ marker, tailAt: text => text.indexOf('<sh-state-x>'), mayBeTail: text => '<sh-state-x>'.startsWith(text) });
  assert.equal(gate.push('计划'), '');
  assert.equal(gate.push(marker + '好'), '好');
  assert.equal(gate.push('呀<sh-op'), '呀');
  assert.equal(gate.release(), '<sh-op', 'held text goes to the tail as written');
  assert.equal(gate.push('en-0123abcd>'), 'en-0123abcd>', 'after release everything passes');
  const cut = new OpeningGate({ marker, tailAt: () => -1, mayBeTail: () => false });
  cut.push(marker + '好呀<sh-op');
  assert.equal(cut.finish(), '', 'a cut-off marker at the very end is dropped');
});

test('openingCut: unchanged without protocol words; the last clean stretch otherwise', () => {
  assert.deepEqual(openingCut('嗯，我在呢。'), { text: '嗯，我在呢。', chars: 0, rules: [] });
  // The cut alone leaves the English line behind the drafted "正文：" line; the head filter then drops it (the protocol test above).
  assert.equal(openingCut(`${PLAN}${REPLY}`).text, `Keep it short, playful, no lecturing.\n${REPLY}`);
  assert.equal(openingCut(`尾注填 positive，gesture: upbeat。\n${REPLY}`).text, REPLY);
  assert.deepEqual(openingCut(`尾注填 positive，gesture: upbeat。\n${REPLY}`).rules, ['tail-word', 'field-name']);
  assert.equal(openingCut('<sh-open-12345678>好呀！').text, '好呀！');
  assert.equal(openingCut('context: support\ngesture: consider\n').text, '');
  assert.deepEqual(openingCut('quote：下雨天\n好的。').rules, ['memorial-field']);
});

test('the session record drops what was in front of the marker and the marker, so the next turn lines up', () => {
  assert.equal(sessionText(`${PLAN}<sh-open-0123abcd>${REPLY}\n<sh-state-0123abcd>{}</sh-state-0123abcd>`), REPLY.trim());
  assert.equal(sessionText(`<sh-open-0123abcd>好呀</sh-open-0123abcd>`), '好呀');
  assert.equal(sessionText('好呀<sh-state-0a>{}'), '好呀', 'unchanged without a marker');
});

test('the journal line: closed names and numbers only, written only when something was off', () => {
  assert.equal(replyCheckInput('gene', null, false), null);
  assert.equal(replyCheckInput('gene', { marker: 'ok', before: 0, cut: 0, rules: [], residue: [] }, false), null, 'an ordinary reply writes nothing');
  assert.equal(replyCheckInput('gene', { marker: 'off', before: 0, cut: 0, rules: [], residue: [] }, false), null, 'nor one with the marker off');
  const samples = [
    { marker: 'ok' as const, before: 120, cut: 0, rules: [], residue: [] },
    { marker: 'missing' as const, before: 0, cut: 80, rules: ['tail-word' as const, 'body-label' as const], residue: [] },
    { marker: 'foreign' as const, before: 0, cut: 30, rules: ['marker' as const], residue: ['field-name' as const] },
    { marker: 'empty' as const, before: 0, cut: 0, rules: [], residue: [] },
    { marker: 'off' as const, before: 0, cut: 0, rules: [], residue: ['tail-word' as const] },
  ];
  const english = (source: string, ...values: readonly unknown[]) => (ENGLISH_JOURNAL_UI_COPY[source] ?? source).replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
  const chinese = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_m, i) => String(values[Number(i)]));
  for (const check of samples) {
    const entry = buildJournalEntry(replyCheckInput('gene', check, true, true)!, 1) as Extract<JournalEntry, { type: 'reply-check' }>;
    assert.ok(entry, check.marker);
    assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry);
    assert.equal(entry.marker, check.marker); assert.equal(entry.filled, true);
    assert.deepEqual(entry.rules, ['marker', 'body-label', 'tail-word', 'memorial-field', 'field-name'].filter(rule => (check.rules as string[]).includes(rule)));
    assert.match(describeJournalEntry(entry, chinese), /[\u4e00-\u9fff]/);
    assert.doesNotMatch(describeJournalEntry(entry, english).replace(/^\d\d:\d\d /, ''), /[\u4e00-\u9fff]/, describeJournalEntry(entry, english));
  }
  assert.equal(buildJournalEntry({ type: 'reply-check', characterId: 'gene', marker: 'maybe', before: 0, cut: 0, rules: [], residue: [], whole: false }, 1), null);
  assert.equal(buildJournalEntry({ type: 'reply-check', characterId: 'gene', marker: 'ok', before: 0, cut: 0, rules: ['free text'], residue: [], whole: false }, 1), null);
  const sneaky = buildJournalEntry({ type: 'reply-check', characterId: 'gene', marker: 'missing', before: 0, cut: 3, rules: [], residue: [], whole: false, text: 'SECRET-TEXT 你好' }, 1)!;
  assert.doesNotMatch(JSON.stringify(sneaky), /SECRET-TEXT|你好/);
});

// ---------------------------------------------------------------- the host: typed chat and voice

async function withService(opening: boolean, run: (service: CompanionService, notes: Array<Record<string, unknown>>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-reply-opening-'));
  const notes: Array<Record<string, unknown>> = [];
  const service = new CompanionService(directory, () => {}, { journal: { record: (input: Record<string, unknown>) => { notes.push(input); } } as never });
  service.setDraftFill(true);
  if (opening) service.setReplyOpening(true);
  try { await service.load(); await service.context('gene', { kind: 'claude', baseUrl: 'https://opening.invalid/v1', model: 'fixture' }, '角色名称：Gene'); await run(service, notes); }
  finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('host: the turn asks for the marker; the window and the archive get only what follows it; the journal notes the drop', async () => {
  await withService(true, async (service, notes) => {
    const shown: string[] = [];
    const turn = await service.begin('open-1', '马上就好～', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const open = /<sh-open-[a-f0-9]{8}>/u.exec(turn.persona)?.[0];
    assert.ok(open, 'the persona carries this turn\'s marker');
    const start = /<sh-state-[a-f0-9]{32}>/u.exec(turn.persona)![0];
    for (const piece of sizes(5)(`${PLAN}${open}${REPLY}\n${start}${TAIL}${start.replace('<', '</')}`)) turn.push('delta', piece);
    await turn.finish('complete');
    assert.equal(shown.join(''), REPLY);
    assert.equal(turn.shownReply?.(), REPLY);
    const record = service.memory.read(turn.scope, turn.recordId, { messageLimit: 10 })!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content]), [['user', '马上就好～'], ['assistant', REPLY]]);
    assert.ok(service.mood.get().snapshot.values.O > 50, 'the tail moved her mood');
    const check = notes.find(note => note.type === 'reply-check');
    assert.deepEqual(check && [check.marker, check.before], ['ok', PLAN.trim().length]);
    assert.ok(!JSON.stringify(notes).includes('马上就好'), 'no text in the journal');
  });
});

test('host: an ordinary reply with the marker writes no check line; with the switch off the turn has no marker', async () => {
  await withService(true, async (service, notes) => {
    const turn = await service.begin('open-2', '在吗', '角色名称：Gene', () => {});
    const open = /<sh-open-[a-f0-9]{8}>/u.exec(turn.persona)![0], start = /<sh-state-[a-f0-9]{32}>/u.exec(turn.persona)![0];
    turn.push('delta', `${open}在呢。\n${start}${TAIL}${start.replace('<', '</')}`);
    await turn.finish('complete');
    assert.ok(!notes.some(note => note.type === 'reply-check'));
  });
  await withService(false, async (service, notes) => {
    const turn = await service.begin('open-3', '在吗', '角色名称：Gene', () => {});
    assert.ok(!turn.persona.includes('<sh-open-'));
    assert.ok(turn.persona.includes('先正常回复用户。'));
    // The check of what was shown runs with the marker off too: protocol words left in the reply get a line (names only).
    const start = /<sh-state-[a-f0-9]{32}>/u.exec(turn.persona)![0];
    turn.push('delta', `在呢～（尾注：positive）
${start}${TAIL}${start.replace('<', '</')}`);
    await turn.finish('complete');
    const check = notes.find(note => note.type === 'reply-check');
    assert.deepEqual(check && [check.marker, check.residue], ['off', ['tail-word']]);
  });
});

test('host: a whole plan in front of the marker and nothing behind it gets her own short line (F4), never the plan', async () => {
  await withService(true, async (service, notes) => {
    const shown: string[] = [];
    const turn = await service.begin('open-4', '马上就好～', '角色名称：Gene', (type, text) => { if (type === 'delta') shown.push(text); });
    const open = /<sh-open-[a-f0-9]{8}>/u.exec(turn.persona)![0], start = /<sh-state-[a-f0-9]{32}>/u.exec(turn.persona)![0];
    turn.push('delta', `尾注填 positive，gesture: upbeat。${open}\n${start}${TAIL}${start.replace('<', '</')}`);
    await turn.finish('complete');
    assert.ok(shown.join('').trim(), 'she says something');
    assert.ok(!shown.join('').includes('尾注'));
    const check = notes.find(note => note.type === 'reply-check');
    assert.deepEqual(check && [check.marker, check.whole, check.filled], ['empty', true, true]);
  });
});

test('host: a voice leg asks for the marker too and shows only what follows it', async () => {
  await withService(true, async service => {
    const group = await service.beginVoiceGroup('voice-open-1', '马上就好～', '角色名称：Gene');
    const shown: string[] = [];
    const leg = await group.beginLeg({ groupId: 'voice-open-1', replyId: 'r1', canonicalUserText: '马上就好～', throughSeq: 1, merged: false } as never, text => shown.push(text));
    const open = /<sh-open-[a-f0-9]{8}>/u.exec(leg.persona)?.[0];
    assert.ok(open);
    const start = /<sh-state-[a-f0-9]{32}>/u.exec(leg.persona)![0];
    for (const piece of sizes(3)(`${PLAIN_PLAN}${open}${REPLY}\n${start}${TAIL}${start.replace('<', '</')}`)) leg.push(piece);
    const done = await leg.finish('complete');
    assert.equal(shown.join(''), REPLY);
    assert.equal(done.status, 'complete');
  });
});

test('replay of a recorded turn with the marker gives what the live turn showed (the evaluation\'s own check)', () => {
  const live = new MoodReplyProtocol(() => {}, { opening: true });
  const nonce = /^<sh-state-([a-f0-9]{32})>$/u.exec(live.start)![1];
  const raw = `${PLAN}${live.open}${REPLY}${live.open.replace('<', '</')}\n${live.start}${TAIL}${live.end}`;
  const chunks: Array<[number, string]> = sizes(7)(raw).map((text, index) => [index * 10, text]);
  const replayed = replay({ chunks, nonce, settingOffered: false, error: null, user: '马上就好～', opening: true });
  assert.equal(replayed.visible, REPLY);
  assert.equal(replayed.appraisal?.context, 'positive');
  assert.ok(replayed.visibleChunks[0][0] >= chunks.findIndex(([, text]) => raw.indexOf(text) >= 0) * 10);
});
