/**
 * I-209 (同时启动三个全屏额外加功能"做"): who is on the full-screen stage besides the first one, on the host side.
 *
 *  - The full-screen panel's 「谁在场」 rows add and remove characters (shared/unbound/company/presence.ts). Default: nobody else.
 *  - Who is on stage goes out through `present` whenever it changes while she is out ([] once she is not): the brain seats each one (step 2)
 *    and the stage coordinator brings each one out as her own complete full screen (electron/unbound/company/stage.ts, step 3).
 *  - The page of the first one may say the frame-cost guard's "one fewer": the last one added goes back and the panel says so in Chinese.
 *    Only from the window she is shown in, like every other request.
 */
import { CompanyChoice, UNBOUND_COMPANY_REQUESTS, parseCompanyGuard, type CompanyCard, type CompanyLook } from '../../../shared/unbound/company';
import type { UnboundState } from '../../../shared/unbound/scene';
import { t } from '../../../shared/foundation/ui-language';

/** What the wiring gives (electron/wiring/unbound-wiring.ts). */
export interface CompanyPorts {
  /** Every card in card order: id, name, whether a model is linked (no path). */
  cards(): Promise<CompanyCard[]> | CompanyCard[];
  /** The card of the one you talk with now. */
  current(): string | null;
  /** Her model as her page may load it (registered by the host's asset registry); null when it cannot be used now. */
  model(id: string): Promise<{ url: string; reviewed: boolean } | null>;
  /** Who is on stage besides the first one, told when it changes ([] once she is not out): the brain seats them, the stage brings them out. */
  present?(ids: readonly string[]): void;
  /** I-209 step 3: the card you talk to now ("点谁和谁说": the last one you clicked); absent or null: the first one. */
  addressee?(): string | null;
  /** 「三人同框（Beta）」 switch (shared/foundation/channel-defaults.ts threeOnStage); absent: on. Off: no rows, nobody can be asked out, those out walk out. */
  enabled?(): boolean;
}
/** What the Unbound host lends it. */
export interface CompanyLinks {
  ports(): CompanyPorts | undefined;
  state(): UnboundState;
  /** The request came from the window she is shown in. */
  shown(win: unknown): boolean;
  /** The app's own short line beside her (not something anyone said). */
  notice(text: string): void;
}
type Handle<W> = (channel: string, operation: (win: W, ...args: unknown[]) => unknown) => void;

/** The panel's line when the guard sent someone back (shown under the row, and once beside her). */
export const COMPANY_GUARD_NOTICE = '画面有点吃力，{name}先回去了；这台电脑现在同时放 {cap} 位比较稳。';
export const companyGuardNotice = (name: string, cap: number) => t(COMPANY_GUARD_NOTICE, { name: name.slice(0, 40), cap });

export class CompanyHost {
  readonly channels: readonly string[] = Object.values(UNBOUND_COMPANY_REQUESTS);
  private readonly choice = new CompanyChoice();
  private cardsNow: CompanyCard[] = [];
  private currentNow: string | null = null;
  private presentKey = '[]';

  constructor(private readonly links: CompanyLinks) {}

  /** The page's guard (`handle` checks the window and its top frame; the guard only from the window she is shown in). */
  register<W>(handle: Handle<W>): void {
    handle(UNBOUND_COMPANY_REQUESTS.guard, async (win, value) => {
      const verdict = parseCompanyGuard(value);
      if (!verdict || !this.links.shown(win)) return;
      await this.readCards();
      const dropped = this.choice.drop(verdict.present, this.current(), this.cardsNow, companyGuardNotice);
      if (!dropped) return;
      if (this.choice.notice) this.links.notice(this.choice.notice);
      await this.publish();
    });
  }

  /** The panel's rows (the full-screen input box's panel). */
  async look(): Promise<CompanyLook> {
    await this.readCards();
    if (!this.allowed()) return { out: false, cap: 1, notice: null, entries: [] }; // the switch is off: the panel has no 「谁在场」
    let talking: string | null = null;
    try { talking = this.links.ports()?.addressee?.() ?? null; } catch { talking = null; }
    return this.choice.look(this.current(), this.cardsNow, this.links.state() === 'unbound', talking);
  }
  /** The panel's click: add or send back one character; the look after. Never the first one. */
  async set(id: unknown, on: unknown): Promise<CompanyLook> {
    await this.readCards();
    if (typeof id === 'string' && typeof on === 'boolean' && (on ? this.allowed() : true) && this.choice.set(id, on, this.current(), this.cardsNow)) await this.publish();
    return this.look();
  }

  /** The settings changed (a switch of who you talk with arrives this way): the same people stay on stage. */
  refresh(): void {
    const previous = this.currentNow, next = this.current();
    if (previous && next && previous !== next) this.choice.switched(previous, next);
    if (this.links.state() === 'unbound') void this.publish();
  }
  /** The 「三人同框（Beta）」 switch changed: off sends everyone else out (they walk off the screen first); on shows the rows again. */
  gateChanged(): void { if (!this.allowed()) this.choice.clear(); if (this.links.state() === 'unbound') void this.publish(); }
  private allowed(): boolean {
    try { return this.links.ports()?.enabled?.() !== false; } catch { return true; }
  }
  /** Her mode changed: a new entry measures again from the full cap (the extras chosen stay chosen) and brings them out once she is. */
  modeChanged(state: UnboundState): void {
    if (state === 'entering') this.choice.entered();
    if (state === 'unbound') void this.publish();
    else this.tellPresent([]);
  }
  /** The brain and the stage hear who is on stage; only when it changed. */
  private tellPresent(ids: readonly string[]): void {
    const key = JSON.stringify(ids);
    if (key === this.presentKey) return;
    this.presentKey = key;
    try { this.links.ports()?.present?.(ids); } catch (error) { console.error(error); } // the stage never waits on the brain
  }

  private current(): string | null {
    let id: string | null = null;
    try { id = this.links.ports()?.current() ?? null; } catch { id = null; }
    this.currentNow = id ?? this.currentNow;
    return id;
  }
  private async readCards(): Promise<void> {
    try { this.cardsNow = (await this.links.ports()?.cards()) ?? []; } catch { /* the last list stays */ }
  }

  /** Who is on stage besides the first one now (only those whose model can be used now), told while she is out. */
  private async publish(): Promise<void> {
    await this.readCards();
    const ports = this.links.ports(), ids: string[] = [];
    for (const id of ports && this.allowed() ? this.choice.extrasFor(this.current(), this.cardsNow) : []) { // the switch is off: nobody besides the first one
      let model: { url: string } | null = null;
      try { model = await ports!.model(id); } catch { model = null; }
      if (model && model.url.startsWith('mmd-asset://')) ids.push(id);
    }
    if (this.links.state() === 'unbound') this.tellPresent(ids);
  }
}
