/**
 * I-177 batch 1 (docs/claude/2026-11-22-i177-batch1.md): the call's ears, in the window. It
 *  - records the devices seen (kind and stripped names, this profile's local storage only; never an id, never an owner name),
 *  - chooses the call's microphone from the user's own priority list (an empty list or no entry plugged in: the system default, as always),
 *  - at a call start shows the once-a-day "戴上耳机" line on speakers, the phone-quality note for a headset-only desktop, and, for a device
 *    set it has not seen answered, ONE suggestion card (换 / 不换 / 以后再说) from the keyword verdict or, when an `ask` port is given, Claude's.
 * Nothing changes without the user's click: 换 rewrites the list, 不换 is remembered for that set, 以后再说 and no answer change nothing.
 * The pure rules are shared/voice/call-devices.ts. The microphone itself stays the call's microphone (MicrophoneInput deviceId constraint).
 */
import {
  CALL_DEVICE_TEXT, acceptVerdict, devicesForJudgement, deviceSetKey, keywordVerdict, localDay, pickByPriority, playbackKind, readCallDevices, speakersHintDue, suggestionFor,
  type CallDeviceReading, type CallDeviceVerdict, type DeviceInfo, type Suggestion,
} from '../../../shared/voice/call-devices';

import {
  CALL_DEVICES_STORAGE_KEY, MAX_CALL_DEVICE_SETS, deviceNames, emptyCallDeviceState, localCallDeviceStorage,
  type CallDevicePrefs, type CallDeviceState, type CallDeviceStorage,
} from '../../../shared/voice/call-device-storage';
// I-190: the stored lists moved to shared/voice/call-device-storage.ts (the Unbound input box reads them too); the old names stay here.
export { CALL_DEVICES_STORAGE_KEY, emptyCallDeviceState, localCallDeviceStorage, type CallDevicePrefs, type CallDeviceState, type CallDeviceStorage };
const MAX_SETS = MAX_CALL_DEVICE_SETS, names = deviceNames;

export type CardAnswer = 'yes' | 'no' | 'later';
/** What the call bar shows (src/voice/voice-call/call-devices-card.ts draws it). */
export interface CallBarPorts {
  line(text: string, action?: { label: string; run(): void }): void;
  card(text: string, answer: (value: CardAnswer) => void): void;
  clear(): void;
}
export interface CallMicPorts {
  read(): Promise<DeviceInfo[]>;
  storage: CallDeviceStorage;
  now(): number;
  bar: CallBarPorts;
  /** Claude's judgement for a new device set: stripped names only. Rejecting or answering nonsense falls back to the keyword verdict. Absent: keywords only. */
  ask?(devices: { inputs: string[]; outputs: string[] }): Promise<unknown>;
  /** Waits a little (for the call's microphone to give the page the device names). */
  wait?(ms: number): Promise<void>;
  /** Called with a plain note after the user answered (the card's result line). */
  said?(text: string): void;
}

export class CallMicAdvisor {
  private state: CallDeviceState;
  /** The card shown in this call: its set, its order, and whether the user answered it (Claude's later reading replaces it only if not). */
  private shown: { key: string; order: string; answered: boolean } | null = null;
  constructor(private readonly ports: CallMicPorts) { this.state = ports.storage.load(); }

  get prefs(): CallDevicePrefs { return this.fresh().prefs; }

  /** For MicrophoneInput: which device the call's microphone uses. Before the page has been given the microphone the names are blank: labelsKnown false. */
  async choice(): Promise<{ deviceId: string | null; labelsKnown: boolean }> {
    try {
      const devices = await this.ports.read();
      this.fresh();
      if (!readCallDevices(devices).labelsKnown) return { deviceId: null, labelsKnown: false };
      this.record(devices);
      return { deviceId: pickByPriority(this.state.prefs.inputOrder, devices, 'audioinput'), labelsKnown: true };
    } catch { return { deviceId: null, labelsKnown: true }; }
  }

  /** A device was plugged or unplugged: record the new set (no card now; it comes with the next call). */
  async devicesChanged(): Promise<CallDeviceReading | null> {
    try {
      const devices = await this.ports.read(); this.fresh();
      const reading = readCallDevices(devices);
      if (!reading.labelsKnown) return null;
      this.record(devices);
      return { ...reading, output: playbackKind(devices, this.state.prefs.outputOrder) }; // T-260: the output her voice plays on now
    } catch { return null; /* nothing to record */ }
  }

  /**
   * A call started: the hint, the note, and at most one question. Never blocks the call; any failure just shows nothing.
   * Back (batch 2): what the call plays on (headphones lower the talking-over-her gate), or null when the names cannot be read.
   */
  async callStarted(): Promise<CallDeviceReading | null> {
    try {
      let devices = await this.ports.read();
      if (!readCallDevices(devices).labelsKnown && this.ports.wait) { await this.ports.wait(1500); devices = await this.ports.read(); }
      const reading = readCallDevices(devices);
      if (!reading.labelsKnown) return null;
      this.fresh(); this.shown = null;
      const key = this.record(devices);
      const today = localDay(this.ports.now());
      let verdict = this.state.verdicts[key] ?? keywordVerdict(devices);
      if (reading.output === 'headphones' && verdict.headsetMicOnly && !this.state.prefs.inputOrder.length) this.ports.bar.line(CALL_DEVICE_TEXT.headsetMicNote);
      else if (speakersHintDue({ output: reading.output, labelsKnown: true, off: this.state.prefs.hintOff, lastDay: this.state.hintDay, today })) {
        this.state.hintDay = today; this.save();
        this.ports.bar.line(CALL_DEVICE_TEXT.speakersHint, { label: CALL_DEVICE_TEXT.hintOff, run: () => { this.fresh().prefs.hintOff = true; this.save(); this.ports.bar.clear(); } });
      }
      this.offer(key, verdict, reading);
      // One ask per device set, ever; the card is replaced by Claude's reading only if the user has not answered the first one.
      if (this.ports.ask && !this.state.asked.includes(key) && !this.state.declined.includes(key)) {
        this.state.asked.push(key); this.state.asked = this.state.asked.slice(-MAX_SETS * 2); this.save();
        const judged = devicesForJudgement(devices);
        void Promise.resolve().then(() => this.ports.ask!(judged)).then(answer => {
          const accepted = acceptVerdict(answer, devices);
          if (!accepted) return; // failure or nonsense: the keyword verdict already stands
          this.fresh();
          this.state.verdicts[key] = accepted; this.state.verdicts = Object.fromEntries(Object.entries(this.state.verdicts).slice(-MAX_SETS)); this.save();
          this.offer(key, accepted, reading); // replaces the keyword card unless the user already answered it
        }, () => { /* the keyword verdict stands */ });
      }
      return { ...reading, output: playbackKind(devices, this.state.prefs.outputOrder) }; // T-260: the device her voice plays on, not only the system default
    } catch { return null; /* a call is never blocked by its devices */ }
  }

  /** The suggestion for the devices plugged in now, regardless of earlier answers (the settings page's 「重新看看建议」). */
  async suggestionNow(): Promise<Suggestion | null> {
    try {
      const devices = await this.ports.read();
      this.fresh();
      const reading = readCallDevices(devices), key = this.record(devices);
      return suggestionFor(key, this.state.verdicts[key] ?? keywordVerdict(devices), reading, this.state.prefs.inputOrder);
    } catch { return null; }
  }

  /** The user's answer to a suggestion. Only 换 changes the list. */
  answer(suggestion: Suggestion, value: CardAnswer): void {
    this.fresh();
    if (value === 'yes') {
      this.state.prefs.inputOrder = suggestion.inputOrder.slice(0, 24); this.state.prefs.outputOrder = suggestion.outputOrder.slice(0, 24);
      this.state.declined = this.state.declined.filter(k => k !== suggestion.key); this.save();
      this.ports.said?.('好，下一通电话起照这个顺序用麦克风。');
    } else if (value === 'no') {
      if (!this.state.declined.includes(suggestion.key)) this.state.declined.push(suggestion.key);
      this.state.declined = this.state.declined.slice(-MAX_SETS * 2); this.save();
    }
  }

  /** The names plugged in now (stripped), for the settings lists. */
  async deviceNames(): Promise<{ inputs: string[]; outputs: string[] }> {
    try { return devicesForJudgement(await this.ports.read()); } catch { return { inputs: [], outputs: [] }; }
  }
  setOrders(inputOrder: string[], outputOrder: string[]): void { this.fresh(); this.state.prefs.inputOrder = names(inputOrder); this.state.prefs.outputOrder = names(outputOrder); this.save(); }
  setHintOff(off: boolean): void { this.fresh().prefs.hintOff = off; this.save(); }

  private offer(key: string, verdict: CallDeviceVerdict, reading: CallDeviceReading): void {
    if (this.state.declined.includes(key)) return;
    const suggestion = suggestionFor(key, verdict, reading, this.state.prefs.inputOrder);
    if (!suggestion) return;
    const order = JSON.stringify(suggestion.inputOrder);
    if (this.shown?.key === key && (this.shown.answered || this.shown.order === order)) return;
    const shown: { key: string; order: string; answered: boolean } = { key, order, answered: false };
    this.shown = shown;
    this.ports.bar.card(suggestion.text, value => { shown.answered = true; this.answer(suggestion, value); this.ports.bar.clear(); });
  }
  private record(devices: readonly DeviceInfo[]): string {
    const key = deviceSetKey(devices);
    if (!this.state.seen[key]) {
      this.state.seen[key] = devicesForJudgement(devices);
      const keep = Object.keys(this.state.seen).slice(-MAX_SETS);
      this.state.seen = Object.fromEntries(keep.map(k => [k, this.state.seen[k]]));
      this.save();
    }
    return key;
  }
  private save(): void { this.ports.storage.save(this.state); }
  /**
   * I-177 batch 2: the state as stored now. Both windows load the same page (dist/index.html) in the default session, so they share this
   * profile's local storage; but each window's advisor used to keep the copy it loaded at start, so a list changed in the control window
   * never reached the companion window's call (and its next save wrote the old copy back). Every read and every change starts from storage.
   */
  private fresh(): CallDeviceState { this.state = this.ports.storage.load(); return this.state; }
}

/** I-177 batch 2: the user's 「听」 list as stored now (src/voice/output-sink.ts reads it before her voice plays; empty = the system default). */
export function callOutputOrder(storage: CallDeviceStorage = localCallDeviceStorage()): string[] { return storage.load().prefs.outputOrder; }
/**
 * I-177 batch 2: the output device her cloud voice plays on now: the highest plugged-in entry of the 「听」 list, or null = the system
 * default (an empty list costs nothing: no device list is read). A device that disappeared is simply not found: back to the default.
 */
export async function chooseCallOutput(read: () => Promise<DeviceInfo[]> = readPageDevices, storage: CallDeviceStorage = localCallDeviceStorage()): Promise<string | null> {
  const order = callOutputOrder(storage);
  return order.length ? pickByPriority(order, await read(), 'audiooutput') : null;
}

/** The page's own device list (names are blank until the page was once given a microphone). */
export async function readPageDevices(): Promise<DeviceInfo[]> {
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput').map(d => ({ kind: d.kind as DeviceInfo['kind'], deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
}
