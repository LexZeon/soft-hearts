import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_RULES, COMPANION_WHY, companionRules } from '../shared/brain/companion-rules';
import { getPromptSwitches, promptSwitchDefaults, promptSwitchesFromEnv, setPromptSwitches } from '../shared/brain/prompt-switches';
import { claudeSessionSystemPrompt, composeSessionPrompt } from '../electron/brain/claude-session-prompt';
import { claudeChatSystemPrompt } from '../electron/brain/claude';
import { buildCompanionPersona } from '../electron/brain/conversation-context';
import { MoodHost } from '../electron/mood/mood';
import { moodSituation, SITUATION_FOLLOW_SENTENCE, todayLines } from '../electron/mood/mood-situation';
import { personalitySection, speakOnlyJudgePrompt } from '../electron/brain/speak-only/judge';
import { MoodReplyProtocol } from '../electron/mood/mood-chat';
import type { MoodLabel } from '../shared/foundation/mood';
import { MOOD_LABELS } from '../shared/mood/mood-runtime';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Pinned from main before I-112 / I-115 (fe368c3f): the rules block, the persistent system prompt and the per-message system prompt.
const OLD_RULES_SHA = '86cbdc85c5e6f0e61905d63e95a85a2e2f27821dc120a728a48410f9cf9764df';
// I-137 (2026-11-15) reworded the settings catalog's last sentence (sense cards when asked); before it: b7b0c18a…8d96.
// 2026-11-19: renamed the slow_warm_up switch in the settings catalog on purpose; the old hash was c3e76d5f…db78.
// 2026-11-25 rules removal (docs/claude/2026-11-25-rules-removed.md): urging, body, preaching and socialising lines left the rules; all three hashes re-pinned on purpose (old: rules f4774701…2793, session 33b557da…2f002, chat 0db544cf…87b0).
// 2026-11-24 I-206: rule 2 of the companion rules lost its guilt/leaving wording (old hashes: rules 8b2926af…ea3e, session 20f1c369…33c5), re-pinned on purpose.
const OLD_SESSION_SHA = 'c752893ed8051a83a57cf0e897527a97420af612888e4dd130dcfd8bbf7057a0';
const OLD_CHAT_SHA = 'b37e113da31acb25f9a0b9de8f9bfb5691ee223fe5076904e534e3d700e153fc';

test('switches: stable off, development and source runs on, env can flip one', () => {
  assert.deepEqual(promptSwitchDefaults('stable', true), { why: false, situation: false });
  assert.deepEqual(promptSwitchDefaults('development', true), { why: false, situation: false });
  assert.deepEqual(promptSwitchDefaults(null, false), { why: false, situation: false });
  assert.deepEqual(promptSwitchDefaults(null, true), { why: false, situation: false });
  assert.deepEqual(promptSwitchesFromEnv({ why: true, situation: true }, { SOFT_HEARTS_PROMPT_WHY: '0' }), { why: false, situation: true });
  assert.deepEqual(getPromptSwitches(), { why: false, situation: false }, 'the module starts with both off');
});

test('both switches off: the prompts are byte for byte what they were', () => {
  assert.equal(sha(COMPANION_RULES), OLD_RULES_SHA);
  assert.equal(sha(companionRules({ why: false })), OLD_RULES_SHA);
  assert.equal(sha(claudeSessionSystemPrompt()), OLD_SESSION_SHA);
  assert.equal(sha(claudeChatSystemPrompt()), OLD_CHAT_SHA);
});

test('I-112: the why paragraph is in the fixed prompt once, before the rules, on both paths, and never in a turn message', () => {
  for (const prompt of [claudeSessionSystemPrompt({ why: true }), claudeChatSystemPrompt({ why: true })]) {
    assert.equal(prompt.split('【为什么】').length - 1, 1);
    assert.ok(prompt.indexOf('【为什么】') < prompt.indexOf('【陪伴规则】'));
    assert.ok(!prompt.includes('身材'), 'no body line at all (rules removal 2026-11-25)');
    assert.ok(prompt.includes('一起说以后的事、做做梦也可以'));
    assert.ok(prompt.includes('用户只是说出打算、没问你时，你可以说一句真实的担心，说完把决定权交还给用户，不展开、不追问、不重复'));
    assert.ok(!/[？?]/u.test(prompt.slice(prompt.indexOf('【为什么】'), prompt.indexOf('【陪伴规则】') + 2000).split('\n').filter(line => /^[1-5]\. |^【为什么】|^偏爱|^真正/u.test(line)).join('')), 'no question for her to copy');
  }
  // Rules 3 and 4 keep everything else.
  const on = companionRules({ why: true });
  for (const part of ['用户主动问你怎么看，你才按自己的性格认真说', '有只属于你们的东西']) assert.ok(on.includes(part), part);
  assert.equal(COMPANION_WHY.split('\n').length, 3);
  // The per-turn path: neither the persona composition nor a follow-up turn carries it.
  const persona = buildCompanionPersona({ persona: '角色设定', stateContext: '心情', memories: [], protocolInstruction: '尾注' });
  assert.ok(!persona.includes('【为什么】'));
  const turn = composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: '角色设定', turnPersona: persona, current: { role: 'user', content: '你好' } });
  assert.ok(!turn.includes('【为什么】') && !turn.includes(COMPANION_WHY));
  assert.ok(claudeSessionSystemPrompt({ why: true }).length - claudeSessionSystemPrompt().length < 500, 'the fixed prompt grows by well under 500 characters');
});

test('I-112: the switch state is what the assemblers read when no option is given', () => {
  try {
    setPromptSwitches({ why: true, situation: false });
    assert.ok(claudeSessionSystemPrompt().includes('【为什么】'));
    assert.ok(claudeChatSystemPrompt().includes('【为什么】'));
    setPromptSwitches({ why: false, situation: false });
    assert.equal(sha(claudeSessionSystemPrompt()), OLD_SESSION_SHA);
  } finally { setPromptSwitches({ why: false, situation: false }); }
});

const LABELS = Object.keys(MOOD_LABELS) as MoodLabel[];
const base = { primary: 'sad' as MoodLabel, companion: null, context: 'neutral' as const, eventContext: null, reason: '自然陪伴', welcome: '', lastInteractionAt: null,
  reunion: false, fatigue: '', today: [] as string[], now: 10_000_000_000, random: () => 0.3 };

test('I-115 A: the situation text has no ASCII letters or digits, ends with the follow-the-change sentence, for every feeling and every dice roll', () => {
  const companions = [null, 'playful', 'close', 'comfortable', 'cautious', 'wistful'];
  const contexts = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense', 'fright'] as const;
  for (const primary of LABELS) for (const companion of companions) for (const context of contexts) for (const random of [0, 0.5, 0.999]) {
    const { text } = moodSituation({ ...base, primary, companion, context, eventContext: 'positive', reason: '用户说要去淋雨', random: () => random, lastInteractionAt: base.now - 5 * 3_600_000,
      fatigue: ' 当前疲倦感受：轻微困倦。保留当前角色性格。', today: ['用户今天淋雨去买汉堡'] });
    assert.doesNotMatch(text, /[A-Za-z0-9]/u, text);
    assert.ok(text.endsWith(SITUATION_FOLLOW_SENTENCE));
    assert.ok(SITUATION_FOLLOW_SENTENCE.includes('如果这一轮发生的事让你的心情变了，就跟着变，不用维持原样'));
    assert.doesNotMatch(text, /\/100|值\/基线|快速上升|缓变/u);
  }
});

test('I-115 A: the five sources show up, and what has a letter or a digit is left out', () => {
  const now = 10_000_000_000;
  const { text } = moodSituation({ ...base, now, primary: 'longing', companion: 'wistful', context: 'concern', reason: '用户加班到很晚', lastInteractionAt: now - 5 * 3_600_000,
    fatigue: ' 当前疲倦感受：刚被你叫醒，没睡够、还有点迷糊。', today: ['用户今天淋雨去买汉堡', 'ok 3 times'] });
  for (const part of ['等了用户大半天', '用户加班到很晚', '正在为用户担心', '还有一点没散的想念', '刚被你叫醒', '今天你们之间：用户今天淋雨去买汉堡']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('ok 3 times'));
  const welcome = moodSituation({ ...base, now, welcome: '见到用户很开心。', reunion: true, lastInteractionAt: now - 3_600_000 }).text;
  assert.ok(welcome.includes('见到用户很开心。') && welcome.includes('等了用户一阵子') && !welcome.includes('用户刚回来'));
});

test('I-115 A: the same words are not used twice in a row', () => {
  let last: string | undefined;
  for (let i = 0; i < 20; i++) {
    const made = moodSituation({ ...base, random: () => (i % 7) / 7, lastPhrase: last });
    assert.notEqual(made.picked, last);
    last = made.picked;
  }
  const lines = todayLines([{ title: '甲事', summary: '' }, { title: '乙事', summary: '' }, { title: '丙事', summary: '' }], () => 0, ['甲事']);
  assert.equal(lines.length, 2); assert.ok(!lines.includes('甲事'));
});

async function withMood(run: (mood: MoodHost) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-situation-mood-'));
  const mood = new MoodHost(directory, () => {}, () => 1_000_000);
  try { await mood.load(); mood.activate('gene'); await run(mood); }
  finally { await mood.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}

test('I-115 A: on, the host speaks in words; the numbers still reach the expression layer; off, today\'s text', async () => {
  await withMood(async mood => {
    const off = mood.chatContext();
    assert.match(off, /当前角色内在状态[\s\S]*\/100的程度/u);
    try {
      setPromptSwitches({ why: false, situation: true });
      const on = mood.chatContext({ today: ['用户今天淋雨去买汉堡'] });
      assert.doesNotMatch(on, /[A-Za-z0-9]/u, on);
      assert.ok(on.includes(SITUATION_FOLLOW_SENTENCE) && on.includes('用户今天淋雨去买汉堡'));
      assert.doesNotMatch(on, /当前角色内在状态|\/100/u);
    } finally { setPromptSwitches({ why: false, situation: false }); }
    const view = mood.get();
    assert.ok(Number.isFinite(view.snapshot.values.D) && view.snapshot.intensity.text > 0, 'the numbers are still in the view the expression layer reads');
    assert.equal(mood.chatContext(), off, 'back to today\'s text with the switch off');
  });
});

test('I-115 A: on, the tail guide of a carrier turn no longer lists her numbers', () => {
  const protocol = (moodNow: string) => new MoodReplyProtocol(() => {}, { moodNow }).instruction();
  assert.ok(protocol('她现在（值/基线）：D62/50').includes('她现在（值/基线）'));
  assert.ok(!protocol('').includes('她现在（值/基线）'));
});

test('I-115 C: the mood recorder gets the card\'s whole personality section, not the first 400 characters', () => {
  const personality = '她嘴硬心软，' + '别扭又真诚。'.repeat(120) + '最后一句要看到。';
  const persona = ['角色名称：艾琳', '角色描述：' + '描述。'.repeat(150), `性格：\n${personality}`, '情境：在桌面上', '对话示例：略'].join('\n\n');
  assert.equal(personalitySection(persona), personality);
  const input = { userText: '你好', reply: '嗯', moodNow: '', persona };
  const cut = speakOnlyJudgePrompt(input), full = speakOnlyJudgePrompt({ ...input, fullPersonality: true });
  assert.ok(!cut.includes('最后一句要看到'));
  assert.ok(full.includes('最后一句要看到') && full.includes('她嘴硬心软'));
  assert.ok(!full.includes('描述。描述'), 'the personality section only, not the description');
  // No such section: the first 400 as before.
  assert.equal(speakOnlyJudgePrompt({ ...input, persona: '只有一段设定。', fullPersonality: true }), speakOnlyJudgePrompt({ ...input, persona: '只有一段设定。' }));
  assert.equal(personalitySection('Name: A\n\nPersonality:\nshy but kind\n\nScenario: desk'), 'shy but kind');
});
