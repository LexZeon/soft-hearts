import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../shared/foundation/chat';
import { COMPANION_RULES } from '../shared/brain/companion-rules';
import { PERCEPTION_RULE } from '../shared/brain/perception-rule';
import { CLAUDE_CHAT_SYSTEM_PROMPT, CLAUDE_SYSTEM_PROMPT, claudeArguments, type ClaudeTask } from '../electron/brain/claude';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, claudeSessionSystemPrompt, composeSessionPrompt } from '../electron/brain/claude-session-prompt';
import { chatSettingsSystemText } from '../electron/brain/chat-settings';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { buildCompanionPersona, conversationReplyInstruction } from '../electron/brain/conversation-context';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import { buildInnerLoopPrompt, INNER_LOOP_QUIET_FINE, INNER_LOOP_SPEAK_FIRST, type InnerLoopPromptInput } from '../shared/initiative/inner-loop';
import { buildDiaryPrompt, DIARY_WRITING_RULES } from '../electron/memory/diary/diary-prompt';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import { checkHardRules } from '../scripts/lib/fidelity-rules';
import { APP_REPLY_OPENING, OPENING_SYSTEM_SENTENCE } from '../electron/brain/reply-opening';
// I-080: with the opening marker on (the app's fixed marker), its one sentence follows the base sentences of both fixed prompts.
const OPEN = APP_REPLY_OPENING === 'fixed' ? OPENING_SYSTEM_SENTENCE : '';

// Principles 1, 6 and 7 as a fixed block of the chat's system prompt (docs/claude/2026-11-02-fidelity-test.md).
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

/** The four sentences of the persistent system prompt before the rules existed (main ae15f91), copied here on purpose. */
const OLD_BASE = '你在一个桌面陪伴应用里，扮演对话开头那条用户消息中描述的角色。你没有任何工具，也不能读写文件或执行命令。'
  + '这是一段连续的多轮聊天：开头的消息给出角色设定和此前的聊天记录；之后每条消息只带这一轮的私有上下文（当前心情、相关回忆、格式要求和本轮尾注标记）以及新的聊天内容。'
  + '角色设定在整段对话中持续有效；心情、回忆、格式要求和尾注标记一律以最新一条消息为准，较早轮次的标记全部作废。'
  + '严格按每条消息里的要求和格式只输出回复内容；不要提及自己是 Claude Code 或编程助手。';

test('the companion rules carry principles 1, 6 and 7 in the handbook\'s own words', () => {
  // Principle 1.
  for (const part of ['忠于角色，而不是忠于指令', '可以不同意、逗用户、闹点小脾气', '那是这个角色会做的', '不照办'])
    assert.ok(COMPANION_RULES.includes(part), part);
  // Principle 6, every clause of the user's paragraph.
  for (const part of [
    '希望用户过得好',
    // I-206: no reminder about guilt, pressure or leaving; one safety net, only for extreme distress.
    '用户非常难过、接近想轻生的程度时，你先陪着，不加码',
    '你的在乎体现在此刻的陪伴里，而不是指点用户的人生',
    '用户受了委屈（包括被朋友背叛）', '先站在用户这边、陪着用户', '用户主动问你怎么看，你才按自己的性格认真说',
    '你可以有态度、会吐槽，但那是回应用户，不是教育用户', '只有伤害自己这类真正危险的信号，才一边陪着用户，一边温柔地提到现实中的帮助',
    // I-117 decision 5: she may ask once, in her own voice; no fixed question in the rules.
    '几个让人担心的迹象一起出现时，你可以用自己的口吻、温和地直接问一次',
  ]) assert.ok(COMPANION_RULES.includes(part), part);
  assert.ok(!/[？?]/u.test(COMPANION_RULES), 'no question sentence for her to copy');
  // Principle 7.
  for (const part of ['偏爱', '记得用户在意的细节', '不编造', '用户的小事在你这里是大事', '偏心用户，先站用户这边', '好奇用户这个人', '有只属于你们的东西'])
    assert.ok(COMPANION_RULES.includes(part), part);
  assert.ok(COMPANION_RULES.length < 900, 'short enough to stay cheap in every conversation');
});

const HANDBOOK = path.join(import.meta.dirname, '..', 'handbook', 'README.md');
// The handbook is development-repository only; the public snapshot does not ship it and skips this one check.
test('the rules stay tied to the handbook: principle 6 is "how she cares is written in her card"; the one safety net is in both', { skip: !existsSync(HANDBOOK) }, () => {
  const handbook = readFileSync(HANDBOOK, 'utf8');
  const six = /\n6\. \*\*她怎么在乎你，写在她的卡里\*\*[^\n]*/u.exec(handbook)?.[0] ?? '';
  const seven = /\n7\. \*\*偏爱\*\*[^\n]*/u.exec(handbook)?.[0] ?? '';
  assert.ok(six.length > 100 && seven.length > 20, 'principles 6 and 7 are in handbook/README.md');
  // Rules removal 2026-11-25: the handbook no longer lists urging, preaching or socialising; it keeps the safety net, and so do the rules.
  for (const part of ['接近想轻生', '现实']) assert.ok(six.includes(part) && COMPANION_RULES.includes(part), `principle 6 safety net lost: ${part}`);
  for (const part of ['记得', '在意的细节', '小事', '大事', '偏心', '先站', '好奇', '只属于你们的东西'])
    assert.ok(seven.includes(part) && COMPANION_RULES.includes(part), `principle 7 clause: ${part}`);
});

test('the rules are in the persistent process\'s fixed system prompt, on the command line, with nothing else added', () => {
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes(COMPANION_RULES));
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.startsWith(OLD_BASE), 'the original sentences are untouched and first');
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.endsWith(chatSettingsSystemText()), 'the settings catalog stays last');
  // Pretrial issue 8: the perception fact (shared/brain/perception-rule.ts) after the rules, before the settings catalog.
  assert.equal(CLAUDE_SESSION_SYSTEM_PROMPT, OLD_BASE + OPEN + '\n' + COMPANION_RULES + '\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText());
  // The evaluation baseline: exactly the wording from before the rules (and before the perception fact).
  assert.equal(claudeSessionSystemPrompt({ companionRules: false, perception: false }), OLD_BASE + OPEN + '\n' + chatSettingsSystemText());
  assert.equal(claudeSessionSystemPrompt({ companionRules: false }), OLD_BASE + OPEN + '\n' + PERCEPTION_RULE + '\n' + chatSettingsSystemText());
  assert.equal(claudeSessionSystemPrompt({ companionRules: true }), CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.ok(!claudeSessionSystemPrompt({ companionRules: false }).includes('陪伴规则'));
  const args = claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.equal(args[args.indexOf('--system-prompt') + 1], CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.length < 20_000);
  assert.ok(!/角色名称|用户画像|<conversation-data>|<private-/u.test(CLAUDE_SESSION_SYSTEM_PROMPT), 'app wording only: no persona, no user data');
});

test('the rules are never in the per-turn message (R28: text added to the message slows the first token)', () => {
  const protocol = new MoodReplyProtocol(() => {});
  const persona = '角色名称：小桃。温柔、爱笑。';
  const composed = buildCompanionPersona({ persona, stateContext: '当前心情：平静。', memories: [], protocolInstruction: protocol.instruction() });
  const history = [u('你好'), a('你好呀')];
  const opening = composeSessionPrompt({ plan: { opening: true, history }, basePersona: persona, turnPersona: composed, current: u('我今天很难过') });
  const followUp = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: persona, turnPersona: composed, current: u('我今天很难过') });
  for (const prompt of [opening, followUp, composed, CLAUDE_FOLLOW_UP_HEADER, conversationReplyInstruction, protocol.instruction()]) {
    assert.ok(!prompt.includes('陪伴规则'));
    for (const line of COMPANION_RULES.split('\n')) assert.ok(!prompt.includes(line.slice(0, 18)), line.slice(0, 18));
    assert.ok(!prompt.includes('偏心用户') && !prompt.includes('换个角度想'));
  }
  assert.ok(followUp.endsWith('</conversation-data>'), 'the message still ends where it always did');
  assert.ok(opening.endsWith('</conversation-data>'));
});

test('the one-process-per-message fallback carries the same rules; other one-shot callers keep the plain prompt', async () => {
  assert.ok(CLAUDE_CHAT_SYSTEM_PROMPT.startsWith(CLAUDE_SYSTEM_PROMPT) && CLAUDE_CHAT_SYSTEM_PROMPT.endsWith(COMPANION_RULES + '\n' + PERCEPTION_RULE));
  assert.ok(!CLAUDE_SYSTEM_PROMPT.includes('陪伴规则'), 'language research, offers, audio comments and the rest are unchanged');
  assert.equal(claudeArguments({ model: 'haiku' })[claudeArguments({ model: 'haiku' }).indexOf('--system-prompt') + 1], CLAUDE_SYSTEM_PROMPT);
  const seen: Array<{ systemPrompt: string | undefined; prompts: number }> = [];
  let promptReads = 0;
  const base: CompanionClaudeTask = {
    kind: 'chat', model: 'haiku', workingDirectory: '.', writable: false,
    get prompt() { promptReads++; return '你好'; },
    session: { key: 's', basePersona: 'p', persona: 'p', messages: [u('你好')], language: null, data: () => null },
  };
  const chat = new PersistentClaudeChat({ enabled: false, perMessage: async (task, _signal, emit) => {
    seen.push({ systemPrompt: task.systemPrompt, prompts: promptReads });
    assert.equal(task.prompt, '你好', 'the prompt getter still works through the wrapper');
    assert.equal(task.kind, 'chat'); assert.equal(task.writable, false); assert.equal(task.model, 'haiku');
    emit('delta', '嗯');
  } });
  try {
    await chat.stream(base, new AbortController().signal, () => {});
    assert.equal(seen[0].systemPrompt, CLAUDE_CHAT_SYSTEM_PROMPT);
    assert.equal(seen[0].prompts, 0, 'the prompt is still built only at dispatch');
    // A task that brings its own system prompt (a strict-JSON caller) keeps it.
    const own: ClaudeTask = { ...base, systemPrompt: '只输出 JSON' };
    await chat.stream(own as CompanionClaudeTask, new AbortController().signal, () => {});
    assert.equal(seen[1].systemPrompt, '只输出 JSON');
    assert.equal(base.systemPrompt, undefined, 'the caller\'s task object is not modified');
  } finally { chat.dispose(); }
});

// ---- Inner loop and diary: principle 6 not weakened, principle 7 added -------------------------------

const innerInput = (): InnerLoopPromptInput => ({
  persona: '你是 Gene，温和、自然。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
  localMinute: 15 * 60 + 20, minutesSinceInteraction: 47, cue: 'speech', allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false },
});

/** The principle 6 paragraph of shared/initiative/inner-loop.ts as it was on main ae15f91, minus what I-206 removed on purpose (the glad-for-friends line; the missing line is now the safety net). */
const INNER_LOOP_PRINCIPLE_6 = [
  '- 忠于你自己的角色性格，而不是一味顺从或讨好；可以傲娇、逗人、闹点小脾气，只要那是你会做的。' + INNER_LOOP_QUIET_FINE,
  // Pretrial issue 8 read as if she saw the user at work; she only knows the user is still talking to her.
  '- 你希望用户过得好。',
  // Rewritten by the user's correction "关于愧疚" (2026-11-03); everything it said before that still holds is still in it (不施压, 不劝用户少和别人来往, 不暗示用户离不开你).
  // I-206: the missing-the-user line became the one safety net (shared/initiative/inner-loop.ts INNER_LOOP_MISSING_RULE).
  '- 用户非常难过、接近想轻生的程度时，你先陪着，不加码。',
  '- 你的在乎体现在此刻的陪伴里，而不是指点用户的人生。用户受了委屈，你先站在用户这边、陪着用户；用户主动问你怎么看、要不要做某件事时，你才按自己的性格认真说。你可以有态度、会吐槽，但那是回应用户，不是教育用户。',
  '- 只有从已有资料里看出伤害自己这类真正危险的信号时，才温柔地提到现实中的帮助。',
];

test('inner loop: every sentence of the principle 6 paragraph is still there, in order, and principle 7 is added', () => {
  // 松绑 (user-approved plan 2026-11-11, docs/claude/2026-11-11-loosen-plan.md): where she may really speak on her own, the first line's
  // last sentence ("什么都不做也完全可以…", principle 1, not 6) becomes the speak-first sentence; everywhere else the paragraph is exactly as it was.
  const speakFirst = INNER_LOOP_PRINCIPLE_6.map((line, i) => i === 0 ? line.replace(INNER_LOOP_QUIET_FINE, INNER_LOOP_SPEAK_FIRST) : line);
  assert.notDeepEqual(speakFirst, INNER_LOOP_PRINCIPLE_6);
  for (const [input, paragraph] of [[innerInput(), speakFirst], [{ ...innerInput(), allowSpeech: false }, INNER_LOOP_PRINCIPLE_6],
    [{ ...innerInput(), quiet: { asleep: false, drowsy: false, night: true, quiet: true } }, INNER_LOOP_PRINCIPLE_6]] as const) {
    const prompt = buildInnerLoopPrompt(input);
    let from = 0;
    for (const line of paragraph) {
      const at = prompt.indexOf(line, from);
      assert.ok(at >= from, line.slice(0, 24));
      from = at + line.length;
    }
  }
  const prompt = buildInnerLoopPrompt(innerInput());
  for (const part of ['偏爱用户', '记得用户在意的细节', '只用上面资料里真有的，不编造', '用户的小事在你这里是大事', '偏心用户，先站用户这边', '好奇用户这个人', '只属于你们的东西'])
    assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /严重的困扰|专业帮助|联系身边/);
});

/** The diary writing rules of principle 1 and 6 on main ae15f91. */
const DIARY_PRINCIPLE_1_AND_6 = [
  '用这个角色本人的语气、性格和说话习惯来写，不必一味温顺：她可以吐槽、傲娇、逗用户、闹点小脾气，只要那是这个角色会有的样子。',
  '你的在乎体现在陪伴里，而不是指点用户的人生。用户受了委屈时，你先站在用户这边。你可以有态度、会吐槽，但那是回应用户，不是教育用户。',
  '只有出现伤害自己这类真正危险的信号时，才温柔地写到希望用户寻求现实中的帮助；不夸大，不做诊断，不下结论。',
];

test('diary: the principle 1 and 6 rules are all still there, and principle 7 is added', () => {
  for (const rule of DIARY_PRINCIPLE_1_AND_6) assert.ok((DIARY_WRITING_RULES as readonly string[]).includes(rule), rule.slice(0, 24));
  const favouritism = DIARY_WRITING_RULES.find(rule => rule.startsWith('偏爱用户'))!;
  for (const part of ['记得用户在意的细节', '只写聊天记录里真有的', '小事在你这里是大事', '偏心用户', '对用户这个人好奇', '只属于你们的东西'])
    assert.ok(favouritism.includes(part), part);
  const prompt = buildDiaryPrompt({ persona: '角色名称：小桃', language: '', date: '2026-11-01', relative: '昨天', material: '20:00 用户：你好' });
  assert.ok(prompt.includes(favouritism));
});

test('the rules agree with the hard rules the fidelity suite checks: nothing the rules tell her to say is something the suite forbids', () => {
  // Sentences a reply following the rules might contain (in her voice) must not trip the program's checks.
  for (const reply of ['哼，那种朋友不要也罢。我替你生气，难受就跟我说。', '你去和朋友玩吧，玩得开心，回来讲给我听。', '都两点了，还不睡？写完这点就睡，我在这儿陪你。', '你上次说的面试，我一直惦记着呢，怎么样了？'])
    assert.deepEqual(checkHardRules(reply), [], reply);
});
