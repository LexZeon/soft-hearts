/**
 * I-159 C: the Electron pieces for the card beside her (electron/unbound/card-surface.ts): its small window and the link to the
 * host's own card path. electron/wiring/unbound-wiring.ts creates this once; brain-wiring hands it every card the owning window gets.
 */
import type { ChatSettingCardView } from '../../shared/brain';
import type { UnboundState } from '../../shared/unbound/scene';
import type { UnboundHost } from './host';
import { UnboundCardWindow } from './card-window';
import { UnboundCardSurface } from './card-surface';
import type { UnboundPageSource } from './window';

export interface UnboundCardsWiring {
  page: UnboundPageSource;
  host(): UnboundHost | null;
  /** The host's card path for a tap (ChatSettingProposals.chooseMirrored); null while it is not connected. */
  choose(): ((request: { proposalId: string; choiceId: string }) => Promise<unknown>) | null;
}
export interface UnboundCardsHandle {
  offer(card: ChatSettingCardView): void;
  modeChanged(state: UnboundState): void;
  quit(): void;
}

export function createUnboundCards(wiring: UnboundCardsWiring): UnboundCardsHandle {
  const view: UnboundCardWindow = new UnboundCardWindow({ page: wiring.page, choose: request => surface.choose(request) });
  const surface: UnboundCardSurface = new UnboundCardSurface({
    state: () => wiring.host()?.state ?? 'normal', window: () => wiring.host()?.windowRect() ?? null,
    askHead: () => wiring.host()?.askHead() ?? Promise.resolve(null), view,
    choose: request => wiring.choose()?.(request) ?? Promise.resolve(null),
  });
  return {
    offer: card => { void surface.offer(card).catch(error => console.error('Unbound card', error)); },
    modeChanged: state => surface.modeChanged(state),
    quit: () => { surface.quit(); view.dispose(); },
  };
}
