// I-067 host side: read a card file's text the same way the importer does, then run the pure lint. A file that cannot be
// read gets no reminders here (the import itself says why); a lint problem never stops an import or an update.
import { cardLintNotice, lintCharacterCard } from '../../shared/cards/character-card-lint';
import { readCharacterCardFile } from './character-card-update';

export function lintCardFileText(text: string, existingNames?: readonly string[]): string[] {
  try { return lintCharacterCard(readCharacterCardFile(text).draft, existingNames ? { existingNames } : {}); } catch { return []; }
}
/** The notice to show after an import/update: the card's own notice (if any) plus the reminders. */
export function withCardLint<T extends { notice?: string }>(result: T, text: string, existingNames?: readonly string[]): T {
  const notice = cardLintNotice(lintCardFileText(text, existingNames), result.notice);
  return notice === undefined || notice === result.notice ? result : { ...result, notice };
}
