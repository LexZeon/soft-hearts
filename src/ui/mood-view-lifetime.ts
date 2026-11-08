export interface MoodViewScope { readonly characterId: string; readonly token: string; readonly revision: number }
export interface MoodReadTicket { readonly epoch: number; readonly sequence: number }
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

/** One existing host/page lifetime. No timer, reconnect detector or state values. */
export class MoodViewLifetime {
  private epoch = 0;
  private sequence = 0;
  private revision = -1;
  private token = '';
  private character = '';
  private invalidated = false;
  private disposed = false;
  ticket(): MoodReadTicket { return Object.freeze({ epoch: this.epoch, sequence: this.sequence }); }
  isCurrent(ticket: MoodReadTicket): boolean { return !this.disposed && ticket.epoch === this.epoch && ticket.sequence === this.sequence; }
  invalidate(): void { this.epoch++; this.sequence++; this.invalidated = true; }
  accept(view: MoodViewScope, ticket?: MoodReadTicket): boolean {
    if (this.disposed || ticket && ticket.epoch !== this.epoch || !view || !identity(view.characterId) || !identity(view.token)
      || !Number.isSafeInteger(view.revision) || view.revision < 0 || view.revision < this.revision) return false;
    if (view.revision === this.revision && (view.token !== this.token || view.characterId !== this.character)) return false;
    if (this.invalidated && !ticket && view.revision <= this.revision) return false;
    this.revision = view.revision; this.token = view.token; this.character = view.characterId;
    this.sequence++; this.invalidated = false; return true;
  }
  dispose(): void { this.invalidate(); this.disposed = true; }
}
