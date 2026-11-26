/**
 * I-209 step 1: who is on the
 * full-screen stage besides the character you are talking with. Pure: the host keeps one of these for the app's run.
 *
 *  - The one you talk with is always present; the user adds or removes the others in the full-screen panel. Default: nobody else, so a
 *    user who never opens the panel sees exactly what they saw before.
 *  - At most COMPANY_MAX_PRESENT on stage in all (the user's "最多三个"); fewer when the frame-cost guard lowered the cap this entry.
 *  - Only characters with a model can come out (a card without one has nothing to show).
 *  - Switching who you talk with keeps the same people on stage: if the new one was an extra, the old one takes her place as an extra.
 * Nothing here reaches her conversation, her mood or her memory (step 1 is "present, not talking").
 */

/** the one you talk with and at most two more. */
export const COMPANY_MAX_PRESENT = 3;
/** A card id as the page and the panel may carry it (the card store's UUIDs; nothing else crosses). */
export const COMPANY_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One card as the panel lists it. */
export interface CompanyCard { id: string; name: string; hasModel: boolean; /** I-219: the name with a language tag, for the panel only (display; `name` is what she is told). */ label?: string }
/** Why a card cannot be added now. */
export type CompanyBlock = 'no-model' | 'full' | 'cap';
/** What the full-screen panel shows (src/unbound/company/panel-row.ts). */
export interface CompanyLook {
  /** She is out (the row can act). */
  out: boolean;
  /** current: the first one (never sent back from here); talking (I-209 step 3): the one your words go to now (the last one you clicked). */
  entries: { id: string; name: string; label?: string; present: boolean; current: boolean; talking: boolean; block: CompanyBlock | null }[];
  /** How many may be on stage now (COMPANY_MAX_PRESENT, or the guard's lower cap this entry). */
  cap: number;
  /** The guard's last word (Chinese, shown under the row), or null. */
  notice: string | null;
}

export class CompanyChoice {
  /** The extras in the order the user added them (the guard sends back the last one first). */
  private extras: string[] = [];
  private capNow = COMPANY_MAX_PRESENT;
  private noticeNow: string | null = null;

  get cap(): number { return this.capNow; }
  get notice(): string | null { return this.noticeNow; }

  /** Who stands on stage besides `current`, in the order they came (cards that are gone or lost their model are left out). */
  extrasFor(current: string | null, cards: readonly CompanyCard[]): string[] {
    const usable = new Set(cards.filter(card => card.hasModel).map(card => card.id));
    return this.extras.filter(id => id !== current && usable.has(id)).slice(0, Math.max(0, this.capNow - 1));
  }

  /** The panel's click: add (`on`) or send back one character. False when nothing changed (the current one, no model, full). */
  set(id: string, on: boolean, current: string | null, cards: readonly CompanyCard[]): boolean {
    if (!COMPANY_ID.test(id) || id === current) return false;
    if (!on) {
      const before = this.extras.length;
      this.extras = this.extras.filter(extra => extra !== id);
      return this.extras.length !== before;
    }
    if (this.extras.includes(id) || this.blockOf(id, current, cards) !== null) return false;
    this.extras.push(id);
    this.noticeNow = null;
    return true;
  }

  /** Why `id` cannot be added now (null: it can, or it is already there). */
  blockOf(id: string, current: string | null, cards: readonly CompanyCard[]): CompanyBlock | null {
    const card = cards.find(entry => entry.id === id);
    if (!card || !card.hasModel) return 'no-model';
    if (id === current || this.extras.includes(id)) return null;
    const present = 1 + this.extrasFor(current, cards).length;
    if (present >= COMPANY_MAX_PRESENT) return 'full';
    if (present >= this.capNow) return 'cap';
    return null;
  }

  /** The panel's rows: the one you talk with first, then everyone else in the card order. `talking`: the one you clicked last (null: the first one). */
  look(current: string | null, cards: readonly CompanyCard[], out: boolean, talking: string | null = null): CompanyLook {
    const present = new Set(this.extrasFor(current, cards));
    const ordered = [...cards.filter(card => card.id === current), ...cards.filter(card => card.id !== current)];
    return {
      out, cap: this.capNow, notice: this.noticeNow,
      entries: ordered.map(card => ({ id: card.id, name: card.name, ...(card.label ? { label: card.label } : {}), current: card.id === current, present: card.id === current || present.has(card.id),
        talking: card.id === (talking && present.has(talking) ? talking : current),
        block: card.id === current || present.has(card.id) ? null : this.blockOf(card.id, current, cards) })),
    };
  }

  /**
   * Who you talk with changed from `previous` to `next`. If `next` was on stage as an extra, `previous` takes her place (the same people
   * stay on stage); otherwise the extras stay as they were and `previous` goes back (as a switch always did when she was alone).
   */
  switched(previous: string | null, next: string | null): void {
    if (!previous || !next || previous === next) return;
    const at = this.extras.indexOf(next);
    if (at < 0) return;
    this.extras[at] = previous;
  }

  /**
   * The frame-cost guard: `present` on stage were over the frame budget. The last one added goes back and the cap drops to what was
   * left (never below the one you talk with). Returns the id sent back (null: nobody to send back). `noticeOf` words the panel line.
   */
  drop(present: number, current: string | null, cards: readonly CompanyCard[], noticeOf: (name: string, cap: number) => string): string | null {
    const extras = this.extrasFor(current, cards);
    if (!extras.length || present !== 1 + extras.length) return null; // an old report (someone already left): nothing to do
    const id = extras[extras.length - 1]!;
    this.extras = this.extras.filter(extra => extra !== id);
    this.capNow = Math.max(1, present - 1);
    this.noticeNow = noticeOf(cards.find(card => card.id === id)?.name ?? '', this.capNow);
    return id;
  }

  /** 「三人同框（Beta）」 switched off: nobody besides the one you talk with stays chosen (switching it on again starts from nobody). */
  clear(): void { this.extras = []; }

  /** A new entry: the guard measures again from the full cap (her machine may be quieter now); the extras chosen stay chosen. */
  entered(): void { this.capNow = COMPANY_MAX_PRESENT; this.noticeNow = null; }
}
