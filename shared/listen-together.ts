// I-016 B part, 一起听、一起看 (docs/claude/2026-11-03-listen-together.md, plan docs/claude/2026-11-03-listen-watch-plan.md).
// One switch 「和她一起听」 (the computer's sound). What the computer plays is cut into segments by shared/listen-kind.ts (a song;
// one continuous viewing of a show); the local transcript of a segment is only raw material, kept for the latest few segments;
// a small model writes a note (摘要) per segment, kept long-term per character; she reads the note when you ask, or says one line
// at a natural pause. Never audio; "just talk" (a call, a meeting, a podcast) is never kept.
// Pure: no clock, no I/O.

import type { AudioReadingView } from './audio-reading-toggles';

/** Every bound of the feature in one place (all trial values; the record says why each is what it is). */
export const LISTEN_LIMITS = Object.freeze({
  /** Raw text: keep at least the latest this many segments… */
  keepSegments: 20,
  /** …or every segment that ended within this long, whichever keeps more. */
  keepMs: 3 * 60 * 60_000,
  /** A safety cap on raw segments whatever the rule above says (a runaway producer). */
  hardSegments: 200,
  /** Raw characters per segment; the oldest pieces go first beyond it (the note already covers them). */
  segmentChars: 24_000,
  /** One transcript piece (the broker's own cap is 4000). */
  pieceChars: 4_000,
  /** A song that flickers to "unsure" this briefly is still the same song. */
  musicGapMs: 5_000,
  /** A show interrupted for longer than this starts a new viewing. */
  showGapMs: 10 * 60_000,
  /** A long viewing gets a rolling note this often. */
  rollMs: 10 * 60_000,
  /** A "song" this long without a gap (a mix) is cut into pieces of this length. */
  musicMaxMs: 12 * 60_000,
  /** Shorter segments get no note at all. */
  minNoteMs: 60_000,
  /** Fewer letters than this in a song: no lyrics (pure music, a local note only). */
  lyricLetters: 12,
  /** Transcripts while the kind is undecided wait this long to be placed (kept only if it turns out music or a show). */
  pendingMs: 90_000,
  /** A show quiet this long is paused: a natural pause point. */
  pauseMs: 30_000,
  /** At a pause, a rolling note is written now if at least this many letters arrived since the last note. */
  pauseLetters: 120,
  /** Notes kept per character; beyond it the oldest go (long-term, but not unbounded). */
  notesPerCharacter: 2_000,
  /** What one haiku call may read: the newest part of the window, in characters. */
  noteInputChars: 6_000,
  /** 2026-11-07: talk (voices, no music: narration, a call, a class) is kept in memory only this long, and never written anywhere. */
  talkMemoryMs: 10 * 60_000,
  /** A memory cap for that (the oldest pieces go first). */
  talkMemoryChars: 12_000,
  /** "Someone is talking": a transcribed piece arrived this recently (her hearing line; pieces come every few seconds). */
  speechRecentMs: 45_000,
});

export type ListenSegmentKind = 'music' | 'show';
/** Recognized language codes the transcript route reports (electron/asr/ambient-route.ts); anything else is null. */
export type ListenLanguage = 'zh' | 'en' | 'ja' | null;

export interface ListenPiece { at: number; end: number; text: string; language: ListenLanguage }

/** Raw material of one segment. */
export interface ListenSegment {
  id: string;
  characterId: string;
  kind: ListenSegmentKind;
  startedAt: number;
  /** The last time sound of this kind was heard in it. */
  lastHeardAt: number;
  /** Set when the segment closed (a song ended, a viewing was interrupted too long, the switch went off). */
  endedAt: number | null;
  pieces: ListenPiece[];
  /** Pieces up to this time are covered by the segment's note. */
  notedUpTo: number;
  /** The last time a note (rolling or final) was asked for. */
  notedAt: number;
}

/** What the note says (the small model's strict answer, or a local note for pure music). */
export interface ListenNoteBody {
  what: '歌' | '剧' | '视频' | '其他';
  gist: string;
  mood: string;
  points: string[];
  mention: boolean;
  hook: string;
}

/** A long-term note: "what she listened to and watched with you". Kept per character, readable and deletable. */
export interface ListenNote extends ListenNoteBody {
  id: string;
  characterId: string;
  segmentId: string;
  kind: ListenSegmentKind;
  startedAt: number;
  endedAt: number;
  /** True for a note written locally (pure music, nothing sent anywhere). */
  local: boolean;
  languages: Exclude<ListenLanguage, null>[];
  createdAt: number;
  updatedAt: number;
  /** How many times it was rewritten while the viewing went on. */
  rolls: number;
  /** She mentioned it and the user answered (R14: the chat memory has the words; this marks it as talked about). */
  talkedAt: number | null;
}

/** The control window's view: counts of raw material and the notes (newest first). No raw text. */
export interface ListenTogetherView {
  raw: { segments: number; characters: number; oldestAt: number | null };
  notes: ListenNoteView[];
  total: number;
}
export interface ListenNoteView {
  id: string; kind: ListenSegmentKind; startedAt: number; endedAt: number; local: boolean; talked: boolean;
  what: ListenNoteBody['what']; gist: string; mood: string; points: string[];
}

export const noteView = (note: ListenNote): ListenNoteView => ({ id: note.id, kind: note.kind, startedAt: note.startedAt,
  endedAt: note.endedAt, local: note.local, talked: note.talkedAt !== null, what: note.what, gist: note.gist, mood: note.mood,
  points: [...note.points] });

/** Letters and digits only (punctuation and spaces do not make lyrics). */
export const letterCount = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
export const segmentText = (segment: Pick<ListenSegment, 'pieces'>, from = -Infinity): string =>
  segment.pieces.filter(piece => piece.end > from).map(piece => piece.text.trim()).filter(Boolean).join('\n');
export const segmentLanguages = (segment: Pick<ListenSegment, 'pieces'>): Exclude<ListenLanguage, null>[] =>
  [...new Set(segment.pieces.map(piece => piece.language).filter((l): l is Exclude<ListenLanguage, null> => l !== null))];

/**
 * Which raw segments stay (user decision: not by day; "最近 20 段或最近几小时取多的那个"): every open segment, the latest
 * `keepSegments` closed ones, and every closed one that ended within `keepMs`, up to `hardSegments`. Returns the ids to keep.
 */
export function rawSegmentsToKeep(segments: readonly Pick<ListenSegment, 'id' | 'endedAt' | 'lastHeardAt'>[], now: number,
  limits: Pick<typeof LISTEN_LIMITS, 'keepSegments' | 'keepMs' | 'hardSegments'> = LISTEN_LIMITS): Set<string> {
  const open = segments.filter(s => s.endedAt === null);
  const closed = segments.filter(s => s.endedAt !== null).sort((a, b) => b.endedAt! - a.endedAt! || b.lastHeardAt - a.lastHeardAt);
  const keep = new Set(open.map(s => s.id));
  closed.forEach((s, index) => { if (index < limits.keepSegments || now - s.endedAt! <= limits.keepMs) keep.add(s.id); });
  if (keep.size > limits.hardSegments) {
    const ordered = [...open, ...closed].filter(s => keep.has(s.id)).slice(0, limits.hardSegments);
    return new Set(ordered.map(s => s.id));
  }
  return keep;
}

/**
 * The single switch (the four reading switches become one 「和她一起听」 = the computer's sound; the microphone
 * two are gone). Old state counts: any of the computer's-sound cells on (music or watching), or the computer's sound rhythm on,
 * means the switch is on. Nothing is saved across restarts (each start begins off, as before).
 */
export function listenSwitchOn(view: Pick<AudioReadingView, 'sources'> | null | undefined, systemDance: boolean): boolean {
  const system = view?.sources?.['system-audio'];
  return systemDance || system?.music?.intent === true || system?.movie?.intent === true;
}

/** Whether her transcription (words) is on, not only the rhythm. */
export function listenWordsOn(view: Pick<AudioReadingView, 'sources'> | null | undefined): boolean {
  const system = view?.sources?.['system-audio'];
  return system?.music?.intent === true || system?.movie?.intent === true;
}
