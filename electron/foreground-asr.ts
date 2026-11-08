import type { MediaOwner } from './runtime';

interface ForegroundAsrPorts {
  pauseAndDrain(): Promise<void> | undefined;
  transcribe(wav: ArrayBuffer, signal: AbortSignal): Promise<string>;
  entered(owner: MediaOwner, controller: AbortController): void;
  exited(controller: AbortController): void;
}
/** One real recognizer plus at most one successor, shared by legacy and voice.
 * Aborting a dependency never substitutes for its actual Promise settlement. */
export class ForegroundAsr {
  private tail: Promise<unknown> | null = null;
  private admitted = 0;
  private background = new Set<AbortController>();
  constructor(private readonly ports: ForegroundAsrPorts) {}
  get busy(): boolean { return this.admitted > 0 || this.background.size > 0; }
  get foregroundBusy(): boolean { return this.admitted > 0; }
  run(owner: MediaOwner, wav: ArrayBuffer, signal: AbortSignal, current: () => boolean): Promise<string> {
    if (this.admitted >= 2) return Promise.reject(Error('语音识别队列已满。'));
    this.admitted++;
    for (const background of this.background) background.abort();
    const previous = this.tail, controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const assertCurrent = () => { controller.signal.throwIfAborted(); if (!current()) throw Error('语音输入已停止。'); };
    let operation!: Promise<string>, entered = false;
    operation = (async () => {
      try {
        await previous?.catch(() => {});
        assertCurrent(); entered = true; this.ports.entered(owner, controller);
        await this.ports.pauseAndDrain();
        assertCurrent();
        const text = await this.ports.transcribe(wav, controller.signal);
        assertCurrent(); return text;
      } finally {
        signal.removeEventListener('abort', abort);
        this.admitted--;
        if (this.tail === operation) this.tail = null;
        if (entered) this.ports.exited(controller);
      }
    })();
    this.tail = operation;
    return operation;
  }
  /** Host-only ambient operation: same actual Promise lane, never user/chat dispatch. */
  runBackground<T>(signal: AbortSignal, current: () => boolean, recognize: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.admitted || this.background.size >= 2) return Promise.reject(Error('语音识别连接正忙。'));
    const previous = this.tail, controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    this.background.add(controller);
    let operation!: Promise<T>;
    operation = (async () => {
      try {
        await previous?.catch(() => {});
        controller.signal.throwIfAborted();
        if (!current() || this.admitted) throw Error('背景音频转写已暂停。');
        const result = await recognize(controller.signal);
        controller.signal.throwIfAborted();
        if (!current()) throw Error('背景音频范围已变更。');
        return result;
      } finally {
        signal.removeEventListener('abort', abort); this.background.delete(controller);
        if (this.tail === operation) this.tail = null;
      }
    })();
    this.tail = operation; return operation;
  }

}
