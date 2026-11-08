import type { TextMemorialEvent, TextMemorialOffer, TextMemorialOfferState, TextMemorialPresented } from '../../shared/text-memorials';

export interface TextMemorialOfferApi {
  onTextMemorialEvent(callback: (event: TextMemorialEvent) => void): () => void;
  getCurrentTextMemorialOffer(): Promise<TextMemorialOfferState>;
  acknowledgeTextMemorial(request: { id: string; revision: number }): Promise<TextMemorialPresented | null>;
}
export interface TextMemorialSurface {
  current(): boolean;
  publish(offer: TextMemorialOffer): Promise<void>;
  retract(id: string): void;
  cancelled?(id: string): void;
  commit(result: TextMemorialPresented): void;
}

/** Host revisions order offer state; receipt is presentation only, never consent. */
export class TextMemorialOfferController {
  private revision = -1;
  private pending: { offer: TextMemorialOffer; revision: number; token: number; presentedRevision: number | null; ackIssued: boolean } | null = null;
  private token = 0;
  private disposed = false;
  private readonly unsubscribe: () => void;
  constructor(private readonly api: TextMemorialOfferApi, private readonly surface: TextMemorialSurface) {
    this.unsubscribe = api.onTextMemorialEvent(event => this.event(event));
    void api.getCurrentTextMemorialOffer().then(state => this.snapshot(state)).catch(() => {});
  }
  private snapshot(state: TextMemorialOfferState): void {
    if (this.disposed || state.revision <= this.revision) return;
    this.revision = state.revision;
    if (state.offer) this.start(state.offer, state.revision); else this.clear();
  }
  private event(event: TextMemorialEvent): void {
    if (this.disposed || event.revision <= this.revision) return;
    this.revision = event.revision;
    if (event.type === 'offer') { this.start(event.offer, event.revision); return; }
    if (event.type === 'cancel') this.surface.cancelled?.(event.id);
    if (this.pending?.offer.id !== event.id) return;
    if (event.type === 'cancel') this.clear();
    else if (this.pending.ackIssued) this.pending.presentedRevision = event.revision; // Receipt may resolve after this broadcast.
    else { this.pending = null; this.token++; } // Never retract an already presented question.
  }
  private clear(): void {
    const old = this.pending; this.pending = null; this.token++;
    if (old) this.surface.retract(old.offer.id);
  }
  invalidate(): void { if (!this.disposed) this.clear(); }
  dispose(): void { if (this.disposed) return; this.clear(); this.disposed = true; this.unsubscribe(); }
  private start(offer: TextMemorialOffer, revision: number): void {
    this.clear();
    const pending = { offer, revision, token: ++this.token, presentedRevision: null as number | null, ackIssued: false }; this.pending = pending;
    const current = () => !this.disposed && this.pending === pending && this.token === pending.token && this.surface.current();
    void (async () => {
      try {
        if (!current()) { if (this.pending === pending) this.clear(); return; }
        await this.surface.publish(offer);
        if (!current() || pending.presentedRevision !== null) { if (this.pending === pending) this.clear(); return; }
        pending.ackIssued = true;
        const result = await this.api.acknowledgeTextMemorial({ id: offer.id, revision });
        if (!result || !current() || result.offer.id !== offer.id || result.offer.invite !== offer.invite
          || result.offer.quote !== offer.quote || result.offer.purpose !== offer.purpose || result.context.replyId !== offer.id
          || result.origin.id !== offer.id
          || result.revision <= revision || (pending.presentedRevision !== null && pending.presentedRevision !== result.revision)
          || this.revision > result.revision) { if (this.pending === pending) { if (pending.presentedRevision !== null) { this.pending = null; this.token++; } else this.clear(); } return; }
        this.revision = Math.max(this.revision, result.revision); this.pending = null; this.surface.commit(result);
      } catch { if (this.pending === pending) this.clear(); }
    })();
  }
}

/** Controls consume only host-presented invitations; no receipt or consent is issued. */
export class TextMemorialDeliveredHistory {
  private readonly seen = new Set<string>();
  private revision = -1;
  constructor(private readonly append: (event: Extract<TextMemorialEvent, {type: 'presented'}>) => void) {}
  event(event: TextMemorialEvent): void {
    if (event.revision <= this.revision) return;
    this.revision = event.revision;
    if (event.type !== 'presented' || event.id !== event.offer.id || event.origin.id !== event.id || this.seen.has(event.id)) return;
    this.seen.add(event.id); if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    this.append(event);
  }
}
