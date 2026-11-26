/**
 * Unbound v1 step 1 (I-136, docs/claude/2026-11-15-unbound-v1-step1-entry.md): the normal ways in and out — the tray's
 * 「让她出来 / 回到小窗」, the control window's button and Ctrl+Alt+U. All three call `toggle`:
 *  - she is out (or on her way out): she comes back to the small window at once, whatever started it;
 *  - she is in the small window: the permission page (the host's own dialog, never a page the renderer could answer for the
 *    user) unless the user ticked 「以后直接进，不再问」 for this very list; cancel changes nothing; confirm enters, and once she
 *    is out the bundle turns on what was off (electron/unbound/permission-bundle.ts).
 * Whenever the mode goes back to normal (any way: this toggle, 显示/隐藏桌宠, the developer switch, her window crashing,
 * entering failing) the bundle puts back what it turned on. The developer panel's own switch enters without the bundle.
 */
import type { UnboundState } from '../../shared/unbound/scene';
import { BUNDLE_SIGNATURE, bundleDialog, type BundleDialog, type BundleFacts, type BundleOutcome, type FaceReadiness, type PermissionBundle } from './permission-bundle';

export interface UnboundEntryPorts {
  state(): UnboundState;
  enter(): void;
  exit(): void;
  /** The permission page; resolves with the user's answer (closing it is a cancel). */
  ask(dialog: BundleDialog): Promise<{ confirmed: boolean; remember: boolean }>;
  /** The saved 「以后直接进，不再问」: the bundle list it was given for, or null. */
  skipAsk(): string | null;
  setSkipAsk(signature: string | null): Promise<void>;
  bundle: PermissionBundle;
  read(): BundleFacts | null;
  face(): FaceReadiness;
  translate?(text: string, params?: Record<string, string>): string;
  /** After the bundle turned on: what did not open (shown to the user, never silently). */
  outcome?(outcome: BundleOutcome): void;
  /** An entry confirmed here ended before she was out (the reason is in the host's view). */
  failed?(): void;
  log?(line: string): void;
  /** The way in is on (shared/foundation/channel-defaults.ts: on in every channel since 2026-11-25; the user may switch it off). Coming back is never held. */
  allowed?(): boolean;
}

export type ToggleResult = 'back' | 'cancelled' | 'entering' | 'busy' | 'unavailable';

export class UnboundEntry {
  private asking = false;
  /** This entry was confirmed on the page (or by the saved choice): turn the bundle on once she is out. */
  private wanted = false;
  constructor(private readonly ports: UnboundEntryPorts) {}

  get askingNow(): boolean { return this.asking; }

  async toggle(): Promise<ToggleResult> {
    if (this.ports.state() !== 'normal') { this.wanted = false; this.ports.exit(); return 'back'; }
    if (this.ports.allowed && !this.ports.allowed()) return 'unavailable';
    if (this.asking) return 'busy';
    if (this.ports.skipAsk() !== BUNDLE_SIGNATURE) {
      this.asking = true;
      let answer: { confirmed: boolean; remember: boolean };
      try {
        let facts: BundleFacts | null = null, face: FaceReadiness = { supported: false, installed: false, enrolled: 0 };
        try { facts = this.ports.read(); } catch { facts = null; }
        try { face = this.ports.face(); } catch { /* not offered */ }
        answer = await this.ports.ask(bundleDialog(facts, face, this.ports.translate));
      } catch (error) {
        this.ports.log?.(`unbound entry: the page failed (${error instanceof Error ? error.message : 'unknown'})`);
        answer = { confirmed: false, remember: false };
      } finally { this.asking = false; }
      if (!answer.confirmed) return 'cancelled';
      if (answer.remember) await this.ports.setSkipAsk(BUNDLE_SIGNATURE).catch(() => undefined);
    }
    if (this.ports.state() !== 'normal') return 'busy'; // something else took her out while the page was open
    this.wanted = true;
    this.ports.enter();
    // Entering can end at once (an error): the mode is normal again and nothing is turned on.
    if (this.ports.state() === 'normal') this.wanted = false;
    return 'entering';
  }

  /** UnboundHost's every state change. */
  modeChanged(state: UnboundState): void {
    if (state === 'unbound' && this.wanted) {
      this.wanted = false;
      void this.ports.bundle.apply().then(outcome => { try { this.ports.outcome?.(outcome); } catch { /* a notice only */ } },
        error => this.ports.log?.(`unbound bundle: ${error instanceof Error ? error.message : 'unknown'}`));
    } else if (state === 'normal') {
      const failed = this.wanted;
      this.wanted = false;
      if (failed) { try { this.ports.failed?.(); } catch { /* a notice only */ } }
      void this.ports.bundle.restore('exit').catch(error => this.ports.log?.(`unbound bundle: ${error instanceof Error ? error.message : 'unknown'}`));
    }
  }

  /** The app is quitting (she may be out): what outlives a restart goes back now. */
  quit(): Promise<void> { this.wanted = false; return this.ports.bundle.restore('quit').catch(() => undefined); }
}

/**
 * The tray's Unbound item (and nothing else decides it): she is out: 「回到小窗」, always; she is in the small window: 「让她出来」 only while the
 * way in is on (shared/foundation/channel-defaults.ts: on in every channel since 2026-11-25; the user may switch it off), else no item at all.
 */
export function entryMenuItem(state: UnboundState | undefined, allowed: boolean): 'back' | 'enter' | null {
  if (state && state !== 'normal') return 'back';
  return allowed ? 'enter' : null;
}
