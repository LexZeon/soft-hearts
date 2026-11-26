// Unbound: this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).

export interface UnboundDesktopAPI {
  /** Unbound U1 (controls only, developer mode): the 「Unbound（试验）」 switch and its knobs (electron/unbound/host.ts). */
  getUnbound?(): Promise<import('../unbound').UnboundControlView>;
  setUnbound?(patch: import('../unbound').UnboundControlPatch): Promise<import('../unbound').UnboundControlView>;
  onUnbound?(callback: (view: import('../unbound').UnboundControlView) => void): () => void;
  /** Unbound v1 step 1 (controls only, any mode): 「让她出来」 (the host shows the permission page) or 「回到小窗」. */
  toggleUnbound?(): Promise<'back' | 'cancelled' | 'entering' | 'busy' | 'unavailable'>;
  /** The settings page's switches for what is off by default in stable (shared/foundation/channel-defaults.ts): read, and set (true / false saves, null forgets). */
  getChannelGates?(): Promise<import('../foundation/channel-defaults').ChannelGatesView>;
  setChannelGates?(id: import('../foundation/channel-defaults').ChannelGateId, on: boolean | null): Promise<import('../foundation/channel-defaults').ChannelGatesView>;
  /** I-159 D (controls only): 「下次进来时再问我」 clears the saved 「以后直接进，不再问」; true when it was saved, false when the page was already coming. */
  askUnboundAgain?(): Promise<boolean>;
  /** Unbound v1 step 2 (controls only): the host hands over a line typed in her small box; the window sends it like its own chat box. */
  onUnboundSay?(callback: (line: string | { text: string; cut?: import('../brain').PauseTalkCut; line?: number; sentAt?: number }) => void): () => void;
  /** 2026-11-22 (controls only): whether that line really went out (sent, or dropped and why); a drop opens her box again with the line (electron/unbound/say-ack.ts). */
  ackUnboundSay?(ack: import('../brain').UnboundSayAck): Promise<void>;
  /** Batch A (docs/claude/2026-11-21-unbound-full-ACH.md; either window): her voice's facts for her speaking face (shared/voice/speech-face-cue.ts), relayed only to her full-screen window. */
  relaySpeechFace(cue: import('../voice').SpeechFaceCue): Promise<void>;
}
