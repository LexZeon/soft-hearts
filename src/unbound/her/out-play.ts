/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): the companion window's own overlays for 猜拳, 递东西 and 牵手 on the
 * full-screen Unbound page (src/initiative/RpsOverlay.ts, GiveOverlay.ts, HandsOverlay.ts, unchanged), with HerOutGames (out-games.ts) as
 * their stage and the page's narrow game requests (electron/unbound/games-preload-api.ts) as their host.
 *
 * What the page adds around them, and nothing else:
 *  - the click layer: the window is click-through except over her, so the hit test (main.ts) also takes the overlays' controls (the three
 *    buttons and her invitation's two, the soft target on what she holds out, the target on her hand) through `distance`; a press on one of
 *    them is theirs (`owns`): not a click on her, not a pull, not a pat or a pinch (`covers` for the touch input);
 *  - her game lines are held by the host in her reply bubble and read aloud by the companion window (2026-11-25; sayPorts below); the line
 *    waits its reading time, then the host hears "said";
 *  - the buttons sit beside her head, below her raised arm while she plays (the companion's placement, through the world camera);
 *  - a pat, a pinch or a snack at her mouth takes back what she holds out and lets go of her hand (`interrupt`, as the companion's mood
 *    wiring does); the page hiding does too (the overlays' own rule).
 */
import { GiveOverlay, HandsOverlay, RpsOverlay, shownRects, type RpsSayPorts } from '../../initiative';
import type { UnboundGamesApi } from '../../../electron/unbound/games-preload-api';
import type { HeadSpot } from '../../../shared/unbound/typing';
import type { UnboundBubble } from '../../../shared/unbound/scene';
import type { HerOutGames } from './out-games';

export interface HerPlayPorts {
  /** The page's game requests (null: no host, nothing mounts). */
  api: UnboundGamesApi | null;
  games: HerOutGames;
  /** Her reply bubble (the page's ReplyBubble). */
  bubble: { readonly shown: boolean; receive(bubble: UnboundBubble): void };
  /** She cannot be played with now (the page hidden, she is not shown enough): no offer or reach starts, one on goes back. */
  blocked(): boolean;
  /** Her head on this window, or null when it is off it. */
  head(): HeadSpot | null;
}

/**
 * What the page does for one of her game lines: nothing but pace the game (the host holds the line in her bubble and the companion window reads
 * it): no bubble of its own, no voice of its own, and having no voice here is not "read-aloud was off" (`voiceElsewhere`).
 * `closed`: the page is gone or she cannot be played with now.
 */
export function outSayPorts(closed: () => boolean): RpsSayPorts {
  return { free: () => !closed(), voiceOn: () => false, voiceElsewhere: () => true, show: () => {}, speak: async () => {}, ended: () => {} };
}

export class HerOutPlay {
  readonly rps: RpsOverlay | null;
  readonly give: GiveOverlay | null;
  readonly hands: HandsOverlay | null;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private readonly ports: HerPlayPorts) {
    const api = ports.api;
    if (!api) { this.rps = null; this.give = null; this.hands = null; return; }
    const stage = ports.games.stage;
    // Her reply bubble and said line never sit on the buttons or the score (src/initiative/rps-layout.ts).
    this.rps = new RpsOverlay(root, api, { stage, say: this.sayPorts(), avoid: () => shownRects(root.ownerDocument.querySelectorAll('.unbound-bubble, .unbound-said'), root.getBoundingClientRect()) });
    this.give = new GiveOverlay(root, { onGive: callback => api.onGive(callback), giveAnswer: answer => api.giveAnswer(answer),
      givePicture: async () => false, saveGivePicture: async () => false }, stage, { blocked: () => ports.blocked() }); // no picture of her goes out from here
    this.hands = new HandsOverlay(root, api, stage, { blocked: () => ports.blocked() });
    void this.rps.init(); this.give.init(); this.hands.init();
  }

  /**
   * Her game lines out here (the end-of-game line was not read aloud): the HOST puts each line in her bubble (it
   * is a held line, electron/unbound/game-line.ts, so the read-aloud proof covers it) and the companion window reads it; this page only
   * paces the game by the line's reading time and does not paint a bubble of its own. A line the host could not hold (a chat reply under
   * way, her bubble not visible) the host has already reported as skipped, with its reason.
   */
  private sayPorts(): RpsSayPorts { return outSayPorts(() => this.disposed || this.ports.blocked()); }

  /** Each frame after hers: the buttons beside her head, below her raised arm while she plays (they stay put for small moves). */
  place(width: number, height: number): void {
    if (!this.rps) return;
    const head = this.ports.head();
    this.rps.place({ x: head?.x ?? 0, y: head?.y ?? 0, radius: head?.r, visible: !!head, raisedHand: this.ports.games.raisedHand() }, width, height);
  }

  /** The overlays' controls shown now (CSS px boxes). */
  private boxes(): DOMRect[] {
    const out: DOMRect[] = [];
    for (const element of this.controls()) {
      if (element.hidden) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) out.push(rect);
    }
    return out;
  }
  private controls(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.rps-overlay, .give-target, .give-card, .hands-target')];
  }
  /** Distance (px) from a window point to the nearest control shown, ≤ 0 inside one, Infinity when none shows (the page's hit test). */
  distance(x: number, y: number): number {
    let best = Infinity;
    for (const r of this.boxes()) {
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      best = Math.min(best, dx === 0 && dy === 0 ? -1 : Math.hypot(dx, dy));
    }
    return best;
  }
  /** The point is on one of the controls (a pat or a pinch there is the control's: the touch input's blocksPoint). */
  covers(x: number, y: number): boolean { return this.distance(x, y) <= 0; }
  /** The event's target is one of the controls (the page's own click report and pull leave this press alone). */
  owns(target: EventTarget | null): boolean {
    const element = target as { closest?: (selector: string) => Element | null } | null;
    return typeof element?.closest === 'function' && !!element.closest('.rps-overlay, .give-target, .give-card, .hands-target');
  }
  /** A pat, a pinch or a snack started: what she holds out goes back, a held hand lets go (the companion's mood wiring does the same). */
  interrupt(): void { this.give?.interrupt(); this.hands?.interrupt(); }

  dispose(): void { this.disposed = true; this.rps?.dispose(); this.give?.dispose(); this.hands?.dispose(); }
}
