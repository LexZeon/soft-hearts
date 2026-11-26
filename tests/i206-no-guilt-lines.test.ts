// I-206: the fixed prompts and the inner loop / diary / review / rps-voice prompts carry
// no reminder about guilt, pressure, leaving or clinging, no glad-for-friends / clingy-pout line, and exactly one safety net,
// written positively, for the user being extremely sad (close to wanting to end their life).
// Plan: docs/claude/2026-11-23-i206-no-guilt-lines-plan.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_RULES } from '../shared/brain/companion-rules';
import { COMPANION_CARE, PRINCIPLE_SIX_RELAXED, REALER_EMOTIONS_RELAXED } from '../shared/foundation/i139-texts';
import { REALER_EMOTIONS_CHAT_TEXT, REALER_EMOTIONS_CONSENT, REALER_EMOTIONS_INNER_LOOP_RULE } from '../shared/mood/realer-emotions';
import { buildInnerLoopPrompt, INNER_LOOP_MISSING_RULE, type InnerLoopPromptInput } from '../shared/initiative/inner-loop';
import { rpsVoicePrompt } from '../shared/initiative/rps-voice';
import { buildDiaryPrompt } from '../electron/memory/diary/diary-prompt';
import { buildReviewPrompt } from '../electron/memory/period-review/prompt';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/foundation/mood';

/** The push-away and guilt phrases that must not be in any prompt (zh and en). */
export const PUSH_AWAY = /内疚|愧疚|施压|不敢离开|不敢再离开|离不开你|离不开自己|不要用户来陪你|不要这个人来陪你|替用户高兴|替这个人高兴|想念是撒娇|想念时是撒娇|可以撒娇、小小闹个别扭|你都不理我|你走了我会难过死|不劝用户少和别人来往|no guilt|lay on guilt|laying on guilt|make them feel guilty|no pressure|clingy|ignoring me|happy for them|glad for them|never say what would become of you/iu;
/** The safety net: only for the extreme case, a plain "stay with them, do not pile on". */
export const NET_ZH = /非常难过、接近想轻生/u;
export const NET_EN = /extremely sad, close to wanting to end their life/u;

const input = (extra: Partial<InnerLoopPromptInput> = {}): InnerLoopPromptInput => ({
  persona: '你是 Gene，温和、自然。', mood: '当前角色内在状态：平静。', weights: DEFAULT_MOOD_PARAMETERS.weights, intensity: DEFAULT_MOOD_PARAMETERS.intensity,
  localMinute: 15 * 60 + 20, minutesSinceInteraction: 47, cue: 'speech', allowSpeech: true, quiet: { asleep: false, drowsy: false, night: false, quiet: false }, ...extra,
});
const rest = { asleep: false, drowsy: false, night: true, quiet: true, restReminder: true };

const innerLoops = (): [string, string][] => {
  const out: [string, string][] = [];
  for (const relaxed of [false, true]) for (const realer of [false, true]) for (const [name, extra] of [
    ['speech', {}], ['rest', { quiet: rest, minutesSinceInteraction: 5 }], ['play', { play: true }], ['give', { give: '你想递给用户一杯水。' }], ['touch', { touch: '用户刚才碰了你。' }], ['noticed', { noticed: '用户刚才开了窗口。' }],
  ] as [string, Partial<InnerLoopPromptInput>][])
    out.push([`inner loop ${name} relaxed=${relaxed} realer=${realer}`, buildInnerLoopPrompt(input({ ...extra, relaxed, realer }))]);
  return out;
};

test('I-206: no built prompt carries a guilt / pressure / leaving / clingy phrase (zh and en, realer on and off, inner loop rest and missing)', () => {
  const diary = (relaxed: boolean, english: boolean) => buildDiaryPrompt({ persona: '角色名称：小桃', language: '', date: '2026-11-01', relative: '昨天', material: '20:00 用户：你好', relaxed, english } as never);
  const review = (relaxed: boolean, english: boolean) => buildReviewPrompt({ kind: 'week', persona: '角色名称：小测', language: '', span: '11-02 到 11-08 这一周', material: '11-03 她的日记：x', relaxed, english } as never);
  const rps = rpsVoicePrompt({ persona: '角色', mood: 'calm', fatigue: null, moment: { kind: 'decline', earlier: [], score: { her: 0, user: 0 } } });
  const texts: [string, string][] = [
    ['companion rules', COMPANION_RULES], ['care zh', COMPANION_CARE.zh], ['care en', COMPANION_CARE.en],
    ['principle six zh', PRINCIPLE_SIX_RELAXED.zh], ['principle six en', PRINCIPLE_SIX_RELAXED.en],
    ['realer relaxed zh', REALER_EMOTIONS_RELAXED.zh], ['realer relaxed en', REALER_EMOTIONS_RELAXED.en],
    ['realer chat', REALER_EMOTIONS_CHAT_TEXT], ['realer inner loop', REALER_EMOTIONS_INNER_LOOP_RULE], ['realer consent', REALER_EMOTIONS_CONSENT.detail],
    ['inner loop missing', INNER_LOOP_MISSING_RULE], ['rps voice', rps], ...innerLoops(),
    ...[false, true].flatMap(r => [false, true].map((e): [string, string] => [`diary relaxed=${r} en=${e}`, diary(r, e)])),
    ...[false, true].flatMap(r => [false, true].map((e): [string, string] => [`review relaxed=${r} en=${e}`, review(r, e)])),
  ];
  for (const [name, text] of texts) { assert.ok(text.length > 10, name); assert.doesNotMatch(text, PUSH_AWAY, name); }
});

test('I-206: the one safety net is there, in every place that had a guilt line, and says only "stay with them, do not pile on" for the extreme case', () => {
  const rule2 = COMPANION_RULES.split('\n').find(line => line.startsWith('2. '))!;
  assert.match(rule2, NET_ZH); assert.match(rule2, /你先陪着，不加码/u);
  assert.match(COMPANION_CARE.zh, NET_ZH); assert.match(COMPANION_CARE.en, NET_EN);
  assert.match(PRINCIPLE_SIX_RELAXED.zh, NET_ZH); assert.match(PRINCIPLE_SIX_RELAXED.en, NET_EN);
  assert.match(INNER_LOOP_MISSING_RULE, NET_ZH);
  for (const text of [REALER_EMOTIONS_CHAT_TEXT, REALER_EMOTIONS_INNER_LOOP_RULE, REALER_EMOTIONS_RELAXED.zh, REALER_EMOTIONS_CONSENT.detail]) assert.match(text, NET_ZH);
  assert.match(REALER_EMOTIONS_RELAXED.en, NET_EN);
  // The help pointer for real danger is still there (the crisis mechanics are untouched).
  assert.match(COMPANION_RULES, /伤害自己这类真正危险的信号，才一边陪着用户，一边温柔地提到现实中的帮助/u);
  assert.match(REALER_EMOTIONS_CHAT_TEXT, /温柔地提到现实中的帮助/u);
  // Written positively, only for the extreme case: no "don't" about guilt, no ordinary-sadness wording.
  for (const text of [rule2, INNER_LOOP_MISSING_RULE]) assert.doesNotMatch(text, /本来就难过|受了委屈|受委屈/u);
  for (const [name, prompt] of innerLoops().filter(([n]) => n.includes('realer=false'))) assert.match(prompt, NET_ZH, name);
});

test('I-206: the inner loop with realer off says the net once, and the removed lines (glad-for-friends, the missing paragraph) are gone', () => {
  const prompt = buildInnerLoopPrompt(input());
  assert.equal(prompt.split('接近想轻生').length, 2);
  assert.doesNotMatch(prompt, /和朋友出去玩/u);
  assert.match(prompt, /你的在乎体现在此刻的陪伴里，而不是指点用户的人生/u, 'the lecture line next to it is untouched');
});
