import { callLookFromTurn, callLookNotTaken, type CallLookFields } from '../../../shared/voice';
import type { SenseTurnEnd } from './host';

/**
 * 2026-11-21: the
 * journal's "look" line for a chat message (typed, or voice input sent as a message: the path voice input takes while she is out). Before,
 * only voice and call segments (electron/senses/sense-router/voice.ts) wrote it, so for a chat message nothing said whether the semantic
 * judgment was asked, what it answered, or whether the turn ended first: "was it the meaning, or was it never asked?" could not be told.
 *
 * Same closed words as the call line (shared/voice/call-look-journal.ts), marked `chat`. Only while the camera or the screen is on, or the
 * phrase rules asked for a frame (otherwise there was nothing to look at and no line). Never the words, a frame or the facts.
 */
export interface ChatLookLine {
  /** The router's turn end for a message it took (pass as its `onEnd`). */
  onEnd(rules: readonly ('camera' | 'screen')[]): (end: SenseTurnEnd) => void;
  /** A message the router did not take (its switch off, no character, no judgment possible). */
  notTaken(rules: readonly ('camera' | 'screen')[], on: { camera: boolean; screen: boolean }, held: boolean): void;
}

export function chatLookLine(write: ((fields: CallLookFields & { chat: true }) => void) | undefined): ChatLookLine {
  const note = (fields: CallLookFields) => { try { write?.({ ...fields, chat: true }); } catch { /* journal only */ } };
  return {
    onEnd: rules => end => { if (end.on.camera || end.on.screen || rules.length) note(callLookFromTurn({ call: false, rules, end })); },
    notTaken: (rules, on, held) => { if (on.camera || on.screen || rules.length) note(callLookNotTaken({ call: false, rules, camera: on.camera, screen: on.screen, held })); },
  };
}
