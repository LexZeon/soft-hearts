// I-207: the live end of a card's milestone (electron/wiring/card-milestone-wiring.ts holds the logic and takes ports). Kept apart so the logic can be imported
// without Electron's wiring. The user profile page's call arrives on the `herAlarms` channel (the preload may not grow): initiative-moments-wiring hands it here.
// No module-level side effects.
import type { CardMilestoneRequest, CardMilestoneView } from '../../shared/cards';
import { cardMilestoneRequest } from './card-milestone-wiring';
import { characterCards } from './cards-ready-wiring';
import { companion } from './brain-wiring';
import { recycleSingle, recycleStores, takeCardMilestone } from './memory-wiring';

/** Read the active card's milestone, or clear it (into the recycle bin first). Null: the card declares none. */
export function cardMilestoneCall(request: CardMilestoneRequest): Promise<CardMilestoneView | null> {
  const card = characterCards.getActive();
  return cardMilestoneRequest(request, card, companion.relationship, (take, remove) => recycleSingle(take as never, remove), () => takeCardMilestone(recycleStores(), card.id));
}
