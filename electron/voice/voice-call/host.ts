/**
 * I-091 像打语音电话一样和她聊天: everything the host does for a call, behind the few calls electron/main.ts makes (its IPC
 * handlers and hooks). Electron-free; tests drive it with fakes.
 *
 * Privacy: a call opens the microphone, so it starts only from the user's own action — the window's button (the IPC below),
 * her chat card, or the user's own Claude after the dialog (the agent channel's set_setting voice_call, a sensitive setting).
 * Hanging up is always direct. Recognition stays the existing local path; no audio is kept here or anywhere.
 * Spending: paid filler clips are made only after the window showed the notice for that exact voice (CallFillerStore).
 */
import { chooseCallFiller, type CallFillerMood } from '../../../shared/behaviors/voice-call/choose';
import type { TtsConfig } from '../../../shared/foundation/tts-config';
import { VOICE_CALL_SPOKEN_STYLE, isCallFillerId, type CallFillerClips, type CallFillerId, type CallFillerPick, type CallFillerStatus, type VoiceCallEndReason, type VoiceCallOwner, type VoiceCallVia, type VoiceCallView } from '../../../shared/voice/voice-call';
import type { ClaudeTimingInfo, ClaudeTimingObserver } from '../../brain';
import type { GateNumbers, HeldKind, InterruptBy } from '../../../shared/behaviors/interrupt/judge';
import type { CardLanguage } from '../../../shared/foundation/character-card';
import type { HeardLine } from '../utterance-gate';
import type { SpeechSynthesizer } from '../speech-runtime';
import { VoiceCallController, type VoiceCallTimers } from './controller';
import { CallFillerStore, type CallFillerFs } from './fillers';
import { InterruptionLedger, type SentencePhase, type SentenceRange } from './interruption';
import { nothingCut } from '../../../shared/voice/call-cut-note';
import type { CutRecord } from '../../../shared/foundation/reply-cut';
import { CallAddOn } from './add-on';
import { teeCallTiming } from './timing';
import { isCloudTtsProvider } from '../../../shared/voice/tts';

export type VoiceCallJournalInput =
  | { event: 'start'; via: VoiceCallVia }
  | { event: 'end'; reason: VoiceCallEndReason; seconds: number; turns: number; bargeIns: number; ducks?: { stop: number; resume: number } }
  | { event: 'claude'; process: ClaudeTimingInfo['process']; firstDeltaMs: number | null }
  /** a clip that did not interrupt her and was not a turn (a count, never words). I-204: its recognized characters and echo match. */
  | { event: 'held'; kind: HeldKind; overHer: boolean; call: boolean; chars?: number; match?: number }
  /** I-204: three or more recognized characters (not her echo) interrupted her; the numbers behind it. */
  | { event: 'interrupt'; by: InterruptBy; overHer: boolean; call: boolean; chars?: number; match?: number }
  /** I-197: a line added before her voice started joined the one before it (numbers and a flag only). */
  | { event: 'add-on'; gapMs: number; written: boolean; dropped: number };

export interface VoiceCallHostPorts {
  now(): number;
  timers?: VoiceCallTimers;
  media(): { voiceInput: boolean; voiceOwner: VoiceCallOwner | null | undefined };
  turnOnVoice(owner: VoiceCallOwner): boolean | Promise<boolean>;
  turnOffVoice(owner: VoiceCallOwner): void;
  /** This window and her companion window are on screen (electron/voice/voice-call/surface.ts: out in Unbound counts for her companion window). */
  windowShown(owner: VoiceCallOwner): boolean;
  /** Unbound v1 step 3: she is out in Unbound (the call goes on; her reply shows in her bubble there). */
  out?(): boolean;
  asleep(): boolean;
  /** Her current reading voice, or null while reading aloud is off (then she makes no sound either). */
  ttsConfig(): TtsConfig | null;
  characterId(): string;
  /** Her mood now and her card's baseline (read only). */
  mood(): CallFillerMood;
  keepWarm(on: boolean): void;
  /** Step 4: the user talked over her; stop the host's sentence-by-sentence reading (of `replyId`, or whatever is being read). */
  cancelReading?(replyId: string | null): void;
  /** I-204: where sentence `index` of the reply being read sits in its written text (CompletedReplySpeech.segmentRange), or null. */
  sentence?(replyId: string, index: number): SentenceRange | null;
  /** I-204: the reply's written text so far, read or not (CallStreamingSpeech.writtenText), or null when unknown. */
  writtenText?(replyId: string): string | null;
  broadcast(view: VoiceCallView): void;
  journal(input: VoiceCallJournalInput): void;
  directory(): string | null;
  synthesize: SpeechSynthesizer;
  random?(): number;
  fs?: CallFillerFs;
}

export class VoiceCallHost {
  readonly controller: VoiceCallController;
  readonly interruption = new InterruptionLedger();
  readonly fillers: CallFillerStore;
  /** I-197: from handing her a line until her voice starts, a clear line is added on (electron/voice/voice-call/add-on.ts). */
  readonly addOn: CallAddOn;
  /** Unbound v1 step 3: who listens for her name (set by the voice-input wiring, made after this: electron/senses/voiceprint/gate.ts). */
  private wakeSource: (() => VoiceCallOwner | null) | null = null;
  /** 2026-11-23/24: where a reply's cut record goes (the archive, beside the reply), set by the voice-input wiring. */
  private cutSink: ((replyId: string, cut: CutRecord) => void) | null = null;
  /** I-177 batch 2: this call's clips said over her with a cloud voice (the window ducked her first): stopped her / she went on. */
  private ducks = { stop: 0, resume: 0 };
  constructor(private readonly ports: VoiceCallHostPorts) {
    this.addOn = new CallAddOn({ now: ports.now, timers: ports.timers, inCall: owner => this.controller.on && this.controller.owner === owner,
      journal: row => { try { ports.journal({ event: 'add-on', ...row }); } catch { /* a record only */ } } });
    this.fillers = new CallFillerStore({ directory: ports.directory, synthesize: ports.synthesize, fs: ports.fs });
    this.controller = new VoiceCallController({
      now: ports.now, timers: ports.timers,
      voiceInput: () => { const media = ports.media(); return { on: media.voiceInput === true, owner: media.voiceOwner ?? null }; },
      turnOnVoice: owner => ports.turnOnVoice(owner),
      turnOffVoice: owner => ports.turnOffVoice(owner),
      windowShown: owner => ports.windowShown(owner),
      out: () => ports.out?.() === true,
      wake: () => { try { return this.wakeSource?.() ?? null; } catch { return null; } },
      asleep: () => ports.asleep(),
      fillers: () => this.fillerStatus(),
      keepWarm: on => ports.keepWarm(on),
      publish: view => { if (!view.on) { this.interruption.clear(); this.addOn.clear(); } ports.broadcast(view); },
      journal: entry => { if (entry.event === 'end') { const ducks = this.ducks; this.ducks = { stop: 0, resume: 0 }; ports.journal(ducks.stop + ducks.resume > 0 ? { ...entry, ducks } : entry); } else { this.ducks = { stop: 0, resume: 0 }; ports.journal(entry); } },
    });
  }

  get on(): boolean { return this.controller.on; }
  view(): VoiceCallView { return this.controller.view(); }

  /** The window's own button (or the channel / her chat card through the same handler, with their consent already given). */
  async set(owner: VoiceCallOwner, on: unknown, via: unknown = 'button'): Promise<VoiceCallView> {
    if (typeof on !== 'boolean') throw Error('通话开关不正确。');
    if (!on) return this.controller.stop('user');
    return this.controller.start(owner, via === 'chat' || via === 'channel' ? via : 'button');
  }

  /** Unbound v1 step 3: she heard her name (and it was your voice) in the window listening for it: the call starts there. */
  called(owner: VoiceCallOwner): Promise<VoiceCallView> {
    return this.controller.start(owner, 'name');
  }
  /** Unbound v1 step 3: the window listening for her name now (with no call on), from the voice-input wiring. */
  listenForName(source: () => VoiceCallOwner | null): void { this.wakeSource = source; }
  /** The window listening for her name, or null (also null while a call is on). */
  wakeOwner(): VoiceCallOwner | null { return this.controller.on ? null : this.controller.view().wake ?? null; }

  /** The call's window says the user talked over her reading of `replyId` (`line`: what they said, for her next turn only). */
  bargeIn(owner: VoiceCallOwner, replyId: unknown, line = ''): boolean {
    if (!this.controller.on || this.controller.owner !== owner) return false;
    this.controller.bargeIn();
    // Step 4: she reads while she writes, so the host stops the plan too: nothing more of that reply is read (even sentences not yet written).
    try { this.ports.cancelReading?.(typeof replyId === 'string' ? replyId : null); } catch { /* the window already stopped its own playback */ }
    const marked = this.interruption.mark(replyId, line);
    if (marked) this.fileCut(replyId as string);
    return marked;
  }

  /** Where the cut record of a reply goes (replyId, its record: offsets into the reply's written text); null: nowhere. */
  onCut(sink: ((replyId: string, cut: CutRecord) => void) | null): void { this.cutSink = typeof sink === 'function' ? sink : null; }

  /** The user's voice cut `replyId` just now: one record with the cause, from where the reading window says her voice was (nothing when it had said it all). */
  private fileCut(replyId: string): void {
    let text: string | null = null;
    try { text = this.ports.writtenText?.(replyId) ?? null; } catch { text = null; }
    const point = this.interruption.point(), known = point.known && !!text;
    if (known && nothingCut({ ...point, known, text: text!, userLine: '' })) return;
    try { this.cutSink?.(replyId, { cause: 'user-spoke', known, saidEnd: known ? point.saidEnd : 0, sentenceEnd: known ? point.sentenceEnd : 0 }); } catch { /* a marker only */ }
  }

  /**
   * I-204: three or more recognized characters, not her echo, came while she was speaking
   * (electron/voice/utterance-gate.ts). In this call's window it is the barge-in (counted, the plan stopped, the reply marked at the point
   * her voice stopped, the user's line kept for her next turn). Sound alone never comes here.
   */
  heardOverHer(owner: VoiceCallOwner, by: InterruptBy, overHer = true, heard?: HeardLine): boolean {
    const call = this.controller.on && this.controller.owner === owner;
    if (call && overHer && this.cloudVoice()) this.ducks.stop++;
    try { this.ports.journal({ event: 'interrupt', by, overHer, call, ...gateNumbers(heard) }); } catch { /* a count only */ }
    return call ? this.bargeIn(owner, this.interruption.current, typeof heard?.text === 'string' ? heard.text : '') : false;
  }

  /** A clip was held (under three characters, her echo; noise heard as "嗯"): one journal count with its numbers, nothing else. */
  held(kind: HeldKind, overHer: boolean, owner: VoiceCallOwner | null, gate?: GateNumbers): void {
    if (overHer && this.controller.on && this.controller.owner === owner && this.cloudVoice()) this.ducks.resume++;
    try { this.ports.journal({ event: 'held', kind, overHer, call: this.controller.on && this.controller.owner === owner, ...gateNumbers(gate) }); } catch { /* a count only */ }
  }

  /** I-204: the reading window says sentence `index` of `replyId` started or ended being heard (where her voice is, for the cut and the echo check). */
  sentenceHeard(replyId: unknown, index: unknown, phase: SentencePhase): void {
    if (!this.controller.on || typeof replyId !== 'string' || replyId !== this.interruption.current || !Number.isInteger(index) || (index as number) < 0) return;
    let range: SentenceRange | null = null;
    if (phase === 'start') { try { range = this.ports.sentence?.(replyId, index as number) ?? null; } catch { range = null; } }
    this.interruption.heard(replyId, index, phase, range);
  }

  /** I-204: what the echo check compares a clip with: the stretch she is reading now (or `fallback`, her whole reading text, when unknown). */
  herText(fallback: string): string {
    const id = this.controller.on ? this.interruption.current : null;
    let text: string | null = null;
    if (id) { try { text = this.ports.writtenText?.(id) ?? null; } catch { text = null; } }
    return text ? this.interruption.echoWindow(text) : fallback;
  }

  /** Her pick for this pause; null outside a call, with reading aloud off, or when she makes no sound this time. */
  filler(owner: VoiceCallOwner, last: unknown): CallFillerPick | null {
    const status = this.controller.on && this.controller.owner === owner ? this.fillerStatus() : null;
    if (!status?.ready) return null; // a paid voice without its clips: no sound (the window asks for them after the notice)
    let mood: CallFillerMood = {};
    try { mood = this.ports.mood() ?? {}; } catch { mood = {}; }
    const pick = chooseCallFiller({ ...mood, last: isCallFillerId(last) ? last as CallFillerId : null, random: this.ports.random ?? Math.random });
    return pick && { ...pick, voiceKey: status.voiceKey };
  }

  async clips(owner: VoiceCallOwner): Promise<CallFillerClips | null> {
    const config = this.ports.ttsConfig();
    if (!this.controller.on || this.controller.owner !== owner || !config) return null;
    return this.fillers.clips(this.ports.characterId(), config);
  }

  /** After the window showed the spending notice for `voiceKey`: make the missing clips of the current voice. */
  async prepare(owner: VoiceCallOwner, voiceKey: unknown): Promise<{ generated: number; failed: number }> {
    const config = this.ports.ttsConfig();
    if (!this.controller.on || this.controller.owner !== owner || !config) return { generated: 0, failed: 0 };
    const result = await this.fillers.generate(this.ports.characterId(), config, voiceKey);
    this.controller.refresh();
    return result;
  }

  // Hooks from the existing voice path (electron/main.ts).
  /** A voice reply's reading was authorized ('speech' event) in the call. */
  noteSpeech(replyId: string): void { if (this.controller.on) { this.interruption.noteReading(replyId); this.controller.spoke(); } }
  /** A verified speech start in the call's window. */
  heard(): void { this.controller.heard(); this.addOn.speechStart(); } // I-197: a line begun before her voice still joins
  /** A user voice turn was handed to her. */
  turn(): void { this.controller.turn(); }
  /** Voice input, visibility or her sleep may have changed. */
  check(): void { this.controller.check(); }
  /** Step 4: the spoken-style lines of this call turn's private context (empty outside a call). */
  callStyle(): string { return this.controller.on ? VOICE_CALL_SPOKEN_STYLE : ''; }
  /** The private line for the next utterance, in her chat's language (empty outside a call). I-204: where she was cut, what she said and meant to say, the user's line. */
  turnNote(language?: CardLanguage | null): string {
    return this.controller.on ? this.interruption.takeNote(id => { try { return this.ports.writtenText?.(id) ?? null; } catch { return null; } }, language) : '';
  }
  /** The settings or character changed: the windows learn the filler status of the new voice. */
  voiceChanged(): void { this.controller.refresh(); }
  /** Claude's timing during a call, as journal numbers. */
  timing(base: ClaudeTimingObserver | undefined, now?: () => number): ClaudeTimingObserver {
    return teeCallTiming(base, { on: () => this.controller.on, record: (process, firstDeltaMs) => this.ports.journal({ event: 'claude', process, firstDeltaMs }) }, now);
  }
  dispose(): void { this.controller.dispose(); }

  /** Her call voice is a cloud one (the only kind the window can duck). */
  private cloudVoice(): boolean { try { return isCloudTtsProvider(this.ports.ttsConfig()?.provider); } catch { return false; } }

  private fillerStatus(): CallFillerStatus | null {
    const config = this.ports.ttsConfig();
    return config ? this.fillers.status(this.ports.characterId(), config) : null;
  }
}

/** I-204: the gate's numbers as journal fields (closed numbers only; absent when unknown). */
function gateNumbers(gate: GateNumbers | undefined): { chars?: number; match?: number } {
  if (!gate) return {};
  const chars = Number.isInteger(gate.chars) && gate.chars >= 0 ? Math.min(gate.chars, 100_000) : undefined;
  const match = typeof gate.match === 'number' && Number.isFinite(gate.match) ? Math.max(0, Math.min(1, Math.round(gate.match * 100) / 100)) : undefined;
  return { ...(chars === undefined ? {} : { chars }), ...(match === undefined ? {} : { match }) };
}
