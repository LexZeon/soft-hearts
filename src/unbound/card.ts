/**
 * I-159 C: the card beside her (electron/unbound/card-window.ts). The very same card the control window's chat shows (src/brain/
 * ChatSettingCard.ts renders it; text only through textContent), with a tap going to the host through window.unboundCard
 * (electron/unbound/card-preload-api.ts) and nowhere else. The host decides what is live; this page only draws and forwards.
 */
import type { UnboundCardApi } from '../../electron/unbound/card-preload-api';
import { ChatSettingCards } from '../brain';
import { isUiLanguage } from '../../shared/foundation/ui-languages';
import { setUiLanguage } from '../foundation/ui-language';

const api = (window as unknown as { unboundCard?: UnboundCardApi }).unboundCard;
const container = document.getElementById('cards') as HTMLDivElement;
const cards = new ChatSettingCards({
  choose: request => (api ? api.choose(request) as Promise<never> : Promise.resolve(null)),
  container: () => container,
  settledLifetimeMs: 4_000, // the host hides the window a little after (electron/unbound/card-surface.ts CARD_SETTLED_MS)
});
api?.onCard((card, language) => {
  if (isUiLanguage(language)) { setUiLanguage(language); document.documentElement.lang = language; }
  cards.present(card);
});
