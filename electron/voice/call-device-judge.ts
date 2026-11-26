/**
 * I-177 batch 2 (docs/claude/2026-11-22-i177-batch2.md): the host side of Claude's judgement of a NEW set of audio devices.
 *
 * The call's window (src/voice/voice-call/call-mic.ts CallMicAdvisor) asks through `callDevicesAsk` when a call starts with a device set it
 * has not asked about; the call never waits for it. Here:
 *  - what crosses is cleaned again (defence in depth, the window already did it): strings only, owner names stripped
 *    (shared/voice/call-devices.ts stripDeviceName), no control characters, at most 24 names of 80 characters per side. No ids exist here.
 *  - one ask per device set (both windows share the answer), only while the user's Claude answers (chatAvailability, like every other
 *    background haiku call), at most CALL_DEVICES_KNOBS.callsPerDay a day, aborted after timeoutMs;
 *  - the answer is cut to names that were sent and kinds from a closed set; anything else is null, and the window keeps its keyword verdict
 *    (it checks the answer once more against the devices really plugged in: acceptVerdict).
 * Electron-free; the app's one call is electron/initiative/inner-loop/model.ts quickLineWithClaude (haiku, no tools), given by the wiring.
 */
import { CALL_DEVICES_KNOBS, type CallDevicesKnobs } from '../../shared/behaviors/call-devices/knobs';
import { stripDeviceName, type CallDeviceJudgement, type VerdictKind } from '../../shared/voice/call-devices';

export type CallDeviceAsk = (prompt: string, systemPrompt: string, signal: AbortSignal) => Promise<string>;
export interface CallDeviceNames { inputs: string[]; outputs: string[] }
export interface CallDeviceJudgePorts {
  ask: CallDeviceAsk;
  /** The user's Claude answers now (electron/brain/chat-availability.ts isAvailable). */
  available(): boolean;
  now?(): number;
  localDate?(ms: number): string;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  knobs?: CallDevicesKnobs;
}

const MAX_NAMES = 24, MAX_CHARS = 80, MAX_SETS = 64;
const KINDS: readonly VerdictKind[] = ['headphones', 'speakers', 'microphone'];

function cleanList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, MAX_NAMES * 2)) {
    if (typeof item !== 'string') continue;
    const name = stripDeviceName(item.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, MAX_CHARS).trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

/** What the window sent, cleaned: owner names stripped again; null when it is not two lists of names. */
export function cleanDeviceNames(value: unknown): CallDeviceNames | null {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const inputs = cleanList(v?.inputs), outputs = cleanList(v?.outputs);
  if (!inputs || !outputs || (!inputs.length && !outputs.length)) return null;
  return { inputs, outputs };
}

export const CALL_DEVICE_SYSTEM = [
  'You look at the audio devices of a computer for a voice-call app. Answer with ONE JSON object and nothing else:',
  '{"kinds":{"<name>":"headphones"|"speakers"|"microphone"},"pairs":{"<output name>":"<input name of the same headset>"},',
  '"inputOrder":["<best microphone for calls first>"],"outputOrder":["<best output first>"],"headsetMicOnly":true|false}',
  'Use the device names exactly as given. A Bluetooth headset\'s own microphone (often called Headset or Hands-Free) turns the headset into',
  'phone quality while it is open, so put microphones that are not part of the headset first (a laptop microphone array, then a USB',
  'microphone, then a webcam microphone) and the headset\'s own microphone last. Put headphones before speakers in outputOrder.',
  'headsetMicOnly is true only when the only real microphone belongs to the headset. Leave out virtual devices (Stereo Mix, Voicemeeter).',
].join('\n');

/** The prompt: the two lists, nothing else. */
export function callDevicePrompt(names: CallDeviceNames): string {
  return `Inputs (microphones): ${JSON.stringify(names.inputs)}\nOutputs: ${JSON.stringify(names.outputs)}`;
}

/** Claude's text cut to what is accepted: only names that were sent, only the three kinds. Null: unusable. */
export function parseCallDeviceAnswer(text: unknown, names: CallDeviceNames): CallDeviceJudgement | null {
  try {
    const raw = typeof text === 'string' ? text : '';
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start || end - start > 20_000) return null;
    const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const pick = (x: unknown, allowed: string[]): string[] | null =>
      Array.isArray(x) && x.every(s => typeof s === 'string') ? [...new Set((x as string[]).filter(s => allowed.includes(s)))] : null;
    const inputOrder = pick(v.inputOrder, names.inputs), outputOrder = pick(v.outputOrder, names.outputs);
    if (!inputOrder || !outputOrder || (!inputOrder.length && !outputOrder.length)) return null;
    const all = [...names.inputs, ...names.outputs];
    const kinds: Record<string, VerdictKind> = {};
    const kindsIn = v.kinds && typeof v.kinds === 'object' && !Array.isArray(v.kinds) ? v.kinds as Record<string, unknown> : {};
    for (const [name, kind] of Object.entries(kindsIn)) if (all.includes(name) && KINDS.includes(kind as VerdictKind)) kinds[name] = kind as VerdictKind;
    const pairs: Record<string, string> = {};
    const pairsIn = v.pairs && typeof v.pairs === 'object' && !Array.isArray(v.pairs) ? v.pairs as Record<string, unknown> : {};
    for (const [output, input] of Object.entries(pairsIn)) if (names.outputs.includes(output) && typeof input === 'string' && names.inputs.includes(input)) pairs[output] = input;
    return { kinds, pairs, inputOrder, outputOrder, headsetMicOnly: v.headsetMicOnly === true };
  } catch { return null; }
}

/** The set's identity: kinds and names, order-free. */
const setKey = (names: CallDeviceNames): string => JSON.stringify([[...names.inputs].sort(), [...names.outputs].sort()]);

export class CallDeviceJudge {
  private readonly answers = new Map<string, Promise<CallDeviceJudgement | null>>();
  private day = '';
  private count = 0;
  /** Numbers for tests and the developer line (never names). */
  readonly stats = { asked: 0, judged: 0, unusable: 0, failed: 0, capped: 0, unavailable: 0, repeated: 0, rejected: 0 };
  constructor(private readonly ports: CallDeviceJudgePorts) {}

  private get knobs(): CallDevicesKnobs { return this.ports.knobs ?? CALL_DEVICES_KNOBS; }

  /** The window's ask (IPC `callDevicesAsk`). One ask per set; a known set gets the same answer without a second call. */
  ask(value: unknown): Promise<CallDeviceJudgement | null> {
    const names = cleanDeviceNames(value);
    if (!names) { this.stats.rejected++; return Promise.resolve(null); }
    const key = setKey(names);
    const known = this.answers.get(key);
    if (known) { this.stats.repeated++; return known; }
    let available = false;
    try { available = this.ports.available() === true; } catch { available = false; }
    if (!available) { this.stats.unavailable++; return Promise.resolve(null); } // not remembered: a later call may ask when Claude answers again
    const now = this.ports.now?.() ?? Date.now();
    const day = (this.ports.localDate ?? (ms => new Date(ms).toDateString()))(now);
    if (day !== this.day) { this.day = day; this.count = 0; }
    if (this.count >= this.knobs.callsPerDay) { this.stats.capped++; return Promise.resolve(null); }
    this.count++;
    this.stats.asked++;
    const answer = this.call(names);
    this.answers.set(key, answer);
    if (this.answers.size > MAX_SETS) this.answers.delete(this.answers.keys().next().value!);
    return answer;
  }

  private async call(names: CallDeviceNames): Promise<CallDeviceJudgement | null> {
    const controller = new AbortController();
    const timers = this.ports.timers ?? { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    const timer = timers.set(() => controller.abort(), this.knobs.timeoutMs);
    (timer as { unref?: () => void } | null)?.unref?.();
    try {
      const text = await this.ports.ask(callDevicePrompt(names), CALL_DEVICE_SYSTEM, controller.signal);
      if (controller.signal.aborted) { this.stats.failed++; return null; }
      const judged = parseCallDeviceAnswer(text, names);
      if (judged) this.stats.judged++; else this.stats.unusable++;
      return judged;
    } catch { this.stats.failed++; return null; }
    finally { timers.clear(timer); }
  }
}
