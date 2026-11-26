/**
 * Mood batch 1 (docs/claude/2026-11-11-mood-batch1.md): one shared mood guide for the three models that move her mood, and 害怕
 * (I-076, the user chose A). Synthetic numbers only; no model call.
 *
 * What it pins: the guide's threshold sentences come from the very constants the label rule reads (change one and the text changes,
 * and the label boundary moves with it); the three prompts carry the guide (full for haiku, compact for Opus) and now/baseline
 * numbers; parsing and caps did not change (only "fright" and "scare" were added); 害怕 needs its frightening cause, the same numbers
 * without it read exactly as before, and comfort afterwards leaves it; a haiku "scare" lift carries the cause, other events do not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOOD_PARAMETERS, MOOD_CHANNELS, MOOD_CONTEXTS, MOOD_LABEL_IDS, MOOD_LABEL_THRESHOLDS, applyMoodEvent, applyMoodLift, createMoodState,
  getMoodSnapshot, moodLevel, type MoodContext, type MoodState, type MoodValues,
} from '../shared/foundation/mood';
import { MOOD_LABELS } from '../shared/mood/mood-runtime';
import { MOOD_PRESETS, moodValueForLevel } from '../shared/foundation/mood-presets';
import { MOOD_GUIDE_COMPACT, moodGuideFull, moodLabelRuleLines, moodNowCompact, moodNowFull } from '../shared/foundation/mood-guide';
import { parseReactionAnswer, reactionPrompt, reactionSystemPrompt, scoreReactions } from '../shared/behaviors/reactions/choose';
import { WORD_EVENT_IDS } from '../shared/behaviors/reactions/events';
import { REACTION_KNOBS } from '../shared/behaviors/reactions/knobs';
import { deriveDispositions } from '../shared/behaviors/reactions/dispositions';
import { MOOD_JUDGE_SYSTEM_PROMPT, moodJudgePrompt, parseMoodJudgeAnswer } from '../shared/behaviors/mood-judge/choose';
import { MoodReplyProtocol, TAIL_CHANNEL_SENTENCE_BEFORE, TAIL_CONTEXTS_BEFORE } from '../electron/mood/mood-chat';
import { ReactionHost, type ReactionNowSource } from '../electron/mood/reactions/host';
import { FakeReactionJudge } from '../shared/behaviors/reactions/fake';
import { selectSpeechEmotion } from '../electron/mood/speech-emotion';

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const P = DEFAULT_MOOD_PARAMETERS;
const at = (levels: Partial<MoodValues>, context: MoodContext, p = P): MoodState => {
  const state = createMoodState(T0, p);
  for (const c of MOOD_CHANNELS) if (levels[c] !== undefined) state.values[c] = moodValueForLevel(levels[c]!, p.baseline[c], p.evidence.level);
  state.reason = { text: 'test', at: T0, context, eventId: 'e0' };
  return state;
};
const label = (state: MoodState, p = P) => getMoodSnapshot(state, T0, p).primary;
const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test('the guide writes its combination rules from the label constants, so a changed threshold changes the text', () => {
  const T = MOOD_LABEL_THRESHOLDS;
  const lines = moodLabelRuleLines().join('；');
  assert.ok(lines.includes(`C≥${T.tension.min.C}、N≥${T.tension.min.N}`));
  assert.ok(lines.includes(`N≥${T.afraid.min.N}、C≥${T.afraid.min.C}、E≤${T.afraid.max.E}`));
  assert.ok(lines.includes(`D≥${T.happy.min.D}、E≥${T.happy.min.E}`));
  assert.ok(lines.includes(`D≥${T.excited.min.D}、N≥${T.excited.min.N}`));
  assert.ok(lines.includes(`O≥${T.close.min.O}、E≥${T.close.min.E}、C<${T.close.below.C}`));
  assert.ok(lines.includes(`E≥${T.content.min.E}、N≤${T.content.max.N}、C≤${T.content.max.C}`));
  assert.ok(lines.includes(`D≤${T.disappointed.max.D}`));
  const changed = deepClone(T) as unknown as { happy: { min: { D: number } }; afraid: { max: { E: number } } };
  changed.happy.min.D = 61; changed.afraid.max.E = 44;
  const text = moodGuideFull(changed as typeof T);
  assert.ok(text.includes('D≥61、E≥55') && !text.includes('D≥60、E≥55'), 'a changed happy threshold shows in the guide');
  assert.ok(text.includes('E≤44'));
  assert.ok(moodGuideFull().includes(moodLabelRuleLines().join('；')), 'the full guide carries the generated rules verbatim');
});

test('the label rule reads the same constants: each boundary sits exactly where the guide says', () => {
  const T = MOOD_LABEL_THRESHOLDS;
  assert.equal(label(at({ D: T.happy.min.D, E: T.happy.min.E }, 'positive')), 'happy');
  assert.equal(label(at({ D: T.happy.min.D - 0.5, E: T.happy.min.E }, 'positive')), 'calm');
  assert.equal(label(at({ N: T.tension.min.N, C: T.tension.min.C }, 'neutral')), 'concerned');
  assert.equal(label(at({ N: T.tension.min.N - 0.5, C: T.tension.min.C }, 'neutral')), 'calm');
  assert.equal(label(at({ O: T.close.min.O, E: T.close.min.E, C: T.close.below.C - 0.5 }, 'neutral')), 'close');
  assert.equal(label(at({ E: T.content.min.E, N: T.content.max.N, C: T.content.max.C }, 'neutral')), 'content');
  // moodLevel is the label rule's own reading (a card whose baseline is not 50).
  const p = deepClone(P); p.baseline.D = 30;
  assert.equal(Math.round(moodLevel(44, 30)), 60);
  assert.equal(label(at({ D: 60, E: 55 }, 'positive', p), p), 'happy');
});

test('害怕 needs a frightening cause; the same numbers without it read exactly as before; comfort afterwards leaves it', () => {
  const T = MOOD_LABEL_THRESHOLDS.afraid;
  const scared = { N: T.min.N, C: T.min.C, E: T.max.E };
  assert.equal(label(at(scared, 'fright')), 'afraid');
  assert.equal(label(at(scared, 'neutral')), 'calm', 'no cause: what these numbers always gave');
  assert.equal(label(at({ N: 70, C: 70, E: 40 }, 'neutral')), 'concerned', 'no cause, higher numbers: still 担心 as before');
  assert.equal(label(at({ ...scared, E: T.max.E + 1 }, 'fright')), 'calm', 'E not low: not 害怕');
  assert.equal(label(at({ ...scared, N: T.min.N - 1 }, 'fright')), 'calm', 'N not up: not 害怕');
  // The preset (测试命令) shows 害怕 and its cause.
  assert.equal(label(at(MOOD_PRESETS.afraid.levels, MOOD_PRESETS.afraid.context)), 'afraid');
  // Comfort: a soothing lift (E up, C down) is a new moment of support: 害怕 ends.
  const comforted = applyMoodLift(at({ N: 62, C: 58, E: 42 }, 'fright'), { id: 'comfort', delta: { E: 6, C: -5, O: 3 }, reason: '被安慰', context: 'support' }, T0 + 1_000);
  assert.notEqual(getMoodSnapshot(comforted, T0 + 1_000).primary, 'afraid');
  // A fright lift validated end to end (the context list accepts it, the trend records it).
  const lifted = applyMoodLift(createMoodState(T0), { id: 'scare', delta: { N: 20, C: 20, E: -10 }, reason: 'scare', context: 'fright' }, T0 + 1_000);
  assert.equal(getMoodSnapshot(lifted, T0 + 1_000).primary, 'afraid');
  assert.equal(getMoodSnapshot(lifted, T0 + 40_000).primary === 'afraid', false, 'the cause fades with the usual 30 s context window');
  assert.throws(() => applyMoodEvent(createMoodState(T0), { type: 'chat', id: 'x', context: 'scared' as MoodContext }, T0));
});

test('the label lists: 害怕 everywhere the UI and journal read labels, "fright" everywhere contexts are validated', () => {
  assert.deepEqual(new Set(Object.keys(MOOD_LABELS)), new Set(MOOD_LABEL_IDS));
  assert.equal(MOOD_LABELS.afraid, '害怕');
  assert.ok(MOOD_CONTEXTS.includes('fright'));
  // The voice path validates both lists (an unknown one would throw and drop the reply's voice).
  assert.doesNotThrow(() => selectSpeechEmotion({ context: 'fright', primary: 'afraid' }));
});

test('haiku prompts carry the full guide and value / baseline / level; Opus\'s tail carries the compact guide and value / baseline', () => {
  const guide = moodGuideFull();
  assert.ok(reactionSystemPrompt().includes(guide));
  assert.ok(MOOD_JUDGE_SYSTEM_PROMPT.includes(guide));
  assert.ok(guide.includes('多巴胺') && guide.includes('去甲肾上腺素') && guide.includes('B 无聊') && guide.includes('M 想念') && guide.includes('A 腺苷'));
  assert.ok(guide.includes('被吓一跳') && guide.includes('fright'));
  const values: MoodValues = { D: 62, O: 55, E: 44, N: 70, C: 66 }, baseline: MoodValues = { D: 50, O: 40, E: 50, N: 50, C: 50 };
  const dispositions = deriveDispositions(P);
  const scorings = WORD_EVENT_IDS.map(event => scoreReactions(event, { characterId: 'c', dispositions, mood: 'calm', sleepy: false, at: T0, recent: [] }, { random: () => 0.5 }));
  const prompt = reactionPrompt({ dispositions, persona: '', mood: 'calm', moodWords: '平静', fatigue: '', values, baseline, scorings, text: '你好' });
  assert.ok(prompt.includes(moodNowFull(values, baseline)));
  assert.ok(prompt.includes('O 55（基线 40，程度 63）'), prompt);
  const legacy = reactionPrompt({ dispositions, persona: '', mood: 'calm', moodWords: '平静', fatigue: '', values, scorings, text: '你好' });
  assert.ok(legacy.includes('五个数 D 62、O 55'), 'without a baseline the numbers line is what it was');
  const judge = moodJudgePrompt({ characterId: 'c', persona: '', personality: { playful: 1, close: 1, comfortable: 1, cautious: 1 }, values, baseline,
    sensitivity: { D: 1, O: 1, E: 1, N: 1, C: 1 }, label: '平静', fatigue: '', doing: '', at: T0 }, [{ kind: 'bored', at: T0, level: 'look' }]);
  assert.ok(judge.includes('亲近 O 55（基线 40，程度 63）'));
  assert.equal(moodNowCompact(values, baseline), '她现在（值/基线）：D62/50 O55/40 E44/50 N70/50 C66/50。');
  assert.equal(moodNowCompact(null, baseline), '');
  const tail = new MoodReplyProtocol(() => {}, { moodNow: moodNowCompact(values, baseline) }).instruction();
  assert.ok(tail.includes(MOOD_GUIDE_COMPACT + '她现在（值/基线）：D62/50'));
  assert.ok(tail.includes('context只能是neutral/positive/support/concern/disappointment/offense/fright；'));
  assert.ok(!tail.includes(TAIL_CHANNEL_SENTENCE_BEFORE));
  assert.ok(MOOD_GUIDE_COMPACT.length <= 80, `compact guide stays short (${MOOD_GUIDE_COMPACT.length})`);
  const before = new MoodReplyProtocol(() => {}, { guideBefore: true }).instruction();
  assert.ok(before.includes(`context只能是${TAIL_CONTEXTS_BEFORE}；delta只可包含D/O/E/N/C，各值范围-6到6，不确定时为空。${TAIL_CHANNEL_SENTENCE_BEFORE}`), 'the A/B\'s "before" is the old wording');
});

test('parsing and caps are unchanged: the tail\'s ±6, the reaction\'s ±maxDelta and the judge\'s ±6; only fright and scare are new', () => {
  const parseTail = (json: unknown) => { const p = new MoodReplyProtocol(() => {}); p.push(`正文\n${p.start}${JSON.stringify(json)}${p.end}`); return p.finish(); };
  assert.equal(parseTail({ context: 'fright', delta: { N: 6, C: 5, E: -4 }, reason: '被吓到', confidence: 0.9 })?.context, 'fright');
  assert.equal(parseTail({ context: 'scared', delta: {}, reason: 'x', confidence: 0.9 }), null);
  assert.equal(parseTail({ context: 'fright', delta: { N: 7 }, reason: 'x', confidence: 0.9 }), null, 'still ±6');
  assert.equal(parseTail({ context: 'fright', delta: { N: 3 }, reason: 'x', confidence: 0.7 }), null, 'still 0.75 confidence');
  const dispositions = deriveDispositions(P);
  const scorings = WORD_EVENT_IDS.map(event => scoreReactions(event, { characterId: 'c', dispositions, mood: 'calm', sleepy: false, at: T0, recent: [] }, { random: () => 0.5 }));
  assert.deepEqual(parseReactionAnswer(JSON.stringify({ event: 'scare', reactions: [], delta: { N: 6, C: 4, E: -3 }, confidence: 0.8 }), scorings)?.delta, { N: 6, C: 4, E: -3 });
  assert.equal(parseReactionAnswer(JSON.stringify({ event: 'scare', reactions: [], delta: { N: REACTION_KNOBS.maxDelta + 1 }, confidence: 0.8 }), scorings), null);
  assert.equal(parseReactionAnswer(JSON.stringify({ event: 'scare', reactions: [{ id: 'blush', level: 'mid' }], delta: {}, confidence: 0.8 }), scorings), null, 'scare has no reaction rows yet');
  assert.equal(parseMoodJudgeAnswer(JSON.stringify({ delta: { N: 7 }, fits: true, why: 'fits', confidence: 0.9 })), null);
});

test('a haiku "scare" answer lifts with the frightening cause; a praise lifts as before (no context)', async () => {
  const lifts: { id: string; delta: unknown; context?: MoodContext }[] = [];
  // Only the immediate start runs (the delays are 0 here); the call's timeout never fires.
  const timers = { set: (fn: () => void, ms: number) => { if (ms <= 0) queueMicrotask(fn); return 1; }, clear: () => {} };
  const make = (answer: object) => {
    const now = (): ReactionNowSource => ({ characterId: 'c', dispositions: deriveDispositions(P), mood: 'calm', moodWords: '平静', fatigue: '', sleepy: false,
      values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, persona: '' });
    const store = { enabled: true, today: () => 0, noteCall: () => 1, chatsToday: () => 0, noteChat: () => 1 };
    return new ReactionHost({ ask: new FakeReactionJudge(JSON.stringify(answer)).ask, store, now, quiet: () => null, performers: {},
      lift: lift => { lifts.push({ id: lift.id, delta: lift.delta, ...(lift.context ? { context: lift.context } : {}) }); },
      clock: () => T0, timers, random: () => 0.5, localDate: () => 'day', knobs: { warmParallel: false, firstCharWaitMs: 0, startDelayMs: 0 } });
  };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const scare = make({ event: 'scare', reactions: [], delta: { N: 6, C: 4, E: -3 }, confidence: 0.9 });
  scare.userTurn('m1', '哇！'); scare.firstChar('m1'); await flush();
  const praise = make({ event: 'praise', reactions: [], delta: { O: 3 }, confidence: 0.9 });
  praise.userTurn('m2', '你真可爱'); praise.firstChar('m2'); await flush();
  assert.equal(lifts.length, 2, JSON.stringify(lifts));
  assert.equal(lifts[0].context, 'fright');
  assert.equal(lifts[1].context, undefined);
  scare.dispose(); praise.dispose();
});
