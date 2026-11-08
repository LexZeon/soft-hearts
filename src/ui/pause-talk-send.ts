import type { PauseTalkCut } from '../../shared/behaviors/pause-talk/interface';

/**
 * F7 停停说说, the moment the user sends an ordinary message (src/main.ts sendChat). Switch on: the earlier reply's reveal stops
 * where it is, and how far it got goes with the request (only a number; the host has the text) so its unsaid part can become the
 * next turn's background. Switch off: nothing here touches the reveal, which goes on exactly as before until the new reply replaces it.
 */
export function pauseCutForSend(enabled: boolean, presentation: { interrupt(): PauseTalkCut | null }): PauseTalkCut | undefined {
  if (enabled !== true) return undefined;
  return presentation.interrupt() ?? undefined;
}
