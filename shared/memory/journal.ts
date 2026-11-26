/**
 * 体验记录 (E2, docs/claude/2026-11-03-experience-journal.md): what happened to her mood and why, one JSON line per moment,
 * kept on this computer only (`<profile>/journal/<local date>.jsonl`) while the user's switch "保留体验记录（只存本机）" is on.
 *
 * THE BOUNDARY (tests/journal-*.test.ts pin it): a line holds times, the character id, a type, fixed enum values, numbers and a
 * plain-language reason that this module writes itself from a fixed table. It never holds the user's message, her reply, the
 * diary, the user profile, a nickname, a model's free-text reason, a file path or a key. `buildJournalEntry` copies field by
 * field from closed sets; free text given to it (for example a mood event's reason) is mapped to a fixed source or dropped.
 *
 * Since 2026-11-16 (docs/claude/2026-11-16-journal-split.md) this file is the core: the version, the limits, the list of types,
 * the joined input type and the dispatcher. Each entry type lives in its part's slice, shared/<part>/journal-entries.ts (its input
 * shape, its closed word lists, its builder, its reason, its line in the panel), and every name that moved is exported here as
 * before, so no importer changed. tests/journal-behaviour.test.ts and tests/journal-surface.test.mjs hold the lines and the types.
 *
 * THE RULE FOR A NEW ENTRY TYPE: it goes into its part's slice, shared/<part>/journal-entries.ts: its input shape in the part's
 * <Part>JournalInput, its closed word lists beside it, its case in the slice's three functions (reason, build, describe) and its
 * name in <PART>_JOURNAL_TYPES. Then its name goes into JOURNAL_TYPES below, valid inputs for it into BASES in
 * tests/helpers/journal-behaviour.ts, and both goldens are regenerated (scripts/dev/journal-surface.mjs --write,
 * scripts/dev/journal-behaviour.ts --write), saying why in the commit. Never per-type code in this file. A part without a slice
 * gets one: a new file, one entry in each of the four slice tables below, and its names on the part's index.ts.
 */
import { finite, has, id, type JournalTranslate } from '../foundation/journal-fields';
import { STAGE_JOURNAL_TYPES, buildStageJournalEntry, describeStageJournalEntry, stageJournalReason, type StageJournalInput } from '../stage';
import { SENSES_JOURNAL_TYPES, buildSensesJournalEntry, describeSensesJournalEntry, sensesJournalReason, type SensesJournalInput } from '../senses';
import { MEMORY_JOURNAL_TYPES, buildMemoryJournalEntry, describeMemoryJournalEntry, journalClock, memoryJournalReason, type MemoryJournalInput } from './journal-entries';
import { MOOD_JOURNAL_TYPES, buildMoodJournalEntry, describeMoodJournalEntry, moodJournalReason, type MoodJournalInput } from '../mood';
import { BRAIN_JOURNAL_TYPES, brainJournalReason, buildBrainJournalEntry, describeBrainJournalEntry, type BrainJournalInput } from '../brain';
import { INITIATIVE_JOURNAL_TYPES, buildInitiativeJournalEntry, describeInitiativeJournalEntry, initiativeJournalReason, type InitiativeJournalInput } from '../initiative';
import { SAFETY_JOURNAL_TYPES, buildSafetyJournalEntry, describeSafetyJournalEntry, safetyJournalReason, type SafetyJournalInput } from '../safety';
import { CARDS_JOURNAL_TYPES, buildCardsJournalEntry, cardsJournalReason, describeCardsJournalEntry, type CardsJournalInput } from '../cards';
import { VOICE_JOURNAL_TYPES, buildVoiceJournalEntry, describeVoiceJournalEntry, voiceJournalReason, type VoiceJournalInput } from '../voice';

// ---- What moved to the parts' slices, exported here under the same names (importers of this file did not change).
export { FATIGUE_PHASES, FIRST_CHAR_PROCESSES } from '../foundation/journal-fields';
export type { FirstCharProcess, JournalTranslate } from '../foundation/journal-fields';
export { MOTION_ACTIVITIES, MOTION_GLITCH_KINDS, TOPMOST_FIX_OUTCOMES } from '../stage';
export type { MotionActivity, MotionGlitchKind, TopmostFixOutcome } from '../stage';
export { DANCE_TIERS, PAUSE_STUCK_KINDS } from '../senses';
export type { JournalDanceTier, PauseStuckKind } from '../senses';
export { PERIOD_REVIEW_EVENTS, PERIOD_REVIEW_KINDS, UPCOMING_JOURNAL_EVENTS, UPCOMING_JOURNAL_VIA, journalClock, journalDuration } from './journal-entries';
export type { PeriodReviewJournalEvent, PeriodReviewJournalKind, UpcomingJournalEvent, UpcomingJournalVia } from './journal-entries';
export {
  BLUSH_BLOCKS, BLUSH_OUTCOMES, BLUSH_SOURCES, BLUSH_STAGES, BOREDOM_LEVELS, HER_NEED_JOURNAL_EVENTS, LONGING_LEVELS, MOOD_EVENT_SOURCES, POSE_JOURNAL_EVENTS,
  journalDeltaText, moodEventSource,
} from '../mood';
export type { BlushBlock, BlushOutcome, BlushSource, BlushStage, BoredomLevel, HerNeedJournalEvent, LongingLevel, MoodEventSource, PoseJournalEvent } from '../mood';
export { FIRST_CHAR_REUSES, GESTURE_ANSWERS } from '../brain';
export type { FirstCharReuse, GestureAnswer } from '../brain';
export { GIVE_JOURNAL_EVENTS, RPS_ENDS, RPS_JOURNAL_EVENTS } from '../initiative';
export type { GiveJournalEvent, RpsJournalEvent } from '../initiative';
export { CHARACTER_JOURNAL_EVENTS } from '../cards';
export type { CharacterJournalEvent } from '../cards';
export {
  READING_PROVIDERS, READING_RESULTS, READING_WHYS, SPEECH_FAILURE_LABEL, VOICE_CALL_END_BYS, VOICE_CALL_END_REASONS, VOICE_CALL_VIAS, VOICE_CAPTURE_ENDS, VOICE_DEVICES,
  VOICE_INPUT_FAILURE_LABEL, VOICE_TIME_ENGINES, VOICE_TIME_RESULTS,
} from '../voice';
export type { ReadingCancelBy, ReadingProvider, ReadingResult, ReadingWhy, VoiceCaptureEnd, VoiceTimeResult } from '../voice';

export const JOURNAL_VERSION = 1;
/**
 * A wide daily ceiling, 8 MiB (8,388,608 bytes) **with** the `truncated` marker: a line is written only while the marker still
 * fits after it; the line that would not leave room becomes the marker, and nothing more is written that day (earlier lines stay).
 */
export const JOURNAL_DAY_LIMIT_BYTES = 8 * 1024 * 1024;
/** "刚才发生了什么": the newest lines shown in the control window. */
export const JOURNAL_RECENT = 50;

export const JOURNAL_TYPES = ['mood-event', 'mood-label', 'boredom', 'longing', 'inner-loop', 'her-life', 'her-need', 'user-state', 'relationship',
  'music', 'rps', 'sleep', 'app', 'setting', 'character', 'journal', 'truncated', 'reply-rhythm', 'motion', 'speech', 'voice-input', 'pose', 'audio-reading', 'feed',
  'agent-words', 'mood-judge', 'first-char', 'listen-tally', 'watch-tally', 'pause-stuck', 'watch-off', 'watch-change',
  'reading-time', 'voice-time', 'voice-capture', 'voice-call', 'blush', 'her-gesture', 'fatigue-phase', 'topmost-fix', 'launch-time', 'draft-filter', 'reaction', 'reply-check', 'music-verdict',
  // I-050 her folder (its own block)
  'her-folder',
  // P-001 the plans she remembers: closed events and a count, never what the plan was
  'upcoming',
  // I-059 the user's special day she says something about (without her folder): a closed event, the kind of day and who spoke of it first
  'special-day',
  // I-061 the internal channel's link to the user's own Claude Code: a closed state, a failure category and a version number
  'claude-link',
  // I-066 a speech cue that did not reach the inner loop (and what became of a held intent); a screen look's category. Closed only.
  'speech-cue', 'presence-look',
  // I-084 with 「发图片」 on: whether she saw the user this turn and why not. Closed words only, never the picture or the chat.
  'camera-look',
  // I-166 small frames every turn and her own closer look: which senses carried a small frame; which sense she looked closer at and how it ended (closed words, a number)
  'see-and-say',
  // I-086 she hands you something: the item, taken or not, and only the reasons it was offered (closed words)
  'give',
  // I-081 with pose sensing on: she started or stopped looking at you, an eye contact that reached her mood, a shy look-away. Never a position.
  'gaze',
  // I-135 认出"不是你": counts of face checks only (recognised / clearly not / unsure → you / skipped, times she switched). Never a picture, an embedding or a score.
  'face-check',
  // 2026-11-25 认出是不是你 (Beta): one check's closed outcome and its similarity (numbers, shared/senses/face-journal.ts), or why none ran. Never a picture or the face's numbers.
  'face-score',
  // I-087 hold hands, pinky promise, high five: which, how it ended, and only the closed reasons she reached out
  'hands',
  // I-088 her weekly and monthly look-backs: written, not enough yet, failed or unusable; week or month. Never a word of one.
  'period-review',
  // I-085 she looks at you because she wants to: why (closed), which sense, and how it ended. Never what she saw.
  'self-look',
  // I-085 step 3, text first: per chat turn with 和她一起看 or 「发图片」 on, whether each went as a picture or as text, and why a picture went
  'look-turn',
  // 松绑: one moment she thought of reaching out: how strong the urge was, what she did, or why nothing (closed categories only)
  'initiative',
  // I-188 one moment she recognised (a late night, the screen while watching together, a reminder, out of full screen, …): which, how it ended, why. Never a word.
  'moment',
  // I-098 one message's mood book: her tail or haiku after she spoke, how it went, the context and D/O/E/N/C numbers it gave. Never a word.
  'mood-book',
  // I-136 one merged touch (a click, a pull, a pinch): kind, part, place, count, the face she showed, the reaction, whether she spoke. Never a word.
  'touch', 'mood-snapshot',
  // Overhaul step 7: the part runner switched one unit off on its own: which part and unit, and `<start|tick|callback>:<error.name>`. Never a message.
  'part-off',
  // Unbound step 4: one thing she noticed of you while she was out (left, came back, faced her, waved, …): kind, sure or maybe, whether she spoke. Never a word.
  'noticed',
  // 2026-11-22 嘴型记录: per reply read aloud on the Unbound engine, per stretch the expression word and the peak lip opening (share of あ), floor/ceiling flags. Never a word.
  'mouth-reading',
  // I-189 a local pose use did something (her reading paused for you, a turned face in a call, a nod answer, the two-people note, sitting asked): closed words, seconds. Never a point or a picture.
  'pose-use',
  // 2026-11-22 a typed line that did not go out: why (closed), where it was typed, ms from the send to the drop. Never the line.
  'send-dropped',
  // 2026-11-22 free prewarm: one spare chat process spawned ahead of her first line, and why (a closed word). Nothing was sent to it.
  'spare-process',
  // 2026-11-23 I-202 the start gate for Claude Code processes: a reply failed because the login is gone (closed word login-lost). Never a failure text.
  'claude-gate',
  // 2026-11-22 显卡重置: the GPU process went away (how it ended, exit code) or WebGL went off for the run; counts in 10 minutes and this run
  'gpu-reset',
  // 2026-11-23 a kiss or a hug her reply wrote that did not walk up (its closed block word); an action of hers you ended directly (which, by what). Never a word.
  'close-beat-skipped', 'action-interrupted',
  // 2026-11-23 her "go where" words (went / stayed and why, metres) and each walk of hers that ended (whose, where, metres). Closed words and numbers.
  'go-beat', 'place-moved',
  // 2026-11-24 I-212 her hidden place marker in her reply to you (keep / clear your default place) and whether it took. Closed words.
  'default-place',
  // 2026-11-24 三人同框别卡: once at start which graphics chip draws (closed words), and once a minute per full-screen instance its frame times (numbers). Never a word.
  'gpu-start', 'frame-time',
  // 2026-11-24 每一句话都停: one reply's per-sentence reading timing (voice slice) and where its text stopped arriving (brain slice). Numbers and closed words only.
  'reading-segments', 'stream-gaps',
  // 2026-11-24 I-209 step 4: one chime-in decision (her haiku) or line on the full-screen stage: yes / no / dropped / failed, said / quiet / undelivered, ms. Never a word.
  'chime-in',
  // 2026-11-25 a Claude Code stream-json event kind the chat reader does not know, once per process: type and system subtype, identifier-shaped or "odd". Never a field's text.
  'claude-stream-kind',
  // 2026-11-25 a kiss or a hug her reply wrote in full screen, once its fate is known: played or not, and why not (closed words). Never a word.
  'close-beat',
  // 2026-11-25 the app was started from inside a Claude Code session: that session's endpoint and credential variable names left out of her processes, once per run. Never a value.
  'claude-env-dropped',
  // 2026-11-25 只有插话会打断她: a change that waited for her to finish (which kind, what she was doing). Closed words only.
  'setting-deferred'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/** What a caller hands to the writer (no time, no reason: the writer adds the time, this module the reason). */
export type JournalInput = StageJournalInput | SensesJournalInput | MemoryJournalInput | MoodJournalInput | BrainJournalInput | InitiativeJournalInput
  | SafetyJournalInput | CardsJournalInput | VoiceJournalInput;
// tsc fails here when a type in JOURNAL_TYPES has no input shape in a slice, or a slice has a type the list lacks.
type SameTypes<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type MustBeTrue<T extends true> = T;
type JournalTypesCovered = MustBeTrue<SameTypes<JournalInput['type'], JournalType>>;

/** One line of a journal file: the input's fields plus the version, the time and the fixed plain-language reason. */
export type JournalEntry = JournalInput & { v: 1; at: number; time: string; reason: string;
  /** The plain-language note, in its own field when the input has a `reason` of its own (a call's end keeps its reason word). */
  note?: string };

// ---------------------------------------------------------------- the slices, in part order

// The four tables are functions: nothing from a slice is read while this file loads. It sits in an import cycle (shared/memory's
// page -> this file -> shared/cards' page -> shared/cards/character-convert.ts -> shared/memory's page), and under CommonJS (some
// tests load it that way) a slice's page may not have filled in its names yet at that moment.
/** Each slice's entry types. */
const SLICE_TYPES = (): readonly (readonly string[])[] => [STAGE_JOURNAL_TYPES, SENSES_JOURNAL_TYPES, MEMORY_JOURNAL_TYPES, MOOD_JOURNAL_TYPES, BRAIN_JOURNAL_TYPES,
  INITIATIVE_JOURNAL_TYPES, SAFETY_JOURNAL_TYPES, CARDS_JOURNAL_TYPES, VOICE_JOURNAL_TYPES];
/** Each slice's builder, reason and panel line, in the same order (kept apart so a bundle that only shows lines can leave the builders out). */
const SLICE_BUILD = (): readonly ((type: string, v: Record<string, unknown>, characterId: string | null) => JournalInput | null)[] => [buildStageJournalEntry,
  buildSensesJournalEntry, buildMemoryJournalEntry, buildMoodJournalEntry, buildBrainJournalEntry, buildInitiativeJournalEntry, buildSafetyJournalEntry,
  buildCardsJournalEntry, buildVoiceJournalEntry];
const SLICE_REASON = (): readonly ((entry: never) => string)[] => [stageJournalReason, sensesJournalReason, memoryJournalReason, moodJournalReason, brainJournalReason,
  initiativeJournalReason, safetyJournalReason, cardsJournalReason, voiceJournalReason];
const SLICE_DESCRIBE = (): readonly ((entry: never, reason: string, tr: JournalTranslate) => string)[] => [describeStageJournalEntry, describeSensesJournalEntry,
  describeMemoryJournalEntry, describeMoodJournalEntry, describeBrainJournalEntry, describeInitiativeJournalEntry, describeSafetyJournalEntry,
  describeCardsJournalEntry, describeVoiceJournalEntry];

let sliceByType: Map<string, number> | undefined;
/** The slice an entry type belongs to, or -1 (not a journal type). */
function sliceOf(type: unknown): number {
  sliceByType ??= new Map(SLICE_TYPES().flatMap((types, slice) => types.map(name => [name, slice] as const)));
  return typeof type === 'string' ? sliceByType.get(type) ?? -1 : -1;
}

// ---------------------------------------------------------------- the fixed plain-language reasons

/** The fixed reason of an entry. Only enum fields choose it; nothing a caller wrote can reach it. */
export function journalReason(entry: JournalInput): string {
  const slice = sliceOf(entry.type);
  return (slice < 0 ? undefined : SLICE_REASON()[slice]!(entry as never)) as string;
}

// ---------------------------------------------------------------- building a line (the whitelist)

/** The only way a journal line is made: field by field from closed sets. Null when anything does not fit. */
export function buildJournalEntry(input: unknown, at: number): JournalEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !finite(at) || at < 0) return null;
  const v = input as Record<string, unknown>;
  const type = v.type;
  if (!has(JOURNAL_TYPES, type)) return null;
  const characterId = id(v.characterId);
  const body: JournalInput | null = SLICE_BUILD()[sliceOf(type)]!(type, v, characterId);
  if (!body) return null;
  const time = new Date(Math.floor(at)).toISOString();
  const note = journalReason(body);
  // A few inputs carry a reason word of their own (a call's end): it stays what it was and the note goes in its own field
  // (it used to be overwritten, and such a line then failed to read back through the whitelist).
  return { v: JOURNAL_VERSION, at: Math.floor(at), time, ...body, ...('reason' in body ? { note } : { reason: note }) } as JournalEntry;
}

/** A line read back from a journal file: parsed, then rebuilt through the same whitelist (a damaged or foreign line is dropped). */
export function readJournalLine(line: string): JournalEntry | null {
  if (typeof line !== 'string' || !line.trim() || line.length > 4_000) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || value.v !== JOURNAL_VERSION || !finite(value.at)) return null;
    return buildJournalEntry(value, value.at);
  } catch { return null; }
}

/** What the control window's "刚才发生了什么" shows (electron/memory/journal/app-journal.ts). Names come from the cards, not the journal. */
export interface JournalView {
  enabled: boolean;
  /** Newest last, at most JOURNAL_RECENT; empty while the switch is off. */
  entries: JournalEntry[];
  characters: Array<{ id: string; name: string; language?: string }>;
  /** The last write failed (the lines are still shown from memory). */
  failure: boolean;
  /** Today's file reached the daily ceiling. */
  truncatedToday: boolean;
}

// ---------------------------------------------------------------- "刚才发生了什么": one plain line per entry

/** "11:42 你摸了摸头 → 亲近 +6，现在：满足". Plain text only; the panel sets it as textContent. */
export function describeJournalEntry(entry: JournalEntry, tr: JournalTranslate): string {
  const reason = tr(entry.note ?? entry.reason);
  const slice = sliceOf(entry.type);
  const body = slice < 0 ? reason : SLICE_DESCRIBE()[slice]!(entry as never, reason, tr);
  return `${journalClock(entry.at)} ${body}`;
}
