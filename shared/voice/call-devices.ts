/**
 * I-177 batch 1 (docs/claude/2026-11-22-i177-batch1.md): the call and her ears. Pure rules for the audio devices a call sees:
 * headphones or speakers from a device NAME, the names with their owner stripped (a name never leaves the window with "艾乐的" in it),
 * which input and output belong to one headset, the keyword verdict (the free, instant first layer and the fallback when Claude is not
 * asked or fails), the priority pick (the highest available entry of the user's own list), and the once-a-day speakers hint.
 * Nothing here stores, sends or logs anything; the window part is src/voice/voice-call/call-mic.ts.
 */

export type OutputKind = 'headphones' | 'speakers' | 'unknown';
/** I-190: 'videoinput' only for the camera's priority list (pickByPriority); every call rule reads the two audio kinds. */
export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';
/** The part of a MediaDeviceInfo this file reads. */
export interface DeviceInfo { kind: DeviceKind; deviceId: string; groupId: string; label: string }
/** What a device is, as the verdict says (Claude's answer is cut to exactly this). */
export type VerdictKind = 'headphones' | 'speakers' | 'microphone';
export interface CallDeviceVerdict {
  /** Stripped names → what each is. */
  kinds: Record<string, VerdictKind>;
  /** Output name → input name of the same headset. */
  pairs: Record<string, string>;
  /** Suggested order: first is used first. Names are the stripped names (the user's list holds exactly these). */
  inputOrder: string[];
  outputOrder: string[];
  /** The only microphone there is belongs to the headset that plays her voice (many desktops): the call can only be phone quality. */
  headsetMicOnly: boolean;
  by: 'keywords' | 'claude';
}
/** What the host's Claude judgement sends back (electron/voice/call-device-judge.ts; IPC callDevicesAsk): a verdict without its source. */
export type CallDeviceJudgement = Omit<CallDeviceVerdict, 'by'>;

const HEADPHONE_WORDS = /headphone|headset|earphone|earbud|airpods|buds[0-9]*\b|hands-?free|耳机|耳麦|耳塞|免提/i;
const SPEAKER_WORDS = /speaker|扬声器|音箱|喇叭|soundbar|扬声/i;
const BLUETOOTH_WORDS = /bluetooth|蓝牙/i;
/** Words that show a Bluetooth headset when the name does not say "Bluetooth" (Windows names its hands-free side so). */
const WIRELESS_WORDS = /bluetooth|蓝牙|airpods|buds[0-9]*\b|hands-?free|免提|ag audio/i;
const VIRTUAL_INPUT = /stereo mix|立体声混音|virtual|虚拟|cable|voicemeeter|loopback|what u hear|wave out/i;
const ARRAY_MIC = /array|阵列/i;
const CAMERA_MIC = /webcam|camera|摄像头|\bc9\d\d\b|brio|\bcam\b/i;

/** Headphones, speakers, or unknown, from the name alone. A speaker word wins over a bare "Bluetooth" (a Bluetooth speaker is a speaker). */
export function classifyOutput(label: string): OutputKind {
  const name = stripDeviceName(label);
  if (HEADPHONE_WORDS.test(name)) return 'headphones';
  if (SPEAKER_WORDS.test(name)) return 'speakers';
  if (BLUETOOTH_WORDS.test(name)) return 'headphones';
  return 'unknown';
}

/**
 * A device name as it may leave the window: no "Default - " / "Communications - " prefix and no owner ("艾乐的 AirPods", "Alex's AirPods",
 * "Alex’s AirPods"). Owner names are the only part of a device name that is about a person, so they are cut before any other use.
 */
export function stripDeviceName(label: string): string {
  let text = String(label ?? '').slice(0, 200);
  text = text.replace(/^(?:default|communications|默认|通信)\s*[-–—]\s*/i, '');
  text = text.replace(/[一-龥A-Za-z0-9_.\-]{1,24}的\s*(?=[A-Za-z一-龥(（])/g, '');
  text = text.replace(/(^|[\s(（])[^\s()（）]{1,24}['’]s\s+/gi, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

const wordsOf = (name: string): string => name.toLowerCase().replace(/hands-?free|ag audio|免提|stereo|find my|立体声|\(|\)|（|）|[^a-z0-9一-龥]+/g, ' ').replace(/\s+/g, ' ').trim();
/** The text between the last parentheses ("Headphones (AirPods Pro Stereo)" → "airpods pro"): the same on both sides of one headset. */
function deviceCore(name: string): string {
  const inner = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(name);
  return wordsOf(inner ? inner[1] : name);
}

function stripped(device: DeviceInfo): string { return stripDeviceName(device.label); }
const isVirtualId = (id: string): boolean => id === 'default' || id === 'communications';

/** Two devices are one headset: the same group (the browser's own grouping) or the same name inside the parentheses. */
export function sameHeadset(a: DeviceInfo, b: DeviceInfo): boolean {
  if (a.groupId && a.groupId === b.groupId) return true;
  const x = deviceCore(stripped(a)), y = deviceCore(stripped(b));
  return x.length >= 3 && x === y;
}

/** Every real (non-"default") device of one kind; the "default" ones only repeat one of them. */
function real(devices: readonly DeviceInfo[], kind: DeviceKind): DeviceInfo[] {
  const all = devices.filter(d => d.kind === kind);
  const list = all.filter(d => !isVirtualId(d.deviceId));
  return list.length ? list : all;
}
/** The device the system uses now: the real entry the "default" entry stands for. */
function systemDefault(devices: readonly DeviceInfo[], kind: DeviceKind): DeviceInfo | null {
  const all = devices.filter(d => d.kind === kind);
  const alias = all.find(d => d.deviceId === 'default');
  const list = real(devices, kind);
  if (!alias) return list[0] ?? null;
  const same = list.find(d => d.groupId && d.groupId === alias.groupId && stripped(d) !== '') ?? list.find(d => stripped(d) === stripped(alias));
  return same ?? alias;
}

/** Labels are blank until the page has once been given the microphone; no name, no judgement. */
export function labelsKnown(devices: readonly DeviceInfo[]): boolean { return devices.some(d => stripped(d) !== ''); }

export interface CallDeviceReading {
  labelsKnown: boolean;
  output: OutputKind;
  outputName: string | null;
  inputName: string | null;
}
/** What the call starts with: the system default output's kind and the default input's name. */
export function readCallDevices(devices: readonly DeviceInfo[]): CallDeviceReading {
  const out = systemDefault(devices, 'audiooutput'), input = systemDefault(devices, 'audioinput');
  const known = labelsKnown(devices);
  return { labelsKnown: known, output: known && out ? classifyOutput(out.label) : 'unknown', outputName: out && known ? stripped(out) : null, inputName: input && known ? stripped(input) : null };
}

/**
 * The kind of the output her voice plays on (T-260): the highest plugged-in entry of the user's 「听」 list when there is one (the same pick
 * the shared output makes: pickByPriority), else the system default. Names blank (not yet given the microphone): 'unknown'. The echo gate
 * for "talking over her" follows this, not the system default alone.
 */
export function playbackKind(devices: readonly DeviceInfo[], outputOrder: readonly string[] | undefined): OutputKind {
  if (!labelsKnown(devices)) return 'unknown';
  const id = pickByPriority(outputOrder, devices, 'audiooutput');
  const chosen = id ? devices.find(d => d.kind === 'audiooutput' && d.deviceId === id) ?? null : null;
  const device = chosen && stripped(chosen) !== '' ? chosen : systemDefault(devices, 'audiooutput');
  return device ? classifyOutput(device.label) : 'unknown';
}

/** A fingerprint of the set of devices (kinds and stripped names only), the key the verdict cache and the "不换" memory use. */
export function deviceSetKey(devices: readonly DeviceInfo[]): string {
  const names = real(devices, 'audioinput').concat(real(devices, 'audiooutput')).map(d => `${d.kind === 'audioinput' ? 'i' : 'o'}:${stripped(d)}`).filter(s => s.length > 2).sort();
  let hash = 0x811c9dc5;
  const joined = names.join('|');
  for (let i = 0; i < joined.length; i++) { hash ^= joined.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${names.length}-${hash.toString(16)}`;
}

/** What may leave the window to be judged by Claude: kinds and stripped names, nothing else (no ids, no group ids). */
export function devicesForJudgement(devices: readonly DeviceInfo[]): { inputs: string[]; outputs: string[] } {
  const names = (kind: DeviceKind) => [...new Set(real(devices, kind).map(stripped).filter(Boolean))].slice(0, 24).map(n => n.slice(0, 80));
  return { inputs: names('audioinput'), outputs: names('audiooutput') };
}

function microphoneRank(name: string): number { return ARRAY_MIC.test(name) ? 0 : CAMERA_MIC.test(name) ? 2 : 1; }

/**
 * The keyword verdict. It never decides anything by itself: it is shown as a suggestion and nothing changes without the user's click.
 * Order of inputs: microphones that are not the headset that plays her voice (array, then others, then a webcam's), then that headset's
 * own. When the only microphone is that headset's, `headsetMicOnly` says so (phone quality). Outputs: headphones first.
 */
export function keywordVerdict(devices: readonly DeviceInfo[]): CallDeviceVerdict {
  const inputs = real(devices, 'audioinput').filter(d => stripped(d) !== '' && !VIRTUAL_INPUT.test(d.label));
  const outputs = real(devices, 'audiooutput').filter(d => stripped(d) !== '');
  const kinds: Record<string, VerdictKind> = {};
  for (const d of outputs) { const kind = classifyOutput(d.label); kinds[stripped(d)] = kind === 'speakers' || kind === 'unknown' ? 'speakers' : 'headphones'; }
  for (const d of inputs) kinds[stripped(d)] ??= 'microphone';
  const pairs: Record<string, string> = {};
  for (const o of outputs) { const mate = inputs.find(i => sameHeadset(o, i)); if (mate) pairs[stripped(o)] = stripped(mate); }
  const outDefault = systemDefault(devices, 'audiooutput');
  const outputOrder = [...outputs].sort((a, b) => Number(classifyOutput(b.label) === 'headphones') - Number(classifyOutput(a.label) === 'headphones')).map(stripped);
  // The headset in her ears: the system's output if it is headphones; its mic is the "hands-free" one that turns her voice into a phone call.
  const wearing = outDefault && classifyOutput(outDefault.label) === 'headphones' ? outDefault : null;
  const headsetMic = wearing ? inputs.find(i => sameHeadset(wearing, i) && (WIRELESS_WORDS.test(wearing.label) || WIRELESS_WORDS.test(i.label))) ?? null : null;
  const others = inputs.filter(i => i !== headsetMic).sort((a, b) => microphoneRank(stripped(a)) - microphoneRank(stripped(b)));
  const inputOrder = headsetMic ? [...others.map(stripped), stripped(headsetMic)] : inputs.map(stripped);
  return { kinds, pairs, inputOrder: [...new Set(inputOrder)], outputOrder: [...new Set(outputOrder)], headsetMicOnly: !!headsetMic && others.length === 0, by: 'keywords' };
}

/** A verdict from outside (Claude's answer) cut down to what we accept: only names that are really present, only the three kinds. null: unusable. */
export function acceptVerdict(value: unknown, devices: readonly DeviceInfo[]): CallDeviceVerdict | null {
  try {
    const v = value as Record<string, unknown> | null;
    if (!v || typeof v !== 'object') return null;
    const present = devicesForJudgement(devices);
    const inSet = new Set([...present.inputs, ...present.outputs]);
    const list = (x: unknown, allowed: string[]): string[] | null => Array.isArray(x) && x.every(s => typeof s === 'string') ? [...new Set((x as string[]).filter(s => allowed.includes(s)))] : null;
    const inputOrder = list(v.inputOrder, present.inputs), outputOrder = list(v.outputOrder, present.outputs);
    if (!inputOrder || !outputOrder) return null;
    const kinds: Record<string, VerdictKind> = {};
    for (const [name, kind] of Object.entries((v.kinds ?? {}) as Record<string, unknown>)) if (inSet.has(name) && (kind === 'headphones' || kind === 'speakers' || kind === 'microphone')) kinds[name] = kind;
    const pairs: Record<string, string> = {};
    for (const [o, i] of Object.entries((v.pairs ?? {}) as Record<string, unknown>)) if (present.outputs.includes(o) && typeof i === 'string' && present.inputs.includes(i)) pairs[o] = i;
    return { kinds, pairs, inputOrder, outputOrder, headsetMicOnly: v.headsetMicOnly === true, by: 'claude' };
  } catch { return null; }
}

/**
 * The highest entry of the user's priority list that is plugged in now, as a device id; null = use the system's default (an empty list,
 * or none of its entries available). Nothing switches by itself: the list only changes when the user answers a suggestion or edits it.
 */
export function pickByPriority(order: readonly string[] | undefined, devices: readonly DeviceInfo[], kind: DeviceKind): string | null {
  if (!order?.length) return null;
  const list = real(devices, kind);
  for (const wanted of order) {
    const hit = list.find(d => stripped(d) === wanted);
    if (hit) return isVirtualId(hit.deviceId) ? null : hit.deviceId;
  }
  return null;
}

export interface Suggestion {
  key: string;
  verdict: CallDeviceVerdict;
  /** What the card says, in Chinese (names are the user's own, shown on their own screen). */
  text: string;
  inputOrder: string[];
  outputOrder: string[];
}
const HEADSET_ONLY_NOTE = '现在用的是耳机的麦克风，她的声音会变成电话音质；想更清楚，可以接一个 USB 麦克风或用摄像头上的麦克风';
export const CALL_DEVICE_TEXT = {
  speakersHint: '戴上耳机会更顺：她听不到自己的回声，你插话也更容易',
  headsetMicNote: HEADSET_ONLY_NOTE,
  hintOff: '不再提醒',
  yes: '换', no: '不换', later: '以后再说',
} as const;

/**
 * The card for a verdict, or null when there is nothing to ask: the first microphone of the suggested order is what the call would use
 * anyway, or the user's list already says exactly this.
 */
export function suggestionFor(key: string, verdict: CallDeviceVerdict, reading: CallDeviceReading, current: readonly string[] | undefined): Suggestion | null {
  const first = verdict.inputOrder[0];
  if (!first || !reading.labelsKnown || verdict.headsetMicOnly) return null; // headsetMicOnly is a note (callNote), not a question
  if (JSON.stringify(current ?? []) === JSON.stringify(verdict.inputOrder)) return null;
  if (!current?.length && first === reading.inputName) return null; // she already listens with it (today's behaviour)
  const text = `现在系统用的麦克风是「${reading.inputName ?? '默认'}」。打电话时改用「${first}」，耳机就只用来听，她的声音保持清楚。要换吗？`;
  return { key, verdict, text, inputOrder: verdict.inputOrder, outputOrder: verdict.outputOrder };
}

/** The speakers hint is due at most once a day, and never when the user turned it off or the names could not be read. */
export function speakersHintDue(input: { output: OutputKind; labelsKnown: boolean; off: boolean; lastDay: string | null; today: string }): boolean {
  return input.labelsKnown && !input.off && input.output !== 'headphones' && input.lastDay !== input.today;
}
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
