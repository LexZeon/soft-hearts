import { createHash, randomUUID } from 'node:crypto';
import { VisualSelfContext, type VisualSelfHint, type VisualSelfOpportunity,
  type VisualSelfSnapshot, type VisualSelfSource } from './visual-self-context';

export interface VisualSelfCapture { readonly ref: string }
export interface VisualSelfLease { readonly ref: string }
type Image = { source: string; dataUrl: string };
type Source = VisualSelfSnapshot['sources'][number];
interface Capture { token: VisualSelfCapture; context: VisualSelfSnapshot; source: Source }
interface Receipt { context: VisualSelfSnapshot; source: Source; digest: string;
  frameKey: string; capturedAt: number; expiresAt: number }
interface Lease { token: VisualSelfLease; opportunity: VisualSelfOpportunity; hints: VisualSelfHint[] }
const stamp = (v: number) => Number.isSafeInteger(v) && v >= 0;
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const validImage = (image: Image) => !!image && typeof image.dataUrl === 'string'
  && image.dataUrl.length <= 4_000_000
  && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl);

/** Only host capture completion may mint a receipt. No image bytes are retained. */
export class VisualSelfRuntime {
  private readonly contextBoundary: VisualSelfContext;
  private readonly clock: () => number;
  private readonly mint: () => string;
  private context: VisualSelfSnapshot | null = null;
  private contextAt = 0;
  private highestRevision = -1;
  private lastNow = -1;
  private disposed = false;
  private readonly captures = new Map<VisualSelfSource, Capture>();
  private readonly receipts = new Map<VisualSelfSource, Receipt>();
  private active: Lease | null = null;

  constructor(options: { clock?: () => number; mint?: () => string } = {}) {
    this.clock = options.clock ?? Date.now;
    this.mint = options.mint ?? randomUUID;
    this.contextBoundary = new VisualSelfContext({ clock: this.clock, mint: this.mint });
  }

  setContext(input: VisualSelfSnapshot): boolean {
    const now = this.now();
    if (this.disposed || now === null) return false;
    if (!this.contextBoundary.setContext(input)) { this.clear(); return false; }
    if (!this.context && input.revision <= this.highestRevision) return false;
    // The original strict boundary has checked all descriptors and values.
    const next: VisualSelfSnapshot = { revision: input.revision,
      character: { key: input.character.key, publicName: input.character.publicName.trim() },
      model: input.model ? { key: input.model.key } : null,
      window: { ...input.window }, sources: input.sources.map(s => ({ ...s })).sort((a, b) => a.kind.localeCompare(b.kind)) };
    if (JSON.stringify(next) === JSON.stringify(this.context)) return true;
    this.clear();
    this.context = next;
    this.highestRevision = next.revision;
    this.contextAt = now;
    return true;
  }

  beginCapture(kind: VisualSelfSource): VisualSelfCapture | null {
    if (this.now() === null || this.disposed || !this.context?.window.visible) return null;
    const source = this.context.sources.find(s => s.kind === kind);
    if (!source) return null;
    const token = Object.freeze({ ref: this.id() });
    this.captures.set(kind, { token, source, context: this.context });
    return token;
  }

  completeCapture(token: VisualSelfCapture, image: Image, capturedAt: number, expiresAt: number): boolean {
    const entry = [...this.captures.entries()].find(([, capture]) => capture.token === token);
    if (!entry) return false;
    this.captures.delete(entry[0]);
    const now = this.now(), capture = entry[1];
    if (now === null || this.disposed || !this.context?.window.visible || capture.context !== this.context
      || !validImage(image) || image.source !== capture.source.kind || !stamp(capturedAt) || !stamp(expiresAt)
      || capturedAt < this.contextAt || capturedAt > now || expiresAt <= now || expiresAt < capturedAt) return false;
    const end = Math.min(expiresAt, capturedAt + 60_000);
    if (end <= now) return false;
    this.receipts.set(capture.source.kind, { context: capture.context, source: capture.source,
      digest: digest(image.dataUrl), frameKey: this.id(), capturedAt, expiresAt: end });
    return true;
  }

  accept(kind: 'user-message' | 'accepted-proactive-vision', acceptedKey: string,
    images: readonly Image[], expiresAt: number): VisualSelfLease | null {
    this.cancelActive();
    const now = this.now(), context = this.context;
    if (now === null || this.disposed || !context?.window.visible || !stamp(expiresAt) || expiresAt <= now
      || !Array.isArray(images) || images.length > 8) return null;
    const matches = new Map<VisualSelfSource, Receipt>();
    for (const image of images) {
      if (!validImage(image) || (image.source !== 'screen' && image.source !== 'camera')) continue;
      const receipt = this.receipts.get(image.source);
      if (receipt && receipt.context === context && receipt.expiresAt > now
        && receipt.digest === digest(image.dataUrl)) matches.set(receipt.source.kind, receipt);
    }
    if (!matches.size) return null;
    const end = Math.min(expiresAt, ...[...matches.values()].map(r => r.expiresAt));
    const opportunity = this.contextBoundary.beginOpportunity(kind, acceptedKey, end);
    if (!opportunity) return null;
    const hints: VisualSelfHint[] = [];
    for (const receipt of matches.values()) {
      // Resolve an existing exact host receipt within this accepted opportunity.
      const ticket = this.contextBoundary.issueFrameTicket(opportunity, receipt.source.kind);
      const hint = ticket && this.contextBoundary.buildHint(opportunity, ticket, {
        frameKey: receipt.frameKey, contextRevision: context.revision, sourceKey: receipt.source.key,
        sourceRevision: receipt.source.revision, capturedAt: receipt.capturedAt, expiresAt: receipt.expiresAt,
      });
      if (hint) hints.push(hint);
    }
    if (!hints.length) { this.contextBoundary.cancel(opportunity); return null; }
    const token = Object.freeze({ ref: this.id() });
    this.active = { token, opportunity, hints };
    return token;
  }

  read(token: VisualSelfLease | null): string | undefined {
    if (!token || this.active?.token !== token || this.now() === null) return undefined;
    const active = this.active;
    if (!active) return undefined;
    const hints = active.hints.filter(h => this.contextBoundary.isCurrent(active.opportunity, h));
    if (!hints.length) return undefined;
    const text = JSON.stringify({ visualSelf: hints });
    return text.length <= 4096 ? text : undefined;
  }

  cancel(token: VisualSelfLease | null): void {
    if (token && this.active?.token === token) this.cancelActive();
  }

  cancelActive(): void {
    if (this.active) this.contextBoundary.cancel(this.active.opportunity);
    this.active = null;
  }

  clear(): void {
    this.cancelActive();
    this.context = null;
    this.captures.clear();
    this.receipts.clear();
  }

  dispose(): void {
    this.clear();
    this.contextBoundary.dispose();
    this.disposed = true;
  }

  private now(): number | null {
    const now = this.clock();
    if (!stamp(now) || now < this.lastNow) { this.clear(); return null; }
    this.lastNow = now;
    return now;
  }

  private id(): string {
    const ref = this.mint();
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) {
      this.clear(); throw Error('Invalid visual-self runtime token');
    }
    return ref;
  }
}
