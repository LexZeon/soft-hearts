/**
 * I-154 safety line (docs/claude/2026-11-19-unbound-in-window.md「安全线怎么保证」): what the window-mode engine may ask the host.
 *
 * The companion window's preload (window.desktop) can switch the user's senses (camera, microphone, screen, the computer's sound) and
 * reach Unbound's way out (which turns on the permission bundle). The window-mode engine never gets it. It gets only what is
 * picked here. A new need adds one named method here and to WINDOW_STAGE_HOST_METHODS; never the whole preload, never a sense, never
 * Unbound. tests/unbound-window-engine.test.ts holds it; scripts/dev/mutations/unbound.json「window-engine-narrow-port」checks the test.
 *
 * What is here, each already called by the companion's own stage in this same window (so nothing new reaches the host):
 *  - isBehaviorModelSupported: "is this the reviewed Gene" (step 1; decides whether motions are fitted to the model);
 *  - batch 5 (2026-11-20, her own motions): the host's grant for a chat gesture, for one of her actions, for a behaviour face and for an
 *    automatic body motion (reads of a resource the host already issued a cue for), the automatic body motion's plan, and the one write:
 *    reportHerAction, the companion window's answer to a test command (played / missing / busy …; without it the host waits it out);
 *  - batch 6 (2026-11-20, 她自己的生活): the host's pinned grant for one of her own life's held poses (thinking, sleepy), a read;
 *  - 2026-11-21 (docs/claude/2026-11-21-window-idle-pose.md): her default stand when no pose is picked (the bundled stand's asset), a read
 *    the old stage in this window makes too (src/stage/rest-stand.ts) and full-screen Unbound's host has made since 2026-11-15.
 * Music (batch 6) needs nothing here: its samples come from the wiring, and only while the user's own 和她一起听 switch is on.
 */
import type { HerLifeMotionResource } from '../../../shared/stage';
import type { AssetRef } from '../../../shared/foundation/settings';
import type { BehaviorMotionResource, BodyMotionPlan, BodyMotionResource, BodyStageObservation, ChatGestureResource, HerActionOutcome,
  HerActionResource } from '../../../shared/actions';

export interface WindowStageHost {
  /** The model shown is the reviewed Gene (motions play as authored; others are fitted to the model). */
  isBehaviorModelSupported(): Promise<boolean>;
  /** Batch 5: the granted bytes of a chat gesture the host cued (row 30). */
  resolveChatGesture(cueId: string, token: string): Promise<ChatGestureResource>;
  /** Batch 5: one of her actions the host cued (row 31), and her answer for it. */
  resolveHerAction(cueId: string): Promise<HerActionResource>;
  reportHerAction(outcome: HerActionOutcome): Promise<void>;
  /** Batch 5: automatic body motions and behaviour faces (row 32): the plan, and the granted bytes of a cue in it. */
  getBehaviorBodyPlan(token: string, observation?: BodyStageObservation): Promise<BodyMotionPlan>;
  resolveBehaviorBody(cueId: string, token: string): Promise<BodyMotionResource>;
  resolveBehaviorMotion(cueId: string, token: string): Promise<BehaviorMotionResource>;
  /** Batch 6: the granted bytes of one of her own life's held poses (row 33). */
  resolveHerLifeMotion(motionId: string, token: string): Promise<HerLifeMotionResource>;
  /** Her default stand (the bundled stand pose's asset) when no pose is picked; null without it. Optional: a port without it gives none. */
  getRestStand?(): Promise<AssetRef | null>;
}
/** Every method the engine may call, by name. */
export const WINDOW_STAGE_HOST_METHODS: readonly (keyof WindowStageHost)[] = Object.freeze(['isBehaviorModelSupported', 'resolveChatGesture',
  'resolveHerAction', 'reportHerAction', 'getBehaviorBodyPlan', 'resolveBehaviorBody', 'resolveBehaviorMotion', 'resolveHerLifeMotion', 'getRestStand']);

/** Picks the engine's port out of the companion window's preload: a new object with the allowed methods only, each bound. */
export function windowStageHost(desktop: WindowStageHost): WindowStageHost {
  return Object.freeze({
    isBehaviorModelSupported: () => desktop.isBehaviorModelSupported(),
    resolveChatGesture: (cueId: string, token: string) => desktop.resolveChatGesture(cueId, token),
    resolveHerAction: (cueId: string) => desktop.resolveHerAction(cueId),
    reportHerAction: (outcome: HerActionOutcome) => desktop.reportHerAction(outcome),
    getBehaviorBodyPlan: (token: string, observation?: BodyStageObservation) => desktop.getBehaviorBodyPlan(token, observation),
    resolveBehaviorBody: (cueId: string, token: string) => desktop.resolveBehaviorBody(cueId, token),
    resolveBehaviorMotion: (cueId: string, token: string) => desktop.resolveBehaviorMotion(cueId, token),
    resolveHerLifeMotion: (motionId: string, token: string) => desktop.resolveHerLifeMotion(motionId, token),
    getRestStand: async () => (await desktop.getRestStand?.()) ?? null,
  });
}
