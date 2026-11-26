/**
 * Where she stands in full-screen Unbound, on the host side (moved out of electron/unbound/host.ts with I-212, 2026-11-24). Memory only.
 *
 * I-212: every decision about where she stands is in screen terms (across, size;
 * shared/unbound/screen-terms) and converted to her world's metres for this screen and her model's own height:
 *  - an entry starts at the place keeper's start (the default place, where she already is, the last place, else the first appearance:
 *    DEFAULT_ACROSS and SCREEN_TERMS_KNOBS.firstSize, half the usable height);
 *  - her height is known only once her model has loaded (the page's ready report). So a start in screen terms rides in the scene (`start`):
 *    the page places her first frame with her measured height through the same conversion (src/unbound/start-place.ts), and when its ready
 *    report brings that height the host works out the same placement (the same function, the same numbers): nothing jumps or walks. Until
 *    then the host's placement is a guess with FALLBACK_HEIGHT_M, never drawn (her window is not shown before the ready report);
 *  - her life's spots (LifeSpot = LookSpot), "come-near"'s target, the places kept and the turn's position line read the same conversion.
 */
import { DEFAULT_ACROSS, DEFAULT_DEPTH_M, clampPlacement, type Placement } from '../../shared/unbound/world';
import { FALLBACK_HEIGHT_M, SCREEN_TERMS_KNOBS, lookOfPlacement, placementOfLook, sizeForToldM, toldDistanceM, type LookSpot, type ScreenFrame, type ScreenTermsKnobs } from '../../shared/unbound/screen-terms';
import { comeNearSize, herSeen, nearTable, nearestWalkSize, type GoTarget, type HerPositionFacts } from '../../shared/unbound/her-position';
import type { UnboundWorld } from '../../shared/unbound/scene';
import { firstWaistUpSize } from '../../shared/unbound/her-position';
import type { PlaceKeeper } from './place-keeper';
import type { LifeLink } from './life';

/** What the position line reads (shared/unbound/her-position/words.ts herPositionLine). */
export interface HerPlaceFacts { spot: LookSpot; facts: HerPositionFacts }

export class HerPlace {
  /** Where she stands (world m); null before her first world. */
  placement: Placement | null = null;
  /** Her depth for the developer knob (m behind the screen). */
  depthM = DEFAULT_DEPTH_M;
  /** Her model's height (m) from the page's ready report; null before it. */
  heightM: number | null = null;
  /** An entry's start in screen terms, sent with the scene until the page has reported her height (null: none, or done). */
  start: LookSpot | null = null;
  /**
   * I-209 step 3: with others already on stage, an entry's place moved clear of them (electron/unbound/company/stage.ts clearOf); null: as it is.
   * Set by the stage on a host it made; the first one's host never has one.
   */
  clearStart: ((at: Placement, frame: ScreenFrame) => Placement) | null = null;

  /** `world`: her world now (the host's; null before her first). */
  constructor(private readonly keeper: PlaceKeeper, private readonly world: () => UnboundWorld | null = () => null, private readonly knobs: ScreenTermsKnobs = SCREEN_TERMS_KNOBS) {}

  /** True while `start` is the first appearance (nothing kept for her): the page's ready report then fixes its size with her real height. */
  private firstAppearance = false;

  /**
   * The first appearance (night, replacing I-212 B's "half the screen high"): DEFAULT_ACROSS, and a size that shows her from the waist up on this
   * screen with her height (shared/unbound/her-position/first.ts); the old firstSize only when that cannot be worked out.
   */
  firstLook(frame: ScreenFrame | null = this.world()): LookSpot { return { across: DEFAULT_ACROSS, size: firstWaistUpSize(frame, this.heightM ?? FALLBACK_HEIGHT_M) ?? this.knobs.firstSize }; }

  /** Her placement for a world built now: an entry asks the keeper; any other rebuild (another screen, the viewing distance) keeps her. */
  place(frame: ScreenFrame, entering: boolean): Placement {
    const guess = (look: LookSpot) => placementOfLook(frame, this.heightM ?? FALLBACK_HEIGHT_M, look) ?? clampPlacement({ xM: 0, depthM: this.depthM });
    if (entering) {
      let first = false;
      const start = this.keeper.startAt(frame, this.placement, () => { first = true; return this.firstLook(frame); });
      this.firstAppearance = first;
      this.start = start.look ?? null;
      this.placement = start.look ? guess(start.look) : start.placement;
      const clear = this.clearStart?.(this.placement, frame); // I-209 step 3: never out inside someone already standing there
      if (clear && (clear.xM !== this.placement.xM || clear.depthM !== this.placement.depthM)) {
        this.placement = clampPlacement(clear);
        this.start = lookOfPlacement(frame, this.heightM ?? FALLBACK_HEIGHT_M, this.placement) ?? this.start;
      }
    } else this.placement = clampPlacement(this.placement ?? guess(this.firstLook(frame)));
    return this.placement;
  }

  /**
   * The page has her on screen and says how tall she is: a start in screen terms becomes her exact placement (the page placed her first frame
   * the same way), and her old records (metres) convert once. True when her placement changed (the scene goes out again).
   */
  ready(heightM: number | null | undefined): boolean {
    const frame = this.world();
    if (typeof heightM !== 'number' || !Number.isFinite(heightM) || heightM <= 0) { this.start = null; return false; }
    this.heightM = heightM;
    let moved = false;
    if (frame && this.start && this.firstAppearance) this.start = { ...this.start, size: this.firstLook(frame).size }; // her real height now: waist-up for HER, not for the guess
    this.firstAppearance = false;
    if (frame && this.start) { const at = placementOfLook(frame, heightM, this.start); if (at) { this.placement = at; moved = true; } }
    this.start = null;
    if (frame) this.keeper.adopt(frame, heightM);
    return moved;
  }

  /** Where she stands as the user sees it (null before her world or her height is known). */
  here(): LookSpot | null { const frame = this.world(); return frame && this.placement ? lookOfPlacement(frame, this.heightM, this.placement) : null; }
  /** A spot on her floor for this screen and her height. */
  toWorld(spot: LookSpot): Placement | null { const frame = this.world(); return frame ? placementOfLook(frame, this.heightM, spot) : null; }
  /** How near "come-near" walks her (a size): the default place's, else a chest-up framing for her height; null when nothing is known. */
  nearSize(): number | null {
    try { return comeNearSize({ defaultPlace: this.keeper.defaultLook, world: this.world(), heightM: this.heightM })?.size ?? null; } catch { return null; }
  }
  /** What her life host reads of her place (shared/unbound/life/host.ts LifeLink): her spot, a spot's metres, come-near's size, the nearest, go's numbers. */
  lifeLink(): Pick<LifeLink, 'here' | 'toWorld' | 'nearSize' | 'nearestSize' | 'goTarget'> {
    return { here: () => this.here(), toWorld: spot => this.toWorld(spot), nearSize: () => this.nearSize(), nearestSize: () => this.nearestSize(), goTarget: target => this.goTarget(target) };
  }
  /** I-193: the nearest she walks to by herself, "only the face", on this screen for her height (null before both are known). */
  nearestSize(): number | null { try { return nearestWalkSize(this.world(), this.heightM); } catch { return null; } }
  /**
   * I-193 numbers: ⟦go 30% 1.2m⟧ as a spot on this screen: the percent is her share across, the metres go through the screen formula backwards
   * (screen-terms sizeForToldM: the same ruler as the told distance, so "1.2 m" looks the same on a laptop and a 27" screen). Not clamped here:
   * her-position/go.ts keeps it between the farthest and the nearest. null: nothing usable (no height yet).
   */
  goTarget(target: GoTarget): { across?: number; size?: number } | null {
    const across = typeof target.percent === 'number' && Number.isFinite(target.percent) ? target.percent / 100 : undefined;
    const size = typeof target.metres === 'number' && Number.isFinite(target.metres) ? sizeForToldM(this.heightM, Math.max(0.05, target.metres)) ?? undefined : undefined;
    return across === undefined && size === undefined ? null : { ...(across !== undefined ? { across } : {}), ...(size !== undefined ? { size } : {}) };
  }
  /** A walk of hers ended here (world m): her place now, kept as her last place. */
  arrived(frame: ScreenFrame, at: Placement): Placement { this.placement = clampPlacement(at); this.keeper.walked(frame, this.placement, this.heightM); return this.placement; }

  /** The developer knob: along your line of sight to her (she keeps her place across the screen and only grows or shrinks). */
  knobDepth(depthM: number, viewerDistanceM: number): void {
    this.depthM = clampPlacement({ xM: 0, depthM }).depthM;
    if (this.placement) { const d = viewerDistanceM; this.placement = clampPlacement({ xM: this.placement.xM * (d + this.depthM) / (d + this.placement.depthM), depthM: this.depthM }); }
  }

  /**
   * I-211: what the turn's position line says (null before she is placed and measured); `taskbar`: the display has one. The distances are the screen
   * formula's: the same look is the same number on every computer, never the world's metres behind the glass.
   */
  facts(): HerPlaceFacts | null {
    const spot = this.here(), world = this.world();
    if (!spot || !world || !this.placement) return null;
    const place = this.keeper.defaultLook, height = this.heightM!;
    return { spot, facts: { taskbar: world.workArea.height < world.display.height, distanceM: toldDistanceM(height, spot.size), seen: herSeen(world, { heightM: height }, this.placement.depthM),
      defaultPlace: place ? { ...place, distanceM: toldDistanceM(height, place.size) } : null, table: nearTable(world, height) } }; // I-193: how big, the near-far table
  }
}
