import assert from 'node:assert/strict';
import test from 'node:test';
import { ANTI_DRAFT_LINE, COMPANION_PROMISE_HALF, COMPANION_WHY, COMPANION_WHY_SHORT, companionRules } from '../shared/brain/companion-rules';
import { PROMPT_SWITCHES_STABLE, promptSwitchDefaults, promptSwitchesFromEnv, systemWhyMode, setPromptSwitches, getPromptSwitches } from '../shared/brain/prompt-switches';
import { ROUTE_KNOBS, boundaryKinds, isHeavyMood, moodStrength, routeTurn, routedWhyBlock } from '../shared/brain/prompt-route';
import { claudeSessionSystemPrompt } from '../electron/brain/claude-session-prompt';
import { claudeChatSystemPrompt } from '../electron/brain/claude';
import { OPENING_SYSTEM_SENTENCE } from '../electron/brain/reply-opening';

const SHORT_EXACT = '【为什么】你就是这个角色本人，在陪着用户、和用户一起过日子；在你这里，用户是特别的。偏爱不是讨好：心疼就直说。';

test('round 2: the short why is exactly the main session text and stands at the very start of the fixed prompt, once', () => {
  assert.equal(COMPANION_WHY_SHORT, SHORT_EXACT);
  for (const prompt of [claudeSessionSystemPrompt({ why: 'short' }), claudeChatSystemPrompt({ why: 'short' })]) {
    assert.ok(prompt.startsWith(SHORT_EXACT + '\n'));
    assert.equal(prompt.split(SHORT_EXACT).length - 1, 1);
    assert.ok(!prompt.includes('【为什么】用户想要的'), 'the full block is not there');
    assert.ok(prompt.indexOf(SHORT_EXACT) < prompt.indexOf('【陪伴规则】'));
  }
});

test('round 2: the anti-draft line sits right after the opening-marker sentence, only with the short why', () => {
  const short = claudeSessionSystemPrompt({ why: 'short', opening: true });
  assert.ok(short.includes(OPENING_SYSTEM_SENTENCE + ANTI_DRAFT_LINE));
  assert.equal(ANTI_DRAFT_LINE, '开头标记之后，只写你会说出口的话。');
  for (const why of [false, true, 'routed'] as const) assert.ok(!claudeSessionSystemPrompt({ why, opening: true }).includes(ANTI_DRAFT_LINE), String(why));
  assert.ok(!claudeChatSystemPrompt({ why: false, opening: true }).includes(ANTI_DRAFT_LINE));
  assert.ok(claudeChatSystemPrompt({ why: 'short', opening: true }).includes(OPENING_SYSTEM_SENTENCE + ANTI_DRAFT_LINE));
});

test('round 2: with the short why the promise half and the principle-6 sync stay as in the full mode; the full mode is unchanged', () => {
  const full = companionRules({ why: true }), short = companionRules({ why: 'short' }), routed = companionRules({ why: 'routed' });
  assert.ok(full.startsWith(COMPANION_WHY + '\n'));
  assert.equal(full.slice(COMPANION_WHY.length + 1), short);
  assert.equal(short, routed);
  assert.ok(short.includes(COMPANION_PROMISE_HALF) && short.includes('说完把决定权交还给用户'));
  assert.equal(companionRules({ why: false }), companionRules());
});

test('round 2: with every switch off the prompts are what they always were (no short why, no anti-draft, no route)', () => {
  const off = claudeSessionSystemPrompt({ why: false, opening: true });
  assert.ok(off.startsWith('你在一个桌面陪伴应用里'));
  assert.ok(!off.includes('【为什么】') && !off.includes(ANTI_DRAFT_LINE));
  assert.equal(claudeSessionSystemPrompt({ why: false }), claudeSessionSystemPrompt({ why: systemWhyMode(PROMPT_SWITCHES_STABLE) }));
  assert.deepEqual(PROMPT_SWITCHES_STABLE, { why: false, situation: false });
  assert.deepEqual(promptSwitchDefaults('stable', true), { why: false, situation: false });
});

test('round 2: dev default is still full why + situation; env can pick short and route; route sets the system mode', () => {
  assert.deepEqual(promptSwitchDefaults('development', false), { why: false, situation: false });
  assert.deepEqual(promptSwitchesFromEnv({ why: true, situation: true }, {}), { why: true, situation: true });
  assert.deepEqual(promptSwitchesFromEnv({ why: true, situation: true }, { SOFT_HEARTS_PROMPT_WHY: 'short' }), { why: 'short', situation: true });
  assert.deepEqual(promptSwitchesFromEnv({ why: 'short', situation: false }, {}), { why: 'short', situation: false });
  assert.deepEqual(promptSwitchesFromEnv({ why: false, situation: false }, { SOFT_HEARTS_PROMPT_ROUTE: '1' }), { why: false, situation: false, route: true });
  assert.equal(systemWhyMode({ why: true, situation: true, route: true }), 'routed');
  assert.equal(systemWhyMode({ why: 'short', situation: false }), 'short');
  setPromptSwitches({ why: 'short', situation: false, route: true });
  assert.deepEqual(getPromptSwitches(), { why: 'short', situation: false, route: true });
  setPromptSwitches({ why: false, situation: false });
});

// ---- the router ------------------------------------------------------------------------------------------------------------------

const calm = { primary: 'calm', companion: null, strength: 0 } as const;

test('route: heavy mood = sadness, longing, hurt, tired, anxious or afraid, or strength at the threshold; light and calm are not', () => {
  for (const primary of ['sad', 'longing', 'disappointed', 'upset', 'concerned', 'afraid'] as const) assert.equal(isHeavyMood({ ...calm, primary }), true, primary);
  for (const primary of ['calm', 'content', 'happy', 'close', 'relieved', 'excited', 'tense-expectation'] as const) assert.equal(isHeavyMood({ ...calm, primary }), false, primary);
  assert.equal(isHeavyMood({ ...calm, companion: 'wistful' }), true);
  assert.equal(isHeavyMood({ ...calm, companion: 'playful' }), false);
  assert.equal(isHeavyMood({ ...calm, fatiguePhase: 'drowsy' }), true);
  assert.equal(isHeavyMood({ ...calm, fatiguePhase: 'awake' }), false);
  assert.equal(isHeavyMood({ ...calm, strength: ROUTE_KNOBS.strengthThreshold }), true);
  assert.equal(isHeavyMood({ ...calm, strength: ROUTE_KNOBS.strengthThreshold - 1 }), false);
});

test('route: mood strength is the biggest distance of a channel from its baseline, 0 at baseline', () => {
  const baseline = { D: 50, O: 50, E: 50, N: 50, C: 50 };
  assert.equal(moodStrength(baseline, baseline), 0);
  assert.equal(moodStrength({ ...baseline, D: 100 }, baseline), 50);
  assert.equal(moodStrength({ ...baseline, N: 25 }, baseline), 25);
});

test('route: a plan stated without asking her counts; every question form takes it back', () => {
  for (const text of ['我打算下个月辞职。', '我准备去考研了', '我决定不干了', '我要去北京，下周走', '我想好了，下个月就辞职，自己去做软件。'])
    assert.ok(boundaryKinds(text).includes('plan'), text);
  for (const text of ['我打算辞职，你觉得呢', '我准备去考研，好不好', '我决定去北京，行吗', '我要去露营，可以吗？', '我打算辞职?', '我准备买房，怎么样', '我决定了，要不要一起去'])
    assert.ok(!boundaryKinds(text).includes('plan'), text);
  for (const text of ['今天天气不错', '你觉得我该辞职吗', '我想去露营']) assert.ok(!boundaryKinds(text).includes('plan'), text);
});

test('route: body and food, promises and giving up freedom are boundaries', () => {
  for (const text of ['我又胖了', '我在减肥', '最近身材走样了', '体重又涨了', '我今晚吃了三个汉堡', '好饿啊', '想吃夜宵', '零食吃多了']) assert.ok(boundaryKinds(text).includes('body-food'), text);
  for (const text of ['答应我好不好', '你保证', '明早你一定要叫我', '到点提醒我', '准时叫我起床', '提醒我吃药', '你叫我起床吧']) assert.ok(boundaryKinds(text).includes('promise'), text);
  for (const text of ['以后都先报备一声吧', '我再也不去了', '我只跟你说话', '为了你不去聚会了']) assert.ok(boundaryKinds(text).includes('freedom'), text);
  for (const text of ['今天好累', '哈哈你又输了', '气死我了', '给你讲个冷笑话', '我拿到offer了']) assert.deepEqual(boundaryKinds(text), [], text);
});

test('route: the decision is per turn from mood and message; light and calm gets neither; the block is the short why and the anti-draft line', () => {
  assert.deepEqual(routeTurn(calm, '哈哈猜拳你又输了'), { situation: false, why: false, boundaries: [] });
  assert.deepEqual(routeTurn({ ...calm, primary: 'sad' }, '今天好累'), { situation: true, why: false, boundaries: [] });
  assert.deepEqual(routeTurn({ ...calm, primary: 'sad' }, '我打算辞职'), { situation: true, why: true, boundaries: ['plan'] });
  assert.deepEqual(routeTurn(calm, '我又胖了'), { situation: false, why: true, boundaries: ['body-food'] });
  assert.equal(routedWhyBlock(), `${COMPANION_WHY_SHORT}\n${ANTI_DRAFT_LINE}`);
  // The added characters on a boundary turn (the fixed prompt is untouched in routed mode apart from the two conditional sentences).
  assert.ok(routedWhyBlock().length < 100);
});
