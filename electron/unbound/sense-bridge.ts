/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): her senses out in full-screen Unbound, exactly what the
 * companion window already gets, read only. (music too).
 *
 *  - Where pose sensing says you are (the companion window's userGaze reading, electron/senses/user-gaze.ts), computed by the wiring against
 *    her Unbound window on every pose signal and relayed here; it goes on only while camera pose sensing runs (the wiring relays the
 *    sensing switch too), checked by the companion's own parser (shared/behaviors/gaze-attention/interface.ts: numbers and closed words,
 *    nothing else is copied), and only to the window she is shown in. Sensing off (the switch, "别看" turning the camera off): one null
 *    goes to that window at once and nothing more until it is on again.
 *  - The music samples of 和她一起听 (the companion window's desk:audio-dance-sample frames, energy numbers only): a frame the capture host
 *    accepted is relayed here and goes on only while that source's dance is on in the capture state (desk:audio-capture-state, every
 *    broadcast passes here), checked by the companion's own parser, only to the window she is shown in. A source's dance off: one null.
 *  - 2026-11-24: the user's music settings (two plain values) go to the window she is shown in before its first music frame and on every
 *    change, so her music out here follows the same strength and "一直跟着跳"; what her body does to the sound comes back as the fact
 *    'stage-state' (the companion window's noteStageState; the wiring hands it to the same StageStateHost, electron/mood/her-state-host.ts).
 *  - Her facts about these (a gaze moment, a song reaction, the music verdict and tier): one request, the closed kinds only, from the window
 *    she is shown in only; the ports route them where the companion window's go (the journal, her mood moments).
 * Nothing is stored here: the last reading is not kept (each one is sent and dropped), so nothing outlives the switch.
 */
import { UNBOUND_REQUESTS } from '../../shared/unbound/scene';
import { UNBOUND_SENSE_EVENTS, danceSources, isHerFactKind, type HerFactKind } from '../../shared/unbound/sense-relay';
import { normalizeMusicSettings, parseAudioDanceFrame, parseUserGazeReading } from '../../shared/senses';
import type { AudioReadingSource } from '../../shared/voice';

/** The names the wiring relays these under (never a broadcast: electron/wiring/unbound-senses-wiring.ts). */
export const SENSE_RELAY = Object.freeze({
  /** Camera pose sensing went on (true) or off (false). */
  poseSensing: 'unbound-relay:pose-sensing',
  /** A pose signal came: the reading against her window (or null when pose gives nothing fresh). */
  userGaze: 'unbound-relay:user-gaze',
  /** A music sample frame the capture host accepted. */
  dance: 'unbound-relay:dance',
} as const);
/** The broadcast that says which sources' dance is on. */
const CAPTURE_STATE = 'desk:audio-capture-state';
/** The broadcast of the user's music settings (electron/wiring/senses-music-wiring.ts), after every accepted change. */
const MUSIC_SETTINGS = 'desk:music-settings';

export interface UnboundSensePorts {
  /** One of her facts, where the companion window's of that kind goes; true when it counted. */
  fact(kind: HerFactKind, value: unknown): boolean;
  /** Camera pose sensing runs now (the senses' wiring keeps it from the switch's own events). */
  poseSensing(): boolean;
  /** 2026-11-24: the user's music settings now (MusicSettings), or null before they are loaded. */
  musicSettings?(): unknown;
}
export interface SenseBridgeHost<W> {
  /** The window she is shown in now (null while entering, leaving or at home). */
  shown(): W | null;
  send(win: W, channel: string, value: unknown): void;
}
type Handle<W> = (channel: string, operation: (win: W, ...args: unknown[]) => unknown) => void;

export class UnboundSenseBridge<W> {
  private dance: ReadonlySet<AudioReadingSource> = new Set();
  /** The window the music settings were last sent to (a window she is newly shown in gets them before its first music frame). */
  private settingsTo: W | null = null;
  constructor(private readonly ports: () => UnboundSensePorts | null | undefined, private readonly host: SenseBridgeHost<W>) {}

  register(handle: Handle<W>): void {
    handle(UNBOUND_REQUESTS.herFact, (win, kind, value) => {
      if (!this.takesFact(win, kind)) return false;
      const ports = this.ports();
      if (!ports) return false;
      try { return ports.fact(kind as HerFactKind, value) === true; } catch { return false; }
    });
  }

  /** Whether a fact of `kind` from `win` is taken (exported for the test of each rule): the closed kinds, from the window she is shown in. */
  takesFact(win: W, kind: unknown): boolean {
    return isHerFactKind(kind) && this.host.shown() === win && win !== null;
  }

  /** Every relay and broadcast the host sees (the mood bridge hands each one on). Returns true when it was one of these. */
  relay(channel: string, value: unknown): boolean {
    switch (channel) {
      case SENSE_RELAY.poseSensing: {
        if (value !== true) this.toShown(UNBOUND_SENSE_EVENTS.userGaze, null); // off: forget at once
        return true;
      }
      case SENSE_RELAY.userGaze: {
        if (!this.poseOn()) return true; // nothing of the camera goes out while pose sensing is off
        const reading = value === null ? null : parseUserGazeReading(value);
        if (value !== null && !reading) return true; // malformed: nothing
        this.toShown(UNBOUND_SENSE_EVENTS.userGaze, reading);
        return true;
      }
      case CAPTURE_STATE: {
        const was = this.dance;
        this.dance = danceSources(value);
        if (was.size > 0 && this.dance.size === 0) this.toShown(UNBOUND_SENSE_EVENTS.dance, null); // the last source's dance off: stop at once
        return false; // the companion windows get it as before
      }
      case MUSIC_SETTINGS: { // 2026-11-24: a change goes to the window she is shown in too (only the two plain values)
        const settings = normalizeMusicSettings(value), win = this.host.shown();
        if (win) { this.host.send(win, UNBOUND_SENSE_EVENTS.musicSettings, settings); this.settingsTo = win; }
        return false; // the companion windows get it as before
      }
      case SENSE_RELAY.dance: {
        const frame = parseAudioDanceFrame(value);
        if (!frame || !this.dance.has(frame.source)) return true; // only while that source's dance is on
        if (frame.sample !== null) { this.settingsFirst(); this.toShown(UNBOUND_SENSE_EVENTS.dance, frame); } // a failed analysis turns that dance off: the capture state says so next
        return true;
      }
      default: return false;
    }
  }

  /** A window she is newly shown in gets the user's music settings before its first music frame (none before they are loaded). */
  private settingsFirst(): void {
    const win = this.host.shown();
    if (!win || win === this.settingsTo) return;
    let current: unknown = null;
    try { current = this.ports()?.musicSettings?.() ?? null; } catch { current = null; }
    if (current === null || current === undefined) return;
    this.host.send(win, UNBOUND_SENSE_EVENTS.musicSettings, normalizeMusicSettings(current));
    this.settingsTo = win;
  }

  private poseOn(): boolean { try { return this.ports()?.poseSensing() === true; } catch { return false; } }

  private toShown(channel: string, value: unknown): void {
    const win = this.host.shown();
    if (win) this.host.send(win, channel, value);
  }
}
