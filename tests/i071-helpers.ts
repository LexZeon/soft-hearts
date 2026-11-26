// I-071 test helper: the shipped Gene preset as a validated draft.
import { preinstalledGeneDraft } from '../electron/cards/gene-preinstalled-card';
import type { CharacterDraft } from '../shared/foundation/character-card';

export function GENE_PRESET_CARD_DRAFT(): CharacterDraft {
  return preinstalledGeneDraft();
}
