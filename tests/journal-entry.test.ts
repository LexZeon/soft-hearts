// 体验记录 (E2): what one journal line may hold (shared/memory/journal.ts). The whitelist is the privacy boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_TYPES, buildJournalEntry, describeJournalEntry, journalDeltaText, journalReason, moodEventSource, readJournalLine, type JournalInput,
} from '../shared/memory/journal';
import { setUiLanguage } from '../shared/foundation/ui-language';
import { uiText } from '../src/foundation/ui-language';

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
  { type: 'watch-off', characterId: 'gene', why: 'window-gone' },
  { type: 'watch-change', characterId: 'gene', event: 'share-lost', why: 'capture-lost' },
  { type: 'watch-change', characterId: 'gene', event: 'resumed', awayS: 300 },
  // P-001: a closed event and a count (tests/p001-upcoming-wiring.test.ts has the boundary checks).
  { type: 'upcoming', characterId: 'gene', event: 'recorded', count: 2 },
  // I-059: closed event, kind of day and who was first (tests/i059-special-day.test.ts has the boundary checks).
  { type: 'special-day', characterId: 'gene', event: 'said', kind: 'birthday', first: 'her' },
  // I-061: link state, failure category, version, who started it (tests/i061-diagnostics.test.ts has the boundary checks).
  { type: 'claude-link', characterId: null, state: 'failed', failure: 'arguments', version: '2.1.319', trigger: 'manual' },
  { type: 'claude-link', characterId: null, state: 'unverified', version: '2.1.316', trigger: 'auto', unreadable: 'repeated-same', rows: 2, headerRepeated: true },
  // Overhaul step 7: one unit switched off alone (tests/part-units.test.ts has the boundary checks).
  { type: 'part-off', characterId: 'gene', part: 'senses', unit: 'face-check', failure: 'start:TypeError' },
  // I-066: a closed outcome and reason; a screen look's category (tests/i066-presence.test.ts has the boundary checks).
  { type: 'speech-cue', characterId: 'gene', outcome: 'held', why: 'away' },
  { type: 'presence-look', characterId: 'gene', look: 'meeting' },
  { type: 'give', characterId: 'gene', event: 'taken', item: 'snack', why: ['still', 'playful'], fromFed: true },
  { type: 'give', characterId: 'gene', event: 'picture', item: 'cushion', why: ['night'], picture: 'late' },
  // 2026-11-06 第一批新记录项 (tests/journal-batch1.test.ts has the boundary checks).
  { type: 'reading-time', characterId: 'gene', firstAudioMs: 620, waitMs: 40, chars: 22, provider: 'system', result: 'played', why: null, firstSinceStart: true },
  { type: 'voice-time', characterId: 'gene', ms: 1800, recognizeMs: 1400, seconds: 3.2, result: 'text', engine: 'local' },
  { type: 'voice-capture', characterId: 'gene', end: 'no-sound', chunks: 94, peak: 0, rms: 0, threshold: 0.0029, sampleRate: 48000, device: 'default', pausedAtStart: false, pausedMs: 0, seconds: 8.1 },
  { type: 'blush', characterId: 'gene', outcome: 'blocked', source: 'words', why: 'cooldown', dO: 1, dE: 0, dN: 0 },
  { type: 'her-gesture', characterId: 'gene', gesture: 'wink', answer: 'played', waited: false },
  { type: 'fatigue-phase', characterId: 'gene', from: 'awake', to: 'light-drowsy', A: 0.71, F: 0.52, W: 0, clock: 0.09, mood: -0.02 },
  { type: 'topmost-fix', characterId: 'gene', outcome: 'forced', visible: true, nth: 2 },
  { type: 'launch-time', characterId: 'gene', ms: 8123 },
  // 2026-11-22 嘴型记录 (tests/mouth-reading-journal.test.ts has the boundary checks).
  { type: 'mouth-reading', characterId: 'gene', sentences: [{ word: 'confirm-smile', peak: 0.72, floor: false, ceiling: false }] },
  // 2026-11-22 显卡重置 (tests/gpu-reset-host.test.ts has the boundary checks).
  { type: 'gpu-reset', characterId: 'gene', event: 'gone', ended: 'crashed', exitCode: -1073741819, recent: 2, total: 2 },
  { type: 'close-beat-skipped', characterId: 'gene', kind: 'hug', block: 'typing' },
  { type: 'action-interrupted', characterId: 'gene', action: 'kiss', by: 'pull' },
  { type: 'close-beat', characterId: 'gene', kind: 'hug', outcome: 'not-played', why: 'game' }, // 2026-11-25 (tests/close-moments-1626.test.ts has the boundary checks)
  // 2026-11-24 (tests/stage-smooth-journal.test.ts has the boundary checks)
  { type: 'gpu-start', characterId: null, kind: 'hardware', vendor: 'nvidia', secondChip: 'no', asked: true, fellBack: false },
  { type: 'frame-time', characterId: 'gene', tier: 'high', onStage: 3, withYou: false, fps: 30, medianMs: 33.3, p95Ms: 34.9, frames: 1802, idlePct: 97 },
  // 2026-11-23 (tests/i193-walk-log.test.ts has the boundary checks)
  { type: 'go-beat', characterId: 'gene', word: 'come-near', outcome: 'went', why: null, metres: 4.3 },
  { type: 'place-moved', characterId: 'gene', by: 'own', side: 'middle', range: 'far', metres: 2.5 },
  // 2026-11-24 I-212 (tests/i212-screen-terms.test.ts has the marker checks)
  { type: 'default-place', characterId: 'gene', action: 'keep', outcome: 'refused' },
  { type: 'music-verdict', characterId: 'gene', music: false, score: 0.2, beat: 0.1, speech: 0.7, soundS: 6, why: 'silence' },
  { type: 'draft-filter', characterId: 'gene', english: 1, plan: 2, format: 0, garbled: 0, chars: 140, whole: false },
  { type: 'reaction', characterId: 'gene', event: 'praise', decider: 'haiku', haiku: 'answered', candidates: [{ id: 'shy', score: 69.8 }], picks: [{ id: 'shy', level: 'mid', done: true }, { id: 'blush', level: 'light', done: false, why: 'showing' }] },
  { type: 'reply-check', characterId: 'gene', marker: 'missing', before: 0, cut: 96, rules: ['body-label', 'tail-word'], residue: [], whole: false },
  // I-050 her folder
  { type: 'her-folder', characterId: 'gene', action: 'created', by: 'her', name: 'letter.md', bytes: 2048, userFile: false },
  // I-084: what she saw of the user this turn and why not (tests/i084-look-at-me.test.ts has the boundary checks).
  { type: 'camera-look', characterId: 'gene', seen: 'none', why: 'judge-no' },
  // I-081: her attention to you (tests/i081-gaze.test.ts has the boundary checks).
  { type: 'gaze', characterId: 'gene', event: 'start', why: 'arrived' },
  // I-135: face-check counts only.
  { type: 'face-check', characterId: 'gene', matched: 4, notYou: 2, unsure: 1, skipped: 0, stranger: 1 },
  { type: 'face-score', characterId: 'gene', event: 'check', outcome: 'weak-not', similarity: 0.33, which: 1, clear: true, frontal: 0.9, det: 0.97 },
  { type: 'face-score', characterId: 'gene', event: 'idle', why: 'no-frames', seconds: 61 },
  // I-087: one reach of hers (tests/i087-hands.test.ts has the boundary checks).
  { type: 'hands', characterId: 'gene', use: 'hold', outcome: 'taken', why: ['rest'] },
  // I-088: her weekly and monthly look-backs: week or month and a closed event, never a word of one (tests/i088-period-review-writer.test.ts has the boundary checks).
  { type: 'period-review', characterId: 'gene', kind: 'week', event: 'written' },
  // I-091: one call turn's timing (tests/i091-voice-call.test.ts has the boundary checks).
  { type: 'voice-call', characterId: 'gene', event: 'turn', endpointMs: 700, handInMs: 760, textMs: 820, fillerMs: 1100, firstCharMs: 2900, firstSoundMs: 4200, bargeIn: false },
  // I-085: one moment she wanted to look (tests/i085-self-look.test.ts has the boundary checks).
  { type: 'self-look', characterId: 'gene', why: 'bored', sense: 'camera', result: 'looked' },
  // I-085 step 3: one chat turn, a picture or text per sense (tests/i085-text-first.test.ts has the boundary checks).
  { type: 'look-turn', characterId: 'gene', screen: 'frame', camera: 'text', why: 'curious' },
  // 松绑: one reach (tests/loosen.test.ts has the boundary checks).
  { type: 'initiative', characterId: 'gene', bucket: 'mid', kind: 'none', why: 'floor', floor: 'meeting' },
  { type: 'touch', characterId: 'gene', kind: 'click', part: 'shoulder', where: 'unbound', count: 2, face: 'smile', reaction: 'blush', speak: 'asked', chance: 3 }, // I-136
  { type: 'noticed', characterId: 'gene', kind: 'came-back', band: 'sure', spoke: 'asked' },
  { type: 'see-and-say', characterId: 'gene', event: 'closer', sense: 'screen', outcome: 'taken', ms: 1500 }, // I-166 (tests/i166-see-and-say.test.ts has the boundary checks) // Unbound step 4 (tests/unbound-life-history.test.ts has the boundary checks)
  // I-098: one message's mood book (tests/i098-speak-only-on.test.ts has the boundary checks).
  { type: 'mood-book', characterId: 'gene', by: 'judge', outcome: 'judged', via: 'warm', context: 'positive', delta: { D: 2, E: 1 }, user: true, ms: 900 },
  // I-188 (tests/i188-moments.test.ts): one moment she recognised, closed words only.
  { type: 'moment', characterId: 'gene', kind: 'reminder', outcome: 'spoke' },
  // I-189 (tests/i189-pose-uses.test.ts): a local pose use, closed words and seconds.
  { type: 'pose-use', characterId: 'gene', use: 'read-pause', event: 'resumed', seconds: 12 },
  // 2026-11-22 (tests/typed-line-drops.test.ts): a typed line that did not go out, closed words and a number.
  { type: 'send-dropped', characterId: 'gene', why: 'superseded', from: 'unbound', waitMs: 39_392 },
  { type: 'spare-process', characterId: 'gene', why: 'switch' },
  // I-202 (tests/claude-start-gate.test.ts): the start gate saw a lost login, one closed word.
  { type: 'claude-gate', characterId: 'gene', event: 'login-lost' },
  // 2026-11-25 (tests/claude-peer-refuse.test.ts): a stream kind the chat reader does not know, names only.
  { type: 'claude-stream-kind', characterId: 'gene', event: 'system', subtype: 'peer_message' },
  // 2026-11-25 (tests/claude-env-from-session.test.ts): started from a Claude Code session, its endpoint and credential variable names left out.
  { type: 'claude-env-dropped', characterId: 'gene', names: ['ANTHROPIC_BASE_URL'] },
  // I-209 step 4 (tests/i209-chime-in.test.ts): one chime-in decision on stage, closed words and ms.
  { type: 'chime-in', characterId: 'gene', step: 'ask', outcome: 'no', ms: 640 },
  // 2026-11-24 每一句话都停 (tests/voice-gaps-journal.test.ts has the boundary checks).
  { type: 'reading-segments', characterId: 'gene', reply: 3, segments: [{ synthMs: 420, silenceMs: null, provider: 'fish', outcome: 'ended' }, { synthMs: 9400, silenceMs: 8100, provider: 'fish', outcome: 'ended' }] },
  { type: 'setting-deferred', characterId: 'gene', what: 'connection', during: 'replying' },
  { type: 'stream-gaps', characterId: 'gene', chunks: 85, rawGapMs: 24100, rawGapAt: 812, rawPending: 'open-tag', shownGapMs: 24120, shownGapAt: 790 },
  // I-179 (tests/i179-mood-journal.test.ts): her whole mood every few minutes.
  { type: 'mood-snapshot', characterId: 'gene', when: 'tick', values: { D: 50, O: 52, E: 51, N: 40, C: 12 }, label: 'calm', B: 3, M: 0, A: 0.3, F: 0.2, phase: 'awake', activity: 'daydream' },
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
