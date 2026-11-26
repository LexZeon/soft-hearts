/**
 * I-091 像打语音电话一样和她聊天: the call in a window. The small 打电话 / 挂断 button beside voice input, the
 * tiny "在听" mark, the call mode of the microphone (MediaInput.setCall), talking over her (barge-in), her short sound before the
 * reply (CallFillerScheduler + CallFillerPlayer) and one timing line per turn. src/main.ts only wires its hooks.
 */
import { VOICE_CALL_KNOBS } from '../../../shared/behaviors/voice-call/knobs';
import { CALL_FILLER_TEXT, VOICE_CALL_TEXT, callFillerPaidNotice, callReadsOut, type CallFillerId, type VoiceCallView } from '../../../shared/voice/voice-call';
import type { AppSettings } from '../../../shared/foundation/settings';
import type { CallInputEvent } from '../../senses';
import type { SharedAudioOutput } from '../audio-output';
import { decodeCue } from '../../initiative';
import { fallbackUtteranceLang, pickSystemVoice } from '../voice-language';
import { uiText } from '../../foundation/ui-language';
import { CallFillerScheduler, type CallFillerPlayer } from './filler-scheduler';
import { CallTurnClock } from './turn-clock';
import { FillerMouthSignal } from './filler-mouth';
import { CallMicAdvisor, localCallDeviceStorage, readPageDevices, type CallBarPorts } from './call-mic'; // I-177: the call's ears
import { CallDeviceBar } from './call-devices-card';
import { CallDuck, callKnobsFor } from './call-duck'; // I-177 batch 2: 先侧耳听，再判断

interface CallApi {
  getVoiceCall(): Promise<VoiceCallView>;
  setVoiceCall(on: boolean): Promise<VoiceCallView>;
  onVoiceCall(callback: (view: VoiceCallView) => void): () => void;
  voiceCallFiller(last: CallFillerId | null): Promise<{ id: CallFillerId; delayMs: number; voiceKey?: string } | null>;
  voiceCallFillerClips(): Promise<{ voiceKey: string; provider: string; clips: Partial<Record<CallFillerId, string>> } | null>;
  prepareVoiceCallFillers(voiceKey: string): Promise<{ generated: number; failed: number }>;
  noteJournalFact(kind: string, value: unknown): Promise<unknown>;
}
export interface CallControlsOptions {
  windowKind: 'pet' | 'controls';
  api: CallApi;
  audio: SharedAudioOutput;
  voice(): AppSettings['voice'];
  media(): { setCall(knobs: typeof VOICE_CALL_KNOBS | null): void; setEchoGuard(on: boolean): void } | null;
  /** Her reply is loading or sounding in this window. */
  replyBusy(): boolean;
  /** 2026-11-20: one of her short sounds sounds (its mouth scale) or stopped (null): every stage that shows her moves her mouth with it (voice-wiring.ts fillerMouth). */
  mouth?(shape: number | null): void;
  notify(message: string, error?: boolean): void;
  /** I-177 seam: Claude's judgement of a NEW device set (stripped names only; one ask per set). Absent: the keyword verdict alone. */
  askDevices?(devices: { inputs: string[]; outputs: string[] }): Promise<unknown>;
}

/** The short sounds in her current voice: cached clips (a paid voice) or the free system voice saying the fixed text. */
class FillerPlayer implements CallFillerPlayer {
  clips = new Map<CallFillerId, Float32Array>();
  provider = 'system';
  private current: { stop(): void } | null = null;
  constructor(private readonly audio: SharedAudioOutput, private readonly voice: () => AppSettings['voice']) {}
  async play(id: CallFillerId): Promise<{ ended: Promise<void>; began?: Promise<void> } | null> {
    this.stop();
    const voice = this.voice();
    if (!voice.enabled) return null;
    if (this.provider === 'system') return this.say(id, voice);
    const samples = this.clips.get(id);
    if (!samples) return null;
    const lease = await this.audio.acquire().catch(() => null);
    if (!lease) return null;
    const context = lease.context;
    let source: AudioBufferSourceNode, gain: GainNode;
    try {
      const buffer = context.createBuffer(1, samples.length, 24000); buffer.getChannelData(0).set(samples);
      gain = context.createGain(); gain.gain.value = Math.max(0, Math.min(1, voice.volume)); gain.connect(context.destination);
      source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
    } catch { lease.release(); return null; }
    let finish!: () => void, done = false;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const end = () => { if (done) return; done = true; try { source.disconnect(); gain.disconnect(); } catch { /* detached */ } lease.release(); finish(); if (this.current === handle) this.current = null; };
    const handle = { stop: () => {
      // A 30 ms fade, never a click; the real reply's first sound comes after it.
      try { const at = context.currentTime; gain.gain.setValueAtTime(gain.gain.value, at); gain.gain.linearRampToValueAtTime(0, at + 0.03); source.stop(at + 0.035); } catch { end(); }
    } };
    source.onended = end;
    source.start(context.currentTime + 0.005);
    this.current = handle;
    setTimeout(end, Math.ceil(samples.length / 24) + 500);
    return { ended };
  }
  /** System voice: the reply's own start stops the engine (src/voice/speech.ts), cutting this sound; stop() here never cancels the engine, so it can never cut her reply. */
  private say(id: CallFillerId, voice: AppSettings['voice']): Promise<{ ended: Promise<void>; began?: Promise<void> } | null> {
    try {
      const utterance = new SpeechSynthesisUtterance(CALL_FILLER_TEXT[id]);
      utterance.voice = pickSystemVoice(speechSynthesis.getVoices(), voice.voiceURI);
      utterance.lang = utterance.voice?.lang ?? fallbackUtteranceLang();
      utterance.rate = voice.rate; utterance.volume = voice.volume;
      let finish!: () => void, begin!: () => void;
      const ended = new Promise<void>(resolve => { finish = resolve; });
      const began = new Promise<void>(resolve => { begin = resolve; }); // the engine's own start: the mouth moves when the sound does, never earlier
      utterance.onstart = () => begin();
      utterance.onend = () => finish(); utterance.onerror = () => finish();
      setTimeout(() => finish(), 3000);
      speechSynthesis.speak(utterance);
      this.current = { stop: () => finish() };
      return Promise.resolve({ ended, began });
    } catch { return Promise.resolve(null); }
  }
  stop(): void { const current = this.current; this.current = null; current?.stop(); }
}

export class CallControls {
  private view: VoiceCallView = { on: false, owner: null, since: null, ended: null, fillers: null };
  private readonly player: FillerPlayer;
  private readonly scheduler: CallFillerScheduler;
  private readonly fillerMouth: FillerMouthSignal;
  private readonly clock: CallTurnClock;
  private clipsKey = '';
  private noticed = new Set<string>();
  private readingNoticeShown = false;
  private button: HTMLButtonElement | null = null;
  private mark: HTMLElement | null = null;
  private dot: HTMLElement | null = null;
  private busy = false;
  private bar: CallBarPorts | null = null;
  /** I-177: the devices the call sees (priority list, hint, suggestion card). Present after init(). */
  advisor: CallMicAdvisor | null = null;
  /** I-177 batch 2: what this call plays on (null until the names were read): headphones lower the talking-over-her gate. */
  private output: 'headphones' | 'speakers' | 'unknown' | null = null;
  /** I-177 batch 2: her voice quieter while the user starts talking over her, until the clip is judged (never a stop by itself). */
  readonly duck: CallDuck;

  constructor(private readonly options: CallControlsOptions) {
    this.player = new FillerPlayer(options.audio, options.voice);
    this.fillerMouth = new FillerMouthSignal(shape => options.mouth?.(shape));
    this.scheduler = new CallFillerScheduler({
      choose: last => this.pick(last),
      player: { play: id => { this.options.media()?.setEchoGuard(true); return this.player.play(id).then(started => {
        if (!started) { this.options.media()?.setEchoGuard(false); return null; }
        void started.ended.finally(() => this.options.media()?.setEchoGuard(false));
        this.fillerMouth.attach(id, started); // 2026-11-20: her mouth moves for exactly as long as the sound
        return started;
      }); }, stop: () => { this.player.stop(); this.fillerMouth.release(); this.options.media()?.setEchoGuard(false); } },
      replyBusy: () => this.options.replyBusy(),
      timers: { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      started: () => this.clock.filler(),
    });
    this.clock = new CallTurnClock(() => performance.now(), timing => { void options.api.noteJournalFact('voice-call-turn', timing).catch(() => {}); });
    this.duck = new CallDuck({ level: (target, ms) => options.audio.duck(target, ms), now: () => performance.now(),
      // A cloud voice only (her call's paid voice, through the shared output): the system voice cannot change volume mid-sentence.
      canDuck: () => { const voice = options.voice(); return this.inCall && this.view.fillers?.paid === true && voice.enabled && voice.volume > 0; },
      timers: { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
  }

  /** Builds the button and the marks (in `slot`), reads the current call and follows it. */
  async init(slot: HTMLElement | null): Promise<void> {
    if (slot) {
      const button = this.button = document.createElement('button');
      button.type = 'button'; button.className = 'voice-call-button'; button.title = uiText(VOICE_CALL_TEXT.title);
      button.onclick = () => void this.toggle();
      const mark = this.mark = document.createElement('small');
      mark.className = 'voice-call-mark'; mark.setAttribute('role', 'status'); mark.hidden = true;
      slot.append(button, mark);
    }
    if (this.options.windowKind === 'pet') {
      const dot = this.dot = document.createElement('output');
      dot.className = 'voice-call-dot'; dot.hidden = true; dot.title = uiText(VOICE_CALL_TEXT.listening); dot.setAttribute('aria-label', uiText(VOICE_CALL_TEXT.listening));
      document.body.append(dot);
    }
    const bar: CallBarPorts = this.bar = slot ? new CallDeviceBar(slot) : { line() {}, card() {}, clear() {} };
    this.advisor = new CallMicAdvisor({ read: readPageDevices, storage: localCallDeviceStorage(), now: () => Date.now(), bar, ask: this.options.askDevices,
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)), said: text => this.options.notify(uiText(text)) });
    try { navigator.mediaDevices?.addEventListener('devicechange', () => { void this.advisor?.devicesChanged().then(reading => { if (reading && this.inCall) { this.output = reading.output; this.options.media()?.setCall(callKnobsFor(this.output)); } }); this.options.audio.sinkChanged(); }); } catch { /* no device events */ } // I-177 batch 2: an unplugged output → back to the default
    this.options.api.onVoiceCall(view => this.apply(view));
    try { this.apply(await this.options.api.getVoiceCall()); } catch { this.render(); }
  }

  /**
   * For every microphone open in this window (MicrophoneInput.micChoice): the user's priority list applies app-wide (plan v2): calls, push-to-talk, listening together. An empty list or no entry plugged in: the system default.
   */
  async micChoice(): Promise<{ deviceId: string | null; labelsKnown: boolean }> {
    return this.advisor ? this.advisor.choice() : { deviceId: null, labelsKnown: true };
  }
  get inCall(): boolean { return this.view.on && this.view.owner === this.options.windowKind; }
  /** Unbound v1 step 3: this is the call's window and she is out, so it reads her call replies although its page is hidden. */
  get readsOut(): boolean { return callReadsOut(this.view, this.options.windowKind); }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try { this.apply(await this.options.api.setVoiceCall(!this.view.on)); }
    catch (error) { this.options.notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : uiText('通话没有开始。'), true); }
    finally { this.busy = false; this.render(); }
  }

  private apply(view: VoiceCallView): void {
    const was = this.inCall;
    this.view = view;
    const now = this.inCall;
    // Unbound v1 step 3: listening for her name (no call yet) listens as in a call; the host lets only words with her name through.
    if (!now) this.output = null;
    this.options.media()?.setCall(now ? callKnobsFor(this.output) : !view.on && view.wake === this.options.windowKind ? VOICE_CALL_KNOBS : null);
    if (!was && now) void this.advisor?.callStarted().then(reading => { // the hint, the note, at most one question; never blocks the call
      if (!reading || !this.inCall) return;
      this.output = reading.output; this.options.media()?.setCall(callKnobsFor(this.output)); // batch 2: headphones (no echo) lower the gate
    });
    if (was && !now) {
      this.bar?.clear(); this.duck.reset();
      this.scheduler.reset(); this.clock.flush(); this.player.clips.clear(); this.clipsKey = '';
      if (view.ended && view.ended !== 'user') this.options.notify(uiText(VOICE_CALL_TEXT.ended[view.ended]));
    }
    if (now) void this.prepareVoice();
    this.render();
  }

  /** Her voice for this call: the free system voice needs nothing; a paid one says what it costs before anything is made. */
  private async prepareVoice(): Promise<void> {
    const fillers = this.view.fillers;
    if (!fillers) return;
    if (fillers.paid && !this.readingNoticeShown) {
      this.readingNoticeShown = true;
      if (fillers.ready) this.options.notify(uiText(`通话中她每句回复照常用${fillers.provider === 'fish' ? 'Drama 3' : '百炼'}朗读，会计费；系统声音免费。`));
    }
    if (fillers.paid && !fillers.ready) {
      if (this.noticed.has(fillers.voiceKey)) return;
      this.noticed.add(fillers.voiceKey);
      this.options.notify(uiText(callFillerPaidNotice(fillers.provider, fillers.missing))); // shown first; only then anything is made
      try { await this.options.api.prepareVoiceCallFillers(fillers.voiceKey); } catch { /* she simply makes no sound */ }
      return; // the host publishes the new status; apply() comes back here with ready
    }
    if (this.clipsKey === fillers.voiceKey) return;
    this.clipsKey = fillers.voiceKey;
    if (!fillers.paid) { this.player.provider = 'system'; this.player.clips.clear(); return; }
    try {
      const clips = await this.options.api.voiceCallFillerClips();
      if (!clips || clips.voiceKey !== fillers.voiceKey) { this.clipsKey = ''; return; }
      this.player.provider = clips.provider; this.player.clips.clear();
      for (const [id, pcm] of Object.entries(clips.clips)) { const samples = pcm ? decodeCue({ pcm }) : null; if (samples) this.player.clips.set(id as CallFillerId, samples); }
    } catch { this.clipsKey = ''; }
  }

  private async pick(last: CallFillerId | null): Promise<{ id: CallFillerId; delayMs: number } | null> {
    if (!this.inCall) return null;
    const pick = await this.options.api.voiceCallFiller(last);
    if (!pick) return null;
    if (pick.voiceKey && pick.voiceKey !== this.clipsKey) { void this.options.api.getVoiceCall().then(view => this.apply(view), () => {}); return null; } // the voice changed: next time
    return pick;
  }

  // Hooks from src/main.ts.
  /** MediaInput's call events. */
  heard(event: CallInputEvent): void {
    if (!this.inCall) return;
    if (event.type === 'voiced') { this.clock.voiced(event.at, event.vad === true); this.scheduler.spoke(); }
    else if (event.type === 'pause') this.scheduler.paused(event.quietMs);
    else if (event.type === 'endpoint') this.clock.endpoint(event.by, event.smartTurnOff);
    else if (event.type === 'handed-in') this.clock.handedIn();
    // sound over her only opens listening; she keeps reading. The host stops her when the
    // clip's words are a clear sentence or a stop command (electron/voice/utterance-gate.ts → VoiceCallHost.heardOverHer).
    else if (event.type === 'barge-in') { this.scheduler.reset(); this.clock.interrupted(); this.duck.overHer(); } // batch 2: quieter, still reading
    else if (event.type === 'over-her-end') this.duck.clipEnded(event.clip);
  }
  /** I-177 batch 2: the clip over her was held (a filler, a fragment, her echo, no words): her voice comes back, she goes on. */
  overHerHeld(): void { this.duck.held(); }
  /** I-177 batch 2: her reading was stopped in this window (a clear sentence or a stop word reached her). */
  readingStopped(): void { this.duck.stopped(); }
  /** The recognized text of the user's turn reached this window. */
  text(): void { if (this.inCall) this.clock.text(); }
  /** The first characters of her reply arrived. */
  firstChar(): void { if (this.inCall) { this.clock.firstChar(); this.scheduler.answered(); } }
  /** Her whole reply has been written. */
  replyDone(): void { if (this.inCall) this.clock.replyDone(); }
  /** Her reply's reading is about to sound (loading) or sounds (true). */
  replySound(sounding: boolean): void {
    if (!this.inCall) return;
    this.scheduler.replySounding();
    if (sounding) this.clock.firstSound();
  }

  private render(): void {
    const on = this.view.on;
    if (this.button) {
      this.button.textContent = uiText(on ? VOICE_CALL_TEXT.stop : VOICE_CALL_TEXT.start);
      this.button.classList.toggle('is-on', on); this.button.disabled = this.busy;
      this.button.setAttribute('aria-pressed', String(on));
    }
    if (this.mark) { this.mark.hidden = !on; this.mark.textContent = on ? uiText(VOICE_CALL_TEXT.listening) : ''; }
    if (this.dot) this.dot.hidden = !on;
  }
}
