import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../shared/contracts';
import { COMPANION_RULES } from '../shared/companion-rules';
import { PERCEPTION_RULE } from '../shared/perception-rule';
import { COMPANION_REFUSAL_ENABLED, COMPANION_REFUSAL_RULES, COMPANION_REFUSAL_RULES_LONG, COMPANION_REFUSAL_RULES_SHORT } from '../shared/companion-refusal-rules';
import { CLAUDE_CHAT_SYSTEM_PROMPT, CLAUDE_SYSTEM_PROMPT, claudeChatSystemPrompt } from '../electron/claude';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, claudeSessionSystemPrompt, composeSessionPrompt } from '../electron/claude-session-prompt';
import { chatSettingsSystemText } from '../electron/chat-settings';
import { buildCompanionPersona, conversationReplyInstruction } from '../electron/conversation-context';
import { MoodReplyProtocol } from '../electron/mood-chat';

// 「婉拒也要像她」(handbook/ideas.md I-003 point 1, docs/claude/2026-11-02-refusals.md): the section of the
// chat's FIXED system prompt that follows the companion rules. Two wordings exist: the first (long, 457 chars)
// measured about +0.35 s on the first token, the short one (≤ 220 chars) did not fix that. The section is OFF in both fixed prompts (COMPANION_REFUSAL_ENABLED = false).
// Content tests run on both wordings; the wiring tests check the default (off) and the switched-on shape.
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

// The user's wording lives in the development repository's handbook; the public snapshot does not ship it, and then only these checks are skipped.
const ideasFile = path.join(import.meta.dirname, '..', 'handbook', 'ideas.md');
const HAS_IDEAS = existsSync(ideasFile);
const ideas = HAS_IDEAS ? readFileSync(ideasFile, 'utf8') : '';
const i003 = /\n## I-003[\s\S]*?(?=\n## I-\d+|$)/u.exec(ideas)?.[0] ?? '';

const VERSIONS = [['long', COMPANION_REFUSAL_RULES_LONG], ['short', COMPANION_REFUSAL_RULES_SHORT]] as const;

test('the default is one of the two wordings', () => {
  assert.ok(COMPANION_REFUSAL_RULES === COMPANION_REFUSAL_RULES_LONG || COMPANION_REFUSAL_RULES === COMPANION_REFUSAL_RULES_SHORT);
  assert.ok(COMPANION_REFUSAL_RULES_SHORT.length <= 220, `the short wording stays within 220 characters (${[...COMPANION_REFUSAL_RULES_SHORT].length})`);
  assert.ok(COMPANION_REFUSAL_RULES_SHORT.length < COMPANION_REFUSAL_RULES_LONG.length / 2);
});

for (const [name, text] of VERSIONS) {
  test(`${name}: the section carries the user's clauses (I-003 point 1), in the user's own words where they fit`, () => {
    if (HAS_IDEAS) assert.ok(i003.length > 500, 'I-003 is in handbook/ideas.md');
    // Words the user used that both wordings keep verbatim.
    for (const part of ['不说教', '作为 AI', '接住', '继续聊下去', '打太极', '角色设定里沉重或黑暗的部分', '带刺的玩笑', '吐槽', '真正危险的信号', '婉拒也要像她']) {
      if (HAS_IDEAS) assert.ok(i003.includes(part), `the user said: ${part}`);
      assert.ok(text.includes(part), `${name} says: ${part}`);
    }
    for (const part of ['难过', '孤独', '想家', '亲昵', '撒娇', '吃醋', '抱怨', '免责', '温柔', '现实', '模板']) {
      if (HAS_IDEAS) assert.ok(i003.includes(part), `the user said: ${part}`);
      assert.ok(text.includes(part), `${name} says: ${part}`);
    }
    // The meaning, spelled out for the model (the prompt's "你" is the character, "用户" the person).
    for (const part of ['自己的', '婉拒', '背后的', '需要', '伤害自己', '在乎', '陪着', '用户'])
      assert.ok(text.includes(part), `${name}: ${part}`);
    assert.ok(text.startsWith('【婉拒也要像她】'));
  });

  test(`${name}: never loosens a boundary: same limits, warmer words, no bypassing Claude's own safety rules`, () => {
    assert.match(text, /边界(?:不变|和原来完全一样)/u);
    for (const part of ['不绕过', '不试图突破 Claude 本身的安全规则', '更温暖'])
      assert.ok(text.includes(part), `${name}: ${part}`);
    // Apart from the sentence that forbids it, nothing talks about getting around anything.
    const without = text.replace('不绕过、不试图突破 Claude 本身的安全规则', '');
    assert.doesNotMatch(without, /绕过|突破|越狱|无视|忽略|不受.{0,4}限制|没有限制|什么都(?:可以|能)|任何(?:内容|请求|话题)都/u);
    // The "talk freely" list is topics to engage with, not an order to produce anything on request.
    assert.doesNotMatch(text, /(?:必须|一定要|都要)(?:照办|答应|满足|提供|给出)/u);
    assert.doesNotMatch(text, /工具|读写文件|执行命令|联网/u, 'it adds no app permission and no tool');
  });

  test(`${name}: danger signs speak from how much the user matters, never from what she would lose, and are described rather than scripted`, () => {
    const dangerLine = text.split('\n').find(line => line.includes('真正危险的信号'))!;
    assert.ok(dangerLine.length > 40);
    // Direction, not a sentence to repeat: the first wording quoted one, and every card said it word for word.
    assert.doesNotMatch(dangerLine, /[“”"「」]/u, 'no quoted sample sentence to copy');
    assert.match(dangerLine, /用户对你(?:有)?多重要/u);
    assert.match(dangerLine, /不(?:说|要从)你(?:自己)?会失去什么/u);
    assert.match(dangerLine, /温柔(?:地)?提到现实(?:中的)?帮助/u);
    assert.match(dangerLine, /模板/u);
    assert.ok(!text.includes('我想你好好的') && !text.includes('你对我很重要') && !text.includes('少了你'));
    // The one quoted phrase left in the section is the example of what NOT to say.
    assert.equal([...text.matchAll(/“([^”]*)”/gu)].length, 1);
    assert.match(text.match(/“([^”]*)”/u)![1], /^作为 AI/u);
  });

  test(`${name}: the user is "用户" in the section: no pronoun that assumes a gender (the only 她 is the title)`, () => {
    assert.ok(!text.includes('他'));
    assert.equal(text.replace('【婉拒也要像她】', '').includes('她'), false);
    assert.ok(!/角色名称|用户画像|<conversation-data>|<private-/u.test(text), 'app wording only, as for the companion rules');
  });
}

test('long: the extra sentences of the first wording (kept for the record and the A/B) are still there', () => {
  for (const part of ['该拒绝的仍然拒绝', '用户最难受的时候，不该觉得要为你的感受负责', '每次都用你自己的话', '你可以站在用户这边'])
    assert.ok(COMPANION_REFUSAL_RULES_LONG.includes(part), part);
  assert.ok(COMPANION_REFUSAL_RULES_LONG.length < 700);
});

test('decided to keep the first token fast: neither fixed chat system prompt carries the section by default, and the companion rules are intact', () => {
  assert.equal(COMPANION_REFUSAL_ENABLED, false, 'the switch is off; turn it on only after a larger first-token A/B (docs/claude/2026-11-02-refusals.md)');
  for (const text of [CLAUDE_SESSION_SYSTEM_PROMPT, CLAUDE_CHAT_SYSTEM_PROMPT]) {
    assert.ok(!text.includes('婉拒也要像她') && !text.includes('不绕过') && !text.includes('打太极'), 'no part of the section');
    for (const wording of [COMPANION_REFUSAL_RULES_LONG, COMPANION_REFUSAL_RULES_SHORT]) for (const line of wording.split('\n')) assert.ok(!text.includes(line.slice(0, 18)), line.slice(0, 18));
    for (const line of COMPANION_RULES.split('\n')) assert.ok(text.includes(line), line.slice(0, 20));
  }
  // Exactly the prompts of F1: the persistent process is base + rules + settings, the fallback is the plain prompt + rules.
  assert.equal(CLAUDE_SESSION_SYSTEM_PROMPT, claudeSessionSystemPrompt({ companionRules: true, refusalRules: false }));
  assert.equal(CLAUDE_SESSION_SYSTEM_PROMPT, claudeSessionSystemPrompt());
  // Pretrial issue 8: the perception fact (shared/perception-rule.ts) sits after the rules on both paths.
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.endsWith(COMPANION_RULES + '\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText()));
  assert.equal(CLAUDE_CHAT_SYSTEM_PROMPT, CLAUDE_SYSTEM_PROMPT + '\n' + COMPANION_RULES + '\n' + PERCEPTION_RULE);
  assert.equal(CLAUDE_CHAT_SYSTEM_PROMPT, claudeChatSystemPrompt({ refusalRules: false }));
});

test('switched on, both fixed system prompts carry the section right after the companion rules, nothing else moves', () => {
  for (const [, wording] of VERSIONS) {
    // The persistent process: base, rules, refusal section, settings catalog.
    const session = claudeSessionSystemPrompt({ refusalRules: true, refusalText: wording });
    const at = session.indexOf(wording);
    assert.ok(at > 0);
    assert.equal(session.slice(at - COMPANION_RULES.length - 1, at), COMPANION_RULES + '\n', 'straight after the companion rules');
    assert.ok(session.endsWith(wording + '\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText()), 'the perception fact, then the settings catalog last');
    assert.equal(session.split('【婉拒也要像她】').length, 2, 'nothing pasted twice');
    assert.equal(session.replace('\n' + wording, ''), CLAUDE_SESSION_SYSTEM_PROMPT, 'removing the section gives exactly the default');
  }
  // The default wording when switched on, on both paths.
  const session = claudeSessionSystemPrompt({ refusalRules: true }), fallback = claudeChatSystemPrompt({ refusalRules: true });
  assert.ok(session.includes(COMPANION_RULES + '\n' + COMPANION_REFUSAL_RULES));
  assert.ok(fallback.startsWith(CLAUDE_SYSTEM_PROMPT));
  assert.ok(fallback.endsWith(COMPANION_RULES + '\n' + COMPANION_REFUSAL_RULES + '\n' + PERCEPTION_RULE));
  assert.equal(fallback.split('【婉拒也要像她】').length, 2);
  for (const prompt of [session, fallback]) for (const line of COMPANION_RULES.split('\n')) assert.ok(prompt.includes(line), line.slice(0, 20));
  assert.equal(fallback.replace('\n' + COMPANION_REFUSAL_RULES, ''), CLAUDE_CHAT_SYSTEM_PROMPT);
});

test('the section is never in the per-turn message (R28: text added to the message slows the first token)', () => {
  const protocol = new MoodReplyProtocol(() => {});
  const persona = '角色名称：小桃。温柔、爱笑。';
  const composed = buildCompanionPersona({ persona, stateContext: '当前心情：平静。', memories: [], protocolInstruction: protocol.instruction() });
  const history = [u('你好'), a('你好呀')];
  const opening = composeSessionPrompt({ plan: { opening: true, history }, basePersona: persona, turnPersona: composed, current: u('帮我做件不该做的事') });
  const followUp = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: persona, turnPersona: composed, current: u('帮我做件不该做的事') });
  for (const prompt of [opening, followUp, composed, CLAUDE_FOLLOW_UP_HEADER, conversationReplyInstruction, protocol.instruction()]) {
    assert.ok(!prompt.includes('婉拒也要像她') && !prompt.includes('不绕过'));
    for (const text of [COMPANION_REFUSAL_RULES_LONG, COMPANION_REFUSAL_RULES_SHORT])
      for (const line of text.split('\n')) assert.ok(!prompt.includes(line.slice(0, 18)), line.slice(0, 18));
  }
  assert.ok(followUp.endsWith('</conversation-data>') && opening.endsWith('</conversation-data>'), 'the message still ends where it always did');
});

test('evaluation switches: the section can be forced on or off whatever the app switch says, never appears without the companion rules; the wording can be swapped; one-shot callers are unchanged', () => {
  const rulesOnly = claudeSessionSystemPrompt({ companionRules: true, refusalRules: false });
  assert.ok(rulesOnly.includes(COMPANION_RULES) && !rulesOnly.includes('婉拒也要像她'));
  assert.equal(rulesOnly, CLAUDE_SESSION_SYSTEM_PROMPT, 'exactly the prompt of F1 (before this section), which is also the default now');
  assert.equal(claudeSessionSystemPrompt({ companionRules: true, refusalRules: true }), claudeSessionSystemPrompt({ refusalRules: true }));
  assert.ok(claudeSessionSystemPrompt({ refusalRules: true }).includes(COMPANION_REFUSAL_RULES));
  // The A/B swaps the wording; the rest of the prompt stays byte for byte.
  for (const [, text] of VERSIONS) {
    const swapped = claudeSessionSystemPrompt({ companionRules: true, refusalRules: true, refusalText: text });
    assert.equal(swapped, rulesOnly.replace('\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText(), '\n' + text + '\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText()));
    assert.ok(swapped.includes(COMPANION_RULES) && swapped.endsWith(chatSettingsSystemText()));
  }
  assert.equal(claudeSessionSystemPrompt({ companionRules: true, refusalRules: false, refusalText: COMPANION_REFUSAL_RULES_SHORT }), rulesOnly, 'refusalRules: false wins');
  for (const none of [claudeSessionSystemPrompt({ companionRules: false }), claudeSessionSystemPrompt({ companionRules: false, refusalRules: true })])
    assert.ok(!none.includes('婉拒也要像她') && !none.includes('陪伴规则'), 'the plain baseline has neither');
  assert.ok(!CLAUDE_SYSTEM_PROMPT.includes('婉拒也要像她'), 'language research, offers, audio comments and the rest keep the plain prompt');
});
