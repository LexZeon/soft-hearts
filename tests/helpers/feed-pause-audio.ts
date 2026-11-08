import type { TestContext } from 'node:test';
import { flush } from './r02-audio-world';

/**
 * B06 feed-pause fakes: a running Web Audio context whose sources honour
 * start(when, offset) and stop(when), and whose gain records its automation,
 * on one millisecond clock shared with timers and performance time.
 */
export interface GainEvent { kind: 'cancel' | 'set' | 'ramp'; value: number; at: number }
export interface PlayedSpan { buffer: number; from: number; to: number; at: number }

export function pauseAudioWorld(t: TestContext) {
  let now = 1000, handles = 0, buffers = 0;
  const due: { id: number; at: number; callback: () => void }[] = [];
  const timers = {
    set(callback: () => void, ms: number) { const id = ++handles; due.push({ id, at: now + Math.max(0, ms), callback }); return id; },
    clear(handle: unknown) { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); },
  };
  const contexts: Context[] = [];
  class Param {
    value = 1; events: GainEvent[] = [];
    cancelScheduledValues(at: number) { this.events.push({ kind: 'cancel', value: this.value, at }); }
    setValueAtTime(value: number, at: number) { this.events.push({ kind: 'set', value, at }); }
    linearRampToValueAtTime(value: number, at: number) { this.events.push({ kind: 'ramp', value, at }); }
    /** Value at context time `x` from the plan that follows the latest cancel at or before `x`. */
    at(x: number): number {
      let start = 0;
      this.events.forEach((event, index) => { if (event.kind === 'cancel' && event.at <= x) start = index + 1; });
      let previous = { value: this.value, at: -Infinity };
      for (const event of this.events.slice(start)) {
        if (event.kind === 'cancel') break;
        if (event.at <= x) { previous = event; continue; }
        return event.kind === 'ramp' ? previous.value + (event.value - previous.value) * (x - previous.at) / (event.at - previous.at) : previous.value;
      }
      return previous.value;
    }
  }
  class Source {
    buffer: { duration: number; id: number } | null = null;
    onended: (() => void) | null = null;
    startAt = -1; offset = 0; stopAt = Infinity; ended = false;
    constructor(private readonly context: Context) {}
    connect() {} disconnect() {}
    start(at = 0, offset = 0) { this.startAt = at; this.offset = offset; }
    stop(at?: number) { this.stopAt = Math.max(this.startAt, at ?? this.context.currentTime); }
    get endAt() { return this.startAt < 0 ? Infinity : Math.min(this.stopAt, this.startAt + (this.buffer?.duration ?? 0) - this.offset); }
  }
  class Context {
    state: AudioContextState = 'running'; baseLatency = 0; outputLatency = 0; destination = {};
    readonly origin = now; sources: Source[] = []; gains: { gain: Param }[] = [];
    constructor() { contexts.push(this); }
    get currentTime() { return (now - this.origin) / 1000; }
    createGain() { const gain = { gain: new Param(), connect() {}, disconnect() {} }; this.gains.push(gain); return gain; }
    createBuffer(_channels: number, frames: number, rate: number) {
      const samples = new Float32Array(frames); return { duration: frames / rate, id: ++buffers, getChannelData: () => samples };
    }
    createBufferSource() { const source = new Source(this); this.sources.push(source); return source; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  async function advance(ms: number) {
    const end = now + ms;
    while (now < end) {
      now++;
      for (const context of contexts) for (const source of context.sources)
        if (!source.ended && source.startAt >= 0 && context.currentTime >= source.endAt - 1e-9) {
          source.ended = true; const ended = source.onended; source.onended = null; ended?.();
        }
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (!next || next.at > now) break;
        due.shift(); next.callback(); await flush();
      }
      await flush();
    }
  }
  /** What each source actually played: buffer, offset range in seconds and when, up to `until`. */
  function played(until = Infinity): PlayedSpan[] {
    const spans: PlayedSpan[] = [];
    for (const context of contexts) for (const source of context.sources) {
      if (source.startAt < 0 || !source.buffer) continue;
      const end = Math.min(source.endAt, until);
      if (end <= source.startAt) continue;
      spans.push({ buffer: source.buffer.id, from: source.offset, to: source.offset + end - source.startAt, at: source.startAt });
    }
    return spans.sort((a, b) => a.at - b.at || a.buffer - b.buffer);
  }
  return { contexts, timers, advance, played, now: () => now, createContext: () => new Context() as unknown as AudioContext };
}

/** A Web Speech fake whose pause() can work, silently fail, or get stuck on resume(). */
export class PausableUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = ''; rate = 1; pitch = 1; volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event?: { error: string }) => void) | null = null;
  onboundary: ((event?: { charIndex: number }) => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;
  constructor(readonly text: string) {}
}

export function pausableEngine(t: TestContext, mode: { pause: 'works' | 'ignored'; resume?: 'works' | 'stuck' } = { pause: 'works' }) {
  let now = 0, ids = 0;
  const due: { at: number; id: number; callback: () => void }[] = [];
  const timers = {
    set: (callback: () => void, ms: number) => { due.push({ at: now + ms, id: ++ids, callback }); return ids; },
    clear: (handle: unknown) => { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); },
  };
  const log: string[] = [];
  const queued: PausableUtterance[] = [];
  let current: PausableUtterance | null = null;
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ voiceURI: 'zh', lang: 'zh-CN' }] as SpeechSynthesisVoice[],
    speak(utterance: PausableUtterance) { queued.push(utterance); log.push(`speak:${utterance.text}@${now}`); },
    cancel() { log.push(`cancel@${now}`); synth.speaking = false; current = null; },
    pause() {
      log.push(`pause@${now}`);
      if (mode.pause === 'works' && synth.speaking && !synth.paused) { synth.paused = true; current?.onpause?.(); }
    },
    resume() {
      log.push(`resume@${now}`);
      if (synth.paused && (mode.resume ?? 'works') === 'works') { synth.paused = false; current?.onresume?.(); }
      else if (!synth.speaking) synth.paused = false;
    },
  };
  const saved = ['speechSynthesis', 'SpeechSynthesisUtterance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: PausableUtterance });
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, writable: true, value: synth });
  t.after(() => { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  return {
    synth, queued, log, timers, now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now++;
        for (;;) {
          due.sort((a, b) => a.at - b.at);
          const next = due[0];
          if (!next || next.at > now) break;
          due.shift(); next.callback(); await flush();
        }
        await flush(); // promise continuations run in the millisecond they become due
      }
      await flush();
    },
    start(utterance: PausableUtterance) { current = utterance; synth.speaking = true; utterance.onstart?.(); },
    boundary(utterance: PausableUtterance, charIndex: number) { utterance.onboundary?.({ charIndex }); },
    end(utterance: PausableUtterance) { synth.speaking = false; if (current === utterance) current = null; utterance.onend?.(); },
  };
}
