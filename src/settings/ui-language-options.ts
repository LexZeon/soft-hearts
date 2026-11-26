import { uiText } from '../foundation/ui-language';
import { uiLanguageChoices } from '../../shared/foundation/ui-languages';

/**
 * The interface-language dropdown rows: "follow system" plus every language in the registry
 * (shared/foundation/ui-languages.ts). layout.ts leaves the select empty; the control window fills it with this.
 */
export function uiLanguageChoiceRows(): { value: string; label: string }[] {
  return [{ value: 'system', label: uiText('跟随系统') }, ...uiLanguageChoices()];
}

export function fillUiLanguageSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...uiLanguageChoiceRows().map(choice => {
    const option = select.ownerDocument.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  }));
}
