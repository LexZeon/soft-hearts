// Renderer wiring, 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): this window's SpeechBeatsView (src/brain/speech-beats-view.ts),
// made the first time somebody asks (nothing here runs on import). Both windows keep the host's final words for a reply (the grey line,
// her history); only the companion window performs, on its stage (the old stage's expressions and looks; the Unbound window engine waits for
// I-154 batch 2). Read-aloud on for the reply: the beats follow the reading; off: the bubble.
import { SpeechBeatsView } from '../brain';
import { isPet } from './shell-wiring'; // no-pet-ok: the existing name of the companion window flag
import { settings } from './settings-wiring';
import { stage } from './stage-wiring';
import { uiText } from '../foundation/ui-language';
import { speechBeatShownText } from '../../shared/behaviors/speech-beats/history';
import type { RecentChatShown } from '../../shared/memory';

let view: SpeechBeatsView | null = null;

/** This window's view of her beats. */
export function speechBeats(): SpeechBeatsView {
  return view ??= new SpeechBeatsView({
    now: () => performance.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...(isPet ? { perform: (word: string, span: boolean | 'line') => { stage?.speechBeat(word, span); }, release: reason => { stage?.speechBeatsRelease(reason); } } : {}), // no-pet-ok: the companion window flag
    pacing: () => settings.voice.enabled ? 'voice' : 'shown',
    ...(isPet ? {} : { note: (_replyId: string, line: string) => noteUnderReply(line) }), // I-195: the chat page's grey line under her reply; no-pet-ok: the companion window flag
  });
}

/** I-195: one small grey line inside her newest reply row (the host sends only "（她记了件事）", never what she wrote). */
function noteUnderReply(line: string): void {
  const rows = document.querySelectorAll('#messages .message.assistant');
  const row = rows[rows.length - 1];
  if (!row || row.querySelector('.message-note')) return;
  const note = document.createElement('div');
  note.className = 'message-note';
  note.textContent = uiText(line);
  row.append(note);
}

/** Her reply from history, as the reply reader shows it: never a marker (a performance-only one is empty there). */
/**
 * The rows a reloaded conversation was drawn with while one of its replies was only a performance (the grey line): they stand for `history` exactly as long
 * as it is the array they were drawn for (the next message makes a new one), so the other window asking for the state gets them too.
 */
let refilled: { base: unknown; rows: RecentChatShown[] } | null = null;
export function rememberRefilledRows(base: unknown, rows: RecentChatShown[] | null): void { refilled = rows ? { base, rows } : null; }
export const refilledRowsFor = (history: unknown): RecentChatShown[] | undefined => refilled && refilled.base === history ? refilled.rows : undefined;
export const shownReplyText = (content: string): string => speechBeatShownText(content).text;
