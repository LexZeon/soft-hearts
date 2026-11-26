/**
 * Unbound, the small input box's 「打电话」 button.
 *
 * The button starts and ends the SAME call the companion window's own button does (I-091: VoiceCallHost.set, which goes through the call controller:
 * the microphone consent is the user's own voice-input switch, the same refusals and Chinese reasons). Nothing here turns the
 * microphone on by itself. The call lives in the companion window's microphone while she is out (step 3), and her replies show in her
 * Unbound bubble. Electron-free so tests drive it; electron/unbound/input-window.ts answers the request only from the box's own frame.
 */
import type { UnboundState } from '../../shared/unbound/scene';
import { SUBMIT_HINTS } from './typing';

/** What the voice-call host gives the bridge (electron/wiring/voice-wiring.ts): is a call on, and start / end one as the companion window's button. */
export interface InputCallPort {
  on(): boolean;
  /** Resolves with whether a call is on afterwards; rejects with the call's own Chinese reason when it cannot start. */
  set(on: boolean): Promise<boolean>;
}
/** The box's button is the companion window's button: the voice-call host's own `set`, as the window that holds the microphone while she is out ('pet'), via 'button'. */ // no-pet-ok: the call owner value the voice-call host uses
export interface InputCallHost {
  readonly on: boolean;
  set(owner: 'pet', on: boolean, via: 'button'): Promise<{ on: boolean }>; // no-pet-ok: the call owner value the voice-call host uses
}
export function inputCallPort(host: InputCallHost): InputCallPort {
  return { on: () => host.on, set: async on => (await host.set('pet', on, 'button')).on === true }; // no-pet-ok: the call owner value the voice-call host uses
}
export interface InputCallResult { ok: boolean; on: boolean; hint?: string }

/** The sender of an input-box request: only the box's own window, only its top frame (the same test for every request the box makes). */
export interface InputSenderFacts { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }
export interface InputWindowLike { isDestroyed(): boolean; webContents: { id: number; isDestroyed(): boolean } }
export function isInputWindowSender(event: InputSenderFacts, win: InputWindowLike | null | undefined): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && event.sender.id === win.webContents.id && event.senderFrame === event.sender.mainFrame;
}

export const CALL_HINTS = Object.freeze({ unavailable: '现在打不了电话。', failed: '电话没打成，再试一次。' });

export class InputCallBridge {
  private port: InputCallPort | null = null;
  private readonly listeners = new Set<(on: boolean) => void>();

  /** The voice wiring connects its call host once it has made it. */
  connect(port: InputCallPort | null): void { this.port = port; }
  isOn(): boolean { try { return this.port?.on() === true; } catch { return false; } }
  /** The box's button label follows this (every change of the call, from either window, a name, a timeout). */
  subscribe(listener: (on: boolean) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed(on: boolean): void { for (const listener of [...this.listeners]) { try { listener(on); } catch { /* a closing box */ } } }

  /**
   * The button was pressed: `on` is what the user wants now. Starting needs her out in Unbound (that is where the box lives); hanging
   * up is always allowed. A refusal keeps the box open with the call's own reason; the call never starts half-way.
   */
  async request(on: unknown, state: () => UnboundState): Promise<InputCallResult> {
    if (typeof on !== 'boolean') return { ok: false, on: this.isOn(), hint: CALL_HINTS.failed };
    const port = this.port;
    if (!port) return { ok: false, on: false, hint: CALL_HINTS.unavailable };
    if (on && state() !== 'unbound') return { ok: false, on: this.isOn(), hint: SUBMIT_HINTS.away };
    try {
      const now = await port.set(on);
      return { ok: now === on, on: now };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 120) : '';
      return { ok: false, on: this.isOn(), hint: message || CALL_HINTS.failed };
    }
  }
}
