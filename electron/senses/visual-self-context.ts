import { randomUUID } from 'node:crypto';

export type VisualSelfSource = 'screen' | 'camera';
export interface VisualSelfSnapshot {
  /** Monotonic host revision; change before any asynchronous context transition. */
  revision: number;
  character: { key: string; publicName: string };
  /** Actual selected/loaded model generation, never a card's desired model path. */
  model: { key: string } | null;
  window: { role: 'pet'; key: string; revision: number; visible: boolean };
  /** Only the sources whose existing explicit consent is currently active. */
  sources: readonly { kind: VisualSelfSource; key: string; revision: number }[];
}
export interface VisualSelfOpportunity { readonly ref: string }
export interface VisualSelfFrameTicket { readonly ref: string }
export interface VisualSelfFrameProof {
  /** Host-owned frame receipt; never accept a renderer source label as proof. */
  frameKey: string;
  contextRevision: number;
  sourceKey: string;
  sourceRevision: number;
  /** Host frame time, with expiry inherited from the existing source policy. */
  capturedAt: number;
  expiresAt: number;
}
export interface VisualSelfHint {
  readonly version: 1;
  readonly frameRef: string;
  readonly source: VisualSelfSource;
  readonly sourceRef: string;
  readonly character: Readonly<{ ref: string; publicName: string }>;
  readonly avatar: Readonly<{ ref: string }> | null;
  readonly selfInFrame: 'UNKNOWN';
  readonly region: null;
  readonly reason: 'FRAME_PIXELS_UNVERIFIED' | 'CAMERA_HAS_NO_SCREEN_CORRELATION' | 'MODEL_NOT_RESOLVED';
}

type Source = VisualSelfSnapshot['sources'][number];
interface Frame {
  ticket: VisualSelfFrameTicket;
  source: Source;
  used: boolean;
  hint: VisualSelfHint | null;
  expiresAt: number;
}
interface Active {
  handle: VisualSelfOpportunity;
  revision: number;
  expiresAt: number;
  characterRef: string;
  modelRef: string | null;
  frames: Map<VisualSelfSource, Frame>;
}
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid visual-self data');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw Error('Invalid visual-self data');
  const fields = Reflect.ownKeys(value);
  if (fields.length !== names.length || fields.some(n => typeof n !== 'string' || !names.includes(n))) throw Error('Invalid visual-self data');
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid visual-self data');
    result[name] = descriptor.value;
  }
  return result;
}
function parseSnapshot(input: unknown): VisualSelfSnapshot {
  const r = record(input, ['revision', 'character', 'model', 'window', 'sources']);
  const card = record(r.character, ['key', 'publicName']);
  const model = r.model === null ? null : record(r.model, ['key']);
  const window = record(r.window, ['role', 'key', 'revision', 'visible']);
  if (!stamp(r.revision) || !key(card.key) || typeof card.publicName !== 'string'
    || !card.publicName.trim() || card.publicName.length > 80 || /[\u0000-\u001f\u007f]/.test(card.publicName)
    || (model && !key(model.key)) || window.role !== 'pet' || !key(window.key)
    || !stamp(window.revision) || typeof window.visible !== 'boolean'
    || !Array.isArray(r.sources) || r.sources.length > 2) throw Error('Invalid visual-self data');
  const sources: Source[] = r.sources.map(input => {
    const source = record(input, ['kind', 'key', 'revision']);
    if ((source.kind !== 'screen' && source.kind !== 'camera') || !key(source.key) || !stamp(source.revision)) throw Error('Invalid visual-self data');
    return { kind: source.kind, key: source.key, revision: source.revision };
  });
  if (new Set(sources.map(s => s.kind)).size !== sources.length) throw Error('Invalid visual-self data');
  sources.sort((a, b) => a.kind.localeCompare(b.kind));
  return { revision: r.revision, character: { key: card.key, publicName: card.publicName.trim() },
    model: model ? { key: model.key as string } : null,
    window: { role: 'pet', key: window.key, revision: window.revision, visible: window.visible }, sources };
}

/**
 * Host-only metadata boundary. This module never captures, enumerates, calls a
 * model, reads cards/files, changes consent, consumes a speech quota or rewards.
 * Main must open it only after the original message/visual opportunity accepts.
 * Geometry/pixels are deliberately unsupported: every admitted hint is UNKNOWN.
 */
export class VisualSelfContext {
  private context: VisualSelfSnapshot | null = null;
  private contextAt = 0;
  private active: Active | null = null;
  private disposed = false;
  private contextRejected = false;
  private lastNow = -1;
  private readonly clock: () => number;
  private readonly mint: () => string;
  constructor(options: { clock?: () => number; mint?: () => string } = {}) {
    this.clock = options.clock ?? Date.now;
    this.mint = options.mint ?? randomUUID;
  }
  /** Authoritative host updates only; never call this from a late frame callback. */
  setContext(input: VisualSelfSnapshot): boolean {
    if (this.disposed) return false;
    let next: VisualSelfSnapshot;
    try { next = parseSnapshot(input); } catch { this.active = null; this.contextRejected = true; return false; }
    const now = this.now(); if (now === null) return false;
    const previous = this.context;
    if (previous) {
      if (next.revision < previous.revision) return false;
      if (next.revision === previous.revision) {
        const same = JSON.stringify(next) === JSON.stringify(previous);
        if (!same) { this.active = null; this.contextRejected = true; }
        return same && !this.contextRejected;
      }
      if (next.window.key === previous.window.key && next.window.revision < previous.window.revision) return false;
      if (next.sources.some(s => previous.sources.some(p => s.kind === p.kind && s.key === p.key && s.revision < p.revision))) return false;
    }
    this.active = null;
    this.contextRejected = false;
    this.context = next;
    this.contextAt = now;
    return true;
  }
  /** A projection scope, not a new authority to capture or send a model request. */
  beginOpportunity(kind: 'user-message' | 'accepted-proactive-vision', acceptedKey: string, expiresAt: number): VisualSelfOpportunity | null {
    const now = this.now(), context = this.context;
    if (this.disposed || this.contextRejected || now === null || !context?.window.visible || !context.sources.length
      || (kind !== 'user-message' && kind !== 'accepted-proactive-vision') || !key(acceptedKey)
      || !stamp(expiresAt) || expiresAt <= now) return null;
    const handle = Object.freeze({ ref: this.id() });
    this.active = { handle, revision: context.revision, expiresAt, characterRef: this.id(),
      modelRef: context.model ? this.id() : null, frames: new Map() };
    return handle;
  }
  /** Call before the existing asynchronous frame operation; no capture is made. */
  issueFrameTicket(handle: VisualSelfOpportunity, kind: VisualSelfSource): VisualSelfFrameTicket | null {
    const active = this.live(handle), source = this.context?.sources.find(s => s.kind === kind);
    if (!active || !source) return null;
    const ticket = Object.freeze({ ref: this.id() });
    active.frames.set(kind, { ticket, source, used: false, hint: null, expiresAt: 0 });
    return ticket;
  }
  /** Build once from a current host receipt; no raw input keys are projected. */
  buildHint(handle: VisualSelfOpportunity, ticket: VisualSelfFrameTicket, input: VisualSelfFrameProof): VisualSelfHint | null {
    const active = this.live(handle); if (!active) return null;
    const entry = [...active.frames.entries()].find(([, frame]) => frame.ticket === ticket);
    if (!entry || entry[1].used) return null;
    const [source, frame] = entry;
    let proof: Record<string, unknown>;
    try { proof = record(input, ['frameKey', 'contextRevision', 'sourceKey', 'sourceRevision', 'capturedAt', 'expiresAt']); } catch { return null; }
    const now = this.now();
    if (now !== null && now >= active.expiresAt) { if (this.active === active) this.active = null; return null; }
    if (now === null || !key(proof.frameKey) || proof.contextRevision !== active.revision
      || proof.sourceKey !== frame.source.key || proof.sourceRevision !== frame.source.revision
      || !stamp(proof.capturedAt) || proof.capturedAt < this.contextAt || proof.capturedAt > now
      || !stamp(proof.expiresAt) || proof.expiresAt <= now || proof.expiresAt < proof.capturedAt) return null;
    const context = this.context!;
    const hint: VisualSelfHint = Object.freeze({ version: 1, frameRef: this.id(), source, sourceRef: this.id(),
      character: Object.freeze({ ref: active.characterRef, publicName: context.character.publicName }),
      avatar: active.modelRef ? Object.freeze({ ref: active.modelRef }) : null,
      selfInFrame: 'UNKNOWN', region: null,
      reason: !context.model ? 'MODEL_NOT_RESOLVED' : source === 'camera' ? 'CAMERA_HAS_NO_SCREEN_CORRELATION' : 'FRAME_PIXELS_UNVERIFIED' });
    frame.used = true; frame.hint = hint; frame.expiresAt = Math.min(proof.expiresAt, active.expiresAt);
    return hint;
  }
  /** Final synchronous pre-send check; a copied/serialized object is not a lease. */
  isCurrent(handle: VisualSelfOpportunity, hint: VisualSelfHint): boolean {
    const active = this.live(handle); if (!active) return false;
    const now = this.now(); if (now === null) return false;
    for (const [kind, frame] of active.frames) {
      if (frame.expiresAt && frame.expiresAt <= now) { active.frames.delete(kind); continue; }
      if (frame.hint === hint) return true;
    }
    return false;
  }
  /** An old reply/frame callback cannot cancel a newer opportunity. */
  cancel(handle: VisualSelfOpportunity): boolean {
    if (this.active?.handle !== handle) return false;
    this.active = null; return true;
  }
  dispose(): void { this.active = null; this.context = null; this.disposed = true; }
  private live(handle: VisualSelfOpportunity): Active | null {
    const now = this.now(), active = this.active;
    if (this.disposed || this.contextRejected || now === null || !active || active.handle !== handle || !this.context?.window.visible
      || active.revision !== this.context.revision || active.expiresAt <= now) {
      if (active?.handle === handle) this.active = null;
      return null;
    }
    return active;
  }
  private now(): number | null {
    const now = this.clock();
    if (!stamp(now) || now < this.lastNow) { this.active = null; return null; }
    this.lastNow = now; return now;
  }
  private id(): string {
    const id = this.mint(); if (!key(id)) { this.active = null; throw Error('Invalid visual-self token'); }
    return id;
  }
}
