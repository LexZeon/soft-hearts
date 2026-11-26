/**
 * I-154 batch 6: VMD bytes for a frame-loop test on a fake clock, with no wall-clock or load dependence.
 *
 * The window engine's motions start through real asynchronous steps (the host's grant, the VMD bytes, the parser, the player's start).
 * A loop that only yields a fixed number of turns per frame lets a slow disk (the suite in parallel) push a start a few frames later on
 * its fake clock; a wave that starts late is still playing when the next one comes ("busy"). Here every read is tracked, and `settle()`
 * waits until no read is in flight and their continuations have run: whatever a frame started has landed before the next frame, however
 * long the bytes take. `delayMs` slows every read on purpose (each run then proves the loop does not depend on how fast reading is).
 */
import { readFile } from 'node:fs/promises';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';

type VmdLoader = { loadVMD(url: string, onLoad: (vmd: unknown) => void, onProgress?: unknown, onError?: (error: unknown) => void): void;
  _getParser(): { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): unknown } };

/** A few event-loop turns (microtasks drain before each). */
const turns = async (count = 3) => { for (let k = 0; k < count; k++) await new Promise(resolve => setImmediate(resolve)); };

export function settledVmdBytes(file: (url: string) => URL | string, options: { delayMs?: number } = {}) {
  const loader = MMDLoader.prototype as unknown as VmdLoader, original = loader.loadVMD, inflight = new Set<Promise<void>>();
  const delay = Math.max(0, options.delayMs ?? 0);
  let reads = 0;
  loader.loadVMD = function (this: VmdLoader, url, onLoad, _progress, onError) {
    reads++;
    const read: Promise<void> = new Promise(resolve => setTimeout(resolve, delay))
      .then(() => readFile(file(url)))
      .then(bytes => { onLoad(this._getParser().parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true)); })
      .catch(error => { onError?.(error); })
      .finally(() => { inflight.delete(read); });
    inflight.add(read);
  };
  return {
    /** Until no read is in flight and what they started has run (a start may ask for another read: wait for that too). */
    async settle(): Promise<void> {
      await turns();
      for (let guard = 0; inflight.size && guard < 100; guard++) { await Promise.allSettled([...inflight]); await turns(); }
    },
    get reads() { return reads; },
    restore(): void { loader.loadVMD = original; },
  };
}
