/**
 * Her own line while she is out, into her bubble (moved out of electron/unbound/host.ts unchanged on 2026-11-24, I-209 step 3, so the host
 * file only shrinks): an inner-loop or touch line, a visual topic, an ambient comment. It goes into her bubble now (delta, then done with
 * how long it lingers), with the read-aloud proof's revision, and her peek and life hear the cue (she speaks), as for a reply.
 */
import type { UnboundBubble } from '../../shared/unbound/scene';
import { UNBOUND_EVENTS } from '../../shared/unbound/scene';
import { lingerField } from './bubble-linger';
import type { UnboundBubbleProof } from './read-aloud';

export interface HoldLinePorts {
  proof: Pick<UnboundBubbleProof, 'line'>;
  send(channel: string, value: unknown): void;
  lingerMs?(text: string): number;
  /** The cue (she speaks): her peek and her life. */
  cue(type: 'delta' | 'done'): void;
}

/** `{ held: true }` once it is in her bubble; nothing (an empty object) for an id or a text that may not go there. */
export function holdLineIn(ports: HoldLinePorts, id: string, text: string): { held: true } | Record<string, never> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 4_000) return {};
  const rev = ports.proof.line(id, text);
  ports.send(UNBOUND_EVENTS.bubble, { id, type: 'delta', text, rev } satisfies UnboundBubble);
  ports.send(UNBOUND_EVENTS.bubble, { id, type: 'done', text: '', rev, ...lingerField(ports.lingerMs, text) } satisfies UnboundBubble);
  ports.cue('delta'); ports.cue('done');
  return { held: true };
}
