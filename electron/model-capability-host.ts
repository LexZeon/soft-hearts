import type { ModelProfile } from '../shared/model-profile';
import type { HaikuMatches } from '../shared/model-capability';
import {
  MODEL_CHECK_SYSTEM_PROMPT, MODEL_CHECK_TIMEOUT_MS, MODEL_CHECK_VERSION, candidateCount, emptyCandidates, isModelCapabilityId, matchCount,
  modelCheckPrompt, parseHaikuCandidates, recordChecked, validateCapabilityChoice, validateHaikuMatches, validateModelCheckRequest,
  type CapabilityPreviewRequest, type CapabilityPreviewResult, type ModelCapabilityRecord, type ModelCapabilityUpdate,
  type ModelCapabilityView, type ModelCheckAskResult, type ModelCheckAsked,
} from '../shared/model-capability-check';
import type { ModelCapabilityStore } from './model-capability-store';

export interface ModelCapabilityHostPorts {
  /** The current model's content hash and asset URL; throws when the model changed while it was hashed. */
  current(): Promise<{ modelKey: string | null; modelUrl: string }>;
  /** The A1 profile cached for this model (after pending profile writes). */
  profile(modelKey: string): Promise<ModelProfile | null>;
  store: Pick<ModelCapabilityStore, 'get' | 'update'>;
  /** Claude can be asked now (chat availability). */
  available(): boolean;
  /** One small tool-less call (electron/inner-loop/model.ts quickLineWithClaude, haiku). */
  ask(prompt: string, systemPrompt: string, signal: AbortSignal): Promise<{ text: string }>;
  developerMode(): boolean;
  log?(line: string): void;
  broadcast(update: ModelCapabilityUpdate): void;
  now?(): number;
  timeoutMs?: number;
}

/**
 * I-024 模型体检 in the host (docs/claude/2026-11-04-i024-capability-host.md). Pages send this model's own part names and
 * the slots its names did not cover; haiku is asked at most once per model (an answer, "nothing fits" and a failure are all
 * remembered), never while Claude is unavailable, and sees nothing else. Pages check haiku's names on the real mesh and report
 * only what passed. The user's on/off is stored per model and broadcast at once to both windows.
 */
export class ModelCapabilityHost {
  private readonly inFlight = new Map<string, Promise<ModelCheckAskResult>>();
  /** For the developer-mode line once the page reports what passed: how many slots were asked and how long haiku took. */
  private readonly lastAsk = new Map<string, { slots: number; ms: number }>();

  constructor(private readonly ports: ModelCapabilityHostPorts) {}

  async view(): Promise<ModelCapabilityView> {
    const { modelKey, modelUrl } = await this.ports.current();
    if (!modelKey) return { modelKey: null, modelUrl, profile: null, record: null };
    return { modelKey, modelUrl, profile: await this.ports.profile(modelKey), record: this.ports.store.get(modelKey) };
  }

  /** What the stage fills into this model's profile on load (getModelProfile): checked matches of a finished check only. */
  haikuFor(modelKey: string | null): HaikuMatches | null {
    const record = modelKey ? this.ports.store.get(modelKey) : null;
    return record && recordChecked(record) && matchCount(record.haiku) ? record.haiku : null;
  }

  async ask(modelKey: unknown, request: unknown): Promise<ModelCheckAskResult> {
    const valid = validateModelCheckRequest(request);
    const key = await this.requireCurrent(modelKey);
    const stored = this.ports.store.get(key);
    if (stored?.asked && stored.checkVersion === MODEL_CHECK_VERSION)
      return { status: 'stored', candidates: stored.asked.outcome === 'failed' ? null : stored.asked.candidates };
    const running = this.inFlight.get(key);
    if (running) return running;
    if (!this.ports.available()) return { status: 'unavailable', candidates: null };
    const task = (async (): Promise<ModelCheckAskResult> => {
      const now = this.ports.now ?? Date.now, started = now(), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.ports.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS);
      let candidates = null;
      try {
        const answer = await this.ports.ask(modelCheckPrompt(valid), MODEL_CHECK_SYSTEM_PROMPT, controller.signal);
        candidates = controller.signal.aborted ? null : parseHaikuCandidates(answer?.text ?? '', valid);
      } catch { candidates = null; } finally { clearTimeout(timer); }
      const slots = valid.wanted.morphs.length + valid.wanted.bones.length;
      const asked: ModelCheckAsked = { at: now(), outcome: !candidates ? 'failed' : candidateCount(candidates) ? 'matched' : 'none', slots,
        candidates: candidates ?? emptyCandidates() };
      this.lastAsk.set(key, { slots, ms: Math.max(0, now() - started) });
      await this.ports.store.update(key, record => ({ ...this.current(record), asked }));
      return { status: candidates ? 'asked' : 'failed', candidates };
    })();
    this.inFlight.set(key, task);
    try { return await task; } finally { if (this.inFlight.get(key) === task) this.inFlight.delete(key); }
  }

  /** What passed the vertex check (only slots haiku named can be matched); marks this model checked. */
  async saveCheck(modelKey: unknown, matches: unknown): Promise<ModelCapabilityRecord> {
    const valid = validateHaikuMatches(matches);
    const key = await this.requireCurrent(modelKey);
    const proposed = this.ports.store.get(key)?.asked?.candidates;
    for (const slot of Object.keys(valid.morphs ?? {})) if (!proposed?.morphs[slot as keyof typeof proposed.morphs]?.length) throw new Error('这一项不是 haiku 给的候选。');
    for (const bone of Object.keys(valid.bones ?? {})) if (!proposed?.bones[bone as keyof typeof proposed.bones]?.length) throw new Error('这一项不是 haiku 给的候选。');
    const now = this.ports.now ?? Date.now;
    const { record, changed } = await this.ports.store.update(key, before => {
      const base = this.current(before);
      return base.checkedAt !== null && JSON.stringify(base.haiku) === JSON.stringify(valid) ? base : { ...base, haiku: valid, checkedAt: now() };
    });
    const asked = this.lastAsk.get(key);
    if (asked) {
      this.lastAsk.delete(key);
      let developer = false;
      try { developer = this.ports.developerMode() === true; } catch { developer = false; }
      // Counts and time only, never a name.
      if (developer) this.ports.log?.(`[模型体检] 问了 ${asked.slots} 项，对上 ${matchCount(valid)} 项，${asked.ms} 毫秒`);
    }
    if (changed) this.publish(key, record);
    return record;
  }

  async setChoice(modelKey: unknown, id: unknown, choice: unknown): Promise<ModelCapabilityRecord> {
    const valid = validateCapabilityChoice(id, choice);
    const key = await this.requireCurrent(modelKey);
    const { record, changed } = await this.ports.store.update(key, before => {
      const choices = { ...before.choices };
      if (valid.choice === null) delete choices[valid.id]; else choices[valid.id] = valid.choice;
      return { ...before, choices };
    });
    if (changed) this.publish(key, record);
    return record;
  }

  /** A record from an older check version keeps only the user's choices (the check runs again). */
  private current(record: ModelCapabilityRecord): ModelCapabilityRecord {
    return record.checkVersion === MODEL_CHECK_VERSION ? record : { ...record, checkVersion: MODEL_CHECK_VERSION, checkedAt: null, haiku: {}, asked: null };
  }

  private async requireCurrent(modelKey: unknown): Promise<string> {
    const { modelKey: key } = await this.ports.current();
    if (!key || key !== modelKey) throw new Error('模型已切换，请重新读取模型体检。');
    return key;
  }

  private publish(modelKey: string, record: ModelCapabilityRecord): void {
    try { this.ports.broadcast({ modelKey, record }); } catch { /* A closed window reads the record again on its next model load. */ }
  }
}

export interface CapabilityPreviewPorts {
  /** Sends the request to the pet window; false when the pet is not shown. */
  send(request: CapabilityPreviewRequest): boolean;
  /** The pet window's sender id (only it may answer). */
  petSender(): number | null;
  id(): string;
  timeoutMs?: number;
}

/**
 * 试一下 on the character page → the pet's stage (stage.previewCapability) and its answer back. Only a capability id crosses;
 * a late, foreign or unknown answer is ignored, and no answer in time is "not ready".
 */
export class CapabilityPreviewRelay {
  private readonly waiting = new Map<string, { resolve(result: CapabilityPreviewResult): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly ports: CapabilityPreviewPorts) {}

  request(id: unknown): Promise<CapabilityPreviewResult> {
    if (!isModelCapabilityId(id)) return Promise.reject(new Error('能力编号不正确。'));
    const requestId = this.ports.id();
    return new Promise<CapabilityPreviewResult>(resolve => {
      const timer = setTimeout(() => { if (this.waiting.delete(requestId)) resolve('not-ready'); }, this.ports.timeoutMs ?? 3_000);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.set(requestId, { resolve, timer });
      let sent = false;
      try { sent = this.ports.send({ requestId, id }); } catch { sent = false; }
      if (!sent) { clearTimeout(timer); this.waiting.delete(requestId); resolve('pet-hidden'); }
    });
  }

  report(sender: number, requestId: unknown, ok: unknown): void {
    if (sender !== this.ports.petSender() || typeof requestId !== 'string' || typeof ok !== 'boolean') throw new Error('试一下的回执不正确。');
    const entry = this.waiting.get(requestId);
    if (!entry) return;
    this.waiting.delete(requestId); clearTimeout(entry.timer);
    entry.resolve(ok ? 'shown' : 'cannot');
  }
}
