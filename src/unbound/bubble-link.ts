/**
 * What the page does with each piece of a reply the host sends (moved out of main.ts 2026-11-24 so the page file shrinks; no behaviour change).
 * U2: a live cue for the director (she speaks); a reply starting mid-peek backs her off. E3: the cue comes first (it may start the opening
 * beat), then the gate, which passes the bubble straight on unless that beat is holding it for its turn.
 */
import type { UnboundBubble } from '../../shared/unbound/scene';
import type { Director } from './director/director';
import type { HerOut } from './her';
import type { SpeechBubbleGate } from './director/speech-beat';

export interface BubbleLinkParts {
  director: Director;
  gate: SpeechBubbleGate;
  her: Pick<HerOut, 'replyMoved' | 'play'>;
  /** 边说边演: the beats' own pieces (not text: the bubble never sees them). */
  beats: { receive(value: UnboundBubble): void };
}

export function bubbleLink(parts: BubbleLinkParts): (value: UnboundBubble) => void {
  const { director, gate, her, beats } = parts;
  return value => {
    if (value?.type === 'beats') { beats.receive(value); return; }
    if (value?.type === 'delta') director.setCue({ ...director.currentCue, speaking: true, replyId: value.id });
    else if (value?.type === 'done' || value?.type === 'error') director.setCue({ ...director.currentCue, speaking: false });
    if (value?.type === 'delta' || value?.type === 'done' || value?.type === 'error') { her.replyMoved(); } // her thinking look ends with the first words
    gate.receive(value);
  };
}
