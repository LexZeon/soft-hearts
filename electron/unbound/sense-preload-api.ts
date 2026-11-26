/**
 * Batches D, F (docs/claude/2026-11-21-unbound-full-D.md): the Unbound window's part of window.unbound for her senses out here. Read only, on
 * fixed `unbound:` channels: where pose sensing says you are (the companion window's userGaze reading; null: sensing went off), the music
 * samples of 和她一起听 (the companion window's dance frames; null: the dance went off), 惊喜 / 害羞 from the preview buttons; and one request
 * for her facts about them (the host takes only the closed kinds, only from the window she is shown in: electron/unbound/sense-bridge.ts).
 * No frame, picture or sound ever comes here, and nothing here turns a sense on.
 */
import { UNBOUND_REQUESTS } from '../../shared/unbound/scene';
import { UNBOUND_SENSE_EVENTS, type HerFactKind } from '../../shared/unbound/sense-relay';

export interface UnboundSenseApi {
  onUserGaze(callback: (reading: unknown) => void): () => void;
  onDance(callback: (frame: unknown) => void): () => void;
  onExpressionPreview(callback: (recipe: unknown) => void): () => void;
  /** 2026-11-24: the user's music settings (two plain values), before the first music frame and on every change. */
  onMusicSettings(callback: (settings: unknown) => void): () => void;
  herFact(kind: HerFactKind, value: unknown): Promise<boolean>;
}
export const UNBOUND_SENSE_API_KEYS = Object.freeze(['onUserGaze', 'onDance', 'onExpressionPreview', 'onMusicSettings', 'herFact'] as const);

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type Subscribe = <T>(channel: string, callback: (value: T) => void) => () => void;

export function createUnboundSenseApi(invoke: Invoke, subscribe: Subscribe): UnboundSenseApi {
  const E = UNBOUND_SENSE_EVENTS;
  return {
    onUserGaze: callback => subscribe(E.userGaze, callback),
    onDance: callback => subscribe(E.dance, callback),
    onExpressionPreview: callback => subscribe(E.expressionPreview, callback),
    onMusicSettings: callback => subscribe(E.musicSettings, callback),
    herFact: (kind, value) => typeof kind !== 'string' ? Promise.reject(new TypeError('herFact takes a kind')) : invoke(UNBOUND_REQUESTS.herFact, kind, value) as Promise<boolean>,
  };
}
