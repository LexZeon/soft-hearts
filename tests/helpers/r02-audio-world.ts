import type { TestContext } from 'node:test';

/** R02 test fakes: a millisecond clock shared by timers, performance time and a fake audio device. */
export const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function world(t: TestContext, options: { deviceStartMs?: number } = {}) {
  let now = 1000;
  let handles = 0;
  const due: { id: number; at: number; callback: () => void }[] = [];
  const contexts: FakeContext[] = [];
  const deviceStartMs = options.deviceStartMs ?? 0;
  class FakeSource {
    buffer: { duration: number } | null = null;
    onended: (() => void) | null = null;
    startAt = -1; stopped = 0;
    connect() {} disconnect() {}
    start(at: number) { this.startAt = at; }
    stop() { this.stopped++; }
  }
  class FakeContext {
    state: AudioContextState = 'suspended';
    baseLatency = 0; outputLatency = 0; destination = {};
    sources: FakeSource[] = []; resumes = 0; closes = 0; suspends = 0;
    private runningSince = -1;
    constructor() { contexts.push(this); }
    get currentTime() { return this.runningSince < 0 ? 0 : (now - this.runningSince) / 1000; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBuffer(_channels: number, frames: number, rate: number) {
      const samples = new Float32Array(frames); return { duration: frames / rate, getChannelData: () => samples };
    }
    createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
    resume() {
      this.resumes++;
      // A cold or suspended Windows output device takes `deviceStartMs` to run.
      return new Promise<void>(resolve => timers.set(() => {
        if (this.state !== 'closed') { this.state = 'running'; this.runningSince = now; }
        resolve();
      }, deviceStartMs));
    }
    suspend() { this.suspends++; this.state = 'suspended'; this.runningSince = -1; return Promise.resolve(); }
    close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }
  }
  const timers = {
    set(callback: () => void, ms: number) { const id = ++handles; due.push({ id, at: now + Math.max(0, ms), callback }); return id; },
    clear(handle: unknown) { const index = due.findIndex(item => item.id === handle); if (index >= 0) due.splice(index, 1); },
  };
  /** Advance time in 1 ms steps so device starts, audible polls and source ends interleave correctly. */
  async function advance(ms: number) {
    const end = now + ms;
    while (now < end) {
      now++;
      for (const context of contexts) for (const source of context.sources)
        if (source.onended && source.startAt >= 0 && context.currentTime >= source.startAt + (source.buffer?.duration ?? 0)) { const ended = source.onended; source.onended = null; ended(); }
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (!next || next.at > now) break;
        due.shift(); next.callback(); await flush();
      }
      await flush();
    }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: FakeContext });
  t.after(() => { if (saved) Object.defineProperty(globalThis, 'AudioContext', saved); else Reflect.deleteProperty(globalThis, 'AudioContext'); });
  return { contexts, timers, advance, now: () => now, createContext: () => new FakeContext() as unknown as AudioContext };
}

/** 24 kHz PCM16 silence; 4800 frames = 0.2 s. */
export const pcm = (frames = 4800) => Buffer.alloc(frames * 2).toString('base64');
