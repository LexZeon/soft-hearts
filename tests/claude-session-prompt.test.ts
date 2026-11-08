import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../shared/contracts';
import { buildCodexChatPrompt, buildCompanionPersona, conversationReplyInstruction } from '../electron/conversation-context';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt, planSessionTurn, sessionText, turnContext } from '../electron/claude-session-prompt';
import { CLAUDE_SYSTEM_PROMPT } from '../electron/claude';
import { ReplyLatencyProbe, type ReplyLatencyRecord } from '../electron/reply-latency';
import { companionHasHistory } from '../electron/claude-session';

const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const data = (prompt: string) => JSON.parse(prompt.split('<conversation-data>\n')[1].split('\n</conversation-data>')[0]);

test('the persistent system prompt is constant app text with the same no-tools rule', () => {
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes('你没有任何工具'));
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes('不要提及自己是 Claude Code'));
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes('以最新一条消息为准'));
  assert.notEqual(CLAUDE_SESSION_SYSTEM_PROMPT, CLAUDE_SYSTEM_PROMPT);
});

test('fixed vs per-turn: the real composed persona splits into the character persona and this turn\'s context', () => {
  const persona = '角色：小桃。温柔、爱笑。';
  const protocol = new MoodReplyProtocol(() => {});
  const memories = [{ title: '一起看海', createdAt: 0, excerpt: '上周聊过海边' }];
  const composed = buildCompanionPersona({ persona, stateContext: '当前心情：有点想念。', memories, protocolInstruction: protocol.instruction() })
    + '\n\n[外部声音资料]';
  const context = turnContext(persona, composed)!;
  assert.ok(!context.includes(persona));
  for (const part of ['当前心情：有点想念。', '无依据不编造经历', conversationReplyInstruction, protocol.start, '[外部声音资料]'])
    assert.ok(context.includes(part), part.slice(0, 20));
  assert.equal(turnContext('', composed), composed);
  assert.equal(turnContext(persona, persona), '');
  assert.equal(turnContext('别的人设', composed), null, 'unknown composition is never guessed');
});

test('opening turn is byte-for-byte today\'s prompt; follow-ups drop persona and known history but keep every per-turn rule', () => {
  const persona = '角色：小桃。';
  const composed = `${persona}\n\n当前心情：平静。\n\n${conversationReplyInstruction}\n\n尾注标记 n-2`;
  const history = [u('你好'), a('你好呀')];
  const opening = composeSessionPrompt({ plan: { opening: true, history }, basePersona: persona, turnPersona: composed, current: u('在吗'), profileContext: '喜欢猫' });
  assert.equal(opening, buildCodexChatPrompt(composed, [...history, u('在吗')], '喜欢猫'));
  const followUp = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: persona, turnPersona: composed, current: u('在吗'), profileContext: '喜欢猫' });
  assert.ok(followUp.startsWith(CLAUDE_FOLLOW_UP_HEADER));
  assert.ok(!followUp.includes(persona));
  for (const part of ['当前心情：平静。', conversationReplyInstruction, '尾注标记 n-2', '喜欢猫', '只回应currentUser'])
    assert.ok(followUp.includes(part), part.slice(0, 20));
  assert.deepEqual(data(followUp), { history: [], currentUser: '在吗' });
  const unknown = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: '别的', turnPersona: composed, current: u('在吗') });
  assert.ok(unknown.includes(persona), 'an unrecognised composition repeats the whole persona');
});

test('planning lines the renderer window up with what Claude already knows', () => {
  assert.deepEqual(planSessionTurn(null, [u('a')]), { opening: true, history: [u('a')] });
  assert.deepEqual(planSessionTurn([], [u('a')]), { opening: true, history: [u('a')] });
  const known = [u('一'), a('回一'), u('二'), a('回二')];
  assert.deepEqual(planSessionTurn(known, known), { opening: false, history: [] });
  // The 24-message window slid forward: still lined up.
  assert.deepEqual(planSessionTurn(known, known.slice(2)), { opening: false, history: [] });
  // New messages Claude never saw (ambient comment, command receipt) are sent once.
  assert.deepEqual(planSessionTurn(known, [...known, a('[主动评论]')]), { opening: false, history: [a('[主动评论]')] });
  // The private tail and blank lines differ between what Claude wrote and what the user saw.
  const raw = [u('一'), a('回一\n<sh-state-0123abcd>{"context":"neutral"}</sh-state-0123abcd>')];
  assert.deepEqual(planSessionTurn(raw, [u('一'), a('回一')]), { opening: false, history: [] });
  // Diverged: cleared, edited, or the last known message is missing.
  assert.equal(planSessionTurn(known, []), null);
  assert.equal(planSessionTurn(known, [u('一'), a('回一'), u('二改过'), a('回二')]), null);
  assert.equal(planSessionTurn([...known, u('被打断且没有文字')], known), null);
  // Repeated short messages still align on the longest overlap.
  const repeated = [u('嗯'), a('好'), u('嗯'), a('好')];
  assert.deepEqual(planSessionTurn(repeated, [u('嗯'), a('好'), u('嗯'), a('好'), u('新')]), { opening: false, history: [u('新')] });
  assert.equal(sessionText('  正文\n<sh-memorial-ab12>{}</sh-memorial-ab12>'), '正文');
  // R28: the reply protocol drops a leading run of <br>; what Claude wrote still lines up with what the user saw.
  const broken = [u('无聊'), a('<br>\n<br>好呀。\n<sh-state-0a>{"context":"neutral"}</sh-state-0a>')];
  assert.deepEqual(planSessionTurn(broken, [u('无聊'), a('好呀。'), u('嗯')]), { opening: false, history: [u('嗯')] });
  assert.deepEqual(planSessionTurn([u('无聊'), a('<br>\n<br>')], [u('无聊'), a(''), u('嗯')]), { opening: false, history: [u('嗯')] });
  assert.equal(sessionText('好<br>呀'), '好<br>呀');
});

test('X-087: only Claude\'s own private tail is ignored; a user message that quotes a marker is compared exactly', () => {
  // The user typed something marker-shaped; the text after it differs between the two windows.
  const known = [u('看看这个 <sh-state-ab12>甲方案'), a('好的。')];
  assert.equal(planSessionTurn(known, [u('看看这个 <sh-state-ab12>乙方案'), a('好的。')]), null,
    'a different user message is a divergence, not "already known"');
  assert.deepEqual(planSessionTurn(known, [...known, u('继续')]), { opening: false, history: [u('继续')] });
  // Claude's tail on its own reply is still dropped before comparing.
  const raw = [u('嗨'), a('嗨～\n<sh-state-0a>{"context":"neutral"}</sh-state-0a>')];
  assert.deepEqual(planSessionTurn(raw, [u('嗨'), a('嗨～')]), { opening: false, history: [] });
});

test('latency log gains cold/warm Claude first-delta timing only when a transport reports it, never text', () => {
  let now = 0;
  const lines: string[] = [];
  const probe = new ReplyLatencyProbe({ enabled: () => true, file: () => null, now: () => now, wallNow: () => 1_800_000_000_000, log: line => lines.push(line),
    timers: { set: callback => { callback(); return 0; }, clear: () => {} } });
  const timing = probe.claudeTiming();
  probe.begin('r1', 'claude', 1_800_000_000_000 - 30);
  now = 20; timing.dispatched('r1', { mode: 'persistent', process: 'warm', sessionTurn: 3 });
  timing.dispatched('other', { mode: 'per-message', process: 'cold', sessionTurn: 0 });
  now = 700; timing.firstDelta('r1'); probe.delta('r1', '你好');
  now = 900; timing.firstDelta('r1');
  probe.complete('r1'); probe.end('r1', false);
  probe.begin('r2', 'claude');
  probe.end('r2', true);
  const [first, second] = lines.map(line => JSON.parse(line) as ReplyLatencyRecord);
  assert.deepEqual(first.claude, { mode: 'persistent', process: 'warm', sessionTurn: 3, dispatchMs: 50, firstDeltaMs: 730 });
  assert.equal(second.claude, undefined, 'no transport, no claude field');
  assert.doesNotMatch(lines.join('\n'), /你好|r1|r2/u);
});

test('pre-warming asks the archive only whether this character has any saved chat', () => {
  const scope = { characterId: 'c', providerScope: 'p' };
  assert.equal(companionHasHistory({ currentScope: () => scope, memory: { list: () => ({ total: 2 }) } }), true);
  assert.equal(companionHasHistory({ currentScope: () => scope, memory: { list: () => ({ total: 0 }) } }), false);
  assert.equal(companionHasHistory({ currentScope: () => { throw Error('switching'); }, memory: { list: () => ({ total: 2 }) } }), false);
  assert.equal(companionHasHistory(undefined), false);
});
