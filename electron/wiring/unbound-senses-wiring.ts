/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): what the senses' wiring hands her full-screen window, read
 * only, through the Unbound host's sense bridge (electron/unbound/sense-bridge.ts decides what goes on and to which window):
 *  - camera pose sensing on or off (a "别看" counts as off here), and on every pose signal where pose says you are, measured against her Unbound window (the companion
 *    window's userGaze reading; memory only, nothing is kept here);
 *  - a music sample frame of 和她一起听 the capture host accepted;
 *  - while she is out, the companion window's facts of her full-screen kinds are not taken (companionFact), so each line is written once.
 * Each is read when called; no module-level side effects.
 */
import { screen } from 'electron';
import { SENSE_RELAY } from '../unbound';
import { companionFactAllowed } from '../../shared/unbound';
import { senseFeeds, unbound, unboundStage } from './unbound-wiring';

type Rect = { x: number; y: number; width: number; height: number };

/** She is out in full-screen Unbound (the companion window is held hidden). */
const out = (): boolean => unbound?.state === 'unbound';

/** Pose sensing went on or off (electron/senses/pose/electron-wiring.ts onSensing): kept for the sense bridge's gate; off forgets the reading on her page at once. */
export function relayPoseSensing(on: boolean): void { senseFeeds.poseOn = on === true; unbound?.mood(SENSE_RELAY.poseSensing, senseFeeds.poseOn && !senseFeeds.held); }
/** A "别看" holds the camera (media-runtime.ts cameraHeld) or lets go: while it holds, nothing of the pose reading goes to her full-screen page either. */
export function relayCameraHeld(held: boolean): void {
  if (senseFeeds.held === (held === true)) return;
  senseFeeds.held = held === true;
  unbound?.mood(SENSE_RELAY.poseSensing, senseFeeds.poseOn && !senseFeeds.held);
}

/** A pose signal came: `read` is UserGazeHost.read (null while pose gives nothing fresh), against her Unbound window; only while she is out. */
export function relayUserGaze(read: (window: Rect, display: Rect) => unknown): void {
  if (!out() || !unbound) return;
  const rect = unbound.windowRect();
  if (!rect) return;
  unbound.mood(SENSE_RELAY.userGaze, read(rect, screen.getDisplayMatching(rect).bounds));
}

/** A music sample frame the capture host accepted (only while she is out; the bridge checks the source's dance is on). */
export function relayDance(frame: unknown): void { if (out()) { unbound?.mood(SENSE_RELAY.dance, frame); relayStageMusic(SENSE_RELAY.dance, frame); } }

/**
 * I-209 step 4 (perceive once, each reacts her own way): the song is detected once; its frames, which sources dance and the user's music
 * settings go to every other character on stage too, whose own page decides whether she dances, nods or stays still. Nothing else is
 * passed on (not her mood view, not where pose says you are: that is measured against one window).
 */
export function relayStageMusic(channel: string, value: unknown): void {
  if (out() && (channel === SENSE_RELAY.dance || channel === 'desk:audio-capture-state' || channel === 'desk:music-settings')) unboundStage()?.relayAll(channel, value);
}

/** A fact of `kind` told by the companion window (`fromCompanion`) is taken now: not while she is out for her full-screen kinds (her page tells those). */
export function companionFact(kind: unknown, fromCompanion: boolean): boolean { return fromCompanion && companionFactAllowed(kind, out()); }
