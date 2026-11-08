/**
 * "这会儿……"的门槛（shared/mood-tendency.ts，I-020 各功能共用）：她的数值回到基线时总会高出一丝（隔一天还高 1e-11），心情模型的
 * companion 照样会写"想黏着你"。#8、#11、#21、#26 的"此刻"都只认够强的倾向，所以"为什么"里只写从此刻状态来的真实理由。
 * 用真的心情模型（摸头后 O 高 10 点，再过 1 / 6 / 24 小时）造此刻；不读任何配置或角色卡。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceMood, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot, type MoodSnapshot } from '../shared/mood';
import { MOOD_TENDENCY_MIN, tendencyNow } from '../shared/mood-tendency';
import { boredomTimingNow, drawBoredomRound, EMPTY_BOREDOM_HISTORY } from '../shared/behaviors/boredom-timing/choose';
import { chooseIdleGesture, idleGestureNow } from '../shared/behaviors/idle-gesture/choose';
import { TOUCH_FEED_TENDENCY_MIN, touchFeedNow } from '../shared/behaviors/touch-feed-effect/choose';
import { BLUSH_TENDENCY_MIN, blushNow } from '../shared/behaviors/blush/choose';
import { seeded } from './helpers/seeded';

const HOUR = 3_600_000;
const p = DEFAULT_MOOD_PARAMETERS;
/** O raised by 10 (a pat's worth), then `hours` later. */
function after(hours: number): MoodSnapshot {
  const state = createMoodState(0, p);
  state.values.O = p.baseline.O + 10;
  return getMoodSnapshot(advanceMood(state, hours * HOUR, { online: true }, p), hours * HOUR, p);
}
const NOW_WORDS = /这会儿有点调皮|这会儿想黏着你|这会儿很放松|这会儿有点拘谨/u;

test('one threshold for every feature; a day later the mood model still names "close", the features do not', () => {
  assert.equal(TOUCH_FEED_TENDENCY_MIN, MOOD_TENDENCY_MIN); assert.equal(BLUSH_TENDENCY_MIN, MOOD_TENDENCY_MIN);
  const day = after(24), hour = after(1), fresh = after(0);
  assert.equal(day.companion, 'close', 'the mood model itself: any value above 0 counts');
  assert.ok(day.tendencies.close > 0 && day.tendencies.close < 1e-9, `${day.tendencies.close}`);
  for (const [name, s, expected] of [['fresh', fresh, 'close'], ['an hour', hour, 'close'], ['six hours', after(6), null], ['a day', day, null]] as const) {
    assert.equal(tendencyNow(s), expected, name);
    assert.equal(boredomTimingNow({ snapshot: s, personality: null, fatiguePhase: null }).tendency, expected, `#8 ${name}`);
    assert.equal(idleGestureNow({ kind: 'look', source: 'rule', snapshot: s, personality: null, contacts: [], fatiguePhase: null, now: 0 }).tendency, expected, `#11 ${name}`);
    assert.equal(touchFeedNow({ snapshot: s, personality: null, fatiguePhase: null }).tendency, expected, `#21 ${name}`);
    assert.equal(blushNow({ snapshot: s, personality: null, fatiguePhase: null, trigger: 'touch' }).tendency, expected, `#26 ${name}`);
  }
  // Wistful comes from a real reunion and needs no strength; a label alone (no tendencies given) counts as before.
  assert.equal(tendencyNow({ companion: 'wistful', tendencies: { playful: 0, close: 0, comfortable: 0, cautious: 0 } }), 'wistful');
  assert.equal(tendencyNow({ companion: 'close' }), 'close');
  assert.equal(tendencyNow({ companion: 'close', tendencies: { close: Number.NaN } }), null);
  assert.equal(tendencyNow({ companion: null }), null);
});

test('#8 and #11 at rest a day later: the why never says "这会儿……"; right after the pat it does, when it leaned the pick', () => {
  const day = after(24), fresh = after(0);
  const whys = (s: MoodSnapshot) => {
    const out: string[] = [];
    const random = seeded(26);
    for (let i = 0; i < 300; i++) {
      out.push(...drawBoredomRound(p.boredom, boredomTimingNow({ snapshot: s, personality: null, fatiguePhase: null }), { boredom: 0, idleMinutes: 0 }, EMPTY_BOREDOM_HISTORY, random).why);
      for (const kind of ['look', 'motion'] as const)
        out.push(...chooseIdleGesture(idleGestureNow({ kind, source: 'rule', snapshot: s, personality: null, contacts: [], fatiguePhase: null, now: 0 }), { shapes: [], faces: [] }, random)!.why);
    }
    return out.join('\n');
  };
  assert.doesNotMatch(whys(day), NOW_WORDS);
  assert.match(whys(fresh), /这会儿想黏着你/u);
});
