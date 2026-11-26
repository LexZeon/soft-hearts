/**
 * D2 / I-008: "非测试消息的提示词逐字节不变". The chat prompt builders (opening turn, follow-up turn, the fixed system prompt, the
 * per-turn persona) are pinned by hash on fixed input. The hashes were taken from the code as it was BEFORE the test
 * commands existed; they must not change because of them. A "测试：…" message outside developer mode is an ordinary message, so it
 * goes through the very same builders and carries no entry list.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt, planSessionTurn } from '../electron/brain/claude-session-prompt';
import { buildCodexChatPrompt, buildCompanionPersona } from '../electron/brain/conversation-context';
import type { ChatMessage } from '../shared/foundation/chat';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const persona = '你是 Gene，一个住在桌面上的伙伴。说话简短。';
const greeting: ChatMessage = { role: 'assistant', content: '你好呀，今天过得怎么样？' };
const known: ChatMessage[] = [greeting, { role: 'user', content: '嗨' }, { role: 'assistant', content: '嗨～' }];
const turnPersona = buildCompanionPersona({ persona, stateContext: '她此刻心情平静。', memories: [], protocolInstruction: '【尾注】固定说明' });
const opening = (text: string) => composeSessionPrompt({ plan: planSessionTurn(null, [greeting])!, basePersona: persona, turnPersona, current: { role: 'user', content: text } });
const followUp = (text: string) => composeSessionPrompt({ plan: planSessionTurn(known, known)!, basePersona: persona, turnPersona, current: { role: 'user', content: text } });
const perMessage = (text: string) => buildCodexChatPrompt(persona, [greeting, { role: 'user', content: text }]);

test('the fixed system prompt, the per-turn persona and the opening, follow-up and per-message prompts are unchanged (pinned hashes)', () => {
  assert.deepEqual({
    system: sha(CLAUDE_SESSION_SYSTEM_PROMPT), turn: sha(turnPersona), opening: sha(opening('你好呀')), followUp: sha(followUp('在吗')), perMessage: sha(perMessage('你好呀')),
  }, {
    // F6 changed the fixed system prompt on purpose (2026-11-03): rule 2 of the companion rules follows the user's correction "关于愧疚",
    // and the settings catalog lists realer_emotions. Before F6: 11acb28c…b005. A card with "更真实的情绪" off never changes it.
    // Pretrial issue 8 (2026-11-03) added the perception fact (shared/brain/perception-rule.ts) on purpose; first-token A/B in
    // docs/claude/2026-11-03-pretrial-fixes-continuity.md. Before it: 54eafbde…a9dd. The per-turn hashes below did not move.
    // 识图第 1 步 (2026-11-03) reworded that fact on purpose: "平时你看不到…以这一轮私有上下文里的【此刻的感知】为准" (the state is now
    // the turn's own line, added by electron/main.ts, not by these builders). Before it: 43dd2668…e366.
    // I-017 (2026-11-03) reworded it again on purpose: no longer "也听不到用户那边的声音" (with the audio switch on she hears the
    // rhythm and dances); whether she hears is the turn's own line too, kept from the last time it was said (docs/claude/
    // 2026-11-03-her-state-line.md, first-token A/B there). Before it: d3d74f51…703b. The per-turn hashes below did not move.
    // 2026-11-06 reworded the last sentence of the settings catalog on purpose (electron/brain/chat-settings.ts CHAT_SETTINGS_UNLISTED_TEXT;
    // first-token A/B in docs/claude/2026-11-06-perception-line.md). Before it: d3d74f51…703b. The per-turn hashes did not move.
    // I-080 turned the opening marker on: one sentence naming <sh-open> follows the base sentences
    // (electron/brain/reply-opening.ts OPENING_SYSTEM_SENTENCE; real-Claude A/B in docs/claude/2026-11-11-leak-root-fix-plan.md).
    // Before it: 4b1385ce…be2e. The per-turn hashes did not move.
    // I-117 (2026-11-13, user decision 5, handbook principle 6): rule 3 gains "几个让人担心的迹象一起出现时，你可以用自己的口吻、
    // 温和地直接问一次" on purpose (no fixed question). Before it: f65f9771…cdfd. The per-turn hashes did not move. Not A/B-measured
    // for the first token (one sentence in the fixed, cached system prompt).
    // I-137 (2026-11-15, user option A): the same sentence now says she may give a sense card when the user asks, never on her own,
    // and nothing is on before the tap (CHAT_SETTINGS_UNLISTED_TEXT). Before it: b7b0c18a…8d96. The per-turn hashes did not move.
    // Not A/B-measured for the first token (docs/claude/2026-11-15-i137-sense-cards.md).
    // 2026-11-19 renamed the slow_warm_up switch in the settings catalog on purpose. Before it: c3e76d5f…db78.
    // 2026-11-25 rules removal (docs/claude/2026-11-25-rules-removed.md) re-pinned on purpose. Before it: 33b557da…2f002.
    system: 'c752893ed8051a83a57cf0e897527a97420af612888e4dd130dcfd8bbf7057a0',
    turn: '08fcc2175dc78ce0f8cf8cab4d6839ba432cc43012b239f21309438d4a5f53eb',
    opening: '07380935f706b96c7eb4ee0ccff6c01e607e2f096459c0f41b66949d27a73bc9',
    followUp: '5be9e7f6b30d5e10e4a22154cfa23833b077c1f884af7f6055bede5475d015aa',
    perMessage: 'c2f881a687165e2b3a59a588d6e2f0c232e3a81c3a5e4e4e572f9900d0058a2c',
  });
});

test('"测试：发呆" outside developer mode is an ordinary message: same builders, no entry list, no test words in any prompt', () => {
  const message = '测试：发呆', token = 'ZZMESSAGEZZ';
  const prompts = [opening(message), followUp(message), perMessage(message), CLAUDE_SESSION_SYSTEM_PROMPT, turnPersona];
  for (const prompt of prompts) assert.equal(/入口清单|测试入口|L2\.daydream|L1\.motion|TestCommand/u.test(prompt), false);
  // The only difference from any other message is the message itself.
  assert.equal(opening(message), opening(token).replaceAll(token, message));
  assert.equal(followUp(message), followUp(token).replaceAll(token, message));
  assert.equal(perMessage(message), perMessage(token).replaceAll(token, message));
});
