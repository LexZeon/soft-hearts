import type { AgentCallOutcome, AgentExposedTier, AgentPolicyTier } from '../../shared/agent-channel';

export type AgentErrorCode =
  | 'channel_off' | 'unknown_tool' | 'invalid_input' | 'not_exposed' | 'unavailable'
  | 'denied_by_user' | 'confirm_timeout' | 'confirm_busy' | 'timeout' | 'failed'
  | 'busy' | 'rate_limited' | 'too_large' | 'auth_failed'
  /** I-025: a user-words call (confirm tier with 三方互通 on) arrived without the user's own words. */
  | 'needs_user_words';

/** A refusal or failure the agent may read. Messages are fixed Chinese text, never secrets. */
export class AgentToolError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) { super(message); }
}

/** `buttons`: [decline, accept] labels for this dialog (default 拒绝 / 允许); F6's consent uses its own words. */
export interface AgentConfirmText { title: string; detail: string; buttons?: readonly [string, string] }
export interface AgentConfirmRequest extends AgentConfirmText { tool: string; toolTitle: string; timeoutMs: number }

export const AGENT_CHANNEL_CLOSED = 'soft hearts 的内部通道已关闭（或已重新打开），这个操作没有执行。';

/**
 * I-025 "需要用户原话": with 三方互通 on, a call that needs the user's consent (confirm tier) must carry
 * what the user said in the conversation (`userWords`); without it nothing runs and no dialog opens. Only its length is ever kept.
 */
export const AGENT_USER_WORDS_MISSING = '三方互通打开时，这个操作需要用户在对话里说的原话（userWords）。这次没有原话，什么都没做。'
  + '请先问用户，用户同意后把他说的那句话原样填进 userWords 再调用（不要改写，也不要替用户编）。';
export const AGENT_USER_WORDS_LIMIT = 2000;

/**
 * Takes `userWords` out of a call's arguments before the tool's own strict validation (every tool may carry it).
 * Returns the trimmed words ('' when absent or blank). A non-string or an overlong value is invalid input.
 */
export function takeUserWords(args: unknown): { args: unknown; words: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype
    || !Object.prototype.hasOwnProperty.call(args, 'userWords')) return { args, words: '' };
  const { userWords, ...rest } = args as Record<string, unknown>;
  if (typeof userWords !== 'string') throw new AgentToolError('invalid_input', 'userWords 只接受文字：用户在对话里说的原话。');
  if ([...userWords].length > AGENT_USER_WORDS_LIMIT) throw new AgentToolError('invalid_input', `userWords 太长了（最多 ${AGENT_USER_WORDS_LIMIT} 字），只填用户说的那一句。`);
  return { args: rest, words: userWords.trim() };
}

/** I-025 体验记录: which item a user-words call changed and to what (closed ids and short values only, never the words). */
export interface AgentWordsUse { tool: string; item: string; value: boolean | number | string | null; words: number }

/**
 * Throws AgentToolError('channel_off') once the call that owns it may no longer take effect:
 * the channel was turned off, closed or replaced since the call began.
 */
export type AgentCommitGuard = () => void;

/**
 * I-014 "能撤回的给撤回": a committed change may leave one way back. `run` gets a guard of its own (the undo call's,
 * or a no-op for the user's own click in the control window) and throws a fixed message when the thing changed again.
 */
export interface AgentUndoOffer { label: string; run(guard: AgentCommitGuard): Promise<unknown> | unknown }

/** Handed to `run()`. Anything that awaits before its change takes effect passes `check` down to that point. */
export interface AgentCallContext {
  readonly signal: AbortSignal;
  readonly check: AgentCommitGuard;
  /** Call after the change committed; the last offer of a successful call is kept (agent-channel/host.ts). */
  readonly offerUndo: (offer: AgentUndoOffer) => void;
}

/**
 * At most one confirmation dialog at a time. The external channel and the chat settings
 * cards share one lock (agent-channel/electron-wiring.ts), so they never stack two dialogs.
 */
export class AgentConfirmLock {
  private held = false;
  get busy(): boolean { return this.held; }
  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  release(): void { this.held = false; }
}

export interface AgentToolDefinition<I = any, P = I> {
  name: string;
  /** Chinese label shown in notices and the status line. */
  title: string;
  tier: AgentPolicyTier;
  /** I-014: defined only while 三方互通 is on; otherwise refused exactly like an unknown tool and never listed. */
  interconnectOnly?: boolean;
  /** One short host-written line for the "由 Claude 操作" notice (a file name, a character), never chat text. */
  noticeDetail?(prepared: P): string | undefined;
  /**
   * I-014: what a confirm-tier call that ran without its dialog (三方互通 on) still shows the user once, without
   * waiting for them (F6's explanation of "更真实的情绪"). Shown after the change committed.
   */
  informWithoutDialog?(prepared: P): AgentConfirmText | undefined;
  /** I-025: what the 体验记录 line of a user-words call names (default: the tool itself, no value). */
  wordsItem?(prepared: P): { item: string; value: boolean | number | string | null };
  /** Strict, synchronous shape check of untrusted arguments. */
  validate(raw: unknown): I;
  /** Async checks (file exists, card exists) before any dialog. */
  prepare?(input: I): Promise<P> | P;
  /** Per-request escalation; the effective tier is never lower than `tier`. */
  tierFor?(prepared: P): AgentPolicyTier;
  /** The exact request shown in the confirmation dialog. Required whenever the effective tier is confirm. */
  confirmation?(prepared: P): AgentConfirmText;
  /**
   * Performs the action. Everything that awaits before its change takes effect must call
   * `context.check()` (or pass it to the host step that commits) right before that point:
   * a change not yet committed when the channel closes is abandoned; a committed one stays.
   */
  run(prepared: P, context: AgentCallContext): Promise<unknown> | unknown;
}

export interface AgentAuditEntry {
  at: string;
  tool: string;
  tier: AgentPolicyTier | 'none';
  outcome: AgentCallOutcome;
  code?: AgentErrorCode;
  /**
   * Confirm tier only: the user's click in the dialog; 三方互通 being on (I-014, before I-025); or (I-025) the user's own words
   * carried by the call, of which only the length (`words`) is recorded.
   */
  approval?: 'dialog' | 'interconnect' | 'user-words';
  words?: number;
  ms: number;
}

export interface AgentCallSummary { tool: string; title: string; tier: AgentExposedTier; outcome: AgentCallOutcome; at: number }

export interface AgentRegistryOptions {
  /** Checked on every call; the channel is off unless the user turned it on. */
  enabled(): boolean;
  /**
   * I-014 "三方互通": true → confirm-tier calls run without the dialog (with the notice) and
   * interconnect-only tools exist. Absent or false → exactly the old behavior. Read on every call.
   * The pet's chat cards never pass it: what is read out of her chat still asks.
   */
  interconnect?(): boolean;
  /** Shows the native dialog. Must resolve true only for an explicit "allow" click; the signal closes it. */
  confirm(request: AgentConfirmRequest, signal: AbortSignal): Promise<boolean>;
  /** Visible "由 Claude 操作" notice for reversible actions (and for confirm-tier ones 三方互通 let through). */
  notice?(tool: string, title: string, detail?: string): void;
  /** I-014: a definition's informWithoutDialog text, shown without waiting for the user. */
  inform?(text: AgentConfirmText): void;
  /** I-025: a user-words call committed (体验记录: which item, to what, how long the words were; never the words). */
  wordsUsed?(use: AgentWordsUse): void;
  audit?(entry: AgentAuditEntry): void;
  /** `undo`: the call's last undo offer, present only for a successful call that made one. */
  called?(summary: AgentCallSummary, undo?: AgentUndoOffer): void;
  /** Shared with every other surface that can open a confirmation dialog; a private one by default. */
  confirmLock?: AgentConfirmLock;
  confirmTimeoutMs?: number;
  runTimeoutMs?: number;
  maxResultBytes?: number;
  now?(): number;
}

export type AgentCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: AgentErrorCode; message: string } };

const RANK: Record<AgentPolicyTier, number> = { read: 0, reversible: 1, confirm: 2, never: 3 };
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_KEY = /^(?:api_?key|apikey|token|secret|password|passphrase|authorization|cookie|credential)s?$/i;

function maxTier(a: AgentPolicyTier, b: AgentPolicyTier): AgentPolicyTier { return RANK[b] > RANK[a] ? b : a; }

/** Drops any secret-named field anywhere in a tool result (belt and braces: handlers already return curated data). */
export function stripSecretFields(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map(item => stripSecretFields(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (!SECRET_KEY.test(key)) out[key] = stripSecretFields(item, depth + 1);
  return out;
}

function failure(code: AgentErrorCode, message: string): AgentCallResult { return { ok: false, error: { code, message } }; }

/**
 * Whitelisted tools with one policy gate. `never` tools are dropped at construction.
 *
 * Closing (X-090, semantics): every call gets its own
 * abort signal; `revoke()` (channel off, closed or replaced) aborts all calls in flight and
 * closes their dialogs. A call that has not committed yet is abandoned with `channel_off`
 * at the next check: after validation, after the dialog, before `run()`, and at the commit
 * point inside `run()` (`context.check`). A change that already took effect keeps its result
 * and audit entry; nothing is rolled back.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();
  private readonly lock: AgentConfirmLock;
  private readonly inflight = new Set<AbortController>();
  constructor(definitions: readonly AgentToolDefinition[], private readonly options: AgentRegistryOptions) {
    this.lock = options.confirmLock ?? new AgentConfirmLock();
    for (const definition of definitions) {
      if (!NAME.test(definition.name)) throw Error(`Invalid agent tool name: ${definition.name}`);
      if (this.tools.has(definition.name)) throw Error(`Duplicate agent tool: ${definition.name}`);
      if (definition.tier === 'never') continue;
      if (definition.tier === 'confirm' && !definition.confirmation) throw Error(`Confirm tool without dialog text: ${definition.name}`);
      this.tools.set(definition.name, definition);
    }
  }

  /** Exposed tool names right now; never-tier definitions are absent, interconnect-only ones only while 三方互通 is on. */
  names(): string[] { return [...this.tools.values()].filter(definition => this.exposed(definition)).map(definition => definition.name); }
  tierOf(name: string): AgentPolicyTier | undefined { const definition = this.tools.get(name); return definition && this.exposed(definition) ? definition.tier : undefined; }
  /** I-014: 三方互通 is on (read on every call; a failing reader means off). */
  get interconnected(): boolean { try { return this.options.interconnect?.() === true; } catch { return false; } }
  private exposed(definition: AgentToolDefinition): boolean { return !definition.interconnectOnly || this.interconnected; }
  /** Calls whose work has not settled yet (a timed-out call counts until its work ends). */
  get pending(): number { return this.inflight.size; }

  /** The channel was turned off, closed or replaced: nothing that has not committed yet may take effect. */
  revoke(): void {
    for (const controller of [...this.inflight]) controller.abort();
  }

  async call(rawName: unknown, args: unknown): Promise<AgentCallResult> {
    const controller = new AbortController();
    this.inflight.add(controller);
    const work: { promise: Promise<unknown> | null } = { promise: null };
    try { return await this.dispatch(rawName, args, controller.signal, work); }
    finally {
      const release = () => { this.inflight.delete(controller); };
      // A call that timed out keeps its signal until its work ends: a later close still stops its commit.
      if (work.promise) void work.promise.then(release, release); else release();
    }
  }

  private async dispatch(rawName: unknown, args: unknown, signal: AbortSignal, work: { promise: Promise<unknown> | null }): Promise<AgentCallResult> {
    const started = this.now();
    const found = typeof rawName === 'string' ? this.tools.get(rawName) : undefined;
    // An interconnect-only tool with 三方互通 off is not defined at all (the same answer as a name that never existed).
    const definition = found && this.exposed(found) ? found : undefined;
    const tool = definition?.name ?? 'unknown';
    let tier: AgentPolicyTier | 'none' = definition?.tier ?? 'none';
    let approval: AgentAuditEntry['approval'];
    let words = 0;
    let undo: AgentUndoOffer | undefined;
    const live = () => !signal.aborted && this.isEnabled();
    const check: AgentCommitGuard = () => { if (!live()) throw new AgentToolError('channel_off', AGENT_CHANNEL_CLOSED); };
    const closed = () => finish('denied', failure('channel_off', AGENT_CHANNEL_CLOSED));
    const finish = (outcome: AgentCallOutcome, result: AgentCallResult): AgentCallResult => {
      const code = result.ok ? undefined : result.error.code;
      try {
        this.options.audit?.({ at: new Date().toISOString(), tool, tier, outcome, ...(code ? { code } : {}), ...(approval ? { approval } : {}),
          ...(approval === 'user-words' ? { words } : {}), ms: Math.max(0, Math.round(this.now() - started)) });
      } catch { /* Auditing never changes the result. */ }
      if (definition && tier !== 'none' && tier !== 'never')
        try { this.options.called?.({ tool, title: definition.title, tier, outcome, at: Date.now() }, result.ok ? undo : undefined); } catch { /* Status only. */ }
      return result;
    };
    const notice = (prepared: unknown) => {
      let detail: string | undefined;
      try { detail = definition?.noticeDetail?.(prepared)?.slice(0, 80) || undefined; } catch { detail = undefined; }
      try { this.options.notice?.(definition!.name, definition!.title, detail); } catch { /* A missing window must not block the notice-less path. */ }
    };
    if (!this.isEnabled()) return finish('denied', failure('channel_off', 'soft hearts 的内部通道已关闭。请在控制窗口「隐私与设置」→「Claude 内部通道」打开“允许 Claude 通过内部通道操作 soft hearts”。'));
    if (!definition) return finish('invalid', failure('unknown_tool', '没有这个工具。'));
    let prepared: unknown;
    let userWords = '';
    try {
      const taken = takeUserWords(args);
      userWords = taken.words;
      prepared = definition.prepare ? await definition.prepare(definition.validate(taken.args)) : definition.validate(taken.args);
      if (definition.tierFor) tier = maxTier(definition.tier, definition.tierFor(prepared));
    } catch (error) {
      return finish('invalid', error instanceof AgentToolError ? failure(error.code, error.message) : failure('invalid_input', '参数不正确。'));
    }
    if (!live()) return closed();
    if (tier === 'never') return finish('denied', failure('not_exposed', '这个操作不开放给 Claude。'));
    // I-014 + I-025: with 三方互通 on, the user's own words in the conversation are the consent: the call
    // must carry them (userWords) or nothing happens; no dialog either way. The notice shows what happened.
    const direct = tier === 'confirm' && this.interconnected;
    if (direct) {
      if (!userWords) return finish('denied', failure('needs_user_words', AGENT_USER_WORDS_MISSING));
      approval = 'user-words';
      words = [...userWords].length;
      notice(prepared);
    } else if (tier === 'confirm') {
      const answer = await this.askUser(definition, prepared, signal);
      // Closed (or turned off and on again) while the dialog was open: even an "allow" is void.
      if (answer === 'closed' || !live()) return closed();
      if (answer !== 'allow') return finish('denied', answer === 'timeout'
        ? failure('confirm_timeout', '用户没有在时限内确认，已视为拒绝。')
        : answer === 'busy' ? failure('confirm_busy', '已有一个确认弹窗在等待用户，请稍后再试。')
        : failure('denied_by_user', '用户拒绝了这个请求。'));
      approval = 'dialog';
    } else if (tier === 'reversible') {
      notice(prepared);
    }
    try {
      check();
      const offerUndo = (offer: AgentUndoOffer) => { if (offer && typeof offer.run === 'function' && typeof offer.label === 'string') undo = offer; };
      const running = Promise.resolve().then(() => definition.run(prepared, { signal, check, offerUndo }));
      work.promise = running;
      const result = stripSecretFields(await this.withTimeout(running));
      // Committed: the result stands even if the channel closed meanwhile (no rollback).
      if (direct) {
        try {
          const named = definition.wordsItem?.(prepared) ?? { item: definition.name, value: null };
          this.options.wordsUsed?.({ tool: definition.name, item: named.item, value: named.value, words });
        } catch { /* Keeping a record never undoes a change. */ }
        let text: AgentConfirmText | undefined;
        try { text = definition.informWithoutDialog?.(prepared); } catch { text = undefined; }
        if (text) try { this.options.inform?.(text); } catch { /* Showing it never undoes the change. */ }
      }
      const size = Buffer.byteLength(JSON.stringify(result ?? null), 'utf8');
      if (size > (this.options.maxResultBytes ?? 48 * 1024)) return finish('failed', failure('too_large', '结果太大，未返回。'));
      return finish('allowed', { ok: true, result: result ?? null });
    } catch (error) {
      if (error instanceof AgentToolError && error.code === 'channel_off') return closed();
      if (error instanceof AgentToolError) return finish('failed', failure(error.code, error.message));
      // Host errors are fixed product messages (Chinese, no secrets); keep them short.
      const message = error instanceof Error && error.message ? error.message.slice(0, 300) : '操作失败。';
      return finish('failed', failure('failed', message));
    }
  }

  private isEnabled(): boolean { try { return this.options.enabled(); } catch { return false; } }
  private now(): number { return this.options.now?.() ?? performance.now(); }

  private async askUser(definition: AgentToolDefinition, prepared: unknown, signal: AbortSignal): Promise<'allow' | 'deny' | 'timeout' | 'busy' | 'closed'> {
    if (this.lock.busy) return 'busy';
    if (!definition.confirmation) return 'deny';
    let text: AgentConfirmText;
    try { text = definition.confirmation(prepared); } catch { return 'deny'; }
    if (signal.aborted) return 'closed';
    if (!this.lock.tryAcquire()) return 'busy';
    const timeoutMs = this.options.confirmTimeoutMs ?? 60_000;
    const dialog = new AbortController();
    const close = () => dialog.abort();
    signal.addEventListener('abort', close, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
      const closing = new Promise<'closed'>(resolve => dialog.signal.addEventListener('abort', () => resolve('closed'), { once: true }));
      const asked = Promise.resolve()
        .then(() => this.options.confirm({ ...text, tool: definition.name, toolTitle: definition.title, timeoutMs }, dialog.signal))
        .then(value => value === true ? 'allow' as const : 'deny' as const, () => 'deny' as const);
      return await Promise.race([asked, timeout, closing]);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', close);
      dialog.abort(); // Closes a still-open dialog; a late "allow" is ignored.
      this.lock.release();
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    const ms = this.options.runTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentToolError('timeout', '操作超时；结果可能稍后生效，请用 get_status 查看。')), ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
