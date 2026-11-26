import type { MediaOwner } from '../../../shared/foundation/runtime-state';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import { CALL_LOOK, spokenLookText } from '../../../shared/senses/call-look';
import { senseCarryNote } from '../../../shared/senses/sense-carry';
import { withheldLook } from '../../../shared/senses/look-request';
import type { SenseId } from '../../../shared/senses/sense-router';
import { callLookFromTurn, callLookNotTaken, type CallLookFields } from '../../../shared/voice';
import type { SenseRouterHost } from './host';

/**
 * I-161 semantic look for voice input and calls (asked whether a spoken "can you see me" with the camera on should count as
 * asking her to look; his answer: it should be decided by meaning, and it had been studied before; earlier he reported a voice turn that did not read the screen by meaning). Before, a voice or call segment ran only the phrase rules (shared/senses/look-request.ts,
 * look-can-see.ts via electron/senses/voice-look.ts), so a phrasing outside them never looked. Now each new utterance also goes through
 * typed chat's I-040 judgment (electron/senses/sense-router/host.ts):
 *  - the question rides on the reaction judge's one haiku call the utterance already makes (electron/wiring/senses-voice-input-wiring.ts
 *    calls reactions.userTurn first): no new judgment call. When that call is not made, its own small call only with
 *    CALL_LOOK.semanticOwnJudge (off: new usage waits for the user);
 *  - the phrase rules stay the fast path: a sense they already took a clear frame of is left out (`covered`);
 *  - voice input outside a call: as typed chat, her short line after her reply;
 *  - in a call: never a second reply. The facts go into her next call words, read where that segment is written: this segment when the
 *    look finished before it was written, else a later one (`note`); that segment ending forgets them (`done`); hang-up drops all (`end`).
 *    A look still going when the next segment arrives is not thrown away (carry-store.ts, host.ts
 *    `lingering`): its facts wait, with how long ago, as something she knows, never an order to say it.
 * Nothing here turns a sense on; "别看", a switch off and the I-161 A frame rules are the router's and voice-look's, unchanged. Never throws.
 */
export interface VoiceSensePorts {
  /** The I-040 router (null: not made yet). */
  router(): Pick<SenseRouterHost, 'userTurn' | 'firstChar' | 'replyDone' | 'takeCarried' | 'releaseCarried' | 'endScope' | 'sensesOn'> | null;
  /** The reaction judge will ask haiku about this utterance (reactions.host.asking): the question rides on it. */
  asking(groupId: string): boolean;
  /** reactions.firstChar, as typed chat calls it: without a warm haiku the reaction call starts after her first character (not 4 s after). */
  reactionFirstChar?(groupId: string): void;
  /** This capture is a call (or another continuous listening the call's rules cover). */
  inCall(owner: MediaOwner): boolean;
  /** Her card's language, for the carried line. */
  language(): CardLanguage | null;
  /** The experience journal's one line for a segment that considered a look (closed words; electron/memory/journal/extras.ts). */
  journal?(fields: CallLookFields): void;
  /** Tests: CALL_LOOK.semanticLook and CALL_LOOK.semanticOwnJudge. */
  enabled?(): boolean;
  ownJudge?(): boolean;
}

/** What the voice host calls (electron/voice/voice-chat-host.ts `senses`). */
export interface VoiceSegmentSenses {
  /** A new utterance, right after the reaction judge took it (synchronously, before anything is awaited). */
  turn(input: { groupId: string; text: string; owner: MediaOwner; scope: string; covered: readonly ('screen' | 'camera')[] }): void;
  /** Her reply to it showed a character (the reaction call and an own judgment may start now, never beside her first character). */
  firstChar(groupId: string): void;
  /** The segment's private line about a finished look ('' for none), read where it is written. */
  note(input: { replyId: string; scope: string; text: string }): string;
  /** The segment ended: 'complete', 'superseded' (more of the utterance came), 'stopped' or 'error'; `text`: what it showed. */
  done(input: { groupId: string; replyId: string; status: string; text: string }): void;
  /** The capture ended (hang-up, voice input off, scope change). */
  end(scope: string): void;
}

export function voiceSegmentSenses(ports: VoiceSensePorts): VoiceSegmentSenses {
  /** Utterances this took, and how each joins ('line' or 'carry'); the last few only. */
  const joins = new Map<string, 'line' | 'carry'>();
  const router = () => { try { return ports.router(); } catch { return null; } };
  const flag = (read: (() => boolean) | undefined, fallback: boolean) => { try { return read ? read() === true : fallback; } catch { return false; } };
  return {
    turn: input => {
      try {
        const host = router();
        const call = ports.inCall(input.owner), words = spokenLookText(input.text);
        // One journal line per segment that considered a look (closed words; shared/voice/call-look-journal.ts): from the router's turn end,
        // or here at once when nothing was judged. Never into her words.
        const note = (fields: CallLookFields) => { try { ports.journal?.(fields); } catch { /* journal only */ } };
        const notTaken = () => { const w = withheldLook(words), on = (() => { try { return host?.sensesOn(); } catch { return null; } })();
          note(callLookNotTaken({ call, rules: input.covered, camera: on?.camera === true, screen: on?.screen === true, held: w === 'refused' || w === 'unread' })); };
        if (!host || !flag(ports.enabled, CALL_LOOK.semanticLook)) { notTaken(); return; }
        const join = call ? 'carry' : 'line';
        // The recognizer's misheard 别 before a look verb reads as "别看" here too (only ever a frame less).
        const took = host.userTurn(input.groupId, words, { merged: ports.asking(input.groupId), covered: input.covered as SenseId[],
          join, ownJudge: flag(ports.ownJudge, CALL_LOOK.semanticOwnJudge), scope: input.scope,
          onEnd: end => note(callLookFromTurn({ call, rules: input.covered, end })) });
        if (!took) { notTaken(); return; }
        joins.set(input.groupId, join);
        while (joins.size > 16) joins.delete(joins.keys().next().value!);
      } catch { /* phrase rules only, as before */ }
    },
    firstChar: groupId => {
      try { ports.reactionFirstChar?.(groupId); } catch { /* never into her words */ }
      try { if (joins.has(groupId)) router()?.firstChar(groupId); } catch { /* never into her words */ }
    },
    note: input => {
      try {
        const notes = router()?.takeCarried(input.scope, input.replyId, spokenLookText(input.text)) ?? [];
        return notes.length ? senseCarryNote(notes, ports.language()) : '';
      } catch { return ''; }
    },
    done: input => {
      try {
        const host = router();
        host?.releaseCarried(input.replyId);
        // Outside a call her short line follows her reply as in typed chat; a merged-away leg waits for the next leg of the utterance.
        if (joins.get(input.groupId) !== 'line' || input.status === 'superseded') return;
        host?.replyDone(input.groupId, input.status === 'complete', input.status === 'complete' ? input.text : '');
      } catch { /* best effort */ }
    },
    end: scope => { try { router()?.endScope(scope); } catch { /* best effort */ } },
  };
}
