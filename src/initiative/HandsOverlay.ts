/**
 * I-087 牵手、拉钩、击掌, companion window (docs/claude/2026-11-11-i087-hands.md). The host's offer starts her reach toward your mouse; a
 * round target (invisible: the hint is the emoji, like the head pat) sits on her hand, and a click on it is "a touch". The session
 * (shared/behaviors/hands/session.ts) turns the touch, the reach's state and interruptions into the stage's commands and the host's
 * answers. The emoji hint is the head pat's own follower (PetInteractionCursor): over her hand while she reaches and waits, and while
 * holding / at the touch, wherever your pointer is in her window; it shows and hides at once, like the pat's.
 *
 * Also watches, between reaches, whether your mouse rests within her reach for a moment; then it asks the host once (handsRequest),
 * which decides by her mood. The window never starts a reach by itself.
 */
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { readHandsEvent, type HandsAnswer, type HandsEvent, type HandsOfferEvent, type HandsRequest } from '../../shared/behaviors/hands/interface';
import { HANDS_KNOBS, type HandEmoji, type HandOutcome } from '../../shared/behaviors/hands/knobs';
import { HandsSession, type HandsStageCommand } from '../../shared/behaviors/hands/session';
import type { HandReachCue, HandReachState } from './hand-reach';
import { PetInteractionCursor } from '../mood/PetInteractionCursor';
import { uiText } from '../foundation/ui-language';

registerUiMessages({ en: { '牵手': 'Hold hands', '拉钩': 'Pinky promise', '击掌': 'High five' }, 'zh-CN': {} });

export interface HandsOverlayAPI {
  onHands(callback: (event: HandsEvent) => void): () => void;
  handsAnswer(answer: HandsAnswer): Promise<boolean>;
  handsRequest(request: HandsRequest): Promise<boolean>;
}
export interface HandsOverlayStage {
  startHands(cue: HandReachCue): boolean;
  handsCommand(command: HandsStageCommand): void;
  handsAnchor(): { x: number; y: number; r: number } | null;
  handsState(): HandReachState | null;
  handsNear(): boolean;
  readonly handInput: { touch(): void; takeTouch(): boolean; read(): { x: number; y: number } | null };
}
export interface HandsCursor { show(x: number, y: number, emoji: HandEmoji): void; hide(): void; dispose?(): void }
interface Doc { createElement(tag: string): HTMLElement }

/** The target's box (centre +- r) cut to the window, so it can never overflow it. Unknown window size: as is. */
export function clampBox(anchor: { x: number; y: number; r: number }, width: number, height: number): { left: number; top: number; width: number; height: number } {
  let left = anchor.x - anchor.r, top = anchor.y - anchor.r, right = anchor.x + anchor.r, bottom = anchor.y + anchor.r;
  if (Number.isFinite(width) && width > 0) { left = Math.max(0, left); right = Math.min(width, right); }
  if (Number.isFinite(height) && height > 0) { top = Math.max(0, top); bottom = Math.min(height, bottom); }
  return { left: Math.round(left), top: Math.round(top), width: Math.max(0, Math.round(right - left)), height: Math.max(0, Math.round(bottom - top)) };
}

const LABEL = { hold: '牵手', pinky: '拉钩', 'high-five': '击掌' } as const;

export class HandsOverlay {
  private readonly target: HTMLButtonElement;
  private readonly cursor: HandsCursor;
  private unsubscribe: (() => void) | null = null;
  private session: HandsSession | null = null;
  private raf = 0;
  private hovered = false;
  private pointer: { x: number; y: number } | null = null;
  private interrupted = false;
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private still: { x: number; y: number; since: number } | null = null;
  private stillMs: number;
  private lastAsk = -Infinity;

  constructor(private readonly parent: HTMLElement, private readonly api: HandsOverlayAPI, private readonly stage: HandsOverlayStage, private readonly options: {
    /** The window is hidden, a drag, …: no reach starts, one on the stage goes back. */
    blocked?: () => boolean;
    now?: () => number;
    random?: () => number;
    frame?: (callback: () => void) => number;
    cancelFrame?: (handle: number) => void;
    document?: Doc;
    cursor?: HandsCursor;
    /** Between reaches: how often the resting mouse is looked at (ms); 0 = never (tests drive `watchRest`). */
    restEveryMs?: number;
  } = {}) {
    const doc = options.document ?? document;
    this.target = doc.createElement('button') as HTMLButtonElement;
    this.target.className = 'hands-target'; this.target.type = 'button'; this.target.hidden = true;
    // A companion control area: pointer events here are this button, never a pat or a pinch (MoodCompanion isPetControlPoint).
    this.target.dataset.moodUi = 'true';
    Object.assign(this.target.style, { position: 'absolute', zIndex: '25', padding: '0', border: 'none', borderRadius: '50%', background: 'transparent', outline: 'none' }); // outline none: the page's focus-visible ring drew a big mint circle round her hand (2026-11-21); the emoji says it // its cursor is hidden only while the emoji is shown (syncCursor), never on its own
    this.target.onclick = () => { if (this.session && !this.session.answered) this.stage.handInput.touch(); };
    this.target.onpointerenter = event => { this.hovered = true; this.pointer = { x: event.clientX, y: event.clientY }; this.syncCursor(); };
    this.target.onpointerleave = () => { this.hovered = false; this.syncCursor(); };
    this.cursor = options.cursor ?? new PetInteractionCursor(parent);
    this.stillMs = this.nextStill();
    parent.append(this.target);
  }

  init(): void {
    if (this.unsubscribe) return;
    const stop = this.api.onHands(event => this.receive(event));
    const move = (event: PointerEvent) => { this.pointer = { x: event.clientX, y: event.clientY }; if (this.session) this.syncCursor(); }; // the emoji follows at once, not a frame later
    const leave = () => { this.pointer = null; this.hovered = false; this.syncCursor(); };
    this.parent.addEventListener('pointermove', move as EventListener, { passive: true } as AddEventListenerOptions);
    this.parent.addEventListener('pointerleave', leave);
    const view = this.parent.ownerDocument?.defaultView; view?.addEventListener('blur', leave); // the window lost the pointer or focus: the system cursor comes back
    const every = this.options.restEveryMs ?? 200;
    if (every > 0) this.restTimer = setInterval(() => this.watchRest(), every);
    this.unsubscribe = () => { stop(); this.parent.removeEventListener('pointermove', move as EventListener); this.parent.removeEventListener('pointerleave', leave); view?.removeEventListener('blur', leave); };
  }

  /** The host's events (desk:hands). */
  receive(value: unknown): void {
    const event = readHandsEvent(value);
    if (!event) return;
    if (event.type === 'offer') this.start(event);
    else if (this.session?.offer.id === event.id) this.apply(this.session.cancel());
  }

  /** A pat, a snack, a drag started: her reach goes back (a hold lets go). */
  interrupt(): void { if (this.session && !this.session.done) this.interrupted = true; }

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }
  private nextStill(): number { const [low, high] = HANDS_KNOBS.restAsk.stillMs; return low + (high - low) * (this.options.random ?? Math.random)(); }

  private start(offer: HandsOfferEvent): void {
    if (this.session && !this.session.done) this.apply(this.session.cancel());
    if (this.options.blocked?.() === true || !this.stage.startHands({ use: offer.use, style: offer.style })) {
      void this.api.handsAnswer({ id: offer.id, outcome: 'interrupted' }).catch(() => {});
      return;
    }
    this.session = new HandsSession({ id: offer.id, use: offer.use, waitMs: offer.waitMs, style: offer.style }, this.now(), this.options.random);
    this.interrupted = false; this.hovered = false;
    this.stage.handInput.takeTouch(); // a click from before this reach is not a touch of it
    this.target.setAttribute('aria-label', uiText(LABEL[offer.use])); // no title: the target is invisible, so a hover tooltip showed a lone "牵手" out of nowhere
    this.loop();
  }

  private apply(step: { readonly commands: readonly HandsStageCommand[]; readonly answers: readonly HandOutcome[] }): void {
    for (const command of step.commands) this.stage.handsCommand(command);
    const id = this.session?.offer.id;
    if (id) for (const outcome of step.answers) void this.api.handsAnswer({ id, outcome }).catch(() => {});
  }

  /** Each frame while a reach is on: the session, the target on her hand, the emoji hint. */
  private loop(): void {
    const frame = this.options.frame ?? (callback => requestAnimationFrame(callback));
    const step = () => {
      this.raf = 0;
      this.frameOnce();
      if (this.session && !this.session.done) this.raf = frame(step);
    };
    if (!this.raf) this.raf = frame(step);
  }

  /** One frame (tests call it directly). */
  frameOnce(): void {
    const session = this.session;
    if (!session) { this.target.hidden = true; this.cursor.hide(); return; }
    const state = this.stage.handsState();
    const blocked = this.interrupted || this.options.blocked?.() === true;
    this.apply(session.step({ now: this.now(), arrived: state?.arrived === true, touch: this.stage.handInput.takeTouch(), far: state?.far === true,
      blocked, stageIdle: !state?.active }));
    if (blocked) this.interrupted = false;
    const anchor = session.phase === 'reaching' || session.phase === 'waiting' || session.phase === 'held' ? this.stage.handsAnchor() : null;
    if (anchor) {
      const box = clampBox(anchor, this.parent.clientWidth, this.parent.clientHeight); // never beyond the window: no scrollbars
      this.target.style.left = `${box.left}px`; this.target.style.top = `${box.top}px`;
      this.target.style.width = `${box.width}px`; this.target.style.height = `${box.height}px`;
      this.target.hidden = false;
    } else { this.target.hidden = true; this.hovered = false; }
    this.syncCursor();
    if (session.done) { this.session = null; this.target.hidden = true; this.hovered = false; this.syncCursor(); }
  }

  /** The one place the pointer is hidden: the emoji shows at the pointer and the target hides the system cursor, or both are undone together. */
  private syncCursor(): void {
    const emoji = this.session ? this.session.emoji(this.hovered) : null;
    if (emoji && this.pointer) { this.cursor.show(this.pointer.x, this.pointer.y, emoji); this.target.style.cursor = this.hovered ? 'none' : ''; }
    else { this.cursor.hide(); this.target.style.cursor = ''; }
  }

  /**
   * Between reaches: your mouse within her reach, nearly still for a moment (a random 2.5–4.5 s), at most once every 40 s → ask the
   * host. It decides by her mood whether she reaches (most of the time she does when she is in the mood).
   */
  watchRest(): void {
    if (this.session || this.options.blocked?.() === true) { this.still = null; return; }
    const now = this.now(), reading = this.stage.handInput.read();
    if (!reading || !this.stage.handsNear()) { this.still = null; return; }
    const still = this.still;
    if (!still || Math.hypot(reading.x - still.x, reading.y - still.y) > HANDS_KNOBS.restAsk.moveNdc) { this.still = { x: reading.x, y: reading.y, since: now }; return; }
    if (now - still.since < this.stillMs || now - this.lastAsk < HANDS_KNOBS.restAsk.everyMs) return;
    this.lastAsk = now; this.still = null; this.stillMs = this.nextStill();
    void this.api.handsRequest({ use: 'hold' }).catch(() => false);
  }

  dispose(): void {
    if (this.session && !this.session.done) this.apply(this.session.cancel());
    this.session = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.restTimer) clearInterval(this.restTimer);
    this.restTimer = null;
    if (this.raf) (this.options.cancelFrame ?? (handle => cancelAnimationFrame(handle)))(this.raf);
    this.raf = 0;
    this.cursor.hide(); this.cursor.dispose?.();
    this.target.style.cursor = '';
    this.target.remove();
  }
}
