import { randomUUID } from 'node:crypto';
import { parseAudioCaptureAck, type AudioCaptureDescriptor, type AudioCaptureState, type ReadingCaptureToken } from '../shared/audio-capture';
import type { AudioReadingSource } from '../shared/audio-reading-toggles';
import { parseAudioDanceFrame, type AudioDanceFrame } from '../shared/audio-dance';

type Owner = 'controls' | 'pet';
interface AmbientReference {
  token: ReadingCaptureToken; signal: AbortSignal; removeAbort(): void;
  resolve(value: { captureId: string; release(): Promise<void> }): void;
  reject(error: Error): void; accepted: boolean;
}
interface Capture {
  value: AudioCaptureDescriptor; minimumRevision: number; ready: boolean; ambient?: AmbientReference;
  released: Promise<void>; releaseDone(): void;
  lastDanceTime?: number; lastDanceAt?: number;
}
interface Ports {
  available(owner: Owner): boolean;
  publish(state: AudioCaptureState): void;
  lost(source: AudioReadingSource, owner: Owner, ambient: ReadingCaptureToken | null): void;
  id?(): string;
  now?(): number;
}
const sources: AudioReadingSource[] = ['system-audio', 'microphone'];

/** Host-only physical ownership. Renderer acknowledgements report facts, not consent.
 * A last-reference release remains owned until its renderer releases or is destroyed.
 */
export class AudioCaptureHost {
  private slots: Record<AudioReadingSource, Capture | undefined> = { 'system-audio': undefined, microphone: undefined };
  private retiring: Record<AudioReadingSource, Capture | undefined> = { 'system-audio': undefined, microphone: undefined };
  private revision = 0;
  constructor(private readonly ports: Ports) {}

  getState(): AudioCaptureState {
    return { revision: this.revision, slots: {
      'system-audio': this.slots['system-audio'] ? structuredClone(this.slots['system-audio']!.value) : null,
      microphone: this.slots.microphone ? structuredClone(this.slots.microphone.value) : null,
    } };
  }
  selectChatOwner(requested: Owner): Owner {
    if (requested !== 'pet' && requested !== 'controls' || !this.ports.available(requested)) throw Error('Microphone owner is unavailable.');
    if (this.retiring.microphone) throw Error('Previous capture release is still pending.');
    const owner = this.slots.microphone?.value.owner ?? requested;
    if (!this.ports.available(owner)) throw Error('Microphone owner is unavailable.');
    return owner;
  }
  /** The first current owner remains the sole microphone owner across windows. */
  setChat(owner: Owner | null): Owner | null {
    const old = this.slots.microphone;
    if (owner === null) {
      if (old?.value.chat) { old.value.chat = false; this.changed(old); this.maybeRetire('microphone'); }
      return null;
    }
    if (owner !== 'pet' && owner !== 'controls' || !this.ports.available(owner)) throw Error('Microphone owner is unavailable.');
    const capture = old ?? this.create('microphone', owner);
    if (!this.ports.available(capture.value.owner)) throw Error('Microphone owner is unavailable.');
    if (!capture.value.chat) { capture.value.chat = true; this.changed(capture); }
    return capture.value.owner;
  }
  setDance(enabled: boolean, source: AudioReadingSource = 'system-audio'): AudioCaptureState {
    if (typeof enabled !== 'boolean' || !sources.includes(source)) throw Error('Invalid dance intent.');
    let capture = this.slots[source];
    if (enabled) {
      if (!this.ports.available('pet')) throw Error('Pet is unavailable.');
      capture ??= this.create(source, 'pet');
      if (!this.ports.available(capture.value.owner)) throw Error('Capture owner is unavailable.');
    }
    if (capture && capture.value.dance !== enabled) {
      capture.value.dance = enabled; this.changed(capture); this.maybeRetire(source);
    }
    return this.getState();
  }
  /** Only energy from the current ready, explicitly consented physical lifetime. */
  acceptDanceSample(owner: Owner, value: unknown): AudioDanceFrame | null {
    const frame = parseAudioDanceFrame(value);
    if (!frame) return null;
    const capture = this.slots[frame.source], now = (this.ports.now ?? Date.now)();
    if (!capture || !capture.ready || !capture.value.dance || !this.ports.available('pet')
      || !this.ports.available(owner) || capture.value.owner !== owner || capture.value.id !== frame.id
      || capture.value.revision !== frame.revision || !Number.isFinite(now)) return null;
    if (frame.sample === null) { this.setDance(false, frame.source); return frame; }
    if (frame.sample.time <= (capture.lastDanceTime ?? -Infinity)
      || now - (capture.lastDanceAt ?? -Infinity) < 20) return null;
    capture.lastDanceTime = frame.sample.time; capture.lastDanceAt = now;
    return frame;
  }
  acquire(input: { scopeId: string; source: AudioReadingSource; epoch: number; signal: AbortSignal }): Promise<{ captureId: string; release(): Promise<void> }> {
    if (!sources.includes(input.source) || typeof input.scopeId !== 'string' || !input.scopeId || input.scopeId.length > 128
      || /[\x00-\x1f\x7f]/.test(input.scopeId) || !Number.isSafeInteger(input.epoch) || input.epoch < 1)
      return Promise.reject(Error('Invalid ambient capture scope.'));
    if (input.signal.aborted) return Promise.reject(Error('Ambient capture cancelled.'));
    let capture: Capture;
    try {
      capture = this.slots[input.source] ?? this.create(input.source, 'pet');
      if (!this.ports.available(capture.value.owner)) throw Error('Capture owner is unavailable.');
      if (capture.ambient) throw Error('Ambient reference already exists.');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const token = { scopeId: input.scopeId, source: input.source, epoch: input.epoch, captureId: capture.value.id };
      const abort = () => { void this.releaseAmbient(capture, reference, true); };
      const reference: AmbientReference = { token, signal: input.signal, accepted: false,
        resolve, reject, removeAbort: () => input.signal.removeEventListener('abort', abort) };
      capture.ambient = reference; capture.value.ambient = token;
      input.signal.addEventListener('abort', abort, { once: true });
      this.changed(capture);
      if (capture.ready && capture.ambient === reference) this.accept(capture, reference);
      if (input.signal.aborted) abort();
    });
  }
  ack(owner: Owner, value: unknown): boolean {
    const ack = parseAudioCaptureAck(value);
    if (!ack) return false;
    const retired = this.retiring[ack.source];
    if (retired && ack.phase !== 'ready') {
      if (!this.matchesFact(retired, owner, ack.id, ack.revision)
        || ack.phase === 'released' && ack.revision !== retired.value.revision) return false;
      // A native loss can precede a concurrent off edit; it still certifies
      // teardown of this lifetime. Planned releases use the last descriptor.
      this.retiring[ack.source] = undefined; retired.releaseDone(); return true;
    }
    const capture = this.slots[ack.source];
    if (!capture || ack.phase === 'released' || !this.matchesFact(capture, owner, ack.id, ack.revision)) return false;
    if (ack.phase === 'ready') {
      capture.ready = true;
      if (capture.ambient) this.accept(capture, capture.ambient);
      return true;
    }
    const token = capture.value.ambient;
    this.withdraw(capture); this.slots[ack.source] = undefined;
    // A device-loss acknowledgement follows local track/context teardown.
    capture.releaseDone(); this.revision++; this.publish();
    this.ports.lost(ack.source, owner, token); return true;
  }
  /** Permission edits fence PCM buffered before an off/on of a purpose. */
  touch(source: AudioReadingSource): void {
    if (!sources.includes(source)) throw Error('Invalid audio source.');
    const capture = this.slots[source]; if (capture) this.changed(capture);
  }

  /** Navigation starts revoke consumers but cannot certify physical teardown. */
  revokeOwner(owner: Owner): void {
    for (const source of sources) {
      const capture = this.slots[source];
      if (capture?.value.owner !== owner) continue;
      const token = capture.value.ambient;
      this.withdraw(capture); capture.value.chat = capture.value.dance = false;
      this.changed(capture); this.maybeRetire(source);
      this.ports.lost(source, owner, token);
    }
  }
  /** Actual webContents destruction is an independent physical release boundary. */
  dropOwner(owner: Owner): void {
    for (const source of sources) {
      const capture = this.slots[source];
      if (capture?.value.owner === owner) {
        const token = capture.value.ambient; this.withdraw(capture); this.slots[source] = undefined;
        capture.releaseDone(); this.ports.lost(source, owner, token);
      }
      const retired = this.retiring[source];
      if (retired?.value.owner === owner) { this.retiring[source] = undefined; retired.releaseDone(); }
    }
    this.revision++; this.publish();
  }
  clear(): void {
    for (const source of sources) {
      const capture = this.slots[source];
      if (!capture) continue;
      this.withdraw(capture); capture.value.chat = capture.value.dance = false; this.maybeRetire(source);
    }
  }
  private create(source: AudioReadingSource, owner: Owner): Capture {
    if (this.retiring[source]) throw Error('Previous capture release is still pending.');
    if (!this.ports.available(owner)) throw Error('Capture owner is unavailable.');
    const id = (this.ports.id ?? randomUUID)();
    if (!id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) throw Error('Invalid host capture identity.');
    let releaseDone!: () => void;
    const released = new Promise<void>(resolve => { releaseDone = resolve; });
    const capture: Capture = { value: { id, source, owner, revision: ++this.revision, chat: false, dance: false, ambient: null },
      minimumRevision: this.revision + 1, ready: false, released, releaseDone };
    this.slots[source] = capture; return capture;
  }
  private matchesFact(capture: Capture, owner: Owner, id: string, revision: number): boolean {
    return capture.value.id === id && capture.value.owner === owner
      && revision >= capture.minimumRevision && revision <= capture.value.revision;
  }
  private changed(capture: Capture): void { capture.value.revision = ++this.revision; this.publish(); }
  private publish(): void { this.ports.publish(this.getState()); }
  private accept(capture: Capture, reference: AmbientReference): void {
    if (reference.accepted || reference.signal.aborted || capture.ambient !== reference) return;
    reference.accepted = true;
    reference.resolve({ captureId: capture.value.id, release: () => this.releaseAmbient(capture, reference) });
  }
  private withdraw(capture: Capture): void {
    const reference = capture.ambient;
    if (!reference) return;
    capture.ambient = undefined; capture.value.ambient = null; reference.removeAbort();
    if (!reference.accepted) reference.reject(Error('Ambient capture cancelled.'));
  }
  private releaseAmbient(capture: Capture, reference: AmbientReference, abort = false): Promise<void> {
    if (capture.ambient === reference) {
      this.withdraw(capture); this.changed(capture); this.maybeRetire(capture.value.source);
    }
    if (abort && !reference.accepted) reference.reject(Error('Ambient capture cancelled.'));
    return this.retiring[capture.value.source] === capture ? capture.released : Promise.resolve();
  }
  private maybeRetire(source: AudioReadingSource): void {
    const capture = this.slots[source];
    if (!capture || capture.value.chat || capture.value.dance || capture.ambient) return;
    this.slots[source] = undefined; this.retiring[source] = capture;
    // Keep the entire issued physical lifetime; PCM still requires the exact current revision.
    this.revision++; this.publish();
  }
}
