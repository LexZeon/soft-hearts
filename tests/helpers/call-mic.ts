// Synthetic microphone for call tests (moved from tests/i091-voice-call.test.ts, 2026-11-19): deterministic noise-like chunks, her echo,
// and a MediaInput with a fake desktop API, a manual clock and captured timers. No microphone, no Electron.
import { MediaInput, type CallInputEvent } from '../../src/senses/MediaInput';

// ---------------------------------------------------------------- synthetic audio

export const RATE = 16000, CHUNK = 1024; // 64 ms chunks
/** A chunk of noise-like signal with this RMS (deterministic). */
export function chunk(rms: number, seed = 1): Float32Array {
  const out = new Float32Array(CHUNK);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < CHUNK; i++) { x = (x * 9301 + 49297) % 233280; out[i] = (x / 233280 * 2 - 1) * rms * Math.sqrt(3); }
  return out;
}
/** Her voice coming back through the speakers: syllable-like, between `low` and `high` RMS. */
export const echo = (index: number, low: number, high: number) => chunk(index % 4 < 2 ? high : low, index);
export const mix = (a: Float32Array, b: Float32Array) => a.map((value, i) => value + b[i]);

export interface Mic {
  media: MediaInput; signals: string[]; events: CallInputEvent['type'][]; submits: ArrayBuffer[]; timers: { fn: () => void; ms: number }[];
  feed(rms: number | Float32Array, count?: number): void; settle(): Promise<void>; runTimers(): Promise<void>;
}
export async function mic(run: (m: Mic) => Promise<void>, pushToTalk = true): Promise<void> {
  const names = ['window', 'performance', 'setTimeout', 'clearTimeout'] as const;
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realSetTimeout = setTimeout;
  const signals: string[] = [], events: CallInputEvent['type'][] = [], submits: ArrayBuffer[] = [], timers: { fn: () => void; ms: number }[] = [];
  let now = 1000, seq = 0;
  const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  install('performance', { now: () => now });
  install('setTimeout', (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; });
  install('clearTimeout', (id: number) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; });
  install('window', { desktop: {
    openVoiceCapture: async () => ({ captureSessionId: 'capture', epoch: 'epoch' }),
    signalVoiceCapture: async (_id: string, signal: string) => { signals.push(signal); return true; },
    submitVoicePcm: async (value: { wav: ArrayBuffer; captureSeq: number }) => { submits.push(value.wav); return { state: 'queued', groupId: 'g', segmentId: 's' + (++seq), captureSeq: value.captureSeq }; },
    noteJournalFact: async () => true,
  } });
  const media = new MediaInput({ windowKind: 'controls', pushToTalk, onTranscript: () => {}, onError: message => { throw Error(message); },
    onCallEvent: event => events.push(event.type) });
  const flush = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', cameraSharing: false, cameraOwner: null, screenSharing: false });
    media.microphoneReady(true);
    await run({ media, signals, events, submits, timers,
      feed: (value, count = 1) => { for (let i = 0; i < count; i++) { media.pushVoicePcm(typeof value === 'number' ? chunk(value, i + now) : value, RATE); now += CHUNK / RATE * 1000; } },
      settle: async () => { for (let i = 0; i < 5; i++) await flush(); },
      runTimers: async () => { const due = timers.splice(0); for (const timer of due) timer.fn(); for (let i = 0; i < 5; i++) await flush(); } });
  } finally {
    media.dispose();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
}
export const wavSeconds = (wav: ArrayBuffer) => new DataView(wav).getUint32(40, true) / 2 / 16000;
