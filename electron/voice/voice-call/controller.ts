/**
 * I-091 step 1: the host's call state. A call is a mode on top of
 * voice input: it turns voice input on for its window when needed (the user's own start: the button, her chat card, or the
 * user's own Claude after the dialog), keeps her Claude process warm, and ends at once when voice input goes off, she falls
 * asleep, the window leaves the screen, or nobody spoke for a long time. Ending is always direct and never needs consent.
 * Electron-free: electron/main.ts wires the ports; tests pass fakes.
 */
import { VOICE_CALL_KNOBS } from '../../../shared/behaviors/voice-call/knobs';
import { VOICE_CALL_OFF, type CallFillerStatus, type VoiceCallEndReason, type VoiceCallOwner, type VoiceCallVia, type VoiceCallView } from '../../../shared/voice/voice-call';

export interface VoiceCallTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface VoiceCallPorts {
  now(): number;
  timers?: VoiceCallTimers;
  /** Voice input now: on, and which window owns it. */
  voiceInput(): { on: boolean; owner: VoiceCallOwner | null };
  /** Turns voice input on for this window (the same host path as its own switch); resolves whether it is on for it now. */
  turnOnVoice(owner: VoiceCallOwner): Promise<boolean> | boolean;
  /** Turns voice input off (only when the call turned it on). */
  turnOffVoice(owner: VoiceCallOwner): void;
  /** The window is on screen (visible, not minimised; her companion window hidden only because she is out in Unbound counts). */
  windowShown(owner: VoiceCallOwner): boolean;
  /** Unbound v1 step 3: she is out in Unbound (her companion window hidden because of it). Absent: never. */
  out?(): boolean;
  /** Unbound v1 step 3: with no call on, the window listening for her name (null: none). Absent: never. */
  wake?(): VoiceCallOwner | null;
  /** She is asleep or falling asleep. */
  asleep(): boolean;
  /** The filler clips for the current voice (null while unknown). */
  fillers(): CallFillerStatus | null;
  /** Keep her Claude process from idling out while the call is on, and start one now if none is ready. */
  keepWarm(on: boolean): void;
  publish(view: VoiceCallView): void;
  /** Numbers and closed categories only (shared/memory/journal.ts 'voice-call'). */
  journal?(entry: { event: 'start'; via: VoiceCallVia } | { event: 'end'; reason: VoiceCallEndReason; seconds: number; turns: number; bargeIns: number }): void;
}

/** How often the call re-checks the ways it ends (voice input, sleep, the window, the long silence). */
export const VOICE_CALL_TICK_MS = 1000;

export class VoiceCallController {
  private state: { owner: VoiceCallOwner; since: number; heardAt: number; turnedOn: boolean; turns: number; bargeIns: number } | null = null;
  private ended: VoiceCallEndReason | null = null;
  private tick: unknown = null;
  private starting: Promise<VoiceCallView> | null = null;
  /** The `out` the windows were last told (a change is published at the next check). */
  private toldOut = false;
  /** The listening-for-her-name window the windows were last told (a change is published at the next check). */
  private toldWake: VoiceCallOwner | null = null;
  private readonly timers: VoiceCallTimers;
  constructor(private readonly ports: VoiceCallPorts, private readonly autoHangUpMs = VOICE_CALL_KNOBS.autoHangUpMs) {
    this.timers = ports.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; }, clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  get on(): boolean { return this.state !== null; }
  get owner(): VoiceCallOwner | null { return this.state?.owner ?? null; }

  view(): VoiceCallView {
    const state = this.state;
    if (!state) { const wake = this.wakeOwner(); return { ...VOICE_CALL_OFF, ended: this.ended, ...(wake ? { wake } : {}) }; }
    let fillers: CallFillerStatus | null = null;
    try { fillers = this.ports.fillers(); } catch { fillers = null; }
    return { on: true, owner: state.owner, since: state.since, ended: null, fillers, ...(this.isOut() ? { out: true as const } : {}) };
  }

  private isOut(): boolean { try { return this.ports.out?.() === true; } catch { return false; } }
  private wakeOwner(): VoiceCallOwner | null { try { const owner = this.ports.wake?.() ?? null; return owner === 'pet' || owner === 'controls' ? owner : null; } catch { return null; } }

  /**
   * Starts a call in this window. The caller already has the user's consent (their own button or chat card, or the dialog
   * for the user's own Claude). Throws a Chinese reason when it cannot start; never starts half-way.
   */
  start(owner: VoiceCallOwner, via: VoiceCallVia): Promise<VoiceCallView> {
    if (owner !== 'pet' && owner !== 'controls') return Promise.reject(Error('通话窗口不正确。'));
    if (via === 'name' && this.wakeOwner() !== owner) return Promise.reject(Error('没有在听她的名字。')); // Unbound v1 step 3: only the listening window, only while it listens
    if (this.state) return Promise.resolve(this.view()); // already on (in whichever window owns the microphone)
    if (this.starting) return this.starting;
    const run = (async () => {
      if (!this.ports.windowShown(owner)) throw Error('请先让这个窗口显示出来，再打电话。');
      if (this.ports.asleep()) throw Error('她睡着了，先别打电话吧。');
      // Voice input already on (hold T): the call uses that same microphone and window, and hanging up leaves it on as it was.
      const before = this.ports.voiceInput(), already = before.on && before.owner !== null;
      if (!already && !await this.ports.turnOnVoice(owner)) throw Error('麦克风没有打开，通话没有开始：可能还没有本机语音识别，设置里会有说明。');
      const voice = this.ports.voiceInput();
      if (!voice.on || !voice.owner) throw Error('麦克风没有打开，通话没有开始。');
      const now = this.ports.now();
      this.state = { owner: voice.owner, since: now, heardAt: now, turnedOn: !already, turns: 0, bargeIns: 0 };
      this.ended = null;
      try { this.ports.keepWarm(true); } catch { /* a cold first reply is slower, not wrong */ }
      this.schedule();
      try { this.ports.journal?.({ event: 'start', via }); } catch { /* record only */ }
      this.publish();
      return this.view();
    })();
    this.starting = run;
    return run.finally(() => { if (this.starting === run) this.starting = null; });
  }

  /** Ends the call now (always allowed). The microphone goes back to how it was before the call. */
  stop(reason: VoiceCallEndReason): VoiceCallView {
    const state = this.state;
    if (!state) return this.view();
    this.state = null; this.ended = reason;
    if (this.tick !== null) { this.timers.clear(this.tick); this.tick = null; }
    try { this.ports.keepWarm(false); } catch { /* idle closes it later as before */ }
    // The call opened the microphone: hanging up closes it. Voice input that was on before (hold T) stays as it was.
    if (state.turnedOn) {
      try { const voice = this.ports.voiceInput(); if (voice.on && voice.owner === state.owner) this.ports.turnOffVoice(state.owner); } catch { /* the window shows its own state */ }
    }
    try {
      this.ports.journal?.({ event: 'end', reason, seconds: Math.max(0, Math.round((this.ports.now() - state.since) / 1000)), turns: state.turns, bargeIns: state.bargeIns });
    } catch { /* record only */ }
    this.publish();
    return this.view();
  }

  /** The user spoke (a verified speech start in the call's window): the long-silence clock restarts. */
  heard(): void { if (this.state) this.state.heardAt = this.ports.now(); }
  /** One user turn in this call (an utterance handed over). */
  turn(): void { if (this.state) { this.state.turns++; this.state.heardAt = this.ports.now(); } }
  /** The user talked over her reading. */
  bargeIn(): void { if (this.state) { this.state.bargeIns++; this.state.heardAt = this.ports.now(); } }
  /** Her reply started sounding: she is talking, so the silence is not long yet. */
  spoke(): void { if (this.state) this.state.heardAt = this.ports.now(); }

  /** Re-checks every way the call ends (also run by the tick); returns the reason it ended, if it did. */
  check(): VoiceCallEndReason | null {
    const state = this.state;
    if (!state) { if (this.wakeOwner() !== this.toldWake) this.publish(); return null; } // Unbound v1 step 3: listening for her name began or ended
    let reason: VoiceCallEndReason | null = null;
    try {
      const voice = this.ports.voiceInput();
      if (!voice.on || voice.owner !== state.owner) reason = 'voice-off';
      else if (!this.ports.windowShown(state.owner)) reason = 'hidden';
      else if (this.ports.asleep()) reason = 'asleep';
      else if (this.ports.now() - state.heardAt >= this.autoHangUpMs) reason = 'silence';
    } catch { reason = 'voice-off'; }
    if (reason) this.stop(reason);
    else if (this.isOut() !== this.toldOut) this.publish(); // she went out or came back: the call's window learns where her reply shows
    return reason;
  }

  /** The filler status changed (voice or cache): tell the windows. */
  refresh(): void { if (this.state) this.publish(); }

  dispose(): void { this.stop('quit'); }

  private schedule(): void {
    if (this.tick !== null) this.timers.clear(this.tick);
    this.tick = this.timers.set(() => { this.tick = null; if (!this.state) return; if (!this.check()) this.schedule(); }, VOICE_CALL_TICK_MS);
  }
  private publish(): void { const view = this.view(); this.toldOut = view.out === true; this.toldWake = view.wake ?? null; try { this.ports.publish(view); } catch { /* a closed window */ } }
}
