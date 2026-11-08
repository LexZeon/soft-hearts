import { createHash, randomUUID } from 'node:crypto';
import type { VoiceInputConfig } from '../shared/contracts';
import {
  AMBIENT_AUDIO_LIMITS, validateAmbientLanguage,
  type AmbientLanguage, type AmbientLanguageDetection, type AmbientMode, type AmbientScope, type AmbientTranscript,
} from '../shared/ambient-audio';
import type { AmbientAudioStore } from './ambient-audio-store';
import type {
  AmbientRuntimeReason, AmbientRuntimeState, AmbientRuntimeSession, AmbientRuntimeSubmission, AmbientSubmissionResult,
} from '../shared/ambient-audio-runtime';
export type {
  AmbientRuntimeReason, AmbientRuntimeState, AmbientRuntimeSession, AmbientRuntimeSubmission, AmbientSubmissionResult,
} from '../shared/ambient-audio-runtime';

const STATUS: Record<AmbientRuntimeReason, string> = {
  off: '声音理解已关闭', listening: '等待系统声音片段', transcribing: '正在理解系统声音…',
  speaking: '语音活动期间暂停理解系统声音', 'asr-busy': '转写连接正忙，稍后继续',
  'recognition-error': '系统声音转写未完成，请检查转写连接。',
  'archive-error': '系统声音文字未能保存，原有记录保持。',
};

export interface AmbientAudioRuntimeDependencies {
  getScope(): AmbientScope;
  getContextIdentity(): string;
  /** Host supplies an automatic-detection clone, with no persisted setting change. */
  getVoiceConfig(): VoiceInputConfig;
  /** Checks pet-window ownership, visibility and the host's verified ASR capability. */
  canStart(owner: number): boolean;
  /** False while the microphone ASR or its maintenance owner holds this connection. */
  canTranscribe(): boolean;
  /** Entry-only rate/backoff gate. A request already in flight remains valid when it closes. */
  canDispatch?(): boolean;
  isSpeaking(): boolean;
  transcribe(config: VoiceInputConfig, wav: ArrayBuffer, signal: AbortSignal): Promise<{ text: string; language: AmbientLanguage; languageDetection?: AmbientLanguageDetection }>;
  store: Pick<AmbientAudioStore, 'append' | 'clearTransient' | 'invalidatePendingTransient'>;
  onState?(state: AmbientRuntimeState): void;
  onTranscript?(record: AmbientTranscript): void;
  now?: () => number;
  createId?: () => string;
  /** Testable deadline source; production uses a real two-second AbortSignal timer. */
  drainTimeoutSignal?(milliseconds: number): AbortSignal;
}

interface Receipt {
  fingerprint: string;
  promise?: Promise<AmbientSubmissionResult>;
  result?: AmbientSubmissionResult;
  error?: string;
}
interface Session {
  owner: number;
  id: string;
  startedAt: number;
  captureReadyAt: number | null;
  mode: AmbientMode;
  scope: AmbientScope;
  contextHash: string;
  generation: number;
  highestSequence: number;
  lastEndOffsetMs: number;
  receipts: Map<number, Receipt>;
  error: 'recognition-error' | 'archive-error' | null;
}
interface Pending { session: Session; generation: number; sequence: number; controller: AbortController }
interface ValidSubmission extends AmbientRuntimeSubmission { fingerprint: string }

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const ownerId = (value: number): void => { if (!Number.isSafeInteger(value) || value <= 0) throw new Error('系统声音窗口身份不正确。'); };
function hostScope(value: AmbientScope): AmbientScope {
  const valid = (text: unknown, maximum: number) => typeof text === 'string' && !!text.trim() && text.length <= maximum && !text.includes('\0');
  if (!value || !valid(value.characterId, 256) || !valid(value.providerScope, 4096)) throw new Error('系统声音角色范围不正确。');
  return { characterId: value.characterId, providerScope: value.providerScope };
}
const scopeIdentity = (scope: AmbientScope): string => JSON.stringify([scope.characterId, scope.providerScope]);
function contextIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) throw new Error('系统声音会话范围不正确。');
  return value;
}
function clock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('系统声音主进程时间不正确。');
  return value;
}
function copyVoiceConfig(value: VoiceInputConfig): VoiceInputConfig {
  if (!value || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048
    || typeof value.model !== 'string' || value.model.length > 200
    || value.language !== '' || value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192))
    throw new Error('系统声音需要主进程提供自动语言检测的转写连接。');
  // No reference to this private clone is retained in a session, receipt or public state.
  return { baseUrl: value.baseUrl, model: value.model, language: '', ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }) };
}
function validateSubmission(value: unknown, session: Session, now: number): ValidSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统声音片段格式不正确。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['sessionId', 'sequence', 'wav', 'startOffsetMs', 'endOffsetMs'].includes(key)))
    throw new Error('系统声音片段不能携带路径、语言或角色指令。');
  if (typeof input.sessionId !== 'string' || !TOKEN.test(input.sessionId) || input.sessionId !== session.id || !sequence(input.sequence))
    throw new Error('系统声音片段不属于当前会话。');
  const start = input.startOffsetMs, end = input.endOffsetMs;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end <= start || end - start > 12_000 + 0.001 || end > now - session.startedAt + 250)
    throw new Error('系统声音片段时间不正确或超出当前会话。');
  if (!(input.wav instanceof ArrayBuffer) || input.wav.byteLength <= 44 || input.wav.byteLength > 44 + 12 * 32000)
    throw new Error('系统声音只接受十二秒以内的 PCM WAV。');
  const wav = input.wav.slice(0), view = new DataView(wav), bytes = new Uint8Array(wav);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data'
    || view.getUint32(4, true) + 8 !== wav.byteLength || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000
    || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== wav.byteLength - 44 || (wav.byteLength - 44) % 2 !== 0)
    throw new Error('系统声音只接受标准 16 kHz、单声道、16-bit PCM WAV。');
  if (Math.abs((wav.byteLength - 44) / 32 - (end - start)) > 2)
    throw new Error('系统声音片段时间与音频长度不一致。');
  const fingerprint = digest(JSON.stringify([session.id, input.sequence, start, end, digest(bytes)]));
  return { sessionId: session.id, sequence: input.sequence, wav, startOffsetMs: start, endOffsetMs: end, fingerprint };
}

/** One host-authorized pet session. No renderer paths, credentials, personality or language metadata. */
export class AmbientAudioRuntime {
  private session: Session | null = null;
  private pending: Pending | null = null;
  private suspended = false;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly usedIds = new Set<string>();

  constructor(private readonly dependencies: AmbientAudioRuntimeDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? randomUUID;
  }

  getState(): AmbientRuntimeState {
    this.checkedSession();
    return this.publicState();
  }
  get state(): AmbientRuntimeState { return this.getState(); }
  /** Host-only actual request ownership, including ignored cancellation. */
  get busy(): boolean { return this.pending !== null; }

  /** Host-only: never send this snapshot over IPC. */
  currentSession(): AmbientRuntimeSession | null {
    const session = this.checkedSession();
    if (!session) return null;
    return { owner: session.owner, sessionId: session.id, startedAt: session.startedAt, captureReadyAt: session.captureReadyAt, mode: session.mode,
      scope: { ...session.scope }, contextIdentity: contextIdentity(this.dependencies.getContextIdentity()) };
  }

  begin(owner: number, mode: unknown): AmbientRuntimeState {
    ownerId(owner);
    if (mode !== 'music' && mode !== 'movie') throw new Error('请选择听音乐或陪看电影。');
    if (!this.dependencies.canStart(owner)) throw new Error('请在可见桌宠中明确开启已验证的声音理解。');
    const current = this.checkedSession();
    if (current && current.owner !== owner) throw new Error('系统声音理解已由另一个窗口使用。');
    const id = this.createId();
    if (!TOKEN.test(id) || this.usedIds.has(id)) throw new Error('系统声音会话身份未能创建。');
    const scope = hostScope(this.dependencies.getScope());
    const identity = contextIdentity(this.dependencies.getContextIdentity()), startedAt = clock(this.now());
    this.endSession();
    this.usedIds.add(id); while (this.usedIds.size > 128) this.usedIds.delete(this.usedIds.values().next().value!);
    this.session = { owner, id, mode, startedAt, captureReadyAt: null, scope, contextHash: digest(identity), generation: 0,
      highestSequence: 0, lastEndOffsetMs: 0, receipts: new Map(), error: null };
    this.emit(); return this.publicState();
  }

  /** Owner-scoped readiness, not another capture grant or a new session clock. */
  confirmCapture(owner: number, sessionId: unknown): void {
    ownerId(owner);
    const session = this.checkedSession();
    if (!session || session.owner !== owner || typeof sessionId !== 'string' || session.id !== sessionId)
      throw new Error('系统声音采集会话已失效。');
    if (session.captureReadyAt === null) session.captureReadyAt = clock(this.now());
  }

  stop(owner?: number): AmbientRuntimeState {
    if (owner !== undefined) {
      ownerId(owner);
      if (this.session && this.session.owner !== owner) throw new Error('此窗口未开启系统声音理解。');
    }
    this.endSession(); this.emit(); return this.publicState();
  }
  dropOwner(owner: number): AmbientRuntimeState {
    ownerId(owner);
    if (this.session?.owner === owner) this.endSession();
    this.emit(); return this.publicState();
  }
  clearContext(): AmbientRuntimeState { return this.stop(); }

  /** Only suppresses an explicitly active session. It never starts/resumes capture. */
  setSuspended(active: boolean): AmbientRuntimeState {
    if (typeof active !== 'boolean') throw new Error('系统声音朗读避让状态不正确。');
    if (active !== this.suspended) {
      this.suspended = active;
      if (active && this.session) {
        this.session.generation++;
        this.pending?.controller.abort();
        this.dependencies.store.invalidatePendingTransient(this.session.scope);
      }
    }
    this.checkedSession(); this.emit(); return this.publicState();
  }

  /** Host microphone handoff: abort is not proof that the prior request settled. */
  async pauseAndDrain(): Promise<void> {
    this.setSuspended(true);
    const pending = this.pending;
    if (!pending) return;
    pending.controller.abort();
    // A re-entrant handoff during dispatch must allow its receipt to be attached.
    await Promise.resolve();
    if (this.pending !== pending) return;
    const completion = pending.session.receipts.get(pending.sequence)?.promise;
    const message = '系统声音转写仍在结束，请稍后重试语音输入';
    if (!completion) throw new Error(message);
    const timeout = this.dependencies.drainTimeoutSignal?.(2000) ?? AbortSignal.timeout(2000);
    await new Promise<void>((resolve, reject) => {
      const expired = () => { timeout.removeEventListener('abort', expired); reject(new Error(message)); };
      const settled = () => { timeout.removeEventListener('abort', expired); resolve(); };
      if (timeout.aborted) { expired(); return; }
      timeout.addEventListener('abort', expired, { once: true });
      // Both success and failure must reach the receipt's final pending-slot release.
      void completion.then(settled, settled);
    });
  }

  submit(owner: number, value: unknown): Promise<AmbientSubmissionResult> {
    ownerId(owner);
    const session = this.checkedSession();
    if (!session || owner !== session.owner) throw new Error('此窗口没有当前系统声音理解授权。');
    const input = validateSubmission(value, session, clock(this.now()));
    const existing = session.receipts.get(input.sequence);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new Error('同一系统声音片段编号不能更换内容。');
      if (existing.error) return Promise.reject(new Error(existing.error));
      return existing.promise ?? Promise.resolve({ ...existing.result! });
    }
    // Gaps are permitted: renderer backpressure may deliberately skip a segment.
    if (input.sequence <= session.highestSequence || input.startOffsetMs < session.lastEndOffsetMs - 2)
      throw new Error('系统声音片段顺序不正确或已过期。');
    if (this.pending) throw new Error('上一段系统声音仍在结束，请稍后重试。');
    const receipt: Receipt = { fingerprint: input.fingerprint };
    session.receipts.set(input.sequence, receipt);
    session.highestSequence = input.sequence; session.lastEndOffsetMs = input.endOffsetMs;
    while (session.receipts.size > 32) session.receipts.delete(session.receipts.keys().next().value!);
    session.error = null;
    if (this.paused() || this.dependencies.canDispatch?.() === false) {
      receipt.result = { status: 'paused', sessionId: session.id, sequence: input.sequence };
      this.emit(); return Promise.resolve({ ...receipt.result });
    }
    const pending: Pending = { session, generation: session.generation, sequence: input.sequence, controller: new AbortController() };
    this.pending = pending;
    const promise = this.dispatch(pending, input).then(result => { receipt.result = { ...result }; return result; }, error => {
      const message = error instanceof Error ? error.message : STATUS['recognition-error'];
      receipt.error = message; throw new Error(message);
    }).finally(() => { receipt.promise = undefined; if (this.pending === pending) this.pending = null; this.emit(); });
    receipt.promise = promise; this.emit(); return promise;
  }

  private async dispatch(pending: Pending, input: ValidSubmission): Promise<AmbientSubmissionResult> {
    const session = pending.session;
    const base = { sessionId: session.id, sequence: input.sequence };
    let phase: 'recognition-error' | 'archive-error' = 'recognition-error';
    try {
      if (!this.current(pending)) return { ...base, status: 'cancelled' };
      const config = copyVoiceConfig(this.dependencies.getVoiceConfig());
      const result = await this.dependencies.transcribe(config, input.wav, pending.controller.signal);
      if (!this.current(pending)) return { ...base, status: 'cancelled' };
      if (!result || typeof result.text !== 'string' || result.text.length > AMBIENT_AUDIO_LIMITS.segmentCharacters || result.text.includes('\0'))
        throw new Error('Invalid transcription');
      const language = validateAmbientLanguage(result.language);
      if (!result.text.trim()) return { ...base, status: 'empty' };
      const diagnostic = result.languageDetection;
      if (diagnostic && (diagnostic.version !== 2
        || Object.keys(diagnostic).some(key => !['version', 'scope', 'windowAnalysis'].includes(key))
        || !['whole-result', 'subwindow-observations'].includes(diagnostic.scope)
        || !['not-requested', 'skipped-empty', 'failed', 'complete'].includes(diagnostic.windowAnalysis)))
        throw new Error('Invalid language evidence');
      // Keep truthful whole-only/failed analysis visible after the adapter result
      // is discarded, using bounded existing metadata rather than raw payloads.
      const tags = diagnostic ? [`language-scope:${diagnostic.scope}`, `window-analysis:${diagnostic.windowAnalysis}`] : undefined;
      const startedAt = Math.round(session.startedAt + input.startOffsetMs), endedAt = Math.round(session.startedAt + input.endOffsetMs);
      phase = 'archive-error';
      const appended = await this.dependencies.store.append(session.scope, {
        id: `${session.id}:${input.sequence}`, sessionId: session.id, mode: session.mode, startedAt, endedAt, text: result.text, language,
        ...(tags ? { tags } : {}),
      });
      // A save already in progress may finish durably. Its old context never returns.
      if (!this.current(pending)) return { ...base, status: 'cancelled' };
      if (appended.inserted) {
        try { this.dependencies.onTranscript?.(appended.record); }
        catch { /* A view callback cannot make a durable segment replay its ASR request. */ }
      }
      return { ...base, status: 'accepted', recordId: appended.record.id, inserted: appended.inserted };
    } catch {
      if (!this.current(pending)) return { ...base, status: 'cancelled' };
      session.error = phase; throw new Error(STATUS[phase]);
    }
  }

  private current(pending: Pending): boolean {
    return !pending.controller.signal.aborted && this.checkedSession() === pending.session
      && pending.generation === pending.session.generation && !this.paused();
  }
  private paused(): boolean {
    return this.suspended || this.dependencies.isSpeaking() || !this.dependencies.canTranscribe();
  }
  private checkedSession(): Session | null {
    const session = this.session;
    if (!session) return null;
    try {
      if (!this.dependencies.canStart(session.owner)
        || scopeIdentity(hostScope(this.dependencies.getScope())) !== scopeIdentity(session.scope)
        || digest(contextIdentity(this.dependencies.getContextIdentity())) !== session.contextHash) {
        this.endSession(); this.emit(); return null;
      }
    } catch { this.endSession(); this.emit(); return null; }
    return session;
  }
  private endSession(): void {
    const session = this.session; this.session = null;
    if (session) { session.generation++; this.dependencies.store.clearTransient(session.scope); }
    // Retain the one global pending slot until settlement, even if a dependency ignores abort.
    this.pending?.controller.abort();
  }
  private publicState(): AmbientRuntimeState {
    const session = this.session;
    const speaking = this.suspended || this.dependencies.isSpeaking();
    const reason: AmbientRuntimeReason = !session ? 'off' : speaking ? 'speaking'
      : !this.dependencies.canTranscribe() || this.pending && this.pending.session !== session ? 'asr-busy'
      : this.pending ? 'transcribing' : session.error ?? (this.dependencies.canDispatch?.() === false ? 'asr-busy' : 'listening');
    return { active: session !== null, sessionId: session?.id ?? null, startedAt: session?.startedAt ?? null,
      mode: session?.mode ?? null, suspended: !!session && speaking, reason, status: STATUS[reason], origin: 'system-audio' };
  }
  private emit(): void {
    try { this.dependencies.onState?.(this.publicState()); }
    catch { /* A disposed view is not permission to restart or replay anything. */ }
  }
}
