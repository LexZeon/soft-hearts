import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetRef } from '../shared/contracts';
import {
  HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, herActionDurationMs, isHerActionId, readHerActionOutcome,
  type HerActionCue, type HerActionId, type HerActionPlayResult, type HerActionResource,
} from '../shared/her-actions';
import type { MotionLibrary } from './motion-library';

export interface HerActionHostPorts {
  /** Sends the cue to every window's stage (desk:her-action). */
  send(cue: HerActionCue): void;
  /** The pet window exists, is shown and not minimised. */
  petVisible(): boolean;
  library: Pick<MotionLibrary, 'resolvePreview'>;
  /** Registers the verified file for a narrow mmd-asset:// grant. */
  register(file: string): Promise<AssetRef>;
  now?: () => number;
  createId?: () => string;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Pending { cue: HerActionCue; settle(result: HerActionPlayResult): void; timer: unknown }

/**
 * 她的动作, host side (shared/her-actions.ts; docs/claude/2026-11-04-codex-actions.md). A test command asks for one action by
 * id; this makes a short-lived cue, sends it to every window and waits for the pet window's answer. A window may resolve
 * only a live cue, and only to the one pinned VMD of that action: the motion library verifies the pack's files, then the
 * bytes are hashed again here against the table in shared/her-actions.ts (even if a local catalog were changed). Nothing is
 * stored; nothing reaches the chat, her mood or the settings.
 */
export class HerActionHost {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly timers: NonNullable<HerActionHostPorts['timers']>;

  constructor(private readonly ports: HerActionHostPorts) {
    this.now = ports.now ?? Date.now;
    this.timers = ports.timers ?? { set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  /** Sends the action; settles with the pet's answer, `no-window` at once, or `no-answer` after HER_ACTION_CUE_MS. */
  play(action: unknown): Promise<HerActionPlayResult> {
    if (!isHerActionId(action)) return Promise.reject(new Error('动作编号不正确。'));
    if (!this.ports.petVisible()) return Promise.resolve({ status: 'no-window', missing: [], detail: '' });
    const { cue, result, drop } = this.open(action);
    try { this.ports.send(cue); } catch { drop(); }
    return result;
  }

  /**
   * I-006 第 2 步: a live cue that is not sent: it rides on her pose reaction (electron/pose-reactions/host.ts, a breather's 哈欠捂嘴),
   * and the stage plays it only in a whole-body framing. Resolving and answering are the same as for a sent cue; null without a pet window.
   */
  issue(action: HerActionId): HerActionCue | null {
    if (!isHerActionId(action) || !this.ports.petVisible()) return null;
    const { cue, result } = this.open(action);
    void result;
    return { ...cue };
  }

  private open(action: HerActionId): { cue: HerActionCue; result: Promise<HerActionPlayResult>; drop(): void } {
    const at = this.now();
    const id = (this.ports.createId ?? (() => randomUUID().replace(/-/g, '')))();
    const cue: HerActionCue = { id, action, at, expiresAt: at + HER_ACTION_CUE_MS };
    let drop = () => {};
    const result = new Promise<HerActionPlayResult>(resolve => {
      let settled = false;
      // Answered once; the cue itself stays resolvable until it expires (the other window may still be loading).
      const settle = (value: HerActionPlayResult) => { if (settled) return; settled = true; resolve(value); };
      const timer = this.timers.set(() => { this.pending.delete(id); settle({ status: 'no-answer', missing: [], detail: '' }); }, HER_ACTION_CUE_MS);
      this.pending.set(id, { cue, settle, timer });
      drop = () => { this.timers.clear(timer); this.pending.delete(id); settle({ status: 'no-window', missing: [], detail: '' }); };
    });
    return { cue, result, drop };
  }

  /** A window's stage asks for the cue's motion. Only a live cue, only its pinned bytes. */
  async resolve(cueId: unknown): Promise<HerActionResource> {
    const live = () => {
      const entry = typeof cueId === 'string' ? this.pending.get(cueId) : undefined;
      if (!entry || entry.cue.expiresAt <= this.now()) throw new Error('这个动作已经结束或失效。');
      return entry.cue;
    };
    const cue = live();
    const spec = HER_ACTION_SPECS[cue.action];
    const file = await this.ports.library.resolvePreview(HER_ACTION_PACK, cue.action);
    if (!path.isAbsolute(file)) throw new Error('动作资源校验失败。');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 30 || info.size > 8 * 1024 * 1024) throw new Error('动作资源校验失败。');
    const bytes = await readFile(file);
    if (bytes.length !== info.size || bytes.subarray(0, 30).toString('ascii').replace(/\0.*$/, '') !== 'Vocaloid Motion Data 0002'
      || createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('动作资源校验失败。');
    live();
    const asset = await this.ports.register(file);
    live();
    return { cueId: cue.id, action: cue.action, packId: HER_ACTION_PACK, motionId: cue.action, url: asset.url, sha256: spec.sha256,
      durationMs: herActionDurationMs(cue.action) };
  }

  /** The pet window's answer (the caller checks the sender is the pet). Unknown or late answers are dropped. */
  report(value: unknown): boolean {
    const outcome = readHerActionOutcome(value);
    const entry = outcome ? this.pending.get(outcome.cueId) : undefined;
    if (!outcome || !entry) return false;
    entry.settle({ status: outcome.status, missing: outcome.missing, detail: outcome.detail });
    return true;
  }

  /** Ends every wait (app closing). */
  dispose(): void {
    for (const [id, entry] of [...this.pending]) { this.timers.clear(entry.timer); this.pending.delete(id); entry.settle({ status: 'no-answer', missing: [], detail: '' }); }
  }

  /** For tests and diagnostics: the live cue ids. */
  get live(): string[] { return [...this.pending.keys()]; }
}

export type { HerActionId };
