/**
 * I-209: the full-screen panel's 「谁在场」 rows (src/unbound/input-senses.ts draws them under 「她出来的位置」). The first one is listed first and
 * always there (no button); everyone else has 「请她出来」 / 「请她回去」, or why not now (no model, three already, the guard's lower cap). Step 3:
 * the one your words go to (the last one you clicked) says 「在和你说话」, everyone else on stage 「在场」. The guard's last word shows under the
 * rows. DOM only; the host decides (electron/unbound/company/host.ts).
 */
import { uiText } from '../../foundation/ui-language';
import type { CompanyLook } from '../../../shared/unbound/company/presence';

export const COMPANY_TEXT = Object.freeze({
  title: '谁在场（Beta）', talking: '在和你说话', here: '在场', away: '没出来', add: '请她出来', remove: '请她回去',
  noModel: '没有模型', full: '最多三位', cap: '先不加了',
  note: '最多三位同时在场；点谁就和谁说。',
});

type Make = (tag: string, className: string, text?: string) => HTMLElement;

/** The rows for `look` (nothing when the host cannot say); `choose(id, on)` is the click. */
export function companyRows(make: Make, look: CompanyLook | null, choose: (id: string, on: boolean) => void): HTMLElement[] {
  if (!look || look.entries.length < 2) return []; // only one card: nobody else could come
  const rows: HTMLElement[] = [make('div', 'senses-title senses-company-title senses-watch', uiText(COMPANY_TEXT.title))]; // one line above the section, none between its rows (three fit without scrolling)
  for (const entry of look.entries) {
    const row = make('div', 'senses-row');
    row.dataset.sense = 'company';
    row.dataset.id = entry.id;
    row.dataset.present = String(entry.present);
    const state = make('span', `senses-state ${entry.present ? 'on' : 'off'}`, uiText(entry.talking ? COMPANY_TEXT.talking : entry.present ? COMPANY_TEXT.here : COMPANY_TEXT.away)); // I-209 step 3: the one you clicked last
    row.append(make('span', 'senses-name', entry.label ?? entry.name), state);
    if (!entry.current) {
      const why = entry.block === 'no-model' ? COMPANY_TEXT.noModel : entry.block === 'full' ? COMPANY_TEXT.full : entry.block === 'cap' ? COMPANY_TEXT.cap : null;
      const button = make('button', 'senses-pick', uiText(entry.present ? COMPANY_TEXT.remove : why ?? COMPANY_TEXT.add)) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.action = entry.present ? 'company-remove' : 'company-add';
      button.disabled = !entry.present && (why !== null || !look.out);
      button.addEventListener('click', () => choose(entry.id, !entry.present));
      row.append(button);
    }
    rows.push(row);
  }
  if (look.notice) rows.push(make('p', 'senses-reason not-heard', look.notice));
  rows.push(make('p', 'senses-reason', uiText(COMPANY_TEXT.note)));
  return rows;
}
