// 真实聊天分析第二批 6、7、9、10（docs/claude/2026-11-07-turn-awareness.md）：每轮都说困不困、上一句没读出来时说一次、
// 问歌/视频但听不到看不到时说一次、讲题不用代码块的规则。只用合成数据，不调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnAwareness } from '../electron/turn-awareness-host';
import { LastReplyReading } from '../electron/last-reply-reading';
import { JournalExtras } from '../electron/journal/extras';
import { COMPANION_RULES } from '../shared/companion-rules';
import { CLAUDE_SESSION_SYSTEM_PROMPT } from '../electron/claude-session-prompt';
import { CLAUDE_CHAT_SYSTEM_PROMPT } from '../electron/claude';
import { perceptionTurnLine, type PerceptionTurn } from '../shared/perception-rule';
import { CANNOT_PERCEIVE_MEDIA_LINE, FATIGUE_WORDS, MEDIA_EXPLAIN_GAP_MS, asksAboutSongOrVideo, fatigueTurnLine } from '../shared/turn-awareness';
import type { FatiguePhase } from '../shared/fatigue';

const PHASES = Object.keys(FATIGUE_WORDS) as FatiguePhase[];
const sight: PerceptionTurn = { screen: false, camera: 'off', attached: { screen: false, camera: false }, asked: null };
const turn = (patch: Partial<{ text: unknown; listening: boolean; screenSharing: boolean; scope: string }> = {}) =>
  ({ text: '你好', listening: false, screenSharing: false, scope: 's1', ...patch });
function setup(phase: unknown = 'awake', clock = { now: 1_000 }) {
  const reading = new LastReplyReading();
  const state = { phase, id: 'gene' as string | null };
  const aware = createTurnAwareness({ phase: () => state.phase, characterId: () => state.id, reading, now: () => clock.now });
  return { aware, reading, state, clock };
}
const record = (segmentIndex: number | null, outcome: 'ended' | 'error' | 'cancelled', playback = outcome === 'ended') => ({
  v: 1, provider: 'system', voice: 'v', kind: 'reply', segmentIndex, textLength: 12, outcome, errorCode: outcome === 'error' ? 'failed' : null,
  t: playback ? { playbackStart: 300 } : {}, hostFirstAudioMs: null, baseLatencyMs: null, outputLatencyMs: null, clockLagMs: null, startLeadMs: null,
  deviceColdStartMs: null, sendToFirstAudioMs: null, interSegmentGapMs: null, stalls: 0, quickEnd: false });

test('6 困意：每一轮都照实说，包括清醒；清醒时明说别说自己困，困时才可以带一句', () => {
  for (const phase of PHASES) {
    const { aware } = setup(phase);
    const line = aware.line(turn());
    assert.match(line, new RegExp(`你现在的困意：${FATIGUE_WORDS[phase]}`), phase);
    assert.ok(line.length < 80, phase + ' short: ' + line.length);
  }
  const awake = setup('awake').aware.line(turn());
  assert.match(awake, /清醒/u); assert.match(awake, /你不困，别说自己困/u);
  const tired = setup('drowsy').aware.line(turn());
  assert.match(tired, /很困/u); assert.doesNotMatch(tired, /别说自己困/u); assert.match(tired, /顺口提一句/u);
  // Every turn, not only the first: a second turn says it again, and a changed phase is followed at once.
  const s = setup('awake');
  assert.match(s.aware.line(turn()), /清醒/u); assert.match(s.aware.line(turn()), /清醒/u);
  s.state.phase = 'light-drowsy';
  assert.match(s.aware.line(turn()), /有点困/u);
  // Unknown phase: she is not told a guess.
  assert.equal(setup(null).aware.line(turn()), '');
  assert.equal(fatigueTurnLine('nonsense'), '');
  // It rides on the same single perception line.
  const full = perceptionTurnLine(sight) + awake;
  assert.ok(full.startsWith('【此刻的感知】') && !full.includes('\n'));
});

test('7 上一句没读出来：出错或窗口没显示时下一轮说一次；读完、被停、朗读关着都不说；体验记录关着也照样记', () => {
  const sink = { record: () => undefined, accepting: () => false }; // the journal is OFF
  const extras = new JournalExtras({ sink, characterId: () => 'gene', engine: () => 'local', uptimeMs: () => 1, blushStage: () => {} });
  const aware = createTurnAwareness({ phase: () => 'awake', characterId: () => 'gene', reading: extras.lastReading });
  const unread = (line: string) => /上一句没能读出来/u.test(line);
  // Read fine.
  extras.speechRecord(record(0, 'ended')); extras.speechRecord(record(1, 'ended'));
  assert.ok(!unread(aware.line(turn())));
  // The engine failed on the only segment.
  extras.speechRecord(record(0, 'error', false));
  const first = aware.line(turn());
  assert.match(first, /上一句没能读出来（原因：朗读出错）/u);
  assert.ok(!unread(aware.line(turn())), 'once');
  // Half read, then an error.
  extras.speechRecord(record(0, 'ended')); extras.speechRecord(record(1, 'error', false));
  assert.match(aware.line(turn()), /只读出了一部分/u);
  // The user stopped it: not a failure.
  extras.speechRecord(record(0, 'cancelled', false));
  assert.ok(!unread(aware.line(turn())));
  // Reading on but the pet window not shown.
  extras.reading.unread('hidden');
  assert.match(aware.line(turn()), /桌宠窗口没显示/u);
  // Voice off: the user's own choice, nothing to say.
  extras.reading.unread('off');
  assert.ok(!unread(aware.line(turn())));
  // A new reply that reads fine replaces an untold failure.
  extras.speechRecord(record(0, 'error', false)); extras.speechRecord(record(0, 'ended'));
  assert.ok(!unread(aware.line(turn())));
  // Previews and other speech are not replies; segments of a reply whose start was not seen are ignored.
  extras.speechRecord({ ...record(0, 'error', false), kind: 'preview' });
  assert.ok(!unread(aware.line(turn())));
});

test('7 每个角色各记各的，换角色不串', () => {
  const r = new LastReplyReading();
  r.segment('a', { kind: 'reply', segmentIndex: 0, outcome: 'error' });
  assert.equal(r.take('b'), null); assert.equal(r.take(null), null);
  assert.equal(r.take('a'), 'failed'); assert.equal(r.take('a'), null);
});

test('10 问歌/视频而她听不到看不到：照实说并带上真实的开关名；开着就不说；一段里只说一次，隔了很久再问再说', () => {
  const ask = '你听听这首歌怎么样';
  const { aware, clock } = setup('awake');
  const withAsk = aware.line(turn({ text: ask }));
  assert.ok(withAsk.includes(CANNOT_PERCEIVE_MEDIA_LINE));
  assert.match(CANNOT_PERCEIVE_MEDIA_LINE, /「和她一起听」/u); assert.match(CANNOT_PERCEIVE_MEDIA_LINE, /听不到也看不到/u); assert.match(CANNOT_PERCEIVE_MEDIA_LINE, /不会替用户打开/u);
  clock.now += 60_000;
  assert.ok(!aware.line(turn({ text: '这个视频好看吗' })).includes(CANNOT_PERCEIVE_MEDIA_LINE), 'not twice in a stretch');
  clock.now += MEDIA_EXPLAIN_GAP_MS + 1;
  assert.ok(aware.line(turn({ text: '这个视频好看吗' })).includes(CANNOT_PERCEIVE_MEDIA_LINE), 'a new stretch');
  // A different perception state is a new stretch (the scope carries the switch revision).
  assert.ok(aware.line(turn({ text: ask, scope: 's2' })).includes(CANNOT_PERCEIVE_MEDIA_LINE));
  // Listening or screen sharing on: nothing is explained (it only describes a missing capability).
  assert.ok(!setup().aware.line(turn({ text: ask, listening: true })).includes(CANNOT_PERCEIVE_MEDIA_LINE));
  assert.ok(!setup().aware.line(turn({ text: ask, screenSharing: true })).includes(CANNOT_PERCEIVE_MEDIA_LINE));
  // Not about media: nothing.
  assert.ok(!setup().aware.line(turn({ text: '今天好累啊' })).includes(CANNOT_PERCEIVE_MEDIA_LINE));
});

test('10 判断用户是不是在问歌或视频：问的算，聊别的不算', () => {
  for (const yes of ['这首歌怎么样', '这个视频好看吗', '你听听这个音乐', '看看这个视频', '刚才那首歌好听吗', '这个mv你觉得如何', '你听一下这首歌']) assert.ok(asksAboutSongOrVideo(yes), yes);
  for (const no of ['今天好累', '我想听你唱歌', '我看了一天的视频好困', '这个题怎么做', '你喜欢吃什么', '', undefined, 42]) assert.ok(!asksAboutSongOrVideo(no), String(no));
});

test('9 陪伴规则里有"讲题用短句、不用代码块和 Markdown"，两条提示词路径都带，长度仍在预算内', () => {
  assert.match(COMPANION_RULES, /讲题或解释步骤时，用几句短话一步步说/u);
  assert.match(COMPANION_RULES, /不用代码块、表格和 Markdown 列表，公式用文字写/u);
  assert.ok(CLAUDE_SESSION_SYSTEM_PROMPT.includes('不用代码块、表格和 Markdown 列表'));
  assert.ok(CLAUDE_CHAT_SYSTEM_PROMPT.includes('不用代码块、表格和 Markdown 列表'));
  assert.ok(COMPANION_RULES.length < 900);
});
