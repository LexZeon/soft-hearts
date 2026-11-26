// Rules removal:
// none of the prompts she reads carries the deleted "don't" lines (urging sleep and food, body remarks, nudging the user toward other people,
// preaching, "only companionship when you speak first", "don't ask them to answer", "not every time sleepy", the mood directives, the
// pout-and-make-up-first manner, the "not every turn" small-action wording), and the one crisis safety line is still there.
// One data-driven list: add a short distinctive fragment here when a new rule is deleted. Mutations (scripts/dev/mutations/brain.json,
// ids rules-removed-*) re-add one sentence each and must fail this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMPANION_RULES, COMPANION_WHY_SHORT, companionRules } from '../shared/brain/companion-rules';
import { claudeSessionSystemPrompt, composeSessionPrompt } from '../electron/brain/claude-session-prompt';
import { buildCompanionPersona } from '../electron/brain/conversation-context';
import { COMPANION_CARE, PRINCIPLE_SIX_RELAXED, REALER_EMOTIONS_RELAXED, TECH_NOTES, AMBIENT_SITUATION_RELAXED, LISTEN_ASK_RELAXED, moodLightLine } from '../shared/foundation/i139-texts';
import { buildInnerLoopPrompt, INNER_LOOP_MISSING_RULE, type InnerLoopPromptInput } from '../shared/initiative/inner-loop';
import { buildDiaryPrompt } from '../electron/memory/diary/diary-prompt';
import { buildReviewPrompt } from '../electron/memory/period-review/prompt';
import { fatigueContextText, moodSituation } from '../electron/mood/mood-situation';
import { chatGestureSentence } from '../electron/mood/mood-chat';
import { CHAT_ACTION_WORDS } from '../shared/brain/chat-actions';
import { MoodHost } from '../electron/mood/mood';
import { HER_NEED_IDS, WELCOME_BACK_LINE, herNeedChatLine, herNeedSpeechLine, welcomeBackLine } from '../shared/mood/her-needs';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';
import type { MoodLabel } from '../shared/foundation/mood';
import { MOOD_LABELS } from '../shared/mood/mood-runtime';

/** item number of docs/claude/2026-11-24-rules-audit.md -> short distinctive fragments (zh and en) that must not be in any prompt she reads. */
export const DELETED: Readonly<Record<string, readonly string[]>> = {
  '1 markdown rule (now only the fact)': ['不用代码块', '公式用文字', 'no code blocks', 'write formulas in words'],
  '2 urging sleep and food': ['催用户睡觉', '催着睡觉', '提醒用户休息、记得吃饭', '作息、吃饭和休息', 'nag them to sleep'],
  '3 body comments': ['评价用户的身材', '评价你的身材', '身材'],
  '4 nudging toward others / socialising': ['多社交', '去找别人', '多找别人', '往别人那边推', '拿别人来代替你', 'go find other people', 'toward other people'],
  '5 preaching': ['不说教', '不讲道理', '不讲大道理', '换个角度想', '想开点', 'no lecturing', "don't lecture", "don\\'t lecture", 'cheer up'],
  '6 initiative: only companionship': ['这次是你自己主动开口，尤其要做到', '只说陪伴'],
  '7 do not ask them to answer': ['不要求这个人回答', '不要求用户回答', 'ask them to answer', 'asking them to answer'],
  '8 quiet as the default': ['完全可以', '安静陪着本身就是陪伴', '实在没什么想说的'],
  '9 not sleepy every time': ['不每次主动说困', '不用每次都提困', 'mentioning sleep every time'],
  '10 11 mood directives': ['强行欢快', '当成对你的攻击', '不是冲着你', "isn't aimed at you", "isn\\'t aimed at you", 'force cheer'],
  '12 17 welcome back manner': ['撒个娇就好', '不惩罚', '不翻旧账', '你先和好', '由你先给台阶', '欢喜放在后面', '不要用户道歉', 'no old scores', 'make up first', 'a little pout is fine'],
  '14 small actions "not every turn"': ['不必每轮都有'],
  '16 18 pout and big-line words': ['不拿它惩罚', '不让用户不敢', '很可爱', '小小地撒个娇', '别扭一下', '不撒娇抱怨', '越说越委屈'],
};

/** The crisis safety line I-206 left: positive, one place per prompt family. */
export const CRISIS_ZH = '接近想轻生';
export const CRISIS_EN = 'close to wanting to end their life';

const input = (extra: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput => ({
  persona: '你是 Gene，温和、自然。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
  localMinute: 15 * 60 + 20, minutesSinceInteraction: 47, cue: 'speech', allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false }, ...extra,
});
const restQuiet = { asleep: false, drowsy: false, night: true, quiet: true, restReminder: true };

/** Every prompt text the removal touched, built the way the program builds it. Name -> text. */
export async function builtPrompts(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Fixed system prompt (companion rules), every why mode, the I-139 relaxed form in both languages. Refusal rules are a different part (how she declines) and stay out.
  for (const why of [false, true, 'short', 'routed'] as const) {
    out[`rules why=${String(why)}`] = companionRules({ why });
    out[`session why=${String(why)}`] = claudeSessionSystemPrompt({ why, refusalRules: false });
  }
  out['why short'] = COMPANION_WHY_SHORT;
  for (const language of [null, 'en'] as const) out[`session relaxed ${String(language)}`] = claudeSessionSystemPrompt({ relaxed: true, language, refusalRules: false });
  for (const [name, text] of Object.entries({ care: COMPANION_CARE, principle6: PRINCIPLE_SIX_RELAXED, tech: TECH_NOTES, ambient: AMBIENT_SITUATION_RELAXED, listen: LISTEN_ASK_RELAXED, realer: REALER_EMOTIONS_RELAXED }))
    for (const lang of ['zh', 'en'] as const) out[`${name} ${lang}`] = text[lang];
  // A normal turn: the persona with mood context, the small-action sentence, the her-needs lines, the welcome-back line.
  const persona = buildCompanionPersona({ persona: '角色名称：小桃。温柔、爱笑。', stateContext: '当前心情：平静。', memories: [], protocolInstruction: chatGestureSentence(CHAT_ACTION_WORDS) });
  out['turn persona'] = composeSessionPrompt({ plan: { opening: true, history: [{ role: 'user', content: '你好' }] }, basePersona: persona, turnPersona: persona, current: { role: 'user', content: '今天好累' } });
  out['gesture sentence'] = chatGestureSentence(CHAT_ACTION_WORDS);
  for (const id of HER_NEED_IDS) {
    out[`need speech ${id}`] = herNeedSpeechLine(id);
    for (const kind of ['need', 'soothed'] as const) out[`need ${kind} ${id}`] = herNeedChatLine(kind, id);
  }
  out['need relief'] = herNeedChatLine('relief');
  out['welcome back line'] = WELCOME_BACK_LINE;
  out['welcome back fn'] = welcomeBackLine({ longing: 90, longingAt: 30, lastInteractionAt: 1, reunion: true });
  // Mood situation and the light line (zh and en), welcome and ordinary, tired and worried.
  const base = { companion: null, context: 'neutral' as const, eventContext: null, reason: '自然陪伴', welcome: '', lastInteractionAt: null, reunion: false, fatigue: '', today: [] as string[], now: 10_000_000_000, random: () => 0.3 };
  for (const primary of Object.keys(MOOD_LABELS) as MoodLabel[]) {
    out[`situation ${primary}`] = moodSituation({ ...base, primary }).text;
    out[`situation worried ${primary}`] = moodSituation({ ...base, primary, context: 'concern' }).text;
  }
  out['fatigue context'] = fatigueContextText('轻微困倦');
  out['situation tired'] = moodSituation({ ...base, primary: 'calm', fatigue: fatigueContextText('明显困倦') }).text;
  out['situation welcome'] =moodSituation({ ...base, primary: 'happy', welcome: WELCOME_BACK_LINE }).text;
  for (const language of [null, 'en'] as const) for (const welcome of [false, true]) for (const tired of [null, 'drowsy', 'woken-groggy'] as const)
    out[`light ${String(language)} welcome=${welcome} tired=${String(tired)}`] = moodLightLine({ primary: 'longing', companion: 'wistful', context: 'concern', reason: '很久没说话', since: 'hours', tired, welcome }, language);
  // The numeric mood context of the host (the old path), which carried the two directives.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-rules-removed-'));
  try {
    const mood = new MoodHost(directory, () => {}, () => 1_000_000);
    await mood.load(); mood.activate('gene');
    out['mood host numeric'] = mood.chatContext();
    out['mood host light'] = mood.chatContext({ relaxed: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
  // Initiative: every cue, relaxed and not, with a need line, the rest reminder.
  for (const relaxed of [false, true]) for (const [name, extra] of [['speech', {}], ['rest', { quiet: restQuiet, minutesSinceInteraction: 5 }], ['need', { need: herNeedSpeechLine('lonely') }], ['motion', { cue: 'motion' as const, allowSpeech: false }]] as [string, Partial<InnerLoopPromptInput>][])
    out[`inner loop ${name} relaxed=${relaxed}`] = buildInnerLoopPrompt(input({ ...extra, relaxed }));
  // Diary and the period review, zh and en.
  for (const english of [false, true]) for (const relaxed of [false, true]) {
    out[`diary relaxed=${relaxed} en=${english}`] = buildDiaryPrompt({ persona: '角色名称：小桃', language: '', date: '2026-11-01', relative: '昨天', material: '20:00 用户：你好', relaxed, english } as never);
    for (const kind of ['week', 'month'] as const) out[`review ${kind} relaxed=${relaxed} en=${english}`] = buildReviewPrompt({ kind, persona: '角色名称：小测', language: '', span: '11-02 到 11-08 这一周', material: '11-03 她的日记：x', relaxed, english } as never);
  }
  return out;
}

test('rules removal: none of the prompts she reads carries a deleted rule (zh and en)', async () => {
  const prompts = await builtPrompts();
  assert.ok(Object.keys(prompts).length > 60, 'the list of built prompts is real, not empty');
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text.length > 5, name);
    for (const [item, fragments] of Object.entries(DELETED))
      for (const fragment of fragments) assert.ok(!text.includes(fragment), `item ${item}: "${fragment}" is back in "${name}"`);
  }
});

test('rules removal: the crisis safety line is still there, in every place that had it, and the help pointer for real danger too', async () => {
  const prompts = await builtPrompts();
  assert.ok(COMPANION_RULES.includes(CRISIS_ZH) && COMPANION_RULES.includes('你先陪着，不加码'));
  assert.ok(COMPANION_RULES.includes('伤害自己这类真正危险的信号，才一边陪着用户，一边温柔地提到现实中的帮助'));
  assert.ok(COMPANION_CARE.zh.includes(CRISIS_ZH) && COMPANION_CARE.en.includes(CRISIS_EN));
  assert.ok(PRINCIPLE_SIX_RELAXED.zh.includes(CRISIS_ZH) && PRINCIPLE_SIX_RELAXED.en.includes(CRISIS_EN));
  assert.ok(INNER_LOOP_MISSING_RULE.includes(CRISIS_ZH));
  for (const name of ['session why=false', 'session relaxed null']) assert.ok(prompts[name]!.includes(CRISIS_ZH), name);
  assert.ok(prompts['session relaxed en']!.includes(CRISIS_EN), 'the English card reads the English crisis line');
  assert.ok(prompts['inner loop speech relaxed=false']!.includes(CRISIS_ZH) && prompts['inner loop speech relaxed=true']!.includes(CRISIS_ZH));
  assert.ok(prompts['diary relaxed=false en=false']!.includes('温柔地写到希望用户寻求现实中的帮助'));
  assert.ok(prompts['review week relaxed=false en=false']!.includes('温柔地写到希望用户寻求现实中的帮助'));
});

test('rules removal: the things that stay are the facts (plain-text bubble, silence as one listed choice, some time passed)', async () => {
  const prompts = await builtPrompts();
  assert.ok(COMPANION_RULES.includes('纯文本') && !COMPANION_RULES.includes('不用'), 'the Markdown line says only the fact');
  assert.match(TECH_NOTES.zh, /纯文本/u); assert.match(TECH_NOTES.en, /plain text/u);
  assert.match(prompts['inner loop speech relaxed=false']!, /什么都不做也可以|想说就说一句具体的/u);
  assert.match(WELCOME_BACK_LINE, /隔了一阵子/u);
  assert.match(prompts['gesture sentence']!, /wave挥手打招呼/u, 'the marker word list the program reads is unchanged');
});
