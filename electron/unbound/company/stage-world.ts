/**
 * I-209 step 3: the one world the full-screen windows on stage share (docs/claude/2026-11-24-i209-step3-instances.md). Memory only.
 *
 * Each page reports her body (shared/unbound/company/bodies.ts StageBody) while two or more are on stage; this keeps the last report of
 * each, and after every report tells the pages what they share:
 *  - who else stands where (each page keeps out of them and steps aside: keepApart, asideGoal on the page);
 *  - (2026-11-25) nothing about the camera: every page frames her own body against the one floor line, so pulling one nearer moves only her
 *    (shared/unbound/company/bodies.ts; step 3's shared eye moved the others up and down);
 *  - the windows' order: the nearer one's window above (stackOrder; `raise` is called far to near, only when the order changed).
 * Alone on stage nothing is reported and nothing is sent but one view that says so (the page then does exactly what it did before).
 */
import { parseStageBody, stackOrder, type StageBody, type StageOther, type StageView } from '../../../shared/unbound/company/bodies';
import type { Placement } from '../../../shared/unbound/world';

export interface StageWorldLinks {
  /** Everyone on stage now, in the order they came (the one you talk with first). */
  ids(): string[];
  /** Send a view to her page (dropped when she has no window). */
  send(id: string, view: StageView): void;
  /** Her window to the top of its band (far to near: the last raised is the front one). */
  raise(id: string): void;
  /** Where her host has her (before her first report: her entry place); null: not known. */
  placement(id: string): Placement | null;
  /** Whether she is being sent back (her view carries `leave`). */
  leaving(id: string): boolean;
  /** The one you are with (the last one you clicked), or null: every page then draws at full rate (shared/unbound/company/extra-pace.ts). */
  focus?(): string | null;
  clock(): number;
}

/** A body as the world keeps it: her last report and when it came (ms). */
interface Kept { body: StageBody; at: number }

/** A body before her first report: where her host has her, standing, a typical width and height. */
const GUESS = { radiusM: 0.25, heightM: 1.6, faceM: 1.47, dipM: 0, vxM: 0, vdM: 0, pulled: false, closing: false, free: false } as const;

export class StageWorld {
  private readonly kept = new Map<string, Kept>();
  private order: string[] = [];
  private sentPresent = new Map<string, string>();

  constructor(private readonly links: StageWorldLinks) {}

  /** A page's report (already from her own window). False when it was not a body. */
  report(id: string, value: unknown): boolean {
    const body = parseStageBody(value);
    if (!body || !this.links.ids().includes(id)) return false;
    this.kept.set(id, { body, at: this.links.clock() });
    this.tell(id);
    return true;
  }

  /** Who is on stage changed (someone came, left or is being sent back): everyone hears it. */
  changed(): void {
    const ids = new Set(this.links.ids());
    for (const id of [...this.kept.keys()]) if (!ids.has(id)) this.kept.delete(id);
    for (const id of [...this.sentPresent.keys()]) if (!ids.has(id)) this.sentPresent.delete(id);
    this.order = this.order.filter(id => ids.has(id));
    this.tell(null);
  }

  /** Everyone's bodies now (a body not reported yet: where her host has her). */
  bodies(): Map<string, StageBody> {
    const out = new Map<string, StageBody>();
    for (const id of this.links.ids()) {
      const kept = this.kept.get(id);
      if (kept) { out.set(id, kept.body); continue; }
      const at = this.links.placement(id);
      if (at) out.set(id, { ...GUESS, xM: at.xM, depthM: at.depthM });
    }
    return out;
  }
  /** The windows' order now, far to near. */
  get stack(): string[] { return [...this.order]; }

  /** Puts the windows back in depth order (after anything raised one of them: a full-screen program's arrival, a new window). */
  restack(): void { for (const id of this.order) this.links.raise(id); }

  /** The view for one page. */
  view(id: string, bodies = this.bodies()): StageView {
    const ids = this.links.ids(), now = this.links.clock();
    const others: StageOther[] = [];
    for (const other of ids) {
      if (other === id) continue;
      const body = bodies.get(other);
      if (!body) continue;
      const age = Math.max(0, now - (this.kept.get(other)?.at ?? now)) / 1000;
      // Sent as where she is now: moved on by her speed over the report's age (the page predicts the rest).
      others.push({ id: other, ...body, xM: body.xM + body.vxM * Math.min(0.25, age), depthM: body.depthM + body.vdM * Math.min(0.25, age) });
    }
    return { present: ids.length, self: id, others, ...(this.links.leaving(id) ? { leave: true } : {}), ...(ids.length > 1 && this.focusNow() ? { focus: this.focusNow()! } : {}) };
  }
  private focusNow(): string | null { try { return this.links.focus?.() ?? null; } catch { return null; } }

  /** After a report of `from` (null: who is on stage changed): the others hear it, the windows follow the order. */
  private tell(from: string | null): void {
    const ids = this.links.ids(), bodies = this.bodies();
    for (const id of ids) {
      const presentKey = `${ids.length}:${this.links.leaving(id)}:${this.focusNow()}`;
      const first = this.sentPresent.get(id) !== presentKey;
      if (id === from && !first) continue; // her own report changes nothing she is told
      this.sentPresent.set(id, presentKey);
      this.links.send(id, this.view(id, bodies));
    }
    const order = stackOrder(bodies, this.order);
    if (order.join('\n') !== this.order.join('\n')) { this.order = order; this.restack(); }
  }
}
