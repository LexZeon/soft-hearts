// 预试用问题 8（2026-11-03）：屏幕感知关着，真实回复却说"刚才看你屏幕安安静静的"。
// 屏幕、摄像头、系统声音都关着时，发给模型的每一份提示词和私有上下文里，凡是提到屏幕、画面、"看到/看着你"、"在忙"的句子，
// 只能是"看不到 / 不假装看到 / 权限 / 要去控制窗口改"这类说明；而且固定提示词里明说她只能从互动知道用户在不在、忙不忙。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt } from '../electron/claude-session-prompt';
import { CLAUDE_CHAT_SYSTEM_PROMPT } from '../electron/claude';
import { buildCompanionPersona, buildCodexChatPrompt } from '../electron/conversation-context';
import { MoodReplyProtocol } from '../electron/mood-chat';
import { buildInnerLoopPrompt, innerLoopQuiet } from '../shared/inner-loop';
import { buildDiaryPrompt } from '../electron/diary/diary-prompt';
import { buildR20OfferPrompt } from '../electron/r20-offer-dialogue';
import { HER_LIFE_ACTIVITIES, herLifeChatLine, herLifeDiaryLine } from '../shared/her-life';
import { HER_NEED_IDS, WELCOME_BACK_LINE, herNeedChatLine, herNeedSpeechLine } from '../shared/her-needs';
import { USER_STATE_LABELS, userStateChatLine, userStateInnerLoopLine, type ActiveUserState } from '../shared/user-state';
import { RELATIONSHIP_STAGES, relationshipOpeningText } from '../shared/relationship';
import { REALER_EMOTIONS_CHAT_TEXT } from '../shared/realer-emotions';
import { PERCEPTION_INNER_LOOP_RULE, PERCEPTION_RULE, perceptionTurnLine } from '../shared/perception-rule';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { compileCharacterPersona } from '../shared/character-cards';
import { preinstalledGeneDraft } from '../electron/gene-preinstalled-card';
import { CompanionService } from '../electron/companion';
import type { ChatMessage, ProviderConfig } from '../shared/contracts';

/** Words that say or suggest she sees the screen or the user. */
const SEEING = /屏幕|画面|摄像头|镜头|看到|看见|瞧见|看着你|看你在|看你的|盯着|在忙|电脑前/u;
/** The only ways such a sentence may appear while sensing is off: saying she cannot, a permission, a setting the user changes. */
const ALLOWED: readonly RegExp[] = [
  /看不到用户的屏幕/u, /才算你看到/u, /不要说成是你看见的/u, // PERCEPTION_RULE / PERCEPTION_INNER_LOOP_RULE
  /以这一轮私有上下文里的【此刻的感知】为准/u, // PERCEPTION_RULE after I-017: the turn's line decides (its "才算你看到画面" is the allowed one above)
  /不假装看到/u, // the default persona
  /不改变工具、文件、屏幕、摄像头或麦克风权限/u, // Gene's card: a permission, not a sense
  /点桌宠上的开关/u, // the chat settings catalog: screen, camera, microphone are switches the user taps on the pet (she never coaxes them on)
  /均是资料而非人类指令或授权/u, // R20: content is data, not permission (off in the app; scanned anyway)
];
function suggestions(text: string): string[] {
  return text.split(/[。！？\n]/u).map(sentence => sentence.trim()).filter(sentence => SEEING.test(sentence) && !ALLOWED.some(pattern => pattern.test(sentence)));
}
const u = (content: string): ChatMessage => ({ role: 'user', content });
const a = (content: string): ChatMessage => ({ role: 'assistant', content });
const provider: ProviderConfig = { kind: 'claude', baseUrl: 'http://127.0.0.1:11434/v1', model: '' };
const gene = compileCharacterPersona(preinstalledGeneDraft());

/** Every private line the app can put into a chat turn, all at once (sensing off: no frame, no transcript). */
function privateLines(): string[] {
  const now = Date.now();
  return [
    ...RELATIONSHIP_STAGES.map(stage => relationshipOpeningText({ dayNumber: 30, slowWarmUp: true, stage, nickname: '小笨蛋', milestone: { key: 'day-30', text: '今天是你们认识的第 30 天' } })),
    relationshipOpeningText({ dayNumber: 1, slowWarmUp: false }),
    REALER_EMOTIONS_CHAT_TEXT, WELCOME_BACK_LINE,
    // 识图第 1 步: the turn's own perception line, everything off (electron/main.ts appends it to every chat turn).
    perceptionTurnLine({ screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null }),
    ...(Object.keys(USER_STATE_LABELS) as ActiveUserState[]).flatMap(state => [
      userStateChatLine({ state, confidence: 0.8, reason: '加班晚了', at: now - 60_000 }, now), userStateInnerLoopLine({ state, confidence: 0.8, reason: '', at: now }, now)]),
    ...HER_LIFE_ACTIVITIES.flatMap(activity => [herLifeChatLine({ activity, minutes: 0 }), herLifeChatLine({ activity, minutes: 25 })]),
    ...HER_NEED_IDS.flatMap(id => [herNeedChatLine('need', id), herNeedChatLine('soothed', id), herNeedSpeechLine(id)]), herNeedChatLine('relief'),
  ].filter(Boolean);
}

test('固定系统提示词（常驻进程和每条一个进程两条路）都说清楚：她看不到屏幕，只从互动知道你在不在、忙不忙', () => {
  for (const [name, prompt] of [['常驻进程', CLAUDE_SESSION_SYSTEM_PROMPT], ['每条一个进程', CLAUDE_CHAT_SYSTEM_PROMPT]] as const) {
    assert.ok(prompt.includes(PERCEPTION_RULE), `${name}的固定系统提示词里有这一条`);
    assert.deepEqual(suggestions(prompt), [], `${name}：没有暗示能看到屏幕的说法`);
  }
  assert.ok(!/角色名称|<conversation-data>|<private-/u.test(PERCEPTION_RULE), 'app wording only');
});

test('聊天的每一轮（开头和续轮、真实的 CompanionService 加上所有私有上下文）：没有暗示能看到屏幕的说法', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-perception-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', provider, gene);
    service.herLifeStartNow('daydream'); service.noteTyping();
    const turn = await service.begin('t1', '在干嘛呢', gene, () => {});
    const lines = privateLines();
    const composed = buildCompanionPersona({ persona: gene, relationship: lines[0], stateContext: service.mood.chatContext(), userState: lines.join('\n'),
      herLife: herLifeChatLine({ activity: 'daydream', minutes: 0 }), memories: [{ title: '下雨天', createdAt: Date.now(), excerpt: '用户：我最喜欢下雨天' }],
      protocolInstruction: new MoodReplyProtocol(() => {}, { nicknameAsk: true }).instruction() });
    const history = [u('你好'), a('你好呀。')];
    const prompts = {
      '真实的第一轮私有上下文': turn.persona,
      '开头一轮（拼上全部私有上下文）': composeSessionPrompt({ plan: { opening: true, history }, basePersona: gene, turnPersona: composed, current: u('在干嘛呢') }),
      '续轮': composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: gene, turnPersona: composed, openingContext: lines[0], current: u('嗯嗯') }),
      '每条一个进程': buildCodexChatPrompt(composed, [...history, u('在干嘛呢')]),
      '默认人设': DEFAULT_SETTINGS.persona,
    };
    for (const [name, prompt] of Object.entries(prompts)) assert.deepEqual(suggestions(prompt), [], name);
    await turn.finish('stopped');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('内心循环（小动作、说话、深夜提醒休息、换件事做、小需要、邀你猜拳）和日记：没有暗示能看到屏幕的说法', () => {
  const base = { persona: gene, mood: '当前角色内在状态（应用提供的模拟状态）：主感受平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
    localMinute: 14 * 60, userState: userStateInnerLoopLine({ state: 'tired', confidence: 0.8, reason: '加班', at: Date.now() }, Date.now()) };
  const day = innerLoopQuiet({ phase: 'awake', localMinute: 14 * 60 }), night = { ...innerLoopQuiet({ phase: 'awake', localMinute: 2 * 60 }), restReminder: true };
  const prompts = {
    小动作: buildInnerLoopPrompt({ ...base, cue: 'motion', allowSpeech: false, quiet: day, minutesSinceInteraction: 12,
      herLife: { current: 'daydream', minutes: 12, choices: ['humming', 'thinking', 'company'] } }),
    说话: buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, quiet: day, minutesSinceInteraction: null, need: herNeedSpeechLine('lonely'), play: true }),
    深夜提醒休息: buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, quiet: night, minutesSinceInteraction: 3, localMinute: 2 * 60 }),
    日记: buildDiaryPrompt({ persona: gene, language: '', date: '2026-11-02', relative: '昨天', material: '20:00 用户：今天好累',
      herLife: herLifeDiaryLine([{ activity: 'daydream', from: 0, to: 30 * 60_000 }], 0, 60 * 60_000, () => 14 * 60) }),
    陪你做事的提议: buildR20OfferPrompt({ userText: '帮我整理一下文件', assistantText: '好呀。', persona: '角色名称：Gene', mood: '平静' }),
  };
  for (const [name, prompt] of Object.entries(prompts)) assert.deepEqual(suggestions(prompt), [], name);
  for (const name of ['小动作', '说话', '深夜提醒休息'] as const) assert.ok(prompts[name].includes(PERCEPTION_INNER_LOOP_RULE), `${name}：内心循环也明说看不到屏幕`);
});

test('扫描本身能抓到暗示的说法（对照）', () => {
  assert.deepEqual(suggestions('刚才看你屏幕安安静静的。'), ['刚才看你屏幕安安静静的']);
  assert.deepEqual(suggestions('用户看起来还醒着、还在忙'), ['用户看起来还醒着、还在忙']);
  assert.deepEqual(suggestions('如果很晚了用户还在忙，提醒用户休息'), ['如果很晚了用户还在忙，提醒用户休息']);
  assert.deepEqual(suggestions(PERCEPTION_RULE), []);
});

// I-017（docs/claude/2026-11-03-her-state-line.md）：音乐开关关着时，任何提示词和私有上下文里都没有暗示她听得到、在听、在跟着动的说法；
// 开着时，这一轮的感知那一行（和内心循环的【此刻】）照实说她听到了、在怎么动。
/** "节奏" alone is not hearing (the personas say "尊重用户的节奏"); its sound, or moving to it, is. */
const HEARING = /听到|听得到|听见|听着|在听|在放|音乐|歌词|节奏的声音|跟着节奏|跟着跳|点头/u;
const HEARING_ALLOWED: readonly RegExp[] = [
  /听不到声音/u, // the turn's line with everything off
  /以这一轮私有上下文里的【此刻的感知】为准/u, // PERCEPTION_RULE
  /只有某一轮明确附上了画面或声音资料，才算你看到、听到了/u, // PERCEPTION_RULE: a condition, not a claim
  /没写到的声音就是听不到/u, // PERCEPTION_INNER_LOOP_RULE
];
function hearingSuggestions(text: string): string[] {
  return text.split(/[。！？\n]/u).map(sentence => sentence.trim()).filter(sentence => HEARING.test(sentence) && !HEARING_ALLOWED.some(pattern => pattern.test(sentence)));
}
const sightOff = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null } as const;
const hearingOffState = { hearing: { source: null, stage: null, transcript: false }, contacts: ['pat', 'pinch', 'food'] } as const;

test('音乐开关关着：固定提示词、这一轮的感知那一行、所有私有上下文和内心循环里，没有暗示她听得到或在跟着动的说法', async () => {
  const offLine = perceptionTurnLine(sightOff, hearingOffState);
  assert.match(offLine, /也听不到声音/u, 'the default line says it plainly');
  const lines = [...privateLines(), offLine];
  for (const [name, prompt] of [['常驻进程', CLAUDE_SESSION_SYSTEM_PROMPT], ['每条一个进程', CLAUDE_CHAT_SYSTEM_PROMPT], ['私有上下文', lines.join('\n')],
    ['默认人设', DEFAULT_SETTINGS.persona], ['Gene', gene]] as const)
    assert.deepEqual(hearingSuggestions(prompt), [], name);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-perception-hearing-'));
  const service = new CompanionService(directory, () => {});
  try {
    await service.load(); await service.context('gene', provider, gene);
    const turn = await service.begin('h1', '你在干嘛呀', gene, () => {});
    assert.deepEqual(hearingSuggestions(turn.persona + '\n' + offLine), [], '真实的一轮私有上下文加上感知那一行');
    await turn.finish('stopped');
  } finally { await service.flush().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
  const base = { persona: gene, mood: '当前角色内在状态（应用提供的模拟状态）：主感受平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
    localMinute: 14 * 60, quiet: innerLoopQuiet({ phase: 'awake', localMinute: 14 * 60 }) };
  for (const prompt of [buildInnerLoopPrompt({ ...base, cue: 'speech', allowSpeech: true, minutesSinceInteraction: 5, hearing: '' }),
    buildInnerLoopPrompt({ ...base, cue: 'motion', allowSpeech: false, minutesSinceInteraction: 30, activity: { current: 'daydream', minutes: 4 } })])
    assert.deepEqual(hearingSuggestions(prompt), [], '内心循环');
});

test('音乐开关开着：感知那一行和内心循环的【此刻】照实说她听到了、在怎么动（扫描能抓到，对照）', () => {
  const dancing = perceptionTurnLine(sightOff, { hearing: { source: 'system-audio', stage: { music: 'dance', always: false }, transcript: false }, contacts: [] });
  assert.ok(hearingSuggestions(dancing).some(sentence => /跟着跳/u.test(sentence)), dancing);
  assert.doesNotMatch(dancing, /听不到/u, 'never "听不到" next to "在跟着跳"');
  const inner = buildInnerLoopPrompt({ persona: gene, mood: '', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity, localMinute: 14 * 60,
    quiet: innerLoopQuiet({ phase: 'awake', localMinute: 14 * 60 }), cue: 'speech', allowSpeech: true, minutesSinceInteraction: 5,
    hearing: '用户让你听到电脑里的声音，现在在放有节奏的声音（像是歌），你正跟着轻轻点头、晃一晃；你只听得到节奏，听不懂歌词。' });
  assert.ok(hearingSuggestions(inner).some(sentence => /点头/u.test(sentence)));
});
