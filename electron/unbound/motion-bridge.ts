/**
 * Batch C (docs/claude/2026-11-21-unbound-full-ACH.md): her own motions out in full-screen Unbound, exactly as the companion window's stage reads
 * them (src/unbound/window-mode/host-ports.ts names the same seven): a chat gesture's granted bytes, one of her actions' cue and its pinned VMD,
 * her answer for it, the automatic body motion's plan and its granted bytes, a behaviour face's granted bytes. No sense, no permission, no
 * setting: each is a read of something the host already cued for her (the motion library checks the files, the host its live cue), and her
 * answer is the one write.
 *
 * The rules (the host's `handle` has already checked the request came from the current Unbound window's own top frame):
 *  - a read is answered only for the window she is shown in, while it is visible;
 *  - her answer to an action is taken only from the window she is shown in (visible or not: "hidden" is an answer too), and the host counts
 *    it only while she is out (herActionAnswerCounts: out, only her full-screen window's answer; at home, only the companion window's);
 *  - one of her actions (desk:her-action) is relayed to her window (nothing else of the broadcasts);
 *  - without the ports (tests, an older wiring) the requests are refused.
 */
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../../shared/unbound/scene';

/** What the host gives (electron/wiring/actions-wiring.ts): the companion stage's own reads, and her answer. */
export interface UnboundMotionPorts {
  resolveChatGesture(cueId: unknown, token: unknown): unknown;
  resolveHerAction(cueId: unknown): unknown;
  reportHerAction(outcome: unknown): void;
  bodyPlan(token: unknown, observation: unknown): unknown;
  resolveBody(cueId: unknown, token: unknown): unknown;
  resolveBehaviorMotion(cueId: unknown, token: unknown): unknown;
}
export interface MotionBridgeWindow { isVisible(): boolean }
export interface MotionBridgeHost<W extends MotionBridgeWindow> {
  /** The current Unbound window (made, maybe still loading), or null. */
  current(): W | null;
  /** The window she is shown in now, or null. */
  shown(): W | null;
  send(win: W, channel: string, value: unknown): void;
}
type Handle<W> = (channel: string, operation: (win: W, ...args: unknown[]) => unknown) => void;

/** Whose answer to one of her actions counts: while she is out, only her full-screen window's; at home, only the companion window's. */
/** She is out and shown in full-screen Unbound (her actions play there; her window's body motion access is open only then); entering is not out yet. */
export const motionsOut = (state: string | null | undefined): boolean => state === 'unbound';
export const herActionAnswerCounts = (from: 'companion' | 'unbound', out: boolean): boolean => from === (out ? 'unbound' : 'companion');

export class UnboundMotionBridge<W extends MotionBridgeWindow> {
  /** `ports` is read when a request comes (the wiring connects it after the host was made). */
  constructor(private readonly ports: () => UnboundMotionPorts | null | undefined, private readonly host: MotionBridgeHost<W>) {}

  register(handle: Handle<W>): void {
    const read = (channel: string, operation: (ports: UnboundMotionPorts, ...args: unknown[]) => unknown) => handle(channel, (win, ...args) => {
      const ports = this.ports();
      if (!ports) throw new Error('她的动作尚未接入。');
      if (!this.reads(win)) throw new Error('只有正在显示她的 Unbound 窗口可以读她的动作。');
      return operation(ports, ...args);
    });
    read(UNBOUND_REQUESTS.resolveChatGesture, (ports, cueId, token) => ports.resolveChatGesture(cueId, token));
    read(UNBOUND_REQUESTS.resolveHerAction, (ports, cueId) => ports.resolveHerAction(cueId));
    read(UNBOUND_REQUESTS.bodyPlan, (ports, token, observation) => ports.bodyPlan(token, observation));
    read(UNBOUND_REQUESTS.resolveBody, (ports, cueId, token) => ports.resolveBody(cueId, token));
    read(UNBOUND_REQUESTS.resolveBehaviorMotion, (ports, cueId, token) => ports.resolveBehaviorMotion(cueId, token));
    handle(UNBOUND_REQUESTS.reportHerAction, (win, outcome) => {
      const ports = this.ports();
      if (!ports) throw new Error('她的动作尚未接入。');
      if (this.host.shown() !== win) return; // a window she is not shown in has no say
      ports.reportHerAction(outcome);
    });
  }

  /** Whether a read from `win` is answered now (exported for the test of each rule). */
  reads(win: W): boolean { return this.host.shown() === win && win.isVisible(); }

  /** Every broadcast the windows get: one of her actions goes to her window too (nothing else here). */
  relay(channel: string, value: unknown): void {
    if (channel !== 'desk:her-action' || !value || typeof value !== 'object') return;
    const win = this.host.current();
    if (win) this.host.send(win, UNBOUND_EVENTS.herAction, value);
  }
}
