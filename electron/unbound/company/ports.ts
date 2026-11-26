/**
 * I-209 step 1: the company's ports from the app's card store and asset registry (electron/wiring/unbound-wiring.ts gives them). Only
 * structural shapes, so this part never imports the cards part: a card's id, name and whether a model is linked go to the panel; an
 * extra's model goes to the page only as the asset URL the registry hands out (never the path). The bundled Gene is the reviewed one.
 */
import type { CompanyCard } from '../../../shared/unbound/company';
import type { CompanyPorts } from './host';

/** The card store's members this reads (electron/cards/character-cards.ts). */
export interface CompanyCardSource {
  modelCards(): { id: string; name: string; modelPath?: string; language?: string }[];
  presetGeneId(): Promise<string | null>;
  publicState(): { activeId: string };
}
/** The models this may hand out: the bundled Gene (checked), any other model file the card links (registered, its folder only). */
export interface CompanyModelSource {
  bundledModel(): Promise<{ url: string }>;
  register(file: string): Promise<{ url: string }>;
}
export const BUNDLED_MODEL_REFERENCE = 'bundled:gene';

/** `present` (I-209 step 2): who is drawn on stage besides the one you talk with, for the brain (CompanionService.stage). */
export function companyPorts(source: () => { cards: CompanyCardSource | null; models: CompanyModelSource | null }, present?: (ids: readonly string[]) => void, enabled?: () => boolean,
  /** I-219: the display names for the panel (a language tag when the cards mix languages); the cards part decides, this part only carries it. */
  labels?: (cards: readonly { id: string; name: string; language?: string }[]) => ReadonlyMap<string, string>): CompanyPorts {
  const cache = new Map<string, Promise<{ url: string; reviewed: boolean } | null>>();
  const reference = async (id: string): Promise<string | null> => {
    const cards = source().cards;
    if (!cards) return null;
    const preset = await cards.presetGeneId().catch(() => null);
    if (id === preset) return BUNDLED_MODEL_REFERENCE;
    return cards.modelCards().find(card => card.id === id)?.modelPath ?? null;
  };
  return {
    ...(present ? { present } : {}),
    ...(enabled ? { enabled } : {}),
    cards: async () => {
      const cards = source().cards;
      if (!cards) return [];
      const preset = await cards.presetGeneId().catch(() => null);
      const all = cards.modelCards(), shown = labels?.(all);
      return all.map((card): CompanyCard => ({ id: card.id, name: card.name.slice(0, 40), hasModel: card.id === preset || !!card.modelPath, ...(shown?.get(card.id) ? { label: shown.get(card.id)!.slice(0, 50) } : {}) }));
    },
    current: () => source().cards?.publicState().activeId || null,
    model: async id => {
      const ref = await reference(id), models = source().models;
      if (!ref || !models) return null;
      const key = `${id}\n${ref}`;
      let found = cache.get(key);
      if (!found) {
        found = (ref === BUNDLED_MODEL_REFERENCE ? models.bundledModel().then(model => ({ url: model.url, reviewed: true }))
          : models.register(ref).then(model => ({ url: model.url, reviewed: false }))).catch(() => null);
        cache.set(key, found);
        void found.then(value => { if (!value) cache.delete(key); }); // a model that could not be read is asked again next time
      }
      return found;
    },
  };
}
