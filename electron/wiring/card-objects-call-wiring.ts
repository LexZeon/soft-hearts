// I-208 step 3: the live end of a card's object notes (electron/wiring/card-objects-wiring.ts holds the logic and takes ports). Kept apart so the logic can be imported
// without Electron's wiring. The archive page's edit and delete arrive on the `herAlarms` channel (the preload may not grow): initiative-moments-wiring hands them here.
// No module-level side effects.
import type { ObjectNoteRequest } from '../../shared/cards';
import { objectNoteRequest } from './card-objects-wiring';
import { characterCards } from './cards-ready-wiring';
import { companion } from './brain-wiring';
import { recycleSingle, recycleStores, takeObjectNote } from './memory-wiring';

/** Edit or delete one note of the character the request names (a delete goes into the recycle bin first). */
export function cardObjectNoteCall(request: ObjectNoteRequest): Promise<{ changed: boolean }> {
  return objectNoteRequest(request, id => characterCards.publicState().cards.find(card => card.id === id), companion.relationship,
    (take, remove) => recycleSingle(take as never, remove), id => takeObjectNote(recycleStores(), request.characterId, id));
}
