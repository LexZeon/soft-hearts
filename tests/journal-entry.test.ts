// 体验记录 (E2): what one journal line may hold (shared/journal.ts). The whitelist is the privacy boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_TYPES, buildJournalEntry, describeJournalEntry, journalDeltaText, journalReason, moodEventSource, readJournalLine, type JournalInput,
} from '../shared/journal';
import { setUiLanguage } from '../shared/ui-language';
import { uiText } from '../src/ui/ui-language';

const AT = Date.UTC(2026, 10, 3, 19, 42, 5);
const values = (n = 50) => ({ D: n, O: n, E: n, N: n, C: n });
const plain = (source: string, ...items: readonly unknown[]) => source.replace(/\{(\d+)\}/g, (_, i: string) => String(items[Number(i)]));

/** One synthetic example of every type (the report's samples come from these). */
const SAMPLES: JournalInput[] = [
  { type: 'mood-event', characterId: 'gene', source: 'touch', before: values(), after: { ...values(), O: 56.4, E: 52.2 }, labelBefore: 'calm', labelAfter: 'content', count: 9, durationMs: 4_200 },
  { type: 'mood-event', characterId: 'gene', source: 'appraisal', context: 'concern', before: values(), after: { ...values(), C: 54 }, labelBefore: 'calm', labelAfter: 'concerned' },
  { type: 'mood-label', characterId: 'gene', from: 'calm', to: 'content' },
  { type: 'boredom', characterId: 'gene', level: 'look', value: 31.2 },
  { type: 'longing', characterId: 'gene', level: 'longing', value: 34, atStart: true },
  { type: 'inner-loop', characterId: 'gene', cue: 'motion', decision: 'switch', result: 'ok', called: true, quiet: false },
  { type: 'her-life', characterId: 'gene', from: 'company', to: 'humming', untilMinutes: 12 },
  { type: 'her-need', characterId: 'gene', event: 'started', need: 'lonely' },
  { type: 'her-need', characterId: 'gene', event: 'faded', need: 'lonely', snubbed: true, dejection: 0.4 },
  { type: 'her-need', characterId: 'gene', event: 'relieved', need: null, relief: 0.4 },
  { type: 'user-state', characterId: 'gene', state: 'tired', confidence: 0.86 },
  { type: 'relationship', characterId: 'gene', kind: 'milestone', dayNumber: 7, togetherDays: 6, qualityDays: 2 },
  { type: 'music', characterId: 'gene', tier: 'nod', score: 0.48 },
  { type: 'rps', characterId: 'gene', event: 'result', origin: 'her', rounds: 4, herWins: 2, userWins: 1, draws: 1, result: 'her', end: 'finished' },
  { type: 'sleep', characterId: 'gene', event: 'asleep', phase: 'asleep' },
  { type: 'app', characterId: 'gene', event: 'start', version: '0.1.0', commit: 'b74e3710aa' },
  { type: 'setting', characterId: 'gene', id: 'readout_volume', previous: 80, value: 60, via: 'agent' },
  { type: 'character', characterId: 'gene', event: 'model-link', linked: true },
  { type: 'journal', characterId: 'gene', event: 'on' },
  { type: 'truncated', characterId: null, day: '2026-11-03' },
  { type: 'reply-rhythm', characterId: 'gene', multiplier: 1.1, mood: 'sad', fatigue: 'drowsy', tendency: 'comfortable', shy: false, user: 'venting' },
  { type: 'motion', characterId: 'gene', kind: 'guard', part: 'bone', name: 'wrist_R', size: 3.15, activities: ['chat-gesture', 'speaking'], fps: 60, frameMs: 16.7 },
  { type: 'speech', characterId: 'gene', provider: 'bailian', failure: 'quota' },
  { type: 'voice-input', characterId: 'gene', engine: 'local', failure: 'needs-component', stopped: false },
  { type: 'audio-reading', characterId: 'gene', engine: 'local', failure: 'timeout', refused: false },
  { type: 'pose', characterId: 'gene', event: 'follow', kind: 'yawn' },
  { type: 'feed', characterId: 'gene', outcome: 'said', category: '甜点', liking: '爱吃' },
  { type: 'agent-words', characterId: 'gene', tool: 'set_setting', item: 'local_asr', value: 'installed', words: 12 },
  // I-027 心情调整员: the closed reason only (tests/i027-mood-judge.test.ts has its own boundary checks).
  { type: 'mood-judge', characterId: 'gene', why: 'too-little', before: values(), after: values(52), labelBefore: 'calm', labelAfter: 'content' },
  // F7 停停说说 · 首字: a number and two flags (tests/f7-pause-talk.test.ts has its own boundary checks).
  { type: 'first-char', characterId: 'gene', ms: 1320, pauseTalk: true, carried: false },
  // 2026-11-06 朗读过后听不见了: counts only, and a closed kind (tests/speech-pause-release.test.ts has the boundary checks).
  { type: 'listen-tally', characterId: 'gene', received: 4, skippedPaused: 2, withText: 1, empty: 1, failed: 0 },
  { type: 'watch-tally', characterId: 'gene', described: 3, skipped: 5, failed: 1, late: 0, summaries: 1, heard: 12, haikuCalls: 4, haikuMs: 5200, keywordHits: 2, cacheFiles: 3, cacheKb: 180 },
  { type: 'pause-stuck', characterId: 'gene', what: 'speech-route' },
  // 2026-11-06 第一批新记录项 (tests/journal-batch1.test.ts has the boundary checks).
  { type: 'reading-time', characterId: 'gene', firstAudioMs: 620, waitMs: 40, chars: 22, provider: 'system', result: 'played', why: null, firstSinceStart: true },
  { type: 'voice-time', characterId: 'gene', ms: 1800, recognizeMs: 1400, seconds: 3.2, result: 'text', engine: 'local' },
  { type: 'voice-capture', characterId: 'gene', end: 'no-sound', chunks: 94, peak: 0, rms: 0, threshold: 0.0029, sampleRate: 48000, device: 'default', pausedAtStart: false, pausedMs: 0, seconds: 8.1 },
  { type: 'blush', characterId: 'gene', outcome: 'blocked', source: 'words', why: 'cooldown', dO: 1, dE: 0, dN: 0 },
  { type: 'her-gesture', characterId: 'gene', gesture: 'wink', answer: 'played', waited: false },
  { type: 'fatigue-phase', characterId: 'gene', from: 'awake', to: 'light-drowsy', A: 0.71, F: 0.52, W: 0, clock: 0.09, mood: -0.02 },
  { type: 'topmost-fix', characterId: 'gene', outcome: 'forced', visible: true, nth: 2 },
  { type: 'launch-time', characterId: 'gene', ms: 8123 },
  { type: 'draft-filter', characterId: 'gene', english: 1, plan: 2, format: 0, garbled: 0, chars: 140, whole: false },
  { type: 'reaction', characterId: 'gene', event: 'praise', decider: 'haiku', haiku: 'answered', candidates: [{ id: 'shy', score: 69.8 }], picks: [{ id: 'shy', level: 'mid', done: true }, { id: 'blush', level: 'light', done: false, why: 'showing' }] },
  { type: 'reply-check', characterId: 'gene', marker: 'missing', before: 0, cut: 96, rules: ['body-label', 'tail-word'], residue: [], whole: false },
];

test('every type builds a line with the version, the time and a fixed reason, and reads back the same', () => {
  const types = new Set<string>();
  for (const input of SAMPLES) {
    const entry = buildJournalEntry(input, AT);
    assert.ok(entry, input.type);
    types.add(entry.type);
    assert.equal(entry.v, 1); assert.equal(entry.at, AT); assert.equal(entry.time, '2026-11-03T19:42:05.000Z');
    assert.equal(entry.reason, journalReason(input));
    assert.deepEqual(readJournalLine(JSON.stringify(entry)), entry);
  }
  assert.deepEqual([...types].sort(), [...JOURNAL_TYPES].sort());
});

test('free text never reaches a line: unknown fields are dropped, text in enum places refuses the whole line', () => {
  const secret = '我今天被老板骂了，秘密口令是蓝色长颈鹿';
  const smuggled = { ...SAMPLES[0], reason: secret, text: secret, message: secret, path: 'C:\\Users\\x\\diary.txt', apiKey: 'sk-123' } as unknown;
  const entry = buildJournalEntry(smuggled, AT)!;
  assert.ok(entry);
  const line = JSON.stringify(entry);
  for (const word of ['老板', '蓝色长颈鹿', 'diary', 'sk-123', 'apiKey', 'message']) assert.ok(!line.includes(word), word);
  assert.equal(entry.reason, '你摸了摸头');
  // An unknown type is no line at all (it never passes through as it came).
  for (const odd of [{ type: 'chat-text', characterId: 'gene', text: secret }, { type: 'reason', reason: secret }, null, 'mood-label', [SAMPLES[2]]])
    assert.equal(buildJournalEntry(odd, AT), null, JSON.stringify(odd));
  // Text where only a closed value may stand refuses the line instead of keeping the text.
  for (const bad of [
    { ...SAMPLES[2], to: secret }, { ...SAMPLES[6], to: secret }, { ...SAMPLES[10], state: secret }, { ...SAMPLES[1], source: secret },
    { ...SAMPLES[15], version: secret }, { ...SAMPLES[16], value: secret }, { ...SAMPLES[16], id: 'api_key' }, { ...SAMPLES[0], characterId: '../x' },
  ]) assert.equal(buildJournalEntry(bad, AT), null, JSON.stringify(bad).slice(0, 80));
  // A setting value that is text is only ever one of the catalog's own enum values (fps is numeric; read_aloud boolean).
  assert.equal(buildJournalEntry({ type: 'setting', characterId: null, id: 'fps', previous: 30, value: 60, via: 'chat' }, AT)?.reason, '通过聊天卡片改了设置');
  // A commit that is not hex is dropped, the line stays.
  assert.equal((buildJournalEntry({ ...SAMPLES[15], commit: 'not a commit' }, AT) as { commit?: unknown } | null)?.commit, null);
});

test('a mood event reason maps to a fixed source; a model reason is never looked at', () => {
  assert.equal(moodEventSource('rua', undefined), 'touch');
  assert.equal(moodEventSource('rua', '有效捏脸'), 'cheek');
  assert.equal(moodEventSource('food', '随便什么'), 'food');
  assert.equal(moodEventSource('chat', '收到用户聊天'), 'chat');
  assert.equal(moodEventSource('chat', '收到用户语音'), 'voice');
  assert.equal(moodEventSource('chat', '和用户玩了猜拳'), 'game');
  assert.equal(moodEventSource('chat', '用户说了一个秘密'), 'chat-other');
  // Even an appraisal whose words happen to match a fixed reason stays an appraisal: its words are never read.
  assert.equal(moodEventSource('appraisal', '有效捏脸'), 'appraisal');
  assert.equal(moodEventSource('appraisal', '被用户哄好了'), 'appraisal');
  assert.equal(moodEventSource('lift', '被用户哄好了'), 'soothed');
  assert.equal(moodEventSource('lift', '一个人待了一会儿，有点低落'), 'dip');
  assert.equal(moodEventSource('lift', '用户来了，松了口气'), 'relief');
  assert.equal(moodEventSource('lift', 'anything else'), 'lift-other');
});

test('the panel line reads like "11:42 你摸了摸头 → 亲近 +6，现在：满足"', () => {
  const at = new Date(2026, 10, 3, 11, 42).getTime();
  const line = describeJournalEntry(buildJournalEntry(SAMPLES[0], at)!, plain);
  assert.equal(line, '11:42 你摸了摸头（4 秒） → 亲近 +6、舒适 +2，现在：满足');
  assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[2], at)!, plain), '11:42 心情：平静 → 满足');
  assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[5], at)!, plain), '11:42 内心循环：换件事做（完成）');
  assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[13], at)!, plain), '11:42 猜拳结束：她赢 2 · 你赢 1 · 平 1');
  assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[16], at)!, plain), '11:42 通过内部通道改了设置「朗读音量」：80% → 60%');
  assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[4], at)!, plain), '11:42 她开始想你了（打开应用时）');
  assert.equal(journalDeltaText(values(), values(), plain), '');
});

test('English lines come from the catalog, with the same numbers', () => {
  setUiLanguage('en');
  try {
    const at = new Date(2026, 10, 3, 11, 42).getTime();
    assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[0], at)!, uiText), '11:42 You patted her head (4 s) → Closeness +6, Comfort +2, now: Content');
    assert.equal(describeJournalEntry(buildJournalEntry(SAMPLES[10], at)!, uiText), '11:42 She thinks you are tired (confidence 0.86)');
    for (const input of SAMPLES) {
      const text = describeJournalEntry(buildJournalEntry(input, at)!, uiText);
      assert.ok(!/[\u4e00-\u9fff]/u.test(text), text);
    }
  } finally { setUiLanguage('zh-CN'); }
});
