import { currentUiLanguage, t } from '../../shared/ui-language';
export { setUiLanguage, currentUiLanguage, t } from '../../shared/ui-language';

/** Call only with authored interface copy. User/provider text must bypass this function. */
export function uiText(source: string, ...values: readonly unknown[]): string {
  return t(source, Object.fromEntries(values.map((value, index) => [String(index), String(value)])));
}
export function uiTemplate(chunks: TemplateStringsArray, ...values: readonly unknown[]): string {
  return uiText(chunks.map((chunk, index) => chunk + (index < values.length ? `{${index}}` : '')).join(''), ...values);
}
export function uiMarkup(markup: string): string { return translateStaticMarkup(markup); }

/** Translate only static authored markup chunks. Interpolated private content is untouched. */
export function uiHtml(chunks: TemplateStringsArray, ...values: readonly unknown[]): string {
  return chunks.map((chunk, index) => translateStaticMarkup(chunk) + (index < values.length ? String(values[index]) : '')).join('');
}

function translateStaticMarkup(markup: string): string {
  if (currentUiLanguage() !== 'en') return markup;
  // Each replacement is an exact text/accessible-attribute value, never an id, URL or event.
  return markup.replace(/(^|>)([^<>]*)(?=<|$)|((?:title|placeholder|aria-label|data-prompt)=)(["'])([^"']*)\4/g,
    (whole, opening: string | undefined, text: string | undefined, attribute: string | undefined, quote: string | undefined, value: string | undefined) => {
      if (opening !== undefined) {
        const body = text ?? '';
        const key = body.trim();
        const translated = uiText(key);
        return opening + (translated === key ? body : body.replace(key, translated));
      }
      const translated = uiText(value ?? '');
      // English copy is escaped even though only maintained catalog values enter attributes.
      return attribute + quote! + translated.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + quote!;
    });
}
