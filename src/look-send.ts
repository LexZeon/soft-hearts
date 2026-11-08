import type { Attachment } from '../shared/contracts';

/**
 * 识图第 1 步「细看」, the window's half of a chat send (src/main.ts sendChat): the window decides nothing about looking. It tells
 * the host the words exactly as they are sent and whether "给她看看屏幕" was pressed; the host reads the words with the one rule
 * (shared/look-request.ts via electron/look-attachments.ts) and takes a frame only after a yes. Kept here so the whole send path
 * is tested with the real pieces (tests/look-refusal-send-path.test.ts, docs/claude/2026-11-04-v1-refusal-grab.md).
 */
export function lookHint(content: string, look: boolean): { text: string; look?: true } {
  return { text: content, ...(look ? { look: true as const } : {}) };
}

/**
 * The frames this turn sends: snapshots the user attached by hand, then what the host took for it; one per source, two at most.
 * The host's frames go on as they came (with their `shareTicket`): that mark is how the host tells them from the user's own.
 * I-036: a camera snapshot the user took by hand (「拍一张给她看」, a clear one) wins over the host's camera frame (the small
 * 「发图片」 one); for the screen the host's fresh frame wins, as before.
 */
export function turnAttachments(manual: readonly Attachment[], shared: readonly Attachment[]): Attachment[] {
  const ownCamera = manual.some(shot => shot.source === 'camera');
  const host = shared.filter(shot => !(ownCamera && shot.source === 'camera'));
  return [...new Map([...manual, ...host].map(shot => [shot.source, shot])).values()].slice(0, 2);
}

/**
 * What a clear of the chat leaves in the control window's draft. Turning sharing off (or the host clearing the vision context)
 * starts the shown conversation over, but a snapshot the user attached by hand stays, like the words typed in the box: the user
 * chose it, sees it with its ×, and sharing never governed it (Codex T-205 round 4: it vanished when sharing was turned off on
 * the pet). A shared frame is never part of a draft. Any other clear (new chat, character, model, reset) empties the draft as before.
 */
export function draftAfterClear(draft: readonly Attachment[], keepHandAttached: boolean): Attachment[] {
  return keepHandAttached ? draft.filter(shot => shot.shareTicket === undefined) : [];
}
