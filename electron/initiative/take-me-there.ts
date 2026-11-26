// 「带我去」 host side (I-051, shared/initiative/take-me-there.ts). One offer at a time, belonging to one reply and one window. It is made
// only when the user's message asked for something on the local map, her reply carried no setting card, and the reply was
// complete. A tap only asks the host to open a page: it changes no setting, grants no permission and starts nothing.
import { randomUUID } from 'node:crypto';
import { isTakeMeThereId, matchTakeMeThere, type TakeMeThereId, type TakeMeThereView } from '../../shared/initiative/take-me-there';

export interface TakeMeThereOptions {
  /** Sends the button (or its removal) to the window that owns the reply. */
  send(owner: number, view: TakeMeThereView): void;
  /** Shows the control window on this page. */
  open(destination: TakeMeThereId): void;
  /** The active character's base name (baseCardName): "让<her name>看屏幕" counts as a request like 让你/让她. Read on every turn, so a switch of character takes effect at once. */
  characterName?(): string;
  now?(): number;
  id?(): string;
  /** An offer stops working after this long, like a setting card. */
  ttlMs?: number;
}

export interface TakeMeThereTurn { ticket: number; destination: TakeMeThereId | null }

interface Active { view: TakeMeThereView; owner: number; expiresAt: number }

export class TakeMeThere {
  private generation = 0;
  private active: Active | null = null;
  constructor(private readonly options: TakeMeThereOptions) {}

  /** A new ordinary chat turn: the earlier button goes away; returns this turn's ticket and what the message asked for. */
  beginTurn(userText: unknown): TakeMeThereTurn {
    this.invalidate();
    return { ticket: this.generation, destination: matchTakeMeThere(userText, this.currentName()) };
  }

  private currentName(): string | undefined { try { return this.options.characterName?.(); } catch { return undefined; } }

  /** Character, conversation or provider changed, or a new turn began. */
  invalidate(): void {
    this.generation++;
    const active = this.active;
    this.active = null;
    if (active) this.send(active.owner, { ...active.view, state: 'gone' });
  }

  /** After a complete, archived reply. `cardShown`: her reply carried a setting card, so the card is the answer. */
  offer(turn: TakeMeThereTurn, owner: number, cardShown: boolean): TakeMeThereView | null {
    if (turn.ticket !== this.generation || !turn.destination || cardShown) return null;
    const view: TakeMeThereView = { kind: 'take-me-there', version: 1, offerId: (this.options.id ?? randomUUID)(), destination: turn.destination, state: 'open' };
    this.generation++; // One offer per reply.
    this.active = { view, owner, expiresAt: this.now() + (this.options.ttlMs ?? 5 * 60_000) };
    this.send(owner, view);
    return structuredClone(view);
  }

  /** A tap from the owning window. Unknown, stale, foreign or malformed requests open nothing. */
  go(sender: number, request: unknown): boolean {
    const input = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
    const active = this.active;
    if (!active || input.offerId !== active.view.offerId || !isTakeMeThereId(input.destination) || input.destination !== active.view.destination) return false;
    if (sender !== active.owner) throw new Error('请求来源未授权。');
    if (this.now() > active.expiresAt) { this.invalidate(); return false; }
    this.options.open(active.view.destination);
    return true;
  }

  private send(owner: number, view: TakeMeThereView): void {
    try { this.options.send(owner, structuredClone(view)); } catch { /* The window may be gone. */ }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
}
