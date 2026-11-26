/**
 * I-053: the experience journal's `music-verdict` line (shared/memory/journal.ts) is made only of these: a verdict flip of the companion window's
 * fast "is it music" layer (src/stage/music-likeness.ts), as numbers and one closed reason. Never audio, titles or lyrics.
 */
export const MUSIC_OFF_REASONS = ['silence', 'speech-like', 'beat-faded', 'memory-ended', 'capture-stopped'] as const;
export type MusicOffReason = (typeof MUSIC_OFF_REASONS)[number];

/** The journal's words for each reason (Chinese; shared/foundation/ui-copy.journal.en.ts has the English next to it). */
export const MUSIC_OFF_LABEL: Readonly<Record<MusicOffReason, string>> = {
  silence: '安静了', 'speech-like': '像在说话', 'beat-faded': '拍子没了', 'memory-ended': '这首歌记忆结束了（连续像对白）', 'capture-stopped': '声音采集停了',
};
