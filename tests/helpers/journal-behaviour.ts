// The experience journal's behaviour golden (docs/claude/2026-11-16-journal-split.md, step 0): the inputs it tries and what it
// records for each. Shared by scripts/dev/journal-behaviour.ts (writes tests/fixtures/journal-behaviour.json) and
// tests/journal-behaviour.test.ts (recomputes and compares). Every input is made up here from the code and the tests; none comes
// from a real journal.
//
// For each journal type: hand-written valid inputs (BASES, one per branch of its builder), then every field of every base tried
// with every closed value its type allows (the pools the checker reads from JournalInput, stored in the golden), with junk
// (JUNK), with field-specific shapes (SHAPES), and left out; and the base under every other type. For each input it records the
// line buildJournalEntry writes (or null, or the error thrown), the panel text describeJournalEntry makes with a translator that
// marks every string it was given, and whether readJournalLine reads the line back to the same entry.
import { createHash } from 'node:crypto';
import { AGENT_SETTINGS, AGENT_TOOLS } from '../../shared/safety';
import { REACTION_BLOCKS, REACTION_LEVELS, REACTION_TABLE } from '../../shared/mood';
import { SPEECH_CUE_PAIRS } from '../../shared/voice';
import { MOOD_MOMENT_REASONS } from '../../shared/foundation/mood-moments';

/** What the golden needs from shared/memory/journal (passed in, so the script and the test load it the same way). */
export interface JournalApi {
  JOURNAL_TYPES: readonly string[];
  buildJournalEntry(input: unknown, at: number): unknown;
  readJournalLine(line: string): unknown;
  describeJournalEntry(entry: never, tr: (source: string, ...values: readonly unknown[]) => string): string;
  journalReason(entry: never): string;
  moodEventSource(type: never, reason: unknown): string;
  journalDeltaText(before: never, after: never, tr: (source: string, ...values: readonly unknown[]) => string): string;
  journalClock(at: number): string;
  journalDuration(ms: number, tr: (source: string, ...values: readonly unknown[]) => string): string;
}

export type Pools = Record<string, Record<string, { values: (string | number | boolean)[]; array?: boolean }>>;

/** One fixed moment: 2026-11-16 21:42:07.123 UTC (the golden runs with TZ=UTC so the panel's clock reads the same everywhere). */
export const AT = Date.UTC(2026, 10, 16, 21, 42, 7, 123);
const HOUR = 3_600_000;

/** The panel translator: fills {n} and marks the string, so the golden shows which strings went through the UI language. */
export const tag = (source: string, ...values: readonly unknown[]): string => `‹${source.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)]))}›`;

const reactionIds = Object.keys(REACTION_TABLE);
const RID = reactionIds[0]!, RID2 = reactionIds[1] ?? reactionIds[0]!;
const enumSetting = AGENT_SETTINGS.find(spec => spec.kind === 'enum' && spec.choices.length >= 2) as { id: string; choices: { value: string }[] };
const numberSetting = AGENT_SETTINGS.find(spec => spec.kind === 'number') as { id: string };
const boolSetting = AGENT_SETTINGS.find(spec => spec.kind !== 'number' && spec.kind !== 'enum') as { id: string } | undefined;
const TOOL = AGENT_TOOLS[0]!.name;
const [cueOutcome, cueWhys] = Object.entries(SPEECH_CUE_PAIRS)[0]!;

const C = 'akiko-1';
const MOOD_A = { D: 50, O: 50, E: 50, N: 50, C: 20 };
const MOOD_B = { D: 52.04, O: 56.36, E: 51, N: 49.95, C: 18 };
// I-179: the rest of her mood state beside D/O/E/N/C (B boredom, M longing, A adenosine, F how tired) and the turn id of a chat-caused change.
const AUX = { A: 0.31, F: 0.4, phase: 'light-drowsy', B: { before: 12.04, after: 0 }, M: { before: 3, after: 0 } };
const NOW = { values: MOOD_B, label: 'content', A: 0.31, F: 0.4, phase: 'awake', B: 7.46, M: 1.5 };

/** Valid inputs, one per branch of each type's builder. Every one must be accepted (the test checks). */
export const BASES: Record<string, Record<string, unknown>[]> = {
  'mood-event': [
    { type: 'mood-event', characterId: C, source: 'touch', before: MOOD_A, after: MOOD_B, labelBefore: 'calm', labelAfter: 'content', count: 3, durationMs: 4200 },
    { type: 'mood-event', characterId: C, source: 'appraisal', context: 'positive', before: MOOD_B, after: MOOD_A, labelBefore: 'happy', labelAfter: 'calm' },
    { type: 'mood-event', characterId: C, source: 'chat', before: MOOD_A, after: MOOD_B, labelBefore: 'calm', labelAfter: 'close', aux: AUX, turn: 'req-12_ab' },
  ],
  'mood-label': [{ type: 'mood-label', characterId: C, from: 'calm', to: 'happy' }],
  boredom: [{ type: 'boredom', characterId: C, level: 'look', value: 42.37, atStart: true }],
  longing: [{ type: 'longing', characterId: C, level: 'sad', value: 77 }],
  'inner-loop': [{ type: 'inner-loop', characterId: C, cue: 'speech', decision: 'speak', result: 'delivered', called: true, quiet: false, restReminder: true }],
  'her-life': [
    { type: 'her-life', characterId: C, from: 'company', to: 'humming', untilMinutes: 12, test: true },
    { type: 'her-life', characterId: C, from: 'daydream', to: 'drowsy', untilMinutes: null },
  ],
  'her-need': [
    { type: 'her-need', characterId: C, event: 'started', need: 'lonely', via: 'touch', dejection: 0.4, relief: 0.2 },
    { type: 'her-need', characterId: C, event: 'faded', need: null, snubbed: true },
  ],
  'user-state': [{ type: 'user-state', characterId: C, state: 'tired', confidence: 0.734 }],
  relationship: [{ type: 'relationship', characterId: C, kind: 'stage', dayNumber: 30, togetherDays: 20, qualityDays: 10, stage: 'warming' }],
  music: [{ type: 'music', characterId: C, tier: 'nod', score: 0.4567 }, { type: 'music', characterId: C, tier: 'none', score: null }],
  rps: [
    { type: 'rps', characterId: C, event: 'result', origin: 'her', rounds: 3, herWins: 2, userWins: 1, draws: 0, result: 'her', end: 'finished', spoke: 2 },
    { type: 'rps', characterId: C, event: 'invite', origin: 'user' },
    { type: 'rps', characterId: C, event: 'line-unread', unread: 'voice-off' },
  ],
  sleep: [{ type: 'sleep', characterId: C, event: 'asleep', phase: 'asleep' }],
  app: [
    { type: 'app', characterId: C, event: 'quit', version: '0.9.3', commit: 'abc1234', cause: 'tray' },
    { type: 'app', characterId: C, event: 'start', version: '0.9.3', commit: null, stopped: 'clean', stoppedAt: AT - 8 * HOUR - 720_000, closedMs: 8 * HOUR + 720_000, cause: 'quit-request' },
    { type: 'app', characterId: null, event: 'start', version: '1.2.3-rc.1', commit: 'abcdef0123456789', stopped: 'unclean', stoppedAt: AT - 3 * 86_400_000, closedMs: 3 * 86_400_000 + 2 * HOUR, clockBack: true },
    { type: 'app', characterId: C, event: 'start', version: '1.0.0', stopped: 'unknown' },
    { type: 'app', characterId: C, event: 'start', version: '1.0.0' },
  ],
  setting: [
    { type: 'setting', characterId: C, id: boolSetting?.id ?? 'pause_talk', previous: false, value: true, via: 'chat' },
    { type: 'setting', characterId: null, id: numberSetting.id, previous: 30, value: 60.12345, via: 'agent' },
    { type: 'setting', characterId: C, id: enumSetting.id, previous: enumSetting.choices[0]!.value, value: enumSetting.choices[1]!.value, via: 'agent' },
    { type: 'setting', characterId: C, id: enumSetting.id, previous: null, value: enumSetting.choices[0]!.value, via: 'chat' },
  ],
  character: [{ type: 'character', characterId: C, event: 'model-link', linked: true }, { type: 'character', characterId: C, event: 'activate' }],
  journal: [{ type: 'journal', characterId: null, event: 'on' }, { type: 'journal', characterId: C, event: 'off' }],
  truncated: [{ type: 'truncated', characterId: null, day: '2026-11-16' }],
  'reply-rhythm': [
    { type: 'reply-rhythm', characterId: C, multiplier: 1.0423, mood: 'happy', fatigue: 'drowsy', tendency: 'playful', shy: true, user: 'quick' },
    { type: 'reply-rhythm', characterId: C, multiplier: 0.9, mood: 'neutral', fatigue: null, tendency: null, shy: false, user: null },
  ],
  motion: [
    { type: 'motion', characterId: C, kind: 'guard', part: 'bone', name: '左腕', size: 12.345, activities: ['speaking', 'chat-gesture', 'speaking'], fps: 59.6, frameMs: 16.71 },
    { type: 'motion', characterId: C, kind: 'physics', part: 'morph', name: 'まばたき', size: 0.4567, activities: [], fps: null, frameMs: null },
    { type: 'motion', characterId: C, kind: 'block', part: 'gpu', name: 'gpu', size: 0.25, cleared: true, activities: ['idle'], fps: 30, frameMs: 33.3 },
    { type: 'motion', characterId: C, kind: 'block', part: 'geometry', name: 'geometry', size: 0.5, cleared: false, activities: ['pat'], fps: 60, frameMs: 16.6 },
    { type: 'motion', characterId: C, kind: 'block', part: 'bone', name: 'センター', size: 0.0123, cleared: false, activities: [], fps: 61, frameMs: 15 },
  ],
  speech: [{ type: 'speech', characterId: null, provider: 'fish', failure: 'quota' },
    { type: 'speech', characterId: C, provider: 'fish', failure: 'network', kind: 'network', retried: true, reply: 7, segment: 2 }],
  'voice-input': [{ type: 'voice-input', characterId: C, engine: 'local', failure: 'empty', stopped: true, peakDb: -42.6 }],
  'audio-reading': [{ type: 'audio-reading', characterId: C, engine: 'compatible', failure: 'timeout', refused: false }],
  pose: [
    { type: 'pose', characterId: C, event: 'follow', kind: 'wave' },
    { type: 'pose', characterId: C, event: 'pause', kind: 'yawn' },
    { type: 'pose', characterId: C, event: 'arrive', kind: null },
    { type: 'pose', characterId: C, event: 'own' },
    { type: 'pose', characterId: C, event: 'pause-pass', kind: null },
  ],
  feed: [{ type: 'feed', characterId: C, outcome: 'said', category: '甜点', liking: '爱吃' }, { type: 'feed', characterId: C, outcome: 'unclear' }],
  'agent-words': [
    { type: 'agent-words', characterId: C, tool: TOOL, item: enumSetting.id, value: enumSetting.choices[1]!.value, words: 12, dialog: 'allowed' },
    { type: 'agent-words', characterId: null, tool: TOOL, item: 'camera', value: 'on', words: 5 },
    { type: 'agent-words', characterId: C, tool: TOOL, item: TOOL, value: null, words: 2000, dialog: 'declined' },
    { type: 'agent-words', characterId: C, tool: TOOL, item: numberSetting.id, value: 45, words: 1 },
  ],
  'mood-judge': [{ type: 'mood-judge', characterId: C, why: 'warmer', before: MOOD_A, after: MOOD_B, labelBefore: 'calm', labelAfter: 'close' },
    { type: 'mood-judge', characterId: C, why: 'warmer', before: MOOD_A, after: MOOD_B, labelBefore: 'calm', labelAfter: 'close', aux: AUX }],
  'mood-snapshot': [{ type: 'mood-snapshot', characterId: C, when: 'tick', ...NOW, activity: 'daydream' }, { type: 'mood-snapshot', characterId: C, when: 'start', values: MOOD_A, label: 'calm', B: 0, M: 0 }],
  'first-char': [
    { type: 'first-char', characterId: C, ms: 1234.6, pauseTalk: true, carried: true, contentMs: 300.4, bubbleMs: 900, sinceStartMs: 600_000, sinceLastMs: 42_000,
      process: 'warm', turn: 3, deltaMs: 800, inputChars: 120, sessionChars: 5000, reuse: 'warm', image: false },
    { type: 'first-char', characterId: null, ms: 2000, pauseTalk: false, carried: false, process: 'cold', reuse: 'diverged-user', image: true },
    { type: 'first-char', characterId: C, ms: 1959, pauseTalk: false, carried: false, endedBy: 'settle-timeout' },
  ],
  'listen-tally': [{ type: 'listen-tally', characterId: C, received: 12, skippedPaused: 1, withText: 8, empty: 2, failed: 1 }],
  'watch-tally': [{ type: 'watch-tally', characterId: C, described: 9, skipped: 3, failed: 1, late: 0, summaries: 2, heard: 4, haikuCalls: 5, haikuMs: 12_345, keywordHits: 1, cacheFiles: 7, cacheKb: 812 }],
  'pause-stuck': [{ type: 'pause-stuck', characterId: C, what: 'mic-window' }],
  'watch-off': [{ type: 'watch-off', characterId: C, why: 'window-gone' }],
  'watch-change': [{ type: 'watch-change', characterId: C, event: 'share-lost', why: 'capture-lost' }, { type: 'watch-change', characterId: C, event: 'paused' },
    { type: 'watch-change', characterId: C, event: 'resumed', awayS: 300 }, { type: 'watch-change', characterId: C, event: 'not-resumed', why: 'turned-off', awayS: 12 }],
  'reading-time': [
    { type: 'reading-time', characterId: C, firstAudioMs: 812.4, waitMs: 40, chars: 56, provider: 'system', result: 'played', why: null, firstSinceStart: true },
    { type: 'reading-time', characterId: C, firstAudioMs: null, waitMs: 1200, chars: 300, provider: 'fish', result: 'partial', why: 'cancelled' },
    { type: 'reading-time', characterId: C, firstAudioMs: 500, waitMs: 30, chars: 40, provider: 'system', result: 'partial', why: 'cancelled', firstSinceStart: false, cancelBy: 'interrupt' },
    { type: 'reading-time', characterId: C, firstAudioMs: null, waitMs: 30, chars: 19, provider: 'fish', result: 'unread', why: 'failed', firstSinceStart: false, afterRetry: true, reply: 7 },
    { type: 'reading-time', characterId: C, firstAudioMs: null, waitMs: 30, chars: 11, provider: 'fish', result: 'unread', why: 'cancelled', firstSinceStart: false, cancelBy: 'unlogged', reply: 6 },
  ],
  'reading-segments': [
    { type: 'reading-segments', characterId: C, reply: 7, segments: [{ synthMs: 420, silenceMs: null, provider: 'fish', outcome: 'ended' }, { synthMs: 9399.4, silenceMs: 8100, provider: 'fish', outcome: 'ended' },
      { synthMs: null, silenceMs: null, provider: 'system', outcome: 'cancelled' }] },
    { type: 'reading-segments', characterId: null, segments: [{ synthMs: 300, silenceMs: 40, provider: 'bailian', outcome: 'error' }] },
  ],
  'setting-deferred': [
    { type: 'setting-deferred', characterId: C, what: 'connection', during: 'replying' },
    { type: 'setting-deferred', characterId: null, what: 'sight-off', during: 'speaking' },
  ],
  'stream-gaps': [
    { type: 'stream-gaps', characterId: C, chunks: 85, rawGapMs: 24_100, rawGapAt: 812, rawPending: 'open-tag', shownGapMs: 24_120, shownGapAt: 790 },
    { type: 'stream-gaps', characterId: null, chunks: 1, rawGapMs: null, shownGapMs: null },
  ],
  'voice-time': [{ type: 'voice-time', characterId: C, ms: 900, recognizeMs: 700.6, seconds: 3.21, result: 'text', engine: 'local' }],
  'voice-capture': [{ type: 'voice-capture', characterId: C, end: 'stopped', chunks: 40, peak: 0.123456, rms: 0.012345, threshold: 0.01234, sampleRate: 16_000, device: 'default',
    pausedAtStart: true, pausedMs: 1200, seconds: 4.04 }],
  'voice-call': [
    { type: 'voice-call', characterId: C, event: 'start', via: 'button' },
    { type: 'voice-call', characterId: C, event: 'end', reason: 'user', seconds: 125, turns: 6, bargeIns: 1 },
    { type: 'voice-call', characterId: C, event: 'turn', endpointMs: 600, handInMs: 650, textMs: 900, fillerMs: 400, firstCharMs: 1500, firstSoundMs: 1800, soundAfterCharMs: 300,
      earlyRead: true, bargeIn: true, endToSoundMs: 1700, vad: true, endBy: 'smart-turn', smartTurnOff: 'guard' },
    { type: 'voice-call', characterId: null, event: 'turn' },
    { type: 'voice-call', characterId: C, event: 'claude', process: 'prewarmed', firstDeltaMs: 700 },
    { type: 'voice-call', characterId: C, event: 'held', kind: 'filler', overHer: true, call: true },
    { type: 'voice-call', characterId: C, event: 'interrupt', by: 'sentence', overHer: true, call: true },
    { type: 'voice-call', characterId: C, event: 'interrupt', by: 'chars', overHer: true, call: true, chars: 5, match: 0.234 }, // I-204
    { type: 'voice-call', characterId: C, event: 'held', kind: 'echo', overHer: true, call: true, chars: 7, match: 0.857 }, // I-204
    { type: 'voice-call', characterId: C, event: 'add-on', gapMs: 900, written: true, dropped: 12 },
    { type: 'voice-call', characterId: C, event: 'add-on', gapMs: 300, written: false, dropped: 0 },
  ],
  blush: [
    { type: 'blush', characterId: C, outcome: 'fired', source: 'words', dO: 3.456, dE: 1, dN: -2, total: 4.5, threshold: 3 },
    { type: 'blush', characterId: C, outcome: 'blocked', source: 'pat', why: 'cooldown' },
    { type: 'blush', characterId: C, outcome: 'stage', source: null, stage: 'no-cheek' },
    { type: 'blush', characterId: C, outcome: 'stage', stage: 'shown' },
  ],
  'her-gesture': [
    { type: 'her-gesture', characterId: C, gesture: 'wave', answer: 'played', waited: true },
    { type: 'her-gesture', characterId: null, gesture: 'none', answer: null },
  ],
  'fatigue-phase': [{ type: 'fatigue-phase', characterId: C, from: 'awake', to: 'light-drowsy', A: 0.123, F: 0.456, W: 0.789, clock: -0.2, mood: 0.05 }],
  'topmost-fix': [{ type: 'topmost-fix', characterId: C, outcome: 'forced', visible: true, nth: 3 }],
  'launch-time': [{ type: 'launch-time', characterId: C, ms: 4321.4 }],
  'close-beat-skipped': [{ type: 'close-beat-skipped', characterId: C, kind: 'hug', block: 'typing' }, { type: 'close-beat-skipped', characterId: null, kind: 'kiss', block: 'busy' }],
  'action-interrupted': [{ type: 'action-interrupted', characterId: C, action: 'hug', by: 'pull' }, { type: 'action-interrupted', characterId: null, action: 'life', by: 'click' }],
  'close-beat': [{ type: 'close-beat', characterId: C, kind: 'hug', outcome: 'played', why: null }, { type: 'close-beat', characterId: C, kind: 'hug', outcome: 'played', why: null, arms: 'still' },
    { type: 'close-beat', characterId: null, kind: 'kiss', outcome: 'not-played', why: 'pulled-away' }],
  'go-beat': [{ type: 'go-beat', characterId: C, word: 'come-near', outcome: 'went', why: null, metres: 4.26 }, { type: 'go-beat', characterId: null, word: 'go-cursor', outcome: 'stayed', why: 'cursor-stale', metres: null },
    { type: 'go-beat', characterId: C, word: 'go', outcome: 'went', why: null, metres: 2.04, target: { percent: 30, metres: 1.25 } }], // I-193 numbers (2026-11-24)
  'place-moved': [{ type: 'place-moved', characterId: C, by: 'go-word', side: 'right', range: 'near', metres: 3.14 }, { type: 'place-moved', characterId: null, by: 'own', side: 'left', range: 'far', metres: 0 }],
  'default-place': [{ type: 'default-place', characterId: C, action: 'keep', outcome: 'done' }, { type: 'default-place', characterId: null, action: 'clear', outcome: 'not-out' }],
  'gpu-start': [{ type: 'gpu-start', characterId: null, kind: 'hardware', vendor: 'nvidia', secondChip: 'no', asked: true, fellBack: false },
    { type: 'gpu-start', characterId: C, kind: 'software', vendor: 'other', secondChip: 'yes', asked: true, fellBack: true }],
  'frame-time': [{ type: 'frame-time', characterId: C, tier: 'high', onStage: 3, withYou: false, fps: 30.04, medianMs: 33.34, p95Ms: 34.9, frames: 1802, idlePct: 97 },
    { type: 'frame-time', characterId: null, tier: 'low', onStage: 1, withYou: true, fps: 60, medianMs: 16.7, p95Ms: 17, frames: 3600, idlePct: 0 }],
  'gpu-reset': [
    { type: 'gpu-reset', characterId: C, event: 'gone', ended: 'crashed', exitCode: -1073741819, recent: 3, total: 3 },
    { type: 'gpu-reset', characterId: null, event: 'software', ended: null, exitCode: null, recent: 4, total: 4 },
  ],
  'mouth-reading': [
    { type: 'mouth-reading', characterId: C, sentences: [{ word: 'none', peak: 0.876, floor: false, ceiling: false }, { word: 'confirm-smile', peak: 0.5, floor: true, ceiling: false },
      { word: 'laugh', peak: 1.234, floor: false, ceiling: true }] },
  ],
  'draft-filter': [
    { type: 'draft-filter', characterId: C, english: 2, plan: 1, format: 0, garbled: 0, chars: 120, whole: true, filled: true },
    { type: 'draft-filter', characterId: C, english: 0, plan: 3, format: 1, garbled: 2, chars: 80, whole: false },
  ],
  reaction: [
    { type: 'reaction', characterId: C, event: 'pat', decider: 'haiku', haiku: 'answered', candidates: [{ id: RID, score: 12.34 }, { id: RID2, score: -3 }],
      picks: [{ id: RID, level: REACTION_LEVELS[0], done: true }, { id: RID2, level: REACTION_LEVELS[REACTION_LEVELS.length - 1], done: false, why: REACTION_BLOCKS[0] }] },
    { type: 'reaction', characterId: C, event: 'none', decider: 'none', haiku: null, candidates: [], picks: [] },
    { type: 'reaction', characterId: C, event: 'praise', decider: 'fallback', haiku: 'timeout', candidates: [{ id: RID, score: 3 }], picks: [{ id: RID, level: REACTION_LEVELS[0], done: false }] },
  ],
  'reply-check': [
    { type: 'reply-check', characterId: C, marker: 'missing', before: 3, cut: 10, rules: ['tail-word', 'marker'], residue: ['marker'], whole: true, filled: true },
    { type: 'reply-check', characterId: C, marker: 'off', before: 0, cut: 0, rules: [], residue: [] },
    { type: 'reply-check', characterId: C, marker: 'ok', before: 5, cut: 0, rules: [], residue: ['english-line', 'body-label'] },
  ],
  'music-verdict': [
    { type: 'music-verdict', characterId: C, music: true, score: 0.81, beat: 0.6, speech: 0.1, soundS: 8.25 },
    { type: 'music-verdict', characterId: C, music: false, score: 0.2, beat: 0.1, speech: 0.7, soundS: 12, why: 'speech-like' },
  ],
  'her-folder': [
    { type: 'her-folder', characterId: C, action: 'created', by: 'her', name: 'note.md', bytes: 2048, userFile: true },
    { type: 'her-folder', characterId: C, action: 'restored', by: 'user', name: '她的画.png', bytes: 123_456 },
    { type: 'her-folder', characterId: C, action: 'refused', by: 'her', why: 'size' },
    { type: 'her-folder', characterId: C, action: 'mentioned', by: 'her' },
  ],
  upcoming: [{ type: 'upcoming', characterId: C, event: 'recorded', count: 2, via: 'early' }, { type: 'upcoming', characterId: null, event: 'expired', count: 1 }],
  'special-day': [
    { type: 'special-day', characterId: C, event: 'said', kind: 'birthday', first: 'her' },
    { type: 'special-day', characterId: C, event: 'hinted', kind: 'anniversary', first: null },
  ],
  'claude-link': [
    { type: 'claude-link', characterId: null, state: 'failed', trigger: 'auto', failure: 'timeout', version: '2.1.319' },
    { type: 'claude-link', characterId: C, state: 'unverified', trigger: 'manual', unreadable: 'wrapped', rows: 3, headerRepeated: true, version: '2.1.3' },
    { type: 'claude-link', characterId: C, state: 'linked', trigger: 'auto' },
    { type: 'claude-link', characterId: C, state: 'failed', trigger: 'manual' },
  ],
  // Overhaul step 7: one unit switched off on its own (closed part and unit, `<category>:<error.name>`; a message never fits)
  'part-off': [
    { type: 'part-off', characterId: C, part: 'senses', unit: 'face-check', failure: 'start:TypeError' },
    { type: 'part-off', characterId: null, part: 'initiative', unit: 'rps', failure: 'tick:Error' },
    { type: 'part-off', characterId: C, part: 'mood', unit: 'reactions', failure: 'callback:InjectedPartFailure' },
  ],
  'speech-cue': Object.entries(SPEECH_CUE_PAIRS).map(([outcome, whys]) => ({ type: 'speech-cue', characterId: C, outcome, why: whys[0] })),
  'presence-look': [{ type: 'presence-look', characterId: C, look: 'gaming' }, { type: 'presence-look', characterId: C, look: 'failed' }],
  'camera-look': [
    { type: 'camera-look', characterId: C, seen: 'clear', via: 'button' },
    { type: 'camera-look', characterId: C, seen: 'later' },
    { type: 'camera-look', characterId: C, seen: 'small', why: 'no-frame' },
    { type: 'camera-look', characterId: C, seen: 'none', why: 'held' },
  ],
  give: [
    { type: 'give', characterId: C, event: 'taken', item: 'snack', why: ['night', 'tired', 'night'], fromFed: true },
    { type: 'give', characterId: C, event: 'picture', item: 'cushion', why: [], picture: 'miss' },
  ],
  gaze: [
    { type: 'gaze', characterId: C, event: 'start', why: 'arrived' },
    { type: 'gaze', characterId: C, event: 'stop', why: 'asleep' },
    { type: 'gaze', characterId: null, event: 'eye-contact' },
  ],
  'face-check': [{ type: 'face-check', characterId: C, matched: 3, notYou: 1, unsure: 2, skipped: 4, stranger: 1 }, { type: 'face-check', characterId: C, matched: 0, notYou: 0, unsure: 0, skipped: 0, stranger: 0 }],
  'face-score': [
    { type: 'face-score', characterId: C, event: 'check', outcome: 'match', similarity: 0.61, which: 2, clear: true, frontal: 0.93, det: 0.97 },
    { type: 'face-score', characterId: C, event: 'check', outcome: 'no-face', similarity: null, which: null, clear: false, frontal: 0, det: 0 },
    { type: 'face-score', characterId: C, event: 'idle', why: 'no-frames', seconds: 62 },
  ],
  noticed: [
    { type: 'noticed', characterId: C, kind: 'came-back', band: 'sure', spoke: 'asked' },
    { type: 'noticed', characterId: null, kind: 'wave', band: 'maybe', spoke: 'quiet' },
  ],
  'see-and-say': [
    { type: 'see-and-say', characterId: C, event: 'frames', camera: true, screen: false },
    { type: 'see-and-say', characterId: C, event: 'closer', sense: 'camera', outcome: 'taken', ms: 1840 },
    { type: 'see-and-say', characterId: null, event: 'closer', sense: 'screen', outcome: 'cancelled', why: 'held' },
  ],
  hands: [
    { type: 'hands', characterId: C, use: 'hold', outcome: 'taken', why: ['rest', 'shy'], first: true },
    { type: 'hands', characterId: C, use: 'high-five', outcome: 'not-taken', why: [] },
  ],
  'period-review': [{ type: 'period-review', characterId: C, kind: 'week', event: 'written' }],
  'self-look': [{ type: 'self-look', characterId: C, why: 'miss', sense: 'camera', result: 'looked' }],
  'look-turn': [
    { type: 'look-turn', characterId: C, screen: 'frame', camera: 'text', why: 'curious' },
    { type: 'look-turn', characterId: C, camera: 'held' },
    { type: 'look-turn', characterId: C, screen: 'none' },
  ],
  'send-dropped': [
    { type: 'send-dropped', characterId: C, why: 'readout-pending', from: 'unbound', waitMs: 43_210 },
    { type: 'send-dropped', characterId: C, why: 'no-ack', from: 'controls' },
  ],
  'spare-process': [
    { type: 'spare-process', characterId: C, why: 'start' },
    { type: 'spare-process', characterId: C, why: 'fullscreen' },
  ],
  'claude-gate': [
    { type: 'claude-gate', characterId: C, event: 'login-lost' },
    { type: 'claude-gate', characterId: null, event: 'login-lost' },
  ],
  'claude-stream-kind': [
    { type: 'claude-stream-kind', characterId: C, event: 'user' },
    { type: 'claude-stream-kind', characterId: null, event: 'system', subtype: 'status' },
  ],
  'claude-env-dropped': [
    { type: 'claude-env-dropped', characterId: C, names: ['ANTHROPIC_BASE_URL'] },
    { type: 'claude-env-dropped', characterId: null, names: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'] },
  ],
  'chime-in': [
    { type: 'chime-in', characterId: C, step: 'ask', outcome: 'yes', ms: 812 },
    { type: 'chime-in', characterId: C, step: 'ask', outcome: 'dropped', ms: 40 },
    { type: 'chime-in', characterId: C, step: 'line', outcome: 'said', ms: 6_210 },
  ],
  initiative: [
    { type: 'initiative', characterId: C, bucket: 'mid', kind: 'talk' },
    { type: 'initiative', characterId: C, bucket: 'low', kind: 'none', why: 'floor', floor: 'night' },
    { type: 'initiative', characterId: C, bucket: 'high', kind: 'none', why: 'cooldown' },
  ],
  moment: [
    { type: 'moment', characterId: C, kind: 'late-night', outcome: 'spoke' },
    { type: 'moment', characterId: C, kind: 'screen', outcome: 'skipped', why: 'cooldown', screen: 'error' },
    { type: 'moment', characterId: C, kind: 'reminder', outcome: 'expired', why: 'late' },
    { type: 'moment', characterId: C, kind: 'sitting', outcome: 'spoke' }, // I-189
  ],
  // I-189: a local pose use did something (closed words and seconds only).
  'pose-use': [
    { type: 'pose-use', characterId: C, use: 'read-pause', event: 'paused' },
    { type: 'pose-use', characterId: C, use: 'read-pause', event: 'ended', seconds: 90 },
    { type: 'pose-use', characterId: C, use: 'nod', event: 'shake' },
  ],
  touch: [
    { type: 'touch', characterId: C, kind: 'pinch', part: 'face', where: 'pet', count: 3, face: 'smile', reaction: RID, speak: 'asked', chance: 4 },
    { type: 'touch', characterId: C, kind: 'click', part: null, where: 'unbound', count: 1, face: 'none', reaction: null, speak: 'quiet' },
    { type: 'touch', characterId: C, kind: 'pat', part: 'other', where: 'pet', count: 2000, face: 'beam', reaction: null, speak: 'held', chance: 0 },
  ],
  'mood-book': [
    { type: 'mood-book', characterId: C, by: 'tail', outcome: 'judged', context: 'positive', delta: { O: 3, E: 1, N: 0 }, user: true },
    { type: 'mood-book', characterId: C, by: 'judge', outcome: 'judged', via: 'warm', delta: { D: -2.04 }, ms: 1234.4 },
    { type: 'mood-book', characterId: C, by: 'judge', outcome: 'failed', via: 'one-shot', ms: 3000 },
    { type: 'mood-book', characterId: C, by: 'judge', outcome: 'judged', delta: {} },
    { type: 'mood-book', characterId: C, by: 'tail', outcome: 'judged', context: 'positive', delta: { O: 2 }, now: NOW, turn: 'req-12_ab' },
  ],
};

/** Junk tried on every field. */
export const JUNK: unknown[] = [
  undefined, null, '', 'bogus', 'x/y', 'gpu', 'geometry', 'note.md', '.hidden.md', 'a.exe', 'Bad Name', 'a'.repeat(41), 'a'.repeat(101), '2026-11-16', '2026-1-1',
  'abcdef0', 'ABCDEF0', '1.2.3', '1.2', 'v1.2.3', 'on', 'off', 'en', 'zh', 'system', 'none', true, false,
  -1, -0.5, 0, 0.004, 0.005, 0.5, 0.996, 1, 1.5, 2, 9, 10, 59.95, 60, 60.05, 99.95, 100, 100.04, 101, 240, 241, 360.5, 999, 1000, 1001, 2000, 2001, 3600,
  86_400, 100_000, 100_001, 600_000, 600_001, 3_600_000, 3_600_001, 1e7, 1e8 + 1, 1e12, 2 ** 53, NaN, Infinity, -Infinity, 1.23456789,
  [], ['bogus'], {}, { D: 1 },
];

/** Shapes tried on the fields that hold objects or object arrays (and on every field of that name). */
export const SHAPES: Record<string, unknown[]> = {
  before: [MOOD_B, { D: 1, O: 2, E: 3, N: 4 }, { D: 150, O: -5, E: 50.04, N: 50.05, C: 0 }, { D: NaN, O: 1, E: 1, N: 1, C: 1 }, { ...MOOD_A, X: 9 }, [1, 2, 3, 4, 5]],
  after: [MOOD_A, { D: 1, O: 2, E: 3, N: 4 }, { D: 150, O: -5, E: 50.04, N: 50.05, C: 0 }, { D: '1', O: 1, E: 1, N: 1, C: 1 }],
  delta: [{}, { D: 6 }, { D: 7 }, { D: 2.55 }, { D: 0.04 }, { Q: 1 }, { D: -6, O: 6, E: 0, N: 1, C: -1 }, { D: '1' }, [1]],
  candidates: [[], [{ id: RID, score: 1 }], [{ id: 'Bad', score: 1 }], [{ id: RID, score: NaN }], [{ id: RID, score: 999 }], [{ id: RID, score: -999.99 }],
    Array.from({ length: 9 }, () => ({ id: RID, score: 1 })), Array.from({ length: 8 }, (_, i) => ({ id: RID, score: i })), [null], ['x'], [{ id: 'a'.repeat(33), score: 1 }]],
  picks: [[], ...REACTION_LEVELS.map(level => [{ id: RID, level, done: true }]), ...REACTION_BLOCKS.map(why => [{ id: RID2, level: REACTION_LEVELS[0], done: false, why }]),
    [{ id: RID, level: REACTION_LEVELS[0], done: true, why: REACTION_BLOCKS[0] }], [{ id: RID, level: 'bogus', done: true }], [{ id: RID, level: REACTION_LEVELS[0], done: 'yes' }],
    Array.from({ length: 5 }, () => ({ id: RID, level: REACTION_LEVELS[0], done: true })), [{ id: 'zz-not-a-row', level: REACTION_LEVELS[0], done: true }], [null]],
  reaction: [...reactionIds, 'zz-not-a-row', 'Bad'],
  tool: AGENT_TOOLS.map(tool => tool.name),
  item: [...AGENT_TOOLS.map(tool => tool.name), ...AGENT_SETTINGS.map(spec => spec.id), 'Camera', 'a_b_c'],
  id: AGENT_SETTINGS.map(spec => spec.id),
  value: [...enumSetting.choices.map(choice => choice.value), 'a,b.c-d_e', 'a b', 1e6, 999_999.9, -999_999.9],
  previous: enumSetting.choices.map(choice => choice.value),
  why: [...new Set(Object.values(SPEECH_CUE_PAIRS).flat()), 'arrived', 'facing', 'left', 'turned', 'off', 'asleep'],
  name: ['note.txt', 'NOTE.MD', 'pic.png', 'a'.repeat(76) + '.md', 'a'.repeat(77) + '.md', 'a<b.md', 'dir/a.md', '左腕', 'ｇｐｕ', 'a:b', 'a'.repeat(40)],
  version: ['2.1.319', '2.1.3 (Claude Code)', 'C:/x/claude.exe', '10.20.30'],
  ms: [0, 0.4, 600_000, 600_000.4],
  aux: [AUX, {}, { A: 2, F: -1 }, { phase: 'bogus', A: 0.5 }, { B: { before: 5 } }, { B: { before: 'x', after: 1 } }, { M: { before: 120, after: -3 } }, [AUX], 'AUX'],
  now: [NOW, {}, { ...NOW, label: 'bogus' }, { ...NOW, values: { D: 1 } }, { ...NOW, B: NaN }, { ...NOW, M: undefined }, { values: MOOD_A, label: 'calm', B: 1, M: 2 }, [NOW]],
  turn: ['req-12_ab', 'with space', 'a'.repeat(100), 'a'.repeat(101), '你好', 'x/y', ''],
  activity: ['company', 'daydream', 'bogus'],
};

/** Every case for one type, in a fixed order. */
export function* casesFor(type: string, pools: Pools, types: readonly string[]): Generator<Record<string, unknown>> {
  const fieldsPool = pools[type] ?? {};
  for (const base of BASES[type] ?? []) {
    yield base;
    const fields = [...new Set([...Object.keys(base), ...Object.keys(fieldsPool)])].filter(field => field !== 'type').sort();
    for (const field of fields) {
      const without = { ...base }; delete without[field];
      yield without;
      const pool = fieldsPool[field];
      const tries: unknown[] = [];
      if (pool?.array) {
        tries.push(pool.values, [...pool.values, ...pool.values], [...pool.values, pool.values[0]]);
        for (const value of pool.values) tries.push([value]);
      } else if (pool) tries.push(...pool.values);
      tries.push(...(SHAPES[field] ?? []), ...JUNK);
      for (const value of tries) yield { ...base, [field]: value };
    }
    for (const other of types) if (other !== type) yield { ...base, type: other };
  }
}

/** What one input gives: the line (or null, or the error), the panel text, whether the line reads back the same. */
export function runCase(api: JournalApi, input: unknown): string {
  let entry: unknown;
  try { entry = api.buildJournalEntry(input, AT); } catch (error) { return `throw ${(error as Error).name}`; }
  if (entry === null) return 'null';
  const line = JSON.stringify(entry);
  let text: string;
  try { text = api.describeJournalEntry(entry as never, tag); } catch (error) { text = `throw ${(error as Error).name}`; }
  const back = api.readJournalLine(line);
  const reason = api.journalReason(entry as never);
  return `${line}\n${text}\n${JSON.stringify(back) === line ? 'reads back' : `reads back as ${JSON.stringify(back)}`}${reason === (entry as { reason: string }).reason ? '' : `\nreason ${reason}`}`;
}

export interface TypeSweep { cases: number; accepted: number; threw: number; sha256: string }

/** Every case of one type, run: counts and one hash over every output in order. */
export function sweep(api: JournalApi, type: string, pools: Pools): TypeSweep {
  const hash = createHash('sha256');
  let cases = 0, accepted = 0, threw = 0;
  for (const input of casesFor(type, pools, api.JOURNAL_TYPES)) {
    const out = runCase(api, input);
    cases++;
    if (out.startsWith('throw')) threw++;
    else if (out !== 'null') accepted++;
    hash.update(`${cases}\t${out}\n`);
  }
  return { cases, accepted, threw, sha256: hash.digest('hex') };
}

/** The base inputs with their full outputs (readable in the golden). */
export function examples(api: JournalApi, type: string): { input: unknown; output: string }[] {
  return (BASES[type] ?? []).map(input => ({ input, output: runCase(api, input) }));
}

/** Lines read back: damaged, foreign, tampered or too long lines, and valid ones with extra fields. */
export function lineCases(api: JournalApi): { line: string; read: string }[] {
  const good = JSON.stringify(api.buildJournalEntry(BASES['mood-event']![0], AT));
  const parsed = JSON.parse(good) as Record<string, unknown>;
  const lines = [
    '', '   ', '{', 'null', '[]', '"x"', '42', good, ` ${good} `, `${good}\n`,
    JSON.stringify({ ...parsed, v: 2 }), JSON.stringify({ ...parsed, v: '1' }), JSON.stringify({ ...parsed, at: -1 }), JSON.stringify({ ...parsed, at: '1' }),
    JSON.stringify({ ...parsed, at: 8.7e15 }), JSON.stringify({ ...parsed, at: AT + 0.9 }), JSON.stringify({ ...parsed, reason: '别的话' }), JSON.stringify({ ...parsed, time: 'x' }),
    JSON.stringify({ ...parsed, message: '用户的话' }), JSON.stringify({ ...parsed, type: 'bogus' }), JSON.stringify({ ...parsed, characterId: 'a/b' }),
    JSON.stringify({ ...parsed, pad: 'x'.repeat(4_000 - good.length - 10) }), JSON.stringify({ ...parsed, pad: 'x'.repeat(4_001 - good.length) }),
    ...Object.values(BASES).flat().map(input => JSON.stringify({ v: 1, at: AT, ...input })),
  ];
  return lines.map(line => {
    let read: string;
    try { read = JSON.stringify(api.readJournalLine(line)); } catch (error) { read = `throw ${(error as Error).name}`; }
    return { line: line.length > 300 ? `${line.slice(0, 120)}…(${line.length} chars)` : line, read };
  });
}

/** The exported helpers outside the line itself. */
export function helperCases(api: JournalApi): Record<string, unknown> {
  const reasons = ['有效摸头', '有效捏脸', '接受一份点心', '收到用户聊天', '收到用户语音', '收到用户回应', '和用户玩了猜拳', '被用户哄好了', '一个人待了一会儿，有点低落',
    '用户来了，松了口气', ...Object.values(MOOD_MOMENT_REASONS), '模型自己的话', '', null, 42, 'toString', '__proto__', 'constructor'];
  const moodEventSource = ['rua', 'food', 'chat', 'appraisal', 'lift'].map(type => [type, reasons.map(reason => api.moodEventSource(type as never, reason)).join(' ')]);
  const deltas = [[MOOD_A, MOOD_B], [MOOD_B, MOOD_A], [MOOD_A, MOOD_A], [MOOD_A, { D: 60, O: 41, E: 50.4, N: 49.5, C: 23 }]]
    .map(([a, b]) => api.journalDeltaText(a as never, b as never, tag));
  const clocks = [0, AT, AT + 17 * 60_000, Date.UTC(2026, 0, 1, 0, 5)].map(at => api.journalClock(at));
  const durations = [-5, 0, 499, 500, 40_000, 59_999, 60_000, 12 * 60_000, HOUR, 8 * HOUR + 720_000, 86_400_000, 3 * 86_400_000 + 2 * HOUR + 59 * 60_000]
    .map(ms => api.journalDuration(ms, tag));
  return { moodEventSource: Object.fromEntries(moodEventSource), journalDeltaText: deltas, journalClock: clocks, journalDuration: durations };
}

/** Every exported value of the module that is data (lists, tables, numbers), in its own key order. */
export function exportedData(module: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(module).sort().filter(name => typeof module[name] !== 'function').map(name => [name, module[name]]));
}
