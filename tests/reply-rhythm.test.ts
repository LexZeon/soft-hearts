// F7 说话节奏: the pure rules (shared/reply-rhythm.ts). Off by default (REPLY_RHYTHM_FALLBACK_ENABLED): the multiplier, the user's
// pace, the "……" stop and the afterthought are 兜底（待定） for 停停说说, so these tests check mechanics and directions,
// not final numbers. Visible characters and grapheme-safe paging are display helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPLY_RHYTHM_MAX, REPLY_RHYTHM_MIN, UserPaceTracker, bubbleHoldMs, ellipsisStop, graphemeBoundaryAtOrBefore, isAfterthought,
  replyRhythmFor, rhythmMoodOf, userTurnShape, validReplyRhythmPacing, visibleLength, type ReplyRhythmInput,
} from '../shared/reply-rhythm';
import type { FatiguePhase } from '../shared/fatigue';
import type { MoodContext, MoodLabel, MoodTendency } from '../shared/mood';

const calm = { primary: 'calm' as MoodLabel, context: 'neutral' as MoodContext };
const m = (input: Partial<ReplyRhythmInput> & { mood?: ReplyRhythmInput['mood'] }) => replyRhythmFor({ mood: calm, ...input }).multiplier;

test('兜底（待定）: the directions of the fallback table (the numbers are trial values, not pinned here)', () => {
  assert.equal(m({}), 1, 'calm and awake: as R27');
  // Faster when glad, slower when tired, comforting, missing, low or shy; a tired reply is slower the sleepier she is.
  for (const primary of ['happy', 'excited'] as const) assert.ok(m({ mood: { primary, context: 'neutral' } }) < 1, primary);
  assert.ok(m({ mood: { primary: 'excited', context: 'neutral' } }) <= m({ mood: { primary: 'happy', context: 'neutral' } }));
  for (const primary of ['longing', 'disappointed', 'sad'] as const) assert.ok(m({ mood: { primary, context: 'neutral' } }) > 1, primary);
  assert.ok(m({ mood: { primary: 'calm', context: 'support' } }) > 1, 'comforting the user');
  assert.ok(m({ fatigue: 'light-drowsy' }) > 1 && m({ fatigue: 'drowsy' }) > m({ fatigue: 'light-drowsy' }) && m({ fatigue: 'falling-asleep' }) >= m({ fatigue: 'drowsy' }));
  assert.ok(m({ shy: true }) > 1);
  assert.ok(m({ mood: { ...calm, companion: 'playful' } }) < 1 && m({ mood: { ...calm, companion: 'comfortable' } }) > 1);
  // T-106: cautious is not slow, close is not slow.
  assert.equal(m({ mood: { ...calm, companion: 'cautious' } }), 1);
  assert.equal(m({ mood: { ...calm, companion: 'close' } }), 1);
  assert.ok(m({ user: 'quick' }) < 1 && m({ user: 'venting' }) > 1);
  // The context comes before a lingering label, like the voice tone.
  assert.equal(rhythmMoodOf({ primary: 'sad', context: 'positive' }), 'happy');
  assert.equal(rhythmMoodOf({ primary: 'excited', context: 'positive' }), 'excited');
  assert.equal(rhythmMoodOf({ primary: 'happy', context: 'offense' }), 'neutral');
  assert.equal(rhythmMoodOf({ primary: 'calm', context: 'neutral', gesture: 'upbeat' }), 'happy');
});

test('兜底（待定）: 文字语气强度 scales every factor; 0 is always exactly 1 and the result stays in the range', () => {
  const labels: MoodLabel[] = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
  const contexts: MoodContext[] = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'];
  const phases: Array<FatiguePhase | null> = [null, 'awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
  const tendencies: Array<MoodTendency | 'wistful' | null> = [null, 'playful', 'close', 'comfortable', 'cautious', 'wistful'];
  let checked = 0;
  for (const primary of labels) for (const context of contexts) for (const fatigue of phases) for (const companion of tendencies)
    for (const shy of [false, true]) for (const user of [null, 'quick', 'venting'] as const) {
      const base = { mood: { primary, context, companion }, fatigue, shy, user };
      assert.equal(replyRhythmFor({ ...base, textIntensity: 0 }).multiplier, 1);
      for (const textIntensity of [1, 25, 50, 75, 100]) {
        const value = replyRhythmFor({ ...base, textIntensity }).multiplier;
        assert.ok(value >= REPLY_RHYTHM_MIN && value <= REPLY_RHYTHM_MAX, `${value}`);
        checked++;
      }
    }
  assert.ok(checked > 10_000);
  const happy = { mood: { primary: 'happy' as MoodLabel, context: 'neutral' as MoodContext } };
  assert.ok(Math.abs(m({ ...happy, textIntensity: 25 }) - 1) < Math.abs(m(happy) - 1) && Math.abs(m(happy) - 1) < Math.abs(m({ ...happy, textIntensity: 75 }) - 1), 'more tone strength, more effect');
  assert.equal(m({ fatigue: 'drowsy', textIntensity: Number.NaN }), m({ fatigue: 'drowsy' }), 'a bad intensity falls back to the template default');
});

test('兜底（待定）: the cue holds only numbers and closed names; the voice gap is 0 unless the developer trial is on', () => {
  const cue = replyRhythmFor({ mood: { primary: 'sad', context: 'neutral', companion: 'comfortable' }, fatigue: 'drowsy', shy: true, user: 'venting', textIntensity: 70 });
  assert.deepEqual(Object.keys(cue).sort(), ['fatigue', 'mood', 'multiplier', 'shy', 'tendency', 'textIntensity', 'user', 'voiceGapMs']);
  assert.equal(cue.voiceGapMs, 0);
  assert.ok(Object.isFrozen(cue));
  const sleepy = replyRhythmFor({ mood: calm, fatigue: 'falling-asleep', voiceTrial: true }).voiceGapMs, tired = replyRhythmFor({ mood: calm, fatigue: 'light-drowsy', voiceTrial: true }).voiceGapMs;
  assert.ok(sleepy > tired && tired > 0 && sleepy <= 200, `${tired} < ${sleepy} ≤ 200 ms`);
  assert.equal(replyRhythmFor({ mood: { primary: 'happy', context: 'neutral' }, voiceTrial: true }).voiceGapMs, 0, 'never on a quick reply');
  assert.equal(replyRhythmFor({ mood: calm, voiceTrial: true }).voiceGapMs, 0);
});

test('the renderer accepts only an id, a finite multiplier (held to the range) and shyness', () => {
  assert.deepEqual(validReplyRhythmPacing({ id: 'r1', multiplier: 1.1, shy: true, extra: 'x' }), { id: 'r1', multiplier: 1.1, shy: true });
  assert.equal(validReplyRhythmPacing({ id: 'r1', multiplier: 9 })!.multiplier, REPLY_RHYTHM_MAX);
  assert.equal(validReplyRhythmPacing({ id: 'r1', multiplier: 0 })!.multiplier, REPLY_RHYTHM_MIN);
  for (const bad of [null, [], 'r1', { id: 'r 1', multiplier: 1 }, { id: 'r1', multiplier: Number.NaN }, { id: 'r1', multiplier: '1' }, { multiplier: 1 }])
    assert.equal(validReplyRhythmPacing(bad), null);
});

test('visible characters: a combined emoji is one, whitespace is none', () => {
  assert.equal(visibleLength('你好 👋'), 3);
  assert.equal(visibleLength('👨‍👩‍👧'), 1);
  assert.equal(visibleLength('🇨🇳！'), 2);
  assert.equal(visibleLength(' \n\t'), 0);
  assert.equal(visibleLength('3.14'), 4);
  const family = '字'.repeat(46) + '👨‍👩‍👧' + '尾';
  assert.equal(graphemeBoundaryAtOrBefore(family, 0, 48), 46, 'a page never ends inside the family emoji');
  assert.equal(graphemeBoundaryAtOrBefore('字'.repeat(60), 0, 48), 48);
  assert.equal(bubbleHoldMs(0), 650);
  assert.equal(bubbleHoldMs(20), 1650);
  assert.equal(bubbleHoldMs(100), 4000);
  assert.equal(bubbleHoldMs(20, 1.1), 1650 * 1.1);
});

test('兜底（待定）: the user turn shape looks at the shape only: very short, venting, or anything else', () => {
  assert.equal(userTurnShape('嗯'), 'short');
  assert.equal(userTurnShape('哈哈哈哈'), 'short');
  assert.equal(userTurnShape('在吗？'), 'other', 'a question wants an answer');
  assert.equal(userTurnShape('今天天气不错，出去走了走'), 'other');
  const vent = '今天真的好累，' + '加班到十点，回家路上又下雨，鞋子全湿了，'.repeat(6) + '我真的有点撑不住了。';
  assert.ok(visibleLength(vent) >= 120);
  assert.equal(userTurnShape(vent), 'venting');
  assert.equal(userTurnShape(vent + '你说我该怎么办？'), 'other', 'asking her for something');
  assert.equal(userTurnShape(vent + ' https://example.com'), 'other');
  const story = '今天去了公园，' + '看到很多人在放风筝，还有小孩在追鸽子，'.repeat(7);
  assert.equal(userTurnShape(story), 'other', 'long but no emotion');
  assert.equal(userTurnShape(story, 'low'), 'venting', 'her read of the user (F2) counts');
});

test('兜底（待定）: the user pace: three very short messages within a minute each are quick; pouring out is venting; nothing else counts', () => {
  const pace = new UserPaceTracker();
  assert.equal(pace.note(0, '嗯'), null);
  assert.equal(pace.note(20_000, '好'), null);
  assert.equal(pace.note(40_000, '哈哈'), 'quick');
  assert.equal(pace.note(130_000, '嗯嗯'), null, 'a gap over a minute');
  assert.equal(pace.note(140_000, '对'), null);
  assert.equal(pace.note(150_000, '是'), 'quick');
  assert.equal(pace.note(160_000, '你今天怎么样？'), null);
  const vent = '今天真的好累，' + '加班到十点，回家路上又下雨，鞋子全湿了，'.repeat(6) + '我真的有点撑不住了。';
  assert.equal(pace.note(170_000, vent), 'venting');
  // No text is kept: only shapes and times.
  assert.ok(!JSON.stringify(pace).includes('加班'));
  assert.ok(!JSON.stringify(pace).includes('哈哈'));
});

test('兜底（待定）: "……" stops only inside a later bubble, with text after it, and never in code or next to a link', () => {
  const raw = '第一句……还是第一句。我……其实挺想你的。';
  const first = raw.indexOf('。') + 1;
  assert.equal(ellipsisStop(raw, 0, first, first), null, 'R27: the first bubble never stops');
  assert.equal(ellipsisStop(raw, first, raw.length, first), first + 3);
  assert.equal(ellipsisStop('首句。结尾……', 3, 7, 3), null, 'nothing after it');
  assert.equal(ellipsisStop('首句。看 `a……b` 这里。', 3, 15, 3), null);
  assert.equal(ellipsisStop('首句。链接 https://x.cn/…… 看看。', 3, 26, 3), null);
  assert.ok(isAfterthought('对了，明天记得带伞。'));
  assert.ok(isAfterthought('\n啊对了……'));
  assert.ok(isAfterthought('话说你吃饭了吗？'));
  assert.ok(isAfterthought('还有啊，别熬夜。'));
  assert.ok(!isAfterthought('你说对了。'));
  assert.ok(!isAfterthought('还有一件事。'));
});
