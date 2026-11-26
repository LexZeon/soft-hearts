/**
 * I-154 follow-up, first slice (docs/claude/2026-11-20-unbound-full-shares.md): touching her out in full-screen Unbound with the companion
 * window's own touch input. A pat (the cursor stroking her scalp), a pinch (a press on her cheek, held and dragged) and a snack (an image
 * dragged to her mouth) are recognised by the same touch input (src/mood), against her head region projected through the world camera
 * (head-region.ts), and become the same mood inputs (touch-session.ts) through the host's narrow moodInteraction request
 * (electron/unbound/mood-bridge.ts). Her mood view comes the same way (getMood, onMood) and goes to her face (out-face.ts).
 *
 * Only her own window's hit on her own body counts: the region is hers, the events are this page's own, `canTouch` is the page's rule for
 * a click (she is shown, not forced click-through by a peek, the page visible), and the host takes a touch's input only from the window she
 * is shown in. No pull here (the page's own pull, pull-input.ts, keeps presses elsewhere on her); no snack picture is sent anywhere (the
 * companion window's I-019 hand-off is not part of this slice: she eats it, the picture stays where it was).
 */
import { MoodInputQueue, MoodTouchSession, MoodViewLifetime, TouchInput, matchesDirectContactCancellation, type TouchHeadRegion,
  type TouchFeedback, type TouchInputState } from '../../mood';
import type { MoodInput, MoodView } from '../../../shared/mood';

/** The page's narrow mood requests (electron/unbound/preload-api.ts). */
export interface HerMoodApi {
  getMood(): Promise<MoodView>;
  onMood(callback: (view: MoodView) => void): () => void;
  moodInteraction(input: MoodInput): Promise<MoodView>;
}
export interface HerTouchPorts {
  /** Her head region now (CSS px in the surface), or null (no model, her head off the window). */
  region(): TouchHeadRegion | null;
  /** She may be touched now (shown, not forced click-through, the page visible). */
  canTouch(): boolean;
  /** A new mood view (her face), or null when the scope was lost. */
  view(view: MoodView | null): void;
  /** The touch input's feedback for her face, or null when it ended. */
  contact(feedback: TouchFeedback | null): void;
  /** A touch session is open (not a mere hover over her scalp). */
  interacting?(active: boolean): void;
  /** A short line for the user (a snack dropped too far from her mouth, a host refusal). */
  notice?(message: string): void;
  /** Batch B: the point is on one of the page's game controls (a pat or a pinch there is the control's, as on the companion window). */
  blocks?(clientX: number, clientY: number): boolean;
  /** A picture may be dropped at this point (her body and a small margin: drop-zone.ts); absent: anywhere on the page. */
  dropZone?(clientX: number, clientY: number): boolean;
}

export class HerOutTouch {
  private view: MoodView | null = null;
  private readonly lifetime = new MoodViewLifetime();
  private readonly queue: MoodInputQueue;
  private readonly session: MoodTouchSession;
  private readonly input: TouchInput;
  private suppress = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(surface: HTMLElement, private readonly api: HerMoodApi, private readonly ports: HerTouchPorts) {
    this.queue = new MoodInputQueue(input => api.moodInteraction(input), view => this.apply(view), message => this.ports.notice?.(message));
    this.session = new MoodTouchSession(input => { void this.queue.push(input); });
    this.input = new TouchInput(surface, {
      getHeadRegion: () => this.ports.region(),
      canInteract: () => !!this.view && !this.disposed && this.ports.canTouch(),
      onState: state => this.state(state),
      onFeedback: feedback => { if (!this.disposed) this.ports.contact(feedback); },
      onEvent: event => { if (!this.disposed && !this.suppress && this.view) this.session.event(event); },
      onError: message => this.ports.notice?.(message),
      onCancel: reason => this.reset(reason),
      blocksPoint: (x, y) => this.ports.blocks?.(x, y) === true,
      acceptsDrop: this.ports.dropZone ? (x, y) => this.ports.dropZone!(x, y) : undefined,
    });
  }

  /** Reads her mood once and follows it. */
  start(): void {
    if (this.disposed || this.unsubscribe) return;
    this.unsubscribe = this.api.onMood(view => this.apply(view));
    void this.refresh();
  }

  /** The press at (x, y) is the touch input's (a pinch on her cheek began): the page's own click and pull leave it alone. */
  get pinching(): boolean { return this.input.state.phase === 'cheek'; }
  /** The touch input's phase now (for the developer view and tests). */
  get phase(): TouchInputState['phase'] { return this.input.state.phase; }
  /** The mood view her face shows (null: none yet or the scope was lost). */
  get mood(): MoodView | null { return this.view; }

  private async refresh(): Promise<void> {
    const ticket = this.lifetime.ticket();
    try { this.apply(await this.api.getMood(), ticket); }
    catch { if (!this.disposed && this.lifetime.isCurrent(ticket)) { this.lifetime.invalidate(); this.queue.setToken(''); } }
  }

  private apply(view: MoodView, ticket?: Parameters<MoodViewLifetime['accept']>[1]): void {
    if (this.disposed || !view || !this.lifetime.accept(view, ticket)) return;
    const changed = this.view?.token !== view.token;
    this.view = view;
    this.queue.setToken(view.token);
    if (changed) this.resetLocal();
    else if (matchesDirectContactCancellation(view, this.session.lastSession)) this.reset('native-blur');
    this.ports.view(view);
  }

  private state(state: TouchInputState): void {
    if (this.suppress || this.disposed || !this.view) return;
    this.ports.interacting?.(state.phase !== 'idle' && state.phase !== 'rua-hover');
    this.session.state(state);
  }

  private resetLocal(): void {
    this.session.resetLocal();
    this.suppress = true;
    try { this.input.reset(); } finally { this.suppress = false; }
    this.ports.contact(null); this.ports.interacting?.(false);
  }

  /** The companion's reset: a session open at the host ends; a lost scope forgets the view and reads it again. */
  reset(reason?: string): void {
    const sessionId = this.session.lastSession;
    this.queue.invalidate(); this.resetLocal();
    if (reason === 'context' || reason === 'character' || reason === 'disconnect') {
      this.lifetime.invalidate(); this.queue.setToken(''); this.view = null; this.ports.view(null);
      if (reason !== 'disconnect') void this.refresh();
      return;
    }
    if (sessionId && this.view && !this.disposed) void this.queue.push({ type: 'phase', phase: 'idle', sessionId });
  }

  dispose(): void {
    if (this.disposed) return;
    const sessionId = this.session.lastSession, token = this.view?.token;
    this.resetLocal(); this.session.dispose(); this.lifetime.dispose(); this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.input.dispose(); this.queue.dispose();
    if (sessionId && token) void this.api.moodInteraction({ token, sessionId, type: 'phase', phase: 'idle' } as MoodInput).catch(() => {});
  }
}
