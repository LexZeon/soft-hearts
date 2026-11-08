import type { CompanionBooleanActionId, CompanionCommandAction, CompanionCommandCandidate, CompanionCommandChoiceRequest,
  CompanionCommandIntentInput, CompanionCommandReceipt, CompanionCommandView } from '../shared/companion-commands';

import type { PetFramingPreset } from '../shared/pet-framing';
export interface FramingTargetState { contextId: string; value: false; revision: number; identity: object; }
export interface CommandTargetState { contextId: string; value: boolean; revision: number; }
export interface ReadoutVolumeTargetState { contextId: string; value: number; revision: number; }
export interface ReadoutStopTargetState { contextId: string; value: false; revision: 0; identity: object | null; }
export interface CommandCommitResult {
  persistence: CompanionCommandReceipt['persistence'];
  presentation: CompanionCommandReceipt['presentation'];
  value?: boolean | number | PetFramingPreset;
  nativeValue?: boolean;
}
export interface CompanionCommandPorts {
  now(): number;
  id(): string;
  target(owner: number, actionId: CompanionBooleanActionId, completingOwnHide?: boolean): CommandTargetState | null;
  volumeTarget?(owner: number): ReadoutVolumeTargetState | null;
  breathTarget?(owner: number): ReadoutVolumeTargetState | null;
  commitBreath?(value: number | true): Promise<CommandCommitResult>;
  framingTarget?(owner: number): FramingTargetState | null;
  cancelFrame?(): void;
  frame?(preset: PetFramingPreset, identity: object, current: () => boolean): Promise<CommandCommitResult>;
  readoutTarget?(owner: number): ReadoutStopTargetState | null;
  stopReadout?(identity: object | null): 'stopped' | 'no-current' | 'unknown';
  classify(input: CompanionCommandIntentInput): CompanionCommandCandidate;
  format(receipt: CompanionCommandReceipt): string;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  commit(value: boolean, actionId: CompanionBooleanActionId): Promise<CommandCommitResult>;
  commitVolume?(percent: number): Promise<CommandCommitResult>;
  publish(view: CompanionCommandView): void;
}
interface Record {
  requestId: string; owner: number; window: 'controls' | 'pet'; target: CommandTargetState | ReadoutVolumeTargetState | ReadoutStopTargetState | FramingTargetState;
  actionId: CompanionCommandAction['actionId']; committingValue?: boolean | number | PetFramingPreset;
  expires: number; revision: number; candidate: CompanionCommandCandidate;
  options: Map<string, CompanionCommandAction | null>; view: CompanionCommandView;
  state: 'ready' | 'choosing' | 'consumed' | 'committing' | 'closed';
  commitResult?: CommandCommitResult;
}
// No renderer method can mint this private identity or supply an action for execution.
export interface CompanionCommandTicket { readonly opaque: object; }
const keys = (v: unknown, allowed: string[]): v is { [key: string]: unknown } => !!v && typeof v === 'object'
  && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === allowed.length
  && Object.keys(v).every(k => allowed.includes(k));
const plainText = (v: unknown, cap: number): v is string => typeof v === 'string' && !!v.trim()
  && v.length <= cap && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
export const validCompanionAction = (v: unknown): v is CompanionCommandAction =>
  keys(v, ['actionId', 'parameters']) && keys(v.parameters, ['value'])
  && (v.actionId === 'pet.set-breath' ? v.parameters.value === true || (typeof v.parameters.value === 'number' && Number.isInteger(v.parameters.value) && v.parameters.value >= 0 && v.parameters.value <= 100) : v.actionId === 'pet.frame' ? v.parameters.value === 'full' || v.parameters.value === 'portrait' : v.actionId === 'voice.stop-readout' ? v.parameters.value === true : v.actionId === 'voice.set-volume'
    ? typeof v.parameters.value === 'number' && Number.isInteger(v.parameters.value) && v.parameters.value >= 0 && v.parameters.value <= 100
    : (v.actionId === 'pet.set-always-on-top' || v.actionId === 'pet.set-visible' || v.actionId === 'pet.set-follow-mouse')
      && typeof v.parameters.value === 'boolean');
function validCandidate(v: unknown): v is CompanionCommandCandidate {
  if (keys(v, ['kind']) && v.kind === 'none') return true;
  if (keys(v, ['kind', 'action']) && v.kind === 'explicit') return validCompanionAction(v.action);
  if (!keys(v, ['kind', 'prompt', 'choices']) || v.kind !== 'clarify' || !plainText(v.prompt, 240)
    || !Array.isArray(v.choices) || v.choices.length < 1 || v.choices.length > 2) return false;
  const values = new Set<boolean | number | PetFramingPreset>();
  let actionId: CompanionCommandAction['actionId'] | undefined;
  return v.choices.every(c => {
    if (!keys(c, ['label', 'action']) || !plainText(c.label, 64) || !validCompanionAction(c.action)
      || values.has(c.action.parameters.value) || (actionId && actionId !== c.action.actionId)) return false;
    actionId = c.action.actionId;
    values.add(c.action.parameters.value); return true;
  });
}

export class CompanionCommandHost {
  private readonly tickets = new WeakMap<object, Record>();
  private readonly recent = new Set<string>();
  private current: Record | null = null;
  constructor(private readonly ports: CompanionCommandPorts) {}

  // Called exclusively from the trusted host's accepted ordinary-human ingress.
  // Never expose this method, source, text, context, or candidate via preload.
  admit(input: { requestId: string; owner: number; window: 'controls' | 'pet'; text: string;
    source: 'current-human' | 'model' | 'screen' | 'quoted' | 'history'; currentVisible?: boolean;
    currentFollowMouse?: boolean; currentReadoutVolume?: number; currentBreath?: number }): CompanionCommandTicket | null {
    if (input.source !== 'current-human' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)
      || !Number.isSafeInteger(input.owner) || !plainText(input.text, 16000) || this.recent.has(input.requestId)) return null;
    this.invalidate();
    this.recent.add(input.requestId);
    if (this.recent.size > 256) this.recent.delete(this.recent.values().next().value!);
    const topmost = this.ports.target(input.owner, 'pet.set-always-on-top');
    const visibility = this.ports.target(input.owner, 'pet.set-visible');
    const followMouse = this.ports.target(input.owner, 'pet.set-follow-mouse');
    const breath = this.ports.breathTarget?.(input.owner) ?? null;
    const volume = this.ports.volumeTarget?.(input.owner) ?? null;
    const readout = this.ports.readoutTarget?.(input.owner) ?? null;
    const candidate = this.ports.classify({ requestId: input.requestId, contextId: topmost?.contextId ?? visibility?.contextId ?? followMouse?.contextId ?? volume?.contextId ?? 'unavailable',
      text: input.text, currentValue: topmost?.value ?? false,
      ...(visibility ? { currentVisible: visibility.value }
        : typeof input.currentVisible === 'boolean' ? { currentVisible: input.currentVisible } : {}),
      ...(breath ? { currentBreath: breath.value }
        : typeof input.currentBreath === 'number' ? { currentBreath: input.currentBreath } : {}),
      ...(followMouse ? { currentFollowMouse: followMouse.value }
        : typeof input.currentFollowMouse === 'boolean' ? { currentFollowMouse: input.currentFollowMouse } : {}),
      ...(volume ? { currentReadoutVolume: volume.value }
        : typeof input.currentReadoutVolume === 'number' ? { currentReadoutVolume: input.currentReadoutVolume } : {}) });
    if (!validCandidate(candidate)) throw Error('桌宠命令提议格式不正确。');
    if (candidate.kind === 'none') return null;
    const actionId = candidate.kind === 'explicit' ? candidate.action.actionId : candidate.choices[0].action.actionId;
    const framing = this.ports.framingTarget?.(input.owner) ?? null;
    const target = actionId === 'pet.set-breath' ? breath : actionId === 'pet.frame' ? framing : actionId === 'voice.stop-readout' ? readout : actionId === 'voice.set-volume' ? volume : actionId === 'pet.set-visible' ? visibility
      : actionId === 'pet.set-follow-mouse' ? followMouse : topmost;
    const record: Record = { requestId: input.requestId, owner: input.owner, window: input.window,
      actionId,
      target: target ? { ...target } : { contextId: '', value: false, revision: -1 },
      expires: this.ports.now() + 60_000, revision: 0,
      candidate: structuredClone(candidate), options: new Map(), state: 'ready',
      view: { requestId: input.requestId, owner: input.window, revision: 0, prompt: '', choices: [] } };
    const opaque = {}; this.tickets.set(opaque, record); this.current = record;
    return Object.freeze({ opaque });
  }

  async run(ticket: CompanionCommandTicket): Promise<CompanionCommandView | null> {
    const r = this.tickets.get(ticket?.opaque);
    if (!r || r !== this.current || r.state !== 'ready') return null;
    // A recognized command without its existing native target is refused here,
    // rather than falling through to a provider or constructing another window.
    if (r.actionId !== 'pet.set-always-on-top' && !r.target.contextId) return this.finish(r, { requestId: r.requestId, revision: 0, status: 'rejected',
      persistence: 'not-committed', presentation: 'not-requested', message: '' });
    if (!this.currentContext(r)) return this.close(r, 'expired');
    if (r.candidate.kind === 'explicit') return this.execute(r, r.candidate.action);
    if (r.candidate.kind !== 'clarify') return null;
    r.state = 'choosing';
    r.view.prompt = r.candidate.prompt;
    for (const option of r.candidate.choices) {
      const id = this.ports.id(); r.options.set(id, option.action);
      r.view.choices.push({ choiceId: id, label: option.label });
    }
    const cancel = this.ports.id(); r.options.set(cancel, null);
    r.view.choices.push({ choiceId: cancel, label: '取消' });
    return this.publish(r);
  }

  async choose(owner: number, value: unknown): Promise<CompanionCommandView | null> {
    if (!keys(value, ['requestId', 'choiceId']) || typeof value.requestId !== 'string'
      || typeof value.choiceId !== 'string') throw Error('确认选项不正确。');
    const choice = value as unknown as CompanionCommandChoiceRequest, r = this.current;
    if (!r || r.requestId !== choice.requestId || r.owner !== owner || r.state !== 'choosing') return null;
    if (!this.currentContext(r)) return this.close(r, 'expired');
    if (!r.options.has(choice.choiceId)) return null;
    const action = r.options.get(choice.choiceId)!;
    if (action === null) { r.state = 'consumed'; return this.close(r, 'cancelled'); }
    return this.execute(r, action);
  }

  invalidate(requestId?: string): void {
    const r = this.current;
    if (!r || (requestId !== undefined && r.requestId !== requestId)) return;
    if (r.actionId === 'pet.frame') this.ports.cancelFrame?.();
    // A queued or issued write remains consumed. Invalidating presentation cannot undo it.
    if (r.state === 'committing') this.finish(r, { requestId: r.requestId, revision: 0, status: 'expired',
      persistence: 'unknown', presentation: 'unknown', message: '' });
    else if (r.state !== 'closed') this.close(r, 'expired');
    if (this.current === r) this.current = null;
  }
  refresh(): void {
    const r = this.current;
    if (r && !this.currentContext(r)) this.invalidate(r.requestId);
  }
  private currentContext(r: Record): boolean {
    // Only the issued hide may retain its own hidden pet sender. Navigation,
    // cancellation, foreign targets and hidden controls still revoke normally.
    const live = this.liveTarget(r);
    return r === this.current && this.ports.now() < r.expires && !!live
      && live.contextId === r.target.contextId;
  }
  private liveTarget(r: Record): CommandTargetState | ReadoutVolumeTargetState | ReadoutStopTargetState | FramingTargetState | null {
    return r.actionId === 'pet.set-breath' ? this.ports.breathTarget?.(r.owner) ?? null : r.actionId === 'pet.frame' ? this.ports.framingTarget?.(r.owner) ?? null : r.actionId === 'voice.stop-readout' ? this.ports.readoutTarget?.(r.owner) ?? null
      : r.actionId === 'voice.set-volume' ? this.ports.volumeTarget?.(r.owner) ?? null
      : this.ports.target(r.owner, r.actionId,
        r.actionId === 'pet.set-visible' && r.state === 'committing' && r.committingValue === false);
  }
  private async execute(r: Record, action: CompanionCommandAction): Promise<CompanionCommandView | null> {
    if (r.state !== 'ready' && r.state !== 'choosing') return null;
    r.state = 'consumed'; r.options.clear(); // before queueing/awaiting: double-window clicks cannot repeat.
    return this.ports.enqueue(async () => {
      if (!this.currentContext(r) || r.state !== 'consumed') return r === this.current ? this.close(r, 'expired') : null;
      const live = this.liveTarget(r)!;
      if (action.actionId === 'voice.stop-readout') {
        if (!('identity' in live) || !('identity' in r.target) || live.identity !== r.target.identity) return this.close(r, 'conflict');
        r.state = 'committing';
        let effect: 'stopped' | 'no-current' | 'unknown' = 'unknown';
        try { effect = this.ports.stopReadout?.(r.target.identity) ?? 'unknown'; } catch { /* Never promote an unknown stop. */ }
        if (!this.currentContext(r) || r.state !== 'committing') return null;
        return this.finish(r, { requestId: r.requestId, revision: 0, status: effect === 'unknown' ? 'failed' : effect,
          persistence: 'not-committed', presentation: 'not-requested', effect, message: '' });
      }
      if (action.actionId === 'pet.frame') {
        if (!('identity' in live) || !('identity' in r.target) || live.identity !== r.target.identity
          || live.revision !== r.target.revision) return this.close(r, 'conflict');
        const identity = r.target.identity;
        if (!identity) return this.close(r, 'conflict');
        r.state = 'committing';
        let result: CommandCommitResult;
        try { result = this.ports.frame ? await this.ports.frame(action.parameters.value, identity,
          () => { const current = this.liveTarget(r); return this.currentContext(r) && r.state === 'committing'
            && !!current && 'identity' in current && current.identity === identity; })
          : { persistence: 'not-committed', presentation: 'not-requested' }; }
        catch { result = { persistence: 'unknown', presentation: 'unknown' }; }
        if (!this.currentContext(r) || r.state !== 'committing') return null;
        return this.finish(r, { requestId: r.requestId, revision: 0,
          status: result.persistence === 'saved' ? 'saved' : result.persistence === 'unchanged' ? 'unchanged' : 'failed',
          persistence: result.persistence, presentation: result.presentation, value: action.parameters.value, message: '' });
      }
      if (live.revision !== r.target.revision || live.value !== r.target.value) return this.close(r, 'conflict');
      let result: CommandCommitResult;
      r.state = 'committing'; r.committingValue = action.parameters.value;
      try { result = action.actionId === 'voice.set-volume'
        ? this.ports.commitVolume ? await this.ports.commitVolume(action.parameters.value)
          : { persistence: 'not-committed', presentation: 'not-requested' }
        : action.actionId === 'pet.set-breath'
          ? this.ports.commitBreath ? await this.ports.commitBreath(action.parameters.value)
            : { persistence: 'not-committed', presentation: 'not-requested' }
          : await this.ports.commit(action.parameters.value, action.actionId); }
      catch { result = { persistence: 'unknown', presentation: 'unknown' }; }
      r.commitResult = structuredClone(result);
      // Even an issued, successfully committed old write must never publish into a newer turn.
      if (!this.currentContext(r) || r.state !== 'committing') return null;
      const status = result.persistence === 'saved' ? 'saved' : result.persistence === 'unchanged' ? 'unchanged' : 'failed';
      return this.finish(r, { requestId: r.requestId, revision: 0, status,
        persistence: result.persistence, presentation: result.presentation,
        ...(typeof result.nativeValue === 'boolean' ? { nativeValue: result.nativeValue } : {}),
        ...(typeof result.value === 'boolean' || typeof result.value === 'number' ? { value: result.value } : {}), message: '' });
    });
  }
  private close(r: Record, status: 'expired' | 'cancelled' | 'conflict'): CompanionCommandView {
    return this.finish(r, { requestId: r.requestId, revision: 0, status,
      persistence: 'not-committed', presentation: 'not-requested', message: '' });
  }
  private finish(r: Record, receipt: CompanionCommandReceipt): CompanionCommandView {
    r.state = 'closed'; r.options.clear(); r.revision++;
    if (r.actionId !== 'pet.set-always-on-top') receipt.actionId = r.actionId;
    receipt.revision = r.revision; receipt.message = this.ports.format(structuredClone(receipt)).slice(0, 500);
    r.view = { requestId: r.requestId, owner: r.window, revision: r.revision,
      prompt: '', choices: [], receipt };
    return this.publish(r, false);
  }
  private publish(r: Record, increment = true): CompanionCommandView {
    if (increment) r.revision++;
    r.view.revision = r.revision;
    const view = structuredClone(r.view); this.ports.publish(structuredClone(view)); return view;
  }
}
