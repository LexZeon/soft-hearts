// 2026-11-23 the opening-marker reminder moves to the end (docs/claude/2026-11-23-opening-marker-plan.md, user "按推荐"): the one sentence
// 给用户的回复写在开头标记<sh-open>之后。 is the very last line she reads before she writes, in every turn shape; nothing else of the text changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../shared/foundation/chat';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { FIXED_TURN_REMINDER_AT, FIXED_TURN_SENTENCE, OPENING_CLOSING_SLOT, takeClosingSlot } from '../electron/brain/reply-opening';
import { buildCodexChatPrompt, buildCompanionPersona } from '../electron/brain/conversation-context';
import { composePreparedOpening, composeSessionPrompt, planSessionTurn } from '../electron/brain/claude-session-prompt';

const BASE = '角色名称：小桃。说话温柔。';
const OPENING_CONTEXT = '你们认识三天了。';
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const WINDOW = [u('早'), a('早呀。'), u('今天好冷')];
const NOW = u('你在吗');

const protocol = (reminderAt?: 'lead' | 'end', extra: object = {}) => new MoodReplyProtocol(() => {}, { opening: 'fixed', chineseChat: true, userText: NOW.content, ...(reminderAt ? { reminderAt } : {}), ...extra });
const persona = (p: MoodReplyProtocol) => buildCompanionPersona({ persona: [BASE, OPENING_CONTEXT].join('\n\n'), stateContext: '当前心情：平静。', memories: [], protocolInstruction: p.instruction() });
const nonce = (text: string) => text.replace(/[a-f0-9]{32}/gu, 'N');

test('the knob defaults to the end; the sentence is the protocol text no more', () => {
  assert.equal(FIXED_TURN_REMINDER_AT, 'end');
  const text = persona(protocol());
  assert.ok(!text.includes(FIXED_TURN_SENTENCE), 'not in the lead any more');
  assert.ok(text.includes('回复正文结束后，另起一行附加且仅附加一次内部状态尾注'));
});

test('single-block opening: the sentence is the last line, after the current user message, and nowhere else', () => {
  const prompt = buildCodexChatPrompt(persona(protocol()), [...WINDOW, NOW]);
  assert.ok(prompt.endsWith('\n</conversation-data>\n' + FIXED_TURN_SENTENCE), 'last line');
  assert.equal(prompt.split(FIXED_TURN_SENTENCE).length - 1, 1, 'once');
  assert.ok(!prompt.includes('<sh-closing-slot>'), 'the slot never reaches her');
  assert.ok(prompt.indexOf(JSON.stringify(NOW.content)) < prompt.lastIndexOf(FIXED_TURN_SENTENCE), 'after the user message');
});

test('byte for byte: the end form is the lead form with the sentence moved, nothing else', () => {
  const end = buildCodexChatPrompt(persona(protocol('end')), [...WINDOW, NOW]);
  const lead = buildCodexChatPrompt(persona(protocol('lead')), [...WINDOW, NOW]);
  assert.ok(lead.includes(FIXED_TURN_SENTENCE + '回复正文结束后，'));
  assert.ok(!lead.includes(OPENING_CLOSING_SLOT) && !lead.endsWith(FIXED_TURN_SENTENCE), 'lead: as before the move');
  // Same text up to the nonces; the move is the only difference.
  assert.equal(nonce(end), nonce(lead).replace(FIXED_TURN_SENTENCE, '') + '\n' + FIXED_TURN_SENTENCE);
});

test("the 'lead' knob restores the old text exactly: no slot, the sentence leads the protocol text, the prompt does not end with it", () => {
  const lead = protocol('lead');
  assert.ok(lead.instruction().startsWith(FIXED_TURN_SENTENCE) && !lead.instruction().includes('<sh-closing-slot>'));
  const text = persona(lead);
  assert.equal(takeClosingSlot(text).closing, '');
  assert.equal(buildCodexChatPrompt(text, [...WINDOW, NOW]).includes(FIXED_TURN_SENTENCE), true);
  assert.ok(!buildCodexChatPrompt(text, [...WINDOW, NOW]).endsWith(FIXED_TURN_SENTENCE));
});

test('follow-up turn (a warm session): ends with the sentence, which is not in the lead', () => {
  const turn = persona(protocol());
  const known = [...WINDOW.slice(0, 2)];
  const plan = planSessionTurn(known, [...WINDOW, NOW])!;
  assert.equal(plan.opening, false);
  const prompt = composeSessionPrompt({ plan, basePersona: [BASE, OPENING_CONTEXT].join('\n\n'), turnPersona: turn, openingContext: null, current: NOW });
  assert.ok(prompt.endsWith('\n</conversation-data>\n' + FIXED_TURN_SENTENCE));
  assert.equal(prompt.split(FIXED_TURN_SENTENCE).length - 1, 1);
});

test('opening turn through composeSessionPrompt: same ending', () => {
  const plan = planSessionTurn(null, [...WINDOW, NOW])!;
  assert.equal(plan.opening, true);
  const prompt = composeSessionPrompt({ plan, basePersona: BASE, turnPersona: persona(protocol()), openingContext: OPENING_CONTEXT, current: NOW });
  assert.ok(prompt.endsWith('\n</conversation-data>\n' + FIXED_TURN_SENTENCE));
});

test('prepared two-block first turn (I-134): block 1 (the cached opening) holds no sentence; block 2 ends with it', () => {
  const preparedOpening = composePreparedOpening({ basePersona: BASE, openingContext: OPENING_CONTEXT, history: WINDOW.slice(0, 2) });
  assert.ok(!preparedOpening.includes(FIXED_TURN_SENTENCE) && !preparedOpening.includes('<sh-closing-slot>'));
  const plan = { opening: false, history: [WINDOW[2]] };
  const second = composeSessionPrompt({ plan, basePersona: BASE, turnPersona: persona(protocol()), openingContext: OPENING_CONTEXT, current: NOW });
  assert.ok(second.endsWith('\n</conversation-data>\n' + FIXED_TURN_SENTENCE));
});

test('memorial and settings turns keep their own text, with the sentence last of all', () => {
  const memorial = protocol('end', { textMemorial: { userText: '下雨天互道晚安要说两遍', persona: 'p', mood: 'm', context: 'c' } });
  const prompt = buildCodexChatPrompt(persona(memorial), [...WINDOW, NOW]);
  assert.ok(prompt.includes('<memorial-data>') && prompt.endsWith('\n' + FIXED_TURN_SENTENCE));
  const withSetting = protocol('end', { settingProposal: { instruction: (s: string, e: string) => `S${s}${e}` } });
  assert.ok(buildCodexChatPrompt(persona(withSetting), [...WINDOW, NOW]).endsWith('\n' + FIXED_TURN_SENTENCE));
});

test('speak-only turns and the turn mode stay as they are (no slot, no closing line)', () => {
  const speak = protocol('end', { speakOnly: true });
  assert.ok(!speak.instruction().includes('<sh-closing-slot>'));
  assert.ok(!buildCodexChatPrompt(persona(speak), [...WINDOW, NOW]).includes(FIXED_TURN_SENTENCE));
  const turnMode = new MoodReplyProtocol(() => {}, { opening: 'turn' });
  assert.ok(!turnMode.instruction().includes('<sh-closing-slot>') && turnMode.instruction().startsWith('给用户的回复写在本轮开头标记'));
  const none = new MoodReplyProtocol(() => {});
  assert.ok(none.instruction().startsWith('先正常回复用户。') && !none.instruction().includes('<sh-closing-slot>'));
});

test('prefix caching does not get worse: two turns of one conversation share at least as long a prefix as before', () => {
  const commonPrefix = (x: string, y: string) => { let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };
  const turn = (reminderAt: 'lead' | 'end', current: string) => {
    const p = new MoodReplyProtocol(() => {}, { opening: 'fixed', chineseChat: true, userText: current, reminderAt });
    // The nonce differs per turn in the real app; the state tail's nonce is replaced so only the layout is compared.
    return nonce(buildCodexChatPrompt(persona(p), [...WINDOW, u(current)]));
  };
  const shared = (reminderAt: 'lead' | 'end') => commonPrefix(turn(reminderAt, '你在吗'), turn(reminderAt, '今晚吃什么'));
  assert.ok(shared('end') >= shared('lead') - FIXED_TURN_SENTENCE.length, 'the moved line is behind everything that two turns share');
  // And the line itself sits after the conversation data, so it is never inside a part another turn could have cached.
  assert.ok(turn('end', '你在吗').lastIndexOf('</conversation-data>') < turn('end', '你在吗').lastIndexOf(FIXED_TURN_SENTENCE));
});
