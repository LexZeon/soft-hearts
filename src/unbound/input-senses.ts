/**
 * I-190: the full-screen input box's senses panel. Full-screen Unbound has no toolbar,
 * so the small button beside the line (or a right click on her) opens this: each sense she has (microphone, camera, screen, the computer's
 * sound), whether it is on, and its source list, drawn by the same builder as the companion toolbar (src/foundation/source-menu.ts) from the
 * same choices (shared/senses/source-choices.ts). Out here the senses stay on while she is out (I-159: "unbound现在默认全开的"), so there is
 * no switch in the panel, only the sources and the line saying how to turn one off. A pick never turns a sense on or off.
 * DOM ports keep it testable: the page passes its elements and its preload API.
 */
import { renderSourceList, focusChecked } from '../foundation/source-menu';
import { uiText } from '../foundation/ui-language';
import { createSourceChoices, type ScreenSourceApi, type SourceChoices, type SourceKind, type WatchTogetherLook } from '../../shared/senses';
import { SENSE_LABELS } from '../../shared/unbound/senses';
import type { UnboundSenses } from '../../shared/unbound/senses';
import type { DefaultPlaceLook, PlaceKeepRefusal } from '../../shared/unbound/life/place-record';
import type { CompanyLook } from '../../shared/unbound/company/presence';
import { companyRows } from './company/panel-row'; // I-209 step 1: 谁在场

export interface SensesPanelApi extends ScreenSourceApi {
  senses(): Promise<UnboundSenses | null>;
  panel(open: boolean): Promise<void>;
  /** 「和她一起看」 as the eye button shows it, and its one click (electron/unbound/input-watch.ts). */
  watchTogether?(): Promise<WatchTogetherLook | null>;
  toggleWatchTogether?(): Promise<WatchTogetherLook | null>;
  /** 「设为默认位置」 (2026-11-23): the user's default place for her, and its two clicks (keep where she stands now / clear). */
  defaultPlace?(): Promise<DefaultPlaceLook | null>;
  setDefaultPlace?(on: boolean): Promise<DefaultPlaceLook | null>;
  /** I-209 step 1: who is on stage, and one character brought out or sent back (src/unbound/company/panel-row.ts). */
  company?(): Promise<CompanyLook | null>;
  setCompany?(id: string, on: boolean): Promise<CompanyLook | null>;
}
/** The four rows, in the light's order; each has its source list. */
export const PANEL_ROWS: ReadonlyArray<readonly [keyof UnboundSenses, SourceKind]> = [['microphone', 'microphone'], ['camera', 'camera'], ['screen', 'screen'], ['audio', 'systemAudio']];
export const PANEL_TEXT = Object.freeze({
  button: '感知和来源', title: '她的感知', on: '开着', off: '关着', sources: '选来源',
  outside: '她在外面时它们一直开着；想关，先回小窗。',
  watch: '和她一起看', turnOn: '打开', turnOff: '关掉',
  watchOutside: '她在外面时屏幕一直开着；这里关掉只停台词。',
  place: '她出来的位置', placeSet: '已设', placeNone: '没设', placeButton: '设为默认位置', placeClear: '清除',
  placeNote: '把她拉到想要的位置再点；每次进全屏，她都从这里出来。',
  // the click always answers, in one plain line.
  placeKept: '已记下她现在站的位置。',
  placeSlow: '没有收到回应，请再点一次。',
  placeWhy: Object.freeze({
    'not-out': '她现在不在全屏里，没法记。',
    'no-height': '她的身高还没量出来，等一下再点。',
    'out-of-reach': '她离得比"只有脸"还近（或太远），这里记不了；把她往后放一点再点。',
    moving: '她正在走，等她站定再点。',
    'not-saved': '记不进文件，重启后会丢；请再点一次，还不行请反馈。',
  } as Readonly<Record<PlaceKeepRefusal, string>>),
  placeNotKept: '没记下来。',
});
const POLL_MS = 1500;
/** A call of the panel to the host that has not answered by now is given up on (the button works again; a late answer is ignored). */
export const PANEL_CALL_LIMIT_MS = 4000;
function limited<T>(call: Promise<T>, ms: number = PANEL_CALL_LIMIT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), ms);
    call.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export class SensesPanel {
  private open = false;
  private expanded: SourceKind | null = null;
  private senses: UnboundSenses | null = null;
  private watch: WatchTogetherLook | null = null;
  private place: DefaultPlaceLook | null = null;
  private company: CompanyLook | null = null;
  /** One in-flight flag for each kind of call, so one that never answers freezes only itself (and is given up on after PANEL_CALL_LIMIT_MS). */
  private readonly busy = { place: false, company: false, watch: false };
  /** The line under the place row after a click: kept, or why not (cleared when the panel closes). */
  private placeLine: { text: string; kept: boolean } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly choices: SourceChoices;
  private readonly stop: () => void;

  constructor(private readonly doc: Document, private readonly root: HTMLElement, private readonly button: HTMLElement, private readonly api: SensesPanelApi, choices?: SourceChoices) {
    this.choices = choices ?? createSourceChoices(api);
    this.stop = this.choices.onChange(() => { void this.drawList(); });
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', root.id);
    root.hidden = true;
    button.addEventListener('click', () => { void this.toggle(); });
  }

  get isOpen(): boolean { return this.open; }

  async toggle(): Promise<void> { if (this.open) await this.close(); else await this.show(); }

  /** Opens the panel (the box grows first, so the panel is never drawn cut off). */
  async show(): Promise<void> {
    if (this.open) return;
    this.open = true;
    this.button.setAttribute('aria-expanded', 'true');
    try { await this.api.panel(true); } catch { /* the box stays its size; the panel scrolls */ }
    this.root.hidden = false;
    await this.refresh();
    this.poll ??= setInterval(() => { void this.refresh(); }, POLL_MS);
    (this.root.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Closes the panel only; every sense and every source stays as it is. */
  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false; this.expanded = null; this.placeLine = null;
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    this.root.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    try { await this.api.panel(false); } catch { /* the box shrinks with its next open */ }
  }

  dispose(): void { if (this.poll) clearInterval(this.poll); this.stop(); this.choices.dispose(); }

  /** Re-reads which senses are on (they can change while the panel is open) and redraws when something differs. */
  async refresh(): Promise<void> {
    let next: UnboundSenses | null = null, watch: WatchTogetherLook | null = null, place: DefaultPlaceLook | null = null;
    try { next = await this.api.senses(); } catch { next = null; }
    try { watch = (await this.api.watchTogether?.()) ?? null; } catch { watch = null; }
    try { place = (await this.api.defaultPlace?.()) ?? null; } catch { place = null; }
    let company: CompanyLook | null = null;
    try { company = (await this.api.company?.()) ?? null; } catch { company = null; }
    if (!this.open) return;
    if (this.root.children.length && JSON.stringify([next, watch, place, company]) === JSON.stringify([this.senses, this.watch, this.place, this.company])) return;
    this.senses = next; this.watch = watch; this.place = place; this.company = company;
    this.draw();
  }

  private draw(): void {
    const doc = this.doc, make = (tag: string, className: string, text = '') => { const node = doc.createElement(tag); node.className = className; if (text) node.textContent = text; return node; };
    const title = make('div', 'senses-title', uiText(PANEL_TEXT.title));
    const rows = make('div', 'senses-rows');
    for (const [sense, kind] of PANEL_ROWS) {
      const row = make('div', 'senses-row');
      row.dataset.sense = sense;
      const on = this.senses?.[sense] === true;
      const state = make('span', `senses-state ${on ? 'on' : 'off'}`, uiText(on ? PANEL_TEXT.on : PANEL_TEXT.off));
      const pick = make('button', 'senses-pick', `${uiText(PANEL_TEXT.sources)} ▾`) as HTMLButtonElement;
      pick.type = 'button';
      pick.dataset.kind = kind;
      pick.setAttribute('aria-expanded', String(this.expanded === kind));
      pick.setAttribute('aria-label', `${uiText(SENSE_LABELS[sense])} · ${uiText(PANEL_TEXT.sources)}`);
      pick.addEventListener('click', () => { this.expanded = this.expanded === kind ? null : kind; this.draw(); void this.drawList(true); });
      const list = make('div', 'senses-list');
      list.dataset.kind = kind;
      list.hidden = this.expanded !== kind;
      row.append(make('span', 'senses-name', uiText(SENSE_LABELS[sense])), state, pick);
      rows.append(row, list);
    }
    this.root.replaceChildren(title, rows, ...this.watchRow(make), ...this.placeRow(make), make('p', 'senses-note', uiText(PANEL_TEXT.outside)),
      ...(this.api.setCompany ? companyRows(make, this.company, (id, on) => { void this.setCompany(id, on); }) : []));
    void this.drawList();
  }

  /**
   * 「设为默认位置」: the button keeps where she stands now as the place she comes out at every time, and a
   * second one clears it. Her own walking never changes it. Nothing when the host cannot say.
   */
  private placeRow(make: (tag: string, className: string, text?: string) => HTMLElement): HTMLElement[] {
    const look = this.place;
    if (!look || !this.api.setDefaultPlace) return [];
    const row = make('div', 'senses-row senses-watch');
    row.dataset.sense = 'place';
    row.dataset.set = String(look.set);
    const button = (action: 'set' | 'clear', text: string, enabled: boolean) => {
      const node = make('button', 'senses-pick', uiText(text)) as HTMLButtonElement;
      node.type = 'button'; node.dataset.action = action; node.disabled = !enabled;
      node.addEventListener('click', () => { void this.setPlace(action === 'set'); });
      return node;
    };
    row.append(make('span', 'senses-name', uiText(PANEL_TEXT.place)), make('span', `senses-state ${look.set ? 'on' : 'off'}`, uiText(look.set ? PANEL_TEXT.placeSet : PANEL_TEXT.placeNone)),
      button('set', PANEL_TEXT.placeButton, look.here));
    const note = make('p', 'senses-reason', uiText(PANEL_TEXT.placeNote));
    const said = this.placeLine ? make('p', `senses-reason place-line${this.placeLine.kept ? '' : ' not-heard'}`, uiText(this.placeLine.text)) : null;
    if (said) { said.dataset.place = this.placeLine!.kept ? 'kept' : 'refused'; said.setAttribute('role', 'status'); }
    return [row, ...(look.set ? [button('clear', PANEL_TEXT.placeClear, true)] : []), ...(said ? [said] : []), note];
  }

  private async setCompany(id: string, on: boolean): Promise<void> {
    if (this.busy.company || !this.api.setCompany) return;
    this.busy.company = true;
    try { this.company = (await limited(this.api.setCompany(id, on))) ?? this.company; } catch { /* the rows stay as they were; the next refresh reads them again */ }
    finally { this.busy.company = false; }
    if (this.open) this.draw();
  }

  /** The click always answers: 已设 at once when it kept her, else one plain line why (the host's `refused`), and a call that never answers is given up on. */
  private async setPlace(on: boolean): Promise<void> {
    if (this.busy.place || !this.api.setDefaultPlace) return;
    this.busy.place = true;
    this.placeLine = null;
    try {
      const look = await limited(this.api.setDefaultPlace(on));
      if (look) {
        this.place = look;
        if (on) this.placeLine = look.refused ? { text: PANEL_TEXT.placeWhy[look.refused] ?? PANEL_TEXT.placeNotKept, kept: false } : { text: PANEL_TEXT.placeKept, kept: true };
      } else if (on) this.placeLine = { text: PANEL_TEXT.placeSlow, kept: false };
    } catch { if (on) this.placeLine = { text: PANEL_TEXT.placeSlow, kept: false }; } // nothing changed as far as the panel knows; the next refresh reads it again
    finally { this.busy.place = false; }
    if (this.open) { this.draw(); (this.root.querySelector(`[data-action="${on ? 'set' : 'clear'}"]`) as HTMLElement | null)?.focus({ preventScroll: true }); }
  }

  /**
   * 「和她一起看」: the eye button's look — pressed or not, the warm mark while she sees the screen
   * but the dialogue does not reach her, the same reason in words — and its one click. Nothing when the host cannot say.
   */
  private watchRow(make: (tag: string, className: string, text?: string) => HTMLElement): HTMLElement[] {
    const look = this.watch;
    if (!look || !this.api.toggleWatchTogether) return [];
    const row = make('div', 'senses-row senses-watch');
    row.dataset.sense = 'watch';
    row.dataset.notHeard = String(look.notHeard);
    const state = make('span', `senses-state ${look.on ? 'on' : 'off'}`, uiText(look.on ? PANEL_TEXT.on : PANEL_TEXT.off));
    const toggle = make('button', 'senses-pick', uiText(look.on ? PANEL_TEXT.turnOff : PANEL_TEXT.turnOn)) as HTMLButtonElement;
    toggle.type = 'button';
    toggle.dataset.action = 'watch';
    toggle.setAttribute('aria-pressed', String(look.on));
    toggle.setAttribute('aria-label', `${uiText(PANEL_TEXT.watch)} · ${uiText(look.on ? PANEL_TEXT.turnOff : PANEL_TEXT.turnOn)}`);
    toggle.addEventListener('click', () => { void this.toggleWatch(); });
    const name = make('span', 'senses-name', uiText(PANEL_TEXT.watch));
    if (look.notHeard) { const mark = make('span', 'senses-mark'); mark.setAttribute('aria-hidden', 'true'); name.append(mark); }
    row.append(name, state, toggle);
    const reason = make('p', `senses-reason${look.notHeard ? ' not-heard' : ''}`, uiText(look.tooltip));
    return [row, reason, make('p', 'senses-reason', uiText(PANEL_TEXT.watchOutside))];
  }

  private async toggleWatch(): Promise<void> {
    if (this.busy.watch || !this.api.toggleWatchTogether) return;
    this.busy.watch = true;
    try { this.watch = (await limited(this.api.toggleWatchTogether())) ?? this.watch; } catch { /* the row stays as it was; the next refresh reads it again */ }
    finally { this.busy.watch = false; }
    if (this.open) { this.draw(); (this.root.querySelector('[data-action="watch"]') as HTMLElement | null)?.focus({ preventScroll: true }); }
  }

  /** Fills the expanded sense's list (from the same choices as the companion toolbar). */
  private async drawList(focus = false): Promise<void> {
    const kind = this.expanded;
    if (!this.open || !kind) return;
    const host = this.root.querySelector<HTMLElement>(`.senses-list[data-kind="${kind}"]`);
    if (!host) return;
    let model;
    try { model = await this.choices.menu(kind); } catch { return; }
    if (this.expanded !== kind || !this.open) return;
    host.replaceChildren(renderSourceList(this.doc, model, id => { void this.choices.choose(kind, id).catch(() => {}); }));
    if (focus) focusChecked(host);
  }
}
