/**
 * I-209 step 3: the ports of one more character's own full-screen Unbound (the same UnboundHost class the first one is). What is hers:
 * her model, her mood, her peek and close moments (read with her mood), her life (her journal rows), her places (her records in the shared
 * books), a click on her (the box opens beside her and your words go to her). What is the stage's, shared with the first one: the screen
 * and its measurement, the full-screen watcher (one for everyone), the readings her life looks at (taken once for everyone), the bubble's
 * linger. What she never has: the companion window (she was never in it: nothing is hidden or restored for her), the control window's view,
 * her games (the game hosts are the desktop companion's), the touch brain's pull report (the touch brain is the desktop companion's).
 */
import type { UnboundState } from '../../../shared/unbound/scene';
import type { UnboundTouchReport } from '../../../shared/unbound/typing';
import type { FullscreenProbe } from '../fullscreen-watch';
import type { UnboundHostPorts, UnboundWindowLike } from '../host-ports';
import type { CloseMomentsLink } from '../close-moments';
import type { LifePorts } from '../life';
import type { UnboundMoodPorts } from '../mood-bridge';
import type { PeekArbiter, PeekPorts } from '../peek';
import type { PlaceFilePort } from '../place-keeper';
import type { FanoutPort } from './ipc-fanout';

export interface InstanceLinks {
  /** The first one's ports: the screen, its measurement, the developer switch, the stand pose, the bubble's linger. */
  base: UnboundHostPorts;
  /** Makes a window without telling anyone (the stage keeps its own book of whose window it is). */
  openWindow: UnboundHostPorts['openWindow'];
  id: string;
  model: { url: string; reviewed: boolean };
  port: FanoutPort;
  /** Her window was made (the stage sends her views there and raises it in depth order). */
  opened(win: UnboundWindowLike): void;
  /** Her own mode changed (she came out, or she is gone). */
  changed(state: UnboundState): void;
  /** You clicked her. */
  touch(report: UnboundTouchReport): void;
  fullscreen?: FullscreenProbe;
  mood?: UnboundMoodPorts;
  peek?: PeekPorts;
  life?: LifePorts;
  places: { last?: PlaceFilePort; fixed?: PlaceFilePort & { clear(): void } };
  /** I-209 step 4: her pull's report, for her own mood (never the desktop companion's touch brain). */
  pull?(report: Record<string, unknown>): void;
}

/** The window made for a host goes to its own ipc port (its requests are its own) for as long as it lives. */
export function ownedWindow(open: UnboundHostPorts['openWindow'], port: FanoutPort, opened: (win: UnboundWindowLike) => void): UnboundHostPorts['openWindow'] {
  return bounds => {
    const made = open(bounds), id = made.window.webContents.id;
    port.own(id);
    made.window.onGone(() => port.disown(id));
    opened(made.window);
    return made;
  };
}

export function instancePorts(links: InstanceLinks): UnboundHostPorts {
  const base = links.base, breath = () => { try { return base.source().breath; } catch { return 0.5; } };
  return {
    ipcMain: links.port.ipcMain,
    // no-pet-ok: the host ports' existing names; she was never in the companion window
    pet: () => null, petWanted: () => false, developerMode: () => base.developerMode(),
    source: () => ({ modelUrl: links.model.url, motion: { pose: null, gesture: null, expression: null, legacy: false }, breath: breath(), physics: null }),
    reviewed: async () => links.model.reviewed, ...(base.restPose ? { restPose: base.restPose } : {}),
    display: () => base.display(), measure: () => base.measure(), ...(base.preview ? { preview: base.preview } : {}),
    openWindow: ownedWindow(links.openWindow, links.port, links.opened),
    ...(links.fullscreen ? { fullscreen: links.fullscreen } : {}), ...(links.peek ? { peek: links.peek } : {}), ...(links.life ? { life: links.life } : {}),
    ...(links.mood ? { mood: links.mood } : {}),
    ...(links.places.last ? { savedPlace: links.places.last } : {}), ...(links.places.fixed ? { defaultPlace: links.places.fixed } : {}),
    company: { cards: () => [], current: () => links.id, model: async () => null }, // her keeper's records are hers; she manages nobody else
    touch: report => links.touch(report), ...(links.pull ? { pull: links.pull } : {}),
    ...(base.lingerMs ? { lingerMs: base.lingerMs } : {}), ...(base.headTimeoutMs ? { headTimeoutMs: base.headTimeoutMs } : {}),
    restored: () => {}, publish: () => {}, modeChanged: state => links.changed(state),
    ...(base.readyFirstMs ? { readyFirstMs: base.readyFirstMs } : {}), ...(base.readyTimeoutMs ? { readyTimeoutMs: base.readyTimeoutMs } : {}),
    ...(base.readyCapMs ? { readyCapMs: base.readyCapMs } : {}), ...(base.measureTimeoutMs ? { measureTimeoutMs: base.measureTimeoutMs } : {}),
  };
}

/**
 * One close moment on stage at a time (plan: "亲亲、抱抱谁都能做，一次只有一个"): while someone else's peek, kiss or hug plays (`busy`), her
 * own does not start (her reply's ⟦kiss⟧ / ⟦hug⟧ is 'busy': the lighter word where she stands, journaled and told as always), and no plan
 * is made for one. Everything else passes through unchanged.
 */
export function oneCloseAtATime(close: CloseMomentsLink, busy: () => boolean): CloseMomentsLink {
  return {
    own: base => (busy() ? null : close.own(base)),
    pulled: (base, heldMs) => close.pulled(base, heldMs),
    ...(close.chat ? { chat: (base, kind, active) => (busy() ? 'busy' : close.chat!(base, kind, active)) } : {}),
    plan: (kind, via) => (busy() ? null : close.plan(kind, via)),
    happened: (kind, via, after, arms) => close.happened(kind, via, after, arms),
    ...(close.started ? { started: (kind, via) => close.started!(kind, via) } : {}), // 2026-11-25: her hand reach lets go as she walks up
  };
}

/** Her own peek waits while someone else's close moment plays (the arbiter's `block`, read once a second). */
export function closeBlocked(arbiter: PeekArbiter | null, busy: () => boolean): PeekArbiter {
  return {
    claim: () => (arbiter ? arbiter.claim() : true),
    block: () => (busy() ? '另一位正在凑近你' : arbiter ? arbiter.block() : null),
    pace: knob => (arbiter ? arbiter.pace(knob) : null),
  };
}
