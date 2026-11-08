// F7 说话节奏 in the host (electron/reply-rhythm-host.ts): frozen once per reply from the voice's snapshot, and the developer panel's
// readout. By default (兜底 off) nothing goes to the windows or the journal: the panel only shows what the
// fallback would have done. The tests marked 兜底（待定） turn it on to check its mechanics (sent with the reply's id, one journal
// line of numbers and categories, the voice listening trial), not final numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyRhythmHost, type ReplyRhythmTurn } from '../electron/reply-rhythm-host';
import { buildJournalEntry, describeJournalEntry, type JournalInput } from '../shared/journal';
import { formatRhythmMultiplier, type ReplyRhythmPacing } from '../shared/reply-rhythm';
import { formatReplyRhythmLine } from '../src/ui/MoodPanel';
import { setUiLanguage } from '../shared/ui-language';
import { uiText } from '../src/ui/ui-language';

const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));
type Snapshot = ReplyRhythmTurn['snapshot'];
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  primary: 'calm', context: 'neutral', companion: null, blush: null,
  intensity: { expression: 50, gaze: 50, posture: 50, playful: 50, text: 50 }, ...over,
});
function host(clock = { now: 1_000 }, applied = true) {
  const sent: ReplyRhythmPacing[] = [], journal: JournalInput[] = [], changed: string[] = [];
  const rhythm = new ReplyRhythmHost({ clock: () => clock.now, applied, send: pacing => sent.push(pacing), journal: input => journal.push(input), changed: id => changed.push(id) });
  return { rhythm, sent, journal, changed, clock };
}
const turn = (over: Partial<ReplyRhythmTurn> = {}): ReplyRhythmTurn => ({ replyId: 'r1', characterId: 'gene', snapshot: snapshot(), userText: '今天上班遇到一件很好玩的事情，想跟你说说', developerMode: false, ...over });

test('by default (兜底 off) the pace is only read: nothing goes to the windows or the journal, and the panel says it is not in use', () => {
  assert.equal(new ReplyRhythmHost().view('gene').applied, false, 'the default is off');
  const { rhythm, sent, journal, changed } = host(undefined, false);
  const cue = rhythm.freeze(turn({ fatigue: 'drowsy' }))!;
  assert.ok(cue.multiplier > 1);
  assert.deepEqual(sent, []); assert.deepEqual(journal, []); assert.deepEqual(changed, ['gene']);
  assert.equal(rhythm.view('gene').applied, false);
  assert.equal(formatReplyRhythmLine(rhythm.view('gene')), `这条回复的节奏（兜底，未启用，气泡照旧）：${formatRhythmMultiplier(cue.multiplier)}（平常、困了）· 文字语气强度 50`);
  // A reply's inputs are read inside the host: a throwing mood or user state never reaches the chat.
  assert.equal(rhythm.freeze(() => { throw Error('mood not ready'); }), null);
});

test('one pace per reply: a second freeze (her mood moved on) returns the first', () => {
  const { rhythm, sent, journal, changed } = host();
  const cue = rhythm.freeze(turn({ snapshot: snapshot({ primary: 'sad' }), fatigue: 'drowsy' }))!;
  const again = rhythm.freeze(() => turn({ snapshot: snapshot({ primary: 'excited', context: 'positive' }) }))!;
  assert.equal(again, cue);
  assert.equal(sent.length, 1); assert.equal(journal.length, 1); assert.deepEqual(changed, ['gene']);
  assert.deepEqual(sent, [{ id: 'r1', multiplier: cue.multiplier, shy: false }], '兜底（待定）: the windows get the id, the multiplier and shyness only');
  assert.equal(rhythm.cue('r1'), cue);
  assert.equal(rhythm.freeze(turn({ replyId: 'bad id' })), null);
});

test('兜底（待定）: shy only while the blush is visibly there; 文字语气强度 0 turns the bubble pace off', () => {
  const { rhythm } = host();
  const blush = (amount: number) => ({ id: 'b', at: 0, until: 1, strength: 1, reason: 'semantic' as const, ageMs: 0, amount,
    profile: { enabled: true, intensity: 35, size: 50, riseMs: 450, holdMs: 1200, fadeMs: 1800, cooldownMs: 60_000 } });
  assert.equal(rhythm.freeze(turn({ replyId: 'a', snapshot: snapshot({ blush: blush(0.3) }) }))!.shy, true);
  assert.equal(rhythm.freeze(turn({ replyId: 'b', snapshot: snapshot({ blush: blush(0.01) }) }))!.shy, false);
  const off = rhythm.freeze(turn({ replyId: 'c', snapshot: snapshot({ primary: 'sad', intensity: { expression: 50, gaze: 50, posture: 50, playful: 50, text: 0 } }), fatigue: 'falling-asleep' }))!;
  assert.equal(off.multiplier, 1);
});

test('兜底（待定）: the user\'s pace comes from the shape of their messages and the times only', () => {
  const { rhythm, clock } = host();
  let last = null;
  for (const [i, id] of ['q1', 'q2', 'q3'].entries()) { clock.now = 1_000 + i * 15_000; last = rhythm.freeze(turn({ replyId: id, userText: ['嗯', '好呀', '哈哈'][i] })); }
  assert.equal(last!.user, 'quick'); assert.ok(last!.multiplier < 1);
  clock.now += 10_000;
  const vent = rhythm.freeze(turn({ replyId: 'v', userText: '今天真的好累，' + '加班到十点，回家路上又下雨，鞋子全湿了，'.repeat(6) + '我真的有点撑不住了。' }))!;
  assert.equal(vent.user, 'venting'); assert.ok(vent.multiplier > 1);
  assert.ok(!JSON.stringify(rhythm).includes('加班'), 'no message text is kept');
});

test('兜底（待定）: the journal line holds only the numbers and categories, through the whitelist', () => {
  const { rhythm, journal } = host();
  const cue = rhythm.freeze(turn({ snapshot: snapshot({ primary: 'happy', companion: 'playful' }), userText: '我今天被老板骂了，秘密口令是蓝色长颈鹿' }))!;
  const entry = buildJournalEntry(journal[0], Date.UTC(2026, 10, 3, 19, 42))!;
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'characterId', 'fatigue', 'mood', 'multiplier', 'reason', 'shy', 'tendency', 'time', 'type', 'user', 'v']);
  assert.ok(!JSON.stringify(entry).includes('老板') && !JSON.stringify(entry).includes('长颈鹿'));
  assert.equal(entry.reason, '这条回复的节奏');
  const at = new Date(2026, 10, 3, 11, 42).getTime();
  assert.equal(describeJournalEntry(buildJournalEntry(journal[0], at)!, plain), `11:42 这条回复的节奏：${formatRhythmMultiplier(cue.multiplier)}（开心、爱玩）`);
  // Out of range or foreign values refuse the whole line.
  for (const bad of [{ multiplier: 2 }, { mood: 'angry' }, { fatigue: 'tipsy' }, { tendency: 'cautious' }, { user: 'slow' }])
    assert.equal(buildJournalEntry({ ...journal[0], ...bad }, at), null, JSON.stringify(bad));
  setUiLanguage('en');
  try { assert.equal(describeJournalEntry(buildJournalEntry(journal[0], at)!, uiText), `11:42 This reply’s pace: ${formatRhythmMultiplier(cue.multiplier)} (Happy, Playful)`); }
  finally { setUiLanguage('zh-CN'); }
});

test('兜底（待定）: developer view and the listening trial: off by default, developer mode only, never on a fast reply, only after the first sentence', () => {
  const { rhythm } = host();
  assert.deepEqual(rhythm.view('gene'), { cue: null, at: null, applied: true, voiceTrial: false });
  assert.equal(formatReplyRhythmLine(rhythm.view('gene')), '这条回复的节奏：还没有回复');
  const slow = rhythm.freeze(turn({ replyId: 's1', fatigue: 'falling-asleep', developerMode: true }))!;
  assert.equal(slow.voiceGapMs, 0, 'the trial is off by default');
  assert.equal(rhythm.setVoiceTrial(true, false), false, 'not outside developer mode');
  assert.equal(rhythm.setVoiceTrial(true, true), true);
  const trial = rhythm.freeze(turn({ replyId: 's2', fatigue: 'falling-asleep', developerMode: true }))!;
  assert.ok(trial.voiceGapMs > 0 && trial.voiceGapMs <= 200);
  assert.deepEqual(rhythm.withGap({ replyId: 's2', index: 0, text: 'a' }), { replyId: 's2', index: 0, text: 'a' }, 'the first sentence speaks at once');
  assert.deepEqual(rhythm.withGap({ replyId: 's2', index: 1, text: 'b' }), { replyId: 's2', index: 1, text: 'b', pauseBeforeMs: trial.voiceGapMs });
  assert.deepEqual(rhythm.withGap({ replyId: 'old', index: 1, text: 'b' }), { replyId: 'old', index: 1, text: 'b' }, 'only the latest reply');
  const notDev = rhythm.freeze(turn({ replyId: 's3', fatigue: 'falling-asleep', developerMode: false }))!;
  assert.equal(notDev.voiceGapMs, 0, 'developer mode turned off: no gap');
  const fast = rhythm.freeze(turn({ replyId: 's4', snapshot: snapshot({ primary: 'excited', context: 'positive' }), developerMode: true }))!;
  assert.equal(fast.voiceGapMs, 0);
  assert.equal(formatReplyRhythmLine(rhythm.view('gene')), `这条回复的节奏：${formatRhythmMultiplier(fast.multiplier)}（兴奋）· 文字语气强度 50`);
  assert.equal(rhythm.view('other').cue, null, 'another character has no pace yet');
  assert.equal(rhythm.view('gene').voiceTrial, true);
});

test('a throwing window, journal or panel never disturbs the reply', () => {
  const rhythm = new ReplyRhythmHost({ applied: true, send: () => { throw Error('closed'); }, journal: () => { throw Error('disk'); }, changed: () => { throw Error('gone'); } });
  assert.equal(rhythm.freeze(turn())!.multiplier, 1);
});
