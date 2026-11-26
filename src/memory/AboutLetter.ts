import { LETTER, LETTER_ENGLISH_NOTE, LETTER_SUMMARY } from '../../shared/memory/letter';
import { currentUiLanguage } from '../../shared/foundation/ui-language';
import { createPaperEnvelope } from './PaperEnvelope';
import { uiText } from '../foundation/ui-language';

/**
 * The letter under 「关于」: one quiet line, opened on click, the text word for word (shared/memory/letter.ts). No popup,
 * nothing in the chat. Text goes in through textContent only. Mounting twice keeps one; no about block, nothing happens.
 */
export function mountAboutLetter(root: ParentNode): HTMLDetailsElement | null {
  const about = root.querySelector('.about');
  if (!about) return null;
  const existing = about.querySelector<HTMLDetailsElement>('details.about-letter');
  if (existing) return existing;
  const doc = about.ownerDocument;
  const details = doc.createElement('details');
  details.className = 'about-letter';
  const summary = doc.createElement('summary');
  summary.textContent = uiText(LETTER_SUMMARY);
  details.append(summary);
  const body = doc.createElement('div');
  body.className = 'about-letter-body';
  if (currentUiLanguage() === 'en') {
    const note = doc.createElement('p');
    note.className = 'about-letter-note';
    note.textContent = uiText(LETTER_ENGLISH_NOTE);
    body.append(note);
  }
  for (const text of LETTER.paragraphs) {
    const p = doc.createElement('p');
    p.textContent = text;
    body.append(p);
  }
  const signature = doc.createElement('p');
  signature.className = 'about-letter-signature';
  signature.textContent = LETTER.signature;
  // I-123: the letter-writer's little pixel envelope, right under its signature (seen only when the letter is open).
  signature.append(createPaperEnvelope(doc));
  body.append(signature);
  details.append(body);
  about.append(details);
  return details;
}
