import { randomUUID } from 'node:crypto';
import {
  AGENT_TOOLS, type AgentChannelNotice, type AgentChannelView, type AgentClaudeCodeLink, type AgentInterconnectView, type AgentRecycleSummary,
} from '../../shared/agent-channel';
import { AgentAuditLog } from './audit';
import { AgentCredentialStore, agentEndpoint, type AgentCredentials } from './credentials';
import { InterconnectStore } from './interconnect';
import {
  AgentToolError, AgentToolRegistry, type AgentCommitGuard, type AgentConfirmLock, type AgentConfirmRequest, type AgentConfirmText,
  type AgentToolDefinition, type AgentUndoOffer, type AgentWordsUse,
} from './registry';
import { AgentChannelServer, type AgentServerLimits } from './transport';
import { argsObject, noArgs, oneOf } from './validate';

/** How long a Claude action can still be undone from the panel or with undo_last_action. */
export const AGENT_UNDO_TTL_MS = 30 * 60_000;
const IDLE_LINK: AgentClaudeCodeLink = { state: 'idle', name: '', message: '' };

export interface AgentChannelHostOptions {
  profileDirectory: string;
  tools: readonly AgentToolDefinition[];
  /** Native confirmation dialog; true only for an explicit "allow" click. */
  confirm(request: AgentConfirmRequest, signal: AbortSignal): Promise<boolean>;
  publishView?(view: AgentChannelView): void;
  publishNotice?(notice: AgentChannelNotice): void;
  /** I-014: a confirm-tier call 三方互通 let through still shows this once (not waited for). */
  inform?(text: AgentConfirmText): void;
  /** I-025 体验记录: a user-words call committed (item, value, words' length). */
  wordsUsed?(use: AgentWordsUse): void;
  /** Registration snippets for this machine (shown only while enabled). */
  setup?(): AgentChannelView['setup'];
  /** I-014 "三方互通"; a store in the profile folder by default. */
  interconnect?: InterconnectStore;
  /**
   * I-014: connects the app to the user's own Claude Code (agent-channel/claude-code-link.ts). Called once after the
   * channel opened with 三方互通 on, and again for 「重新接上」 (`force`).
   */
  linkClaudeCode?(force: boolean, autoRegistered: readonly string[], repoint: AgentRepointJournal): Promise<AgentClaudeCodeLink>;
  /** Delay before the automatic link check, so it never competes with startup and the first reply. */
  linkDelayMs?: number;
  /** I-014 回收站: what the panel shows (names and counts only). */
  recycle?(): { days: number; entries: AgentRecycleSummary[] };
  platform?: NodeJS.Platform;
  username?: string;
  limits?: Partial<AgentServerLimits>;
  confirmTimeoutMs?: number;
  /** One dialog at a time across the channel and the chat settings cards. */
  confirmLock?: AgentConfirmLock;
  audit?: AgentAuditLog;
  now?(): number;
  /** Wall clock for the 30-minute undo window (tests pass their own). */
  clock?(): number;
}

/** The write-ahead mark of a re-point in the user's Claude Code (InterconnectStore.repointing). */
export interface AgentRepointJournal {
  /** Names whose re-point was started and is not over. */
  pending: readonly string[];
  /** Resolves whether the mark was written. */
  mark(name: string, pending: boolean): Promise<boolean>;
}

interface UndoSlot extends AgentUndoOffer { id: string; title: string; expiresAt: number }

/**
 * The switch around registry + transport.
 *
 * I-014 "三方互通", on by default: the channel opens at startup without the user turning it on, its
 * confirm-tier tools run at once (with the "由 Claude 操作" notice) and the interconnect-only tools exist. Turning
 * 三方互通 off (remembered) closes the channel and everything is as before: the channel's own switch, off by default,
 * restored from its token file, and every confirmation dialog. Turning the channel off stops the server, disconnects
 * clients and deletes the token file.
 */
export class AgentChannelHost {
  readonly registry: AgentToolRegistry;
  readonly audit: AgentAuditLog;
  readonly interconnect: InterconnectStore;
  private readonly store: AgentCredentialStore;
  private readonly platform: NodeJS.Platform;
  private credentials: AgentCredentials | null = null;
  private server: AgentChannelServer | null = null;
  private lastAction: AgentChannelView['lastAction'] = null;
  private undoSlot: UndoSlot | null = null;
  private error: string | undefined;
  private link: AgentClaudeCodeLink = { ...IDLE_LINK };
  private linkStarted = false;
  private linkTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /**
   * The user turned 三方互通 off in this run (Codex T-112 round 029, 2026-11-03): from that click on, no call runs without its
   * dialog, also while the choice is still being saved, and also if saving it failed. Only the user turning it on again (saved)
   * gives direct execution back.
   */
  private interconnectWithdrawn = false;
  /** Each 三方互通 click; an older "on" that finishes after a newer "off" click does not give direct execution back. */
  private interconnectClicks = 0;
  /** Off clicks (三方互通 or the channel) whose close has not finished: new calls are refused as if the channel were closed. */
  private closing = 0;

  constructor(private readonly options: AgentChannelHostOptions) {
    this.platform = options.platform ?? process.platform;
    this.store = new AgentCredentialStore(options.profileDirectory, this.platform, options.username);
    this.audit = options.audit ?? new AgentAuditLog(options.profileDirectory);
    this.interconnect = options.interconnect ?? new InterconnectStore(options.profileDirectory);
    this.registry = new AgentToolRegistry([...options.tools, ...this.ownTools()], {
      enabled: () => !!this.credentials && !this.disposed && this.closing === 0,
      interconnect: () => this.interconnected,
      confirm: (request, signal) => options.confirm(request, signal),
      notice: (_tool, title, detail) => this.notice(title, detail),
      inform: text => { try { options.inform?.(text); } catch { /* A missing window must not undo the change. */ } },
      wordsUsed: use => { try { options.wordsUsed?.(use); } catch { /* A record never undoes a change. */ } },
      audit: entry => this.audit.record(entry),
      called: (summary, undo) => {
        this.lastAction = summary;
        if (undo) this.undoSlot = { ...undo, id: randomUUID(), title: summary.title, expiresAt: this.clock() + AGENT_UNDO_TTL_MS };
        else if (summary.outcome === 'allowed' && summary.tier !== 'read' && summary.tool !== 'undo_last_action') this.undoSlot = null;
        this.publish();
      },
      confirmTimeoutMs: options.confirmTimeoutMs,
      confirmLock: options.confirmLock,
      now: options.now,
    });
  }

  get enabled(): boolean { return !!this.credentials; }
  /** I-014: 三方互通 is on (false until the preference has been read, and from the moment the user turns it off). */
  get interconnected(): boolean { return this.loaded && this.interconnect.enabled && !this.interconnectWithdrawn; }

  view(): AgentChannelView {
    const setup = this.credentials ? this.safeSetup() : undefined;
    const undo = this.liveUndo();
    return {
      enabled: !!this.credentials,
      listening: !!this.server?.listening,
      connections: this.server?.connections ?? 0,
      lastAction: this.lastAction ? { ...this.lastAction, ...(undo ? { undo: { id: undo.id, label: undo.label, expiresAt: undo.expiresAt } } : {}) } : null,
      ...(this.error ? { error: this.error } : {}),
      ...(setup ? { setup } : {}),
      // Absent until the preference has been read, so the panel never shows a state that is not the user's.
      ...(this.loaded ? { interconnect: this.interconnectView() } : {}),
    };
  }

  /**
   * Restores the user's choices: with 三方互通 on (the default) the channel opens at once; with it off the channel opens
   * only if its token file exists (the user turned it on by hand), exactly as before I-014.
   */
  init(): Promise<AgentChannelView> {
    return this.serial(async () => {
      await this.interconnect.load();
      this.loaded = true;
      if (this.interconnect.enabled || await this.store.read()) await this.start();
      this.scheduleLink();
      return this.view();
    });
  }

  setEnabled(value: unknown): Promise<AgentChannelView> {
    if (typeof value !== 'boolean') return Promise.reject(new Error('内部通道开关不正确。'));
    if (!value && this.interconnected) return Promise.reject(new Error('“三方互通”开着的时候，内部通道一直开着。要关掉通道，请先关掉“三方互通”。'));
    // Off takes effect for calls in flight at once, and new calls are refused, even if a start/stop is still queued.
    if (!value) { this.closing++; this.registry.revoke(); }
    return this.serial(async () => {
      try {
        if (value && !this.credentials) await this.start();
        else if (!value) await this.stop(true);
        return this.view();
      } finally { if (!value) this.closing--; }
    });
  }

  /**
   * I-014: the user's choice, remembered. On: the channel opens and confirm-tier calls stop asking. Off: calls in flight
   * that have not committed are abandoned, the channel closes and its token file goes; dialogs come back.
   *
   * Off takes effect at the click, before anything is saved (Codex T-112 round 029: a new confirm-tier call that arrived while
   * the choice was being written still ran without a dialog and kept its result): direct execution is withdrawn and new calls
   * are refused at once; then the choice is saved and the channel closed. If saving fails the channel still closes and
   * direct execution stays withdrawn for this run (the error says so); only turning it on again gives it back.
   */
  setInterconnect(value: unknown): Promise<AgentChannelView> {
    if (typeof value !== 'boolean') return Promise.reject(new Error('三方互通开关不正确。'));
    const click = ++this.interconnectClicks;
    if (!value) { this.interconnectWithdrawn = true; this.closing++; this.registry.revoke(); }
    return this.serial(async () => {
      if (value) {
        await this.interconnect.setEnabled(true);
        this.loaded = true;
        if (click === this.interconnectClicks) this.interconnectWithdrawn = false;
        if (!this.credentials) await this.start(); this.scheduleLink(0);
        this.publish();
        return this.view();
      }
      try {
        let failed: unknown = null;
        try { await this.interconnect.setEnabled(false); } catch (error) { failed = error; }
        this.loaded = true;
        await this.stop(true); this.link = { ...IDLE_LINK };
        if (failed) {
          this.error = `“三方互通”的关闭没能保存（${failed instanceof Error ? failed.message.slice(0, 120) : '未知错误'}）。这次已按关闭处理：内部通道已关，需要确认的都会弹窗；下次启动可能又是打开的，请到时再关一次。`;
          this.publish();
          throw new Error(this.error);
        }
        this.publish();
        return this.view();
      } finally { this.closing--; }
    });
  }

  /** 「重新接上」: checks Claude Code again and registers even a name the user removed before. */
  relinkClaudeCode(): Promise<AgentChannelView> {
    if (!this.interconnected || !this.credentials) return Promise.reject(new Error('请先打开“三方互通”。'));
    return this.runLink(true).then(() => this.view());
  }

  /** The panel's 「撤回」 (the user's own click, so no channel guard) or undo_last_action (the call's guard). */
  async undo(id?: unknown, guard: AgentCommitGuard = () => {}): Promise<AgentChannelView> {
    const slot = this.liveUndo();
    if (!slot || (id !== undefined && id !== slot.id)) throw new AgentToolError('unavailable', '没有可以撤回的操作了（可能已经撤回、过了 30 分钟，或之后又有新的操作）。');
    this.undoSlot = null;
    try { await slot.run(guard); }
    finally { this.publish(); }
    return this.view();
  }

  /** The panel and the recycle bin changed (names and counts only). */
  refresh(): void { this.publish(); }

  dispose(): Promise<void> {
    this.disposed = true;
    if (this.linkTimer) clearTimeout(this.linkTimer);
    this.registry.revoke();
    return this.serial(() => this.stop(false)).then(() => this.audit.flush());
  }

  private ownTools(): AgentToolDefinition[] {
    const title = (name: string) => AGENT_TOOLS.find(tool => tool.name === name)?.title ?? name;
    return [
      {
        name: 'undo_last_action', title: title('undo_last_action'), tier: 'reversible', validate: noArgs,
        prepare: () => { const slot = this.liveUndo(); if (!slot) throw new AgentToolError('unavailable', '没有可以撤回的操作了（可能已经撤回、过了 30 分钟，或之后又有新的操作）。'); return slot; },
        noticeDetail: (slot: UndoSlot) => slot.label,
        run: async (slot: UndoSlot, context) => {
          if (this.liveUndo()?.id !== slot.id) throw new AgentToolError('unavailable', '要撤回的操作已经变了，没有撤回。');
          this.undoSlot = null;
          await slot.run(context.check);
          return { undone: slot.label, of: slot.title };
        },
      },
      {
        // I-014: off is always the user's to take back; on is only reachable with 三方互通 off, so it always asks.
        name: 'set_interconnect', title: title('set_interconnect'), tier: 'reversible',
        validate: raw => oneOf(argsObject(raw, ['state']).state, ['on', 'off'] as const, 'state '),
        tierFor: (state: 'on' | 'off') => state === 'on' ? 'confirm' : 'reversible',
        confirmation: () => ({ title: 'Claude 请求打开“三方互通”',
          detail: '打开后，你对自己的 Claude 说的事会直接做，不再在这里弹窗确认；每次都会显示“由 Claude 操作”，能撤回的可以撤回。\n密钥、运行命令、任意读写文件始终不开放。' }),
        noticeDetail: (state: 'on' | 'off') => state === 'on' ? '打开' : '关掉（内部通道随之关闭）',
        run: (state: 'on' | 'off') => {
          if (state === 'on') return this.setInterconnect(true).then(() => ({ interconnect: true }));
          // The answer goes out first; the channel closes right after.
          setTimeout(() => { void this.setInterconnect(false).catch(() => {}); }, 250);
          return { interconnect: false, note: '三方互通马上关闭，内部通道也会随之关闭；需要时请用户在控制窗口「隐私与设置」里重新打开。' };
        },
      },
    ];
  }

  private interconnectView(): AgentInterconnectView {
    const state = this.interconnect.current;
    let recycle: { days: number; entries: AgentRecycleSummary[] } = { days: 7, entries: [] };
    try { recycle = this.options.recycle?.() ?? recycle; } catch { /* Shown empty. */ }
    // What is in effect: off from the click on, also while saving or after saving failed (the error says which).
    return { enabled: this.interconnected, explicit: state.explicit, ...(state.unreadable ? { unreadable: true } : {}),
      recycleDays: recycle.days, recycleBin: recycle.entries, claudeCode: this.interconnected ? { ...this.link } : { ...IDLE_LINK } };
  }

  private liveUndo(): UndoSlot | null {
    if (this.undoSlot && this.clock() > this.undoSlot.expiresAt) this.undoSlot = null;
    return this.undoSlot;
  }

  private notice(title: string, detail?: string): void {
    const notice: AgentChannelNotice = { title, at: Date.now(), ...(detail ? { detail } : {}) };
    try { this.options.publishNotice?.(notice); } catch { /* Window may be gone. */ }
  }

  /** Once per launch, a little after the channel opened (never in the way of startup or the first reply). */
  private scheduleLink(delay = this.options.linkDelayMs ?? 20_000): void {
    if (!this.options.linkClaudeCode || this.disposed || !this.interconnected || !this.credentials) return;
    if (this.linkStarted && delay !== 0) return;
    this.linkStarted = true;
    if (this.linkTimer) clearTimeout(this.linkTimer);
    this.link = { state: 'checking', name: this.link.name, message: '正在检查你的 Claude Code…' };
    this.linkTimer = setTimeout(() => { this.linkTimer = null; void this.runLink(false); }, delay);
    this.linkTimer.unref?.();
  }

  private async runLink(force: boolean): Promise<void> {
    const linker = this.options.linkClaudeCode;
    if (!linker || this.disposed || !this.interconnected) return;
    this.link = { ...this.link, state: 'checking', message: '正在检查你的 Claude Code…' };
    this.publish();
    try {
      const state = this.interconnect.current;
      const link = await linker(force, state.autoRegistered,
        { pending: state.repointing ?? [], mark: (name, pending) => this.interconnect.markRepointing(name, pending) });
      // Remembered first: a name this profile added (or pointed at this version) is never added back by itself once the
      // user removes it, and is pointed at the next version after an update.
      if (link.state === 'registered' || link.state === 'updated') await this.interconnect.noteAutoRegistered(link.name);
      this.link = link;
    } catch (error) {
      this.link = { state: 'failed', name: this.link.name, message: `没能自动接上你的 Claude Code（${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}）。可以复制下面的命令自己运行一次。` };
    }
    this.publish();
  }

  private async start(): Promise<void> {
    if (this.disposed) return;
    this.error = undefined;
    let server: AgentChannelServer | null = null;
    try {
      const endpoint = agentEndpoint(this.options.profileDirectory, this.platform, this.options.username);
      // A fresh token on every start: an old copy of the file stops working.
      const credentials = await this.store.issue(endpoint);
      server = new AgentChannelServer(endpoint, {
        token: () => this.credentials?.token ?? null,
        list: () => ({ tools: this.toolDescriptors() }),
        call: (tool, args) => this.registry.call(tool, args),
        authFailed: () => this.audit.record({ at: new Date().toISOString(), tool: '(auth)', tier: 'none', outcome: 'denied', code: 'auth_failed', ms: 0 }),
        connections: () => this.publish(),
      }, this.options.limits, this.platform);
      this.credentials = credentials;
      await server.start();
      this.server = server;
    } catch (error) {
      this.credentials = null;
      await server?.stop().catch(() => {});
      await this.store.revoke().catch(() => {});
      this.error = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? '通道名已被其他程序占用，未开启。' : `未能开启：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`;
    }
    this.publish();
  }

  private async stop(revoke: boolean): Promise<void> {
    // Calls still in flight from this generation are abandoned before anything else (X-090):
    // approved but uncommitted work fails with channel_off; committed work keeps its result.
    this.registry.revoke();
    const server = this.server;
    this.server = null;
    if (revoke) this.credentials = null;
    await server?.stop();
    if (revoke) { await this.store.revoke(); this.error = undefined; }
    if (!revoke) this.credentials = null;
    this.publish();
  }

  private toolDescriptors() {
    const exposed = new Set(this.registry.names());
    return AGENT_TOOLS.filter(tool => exposed.has(tool.name));
  }

  private safeSetup(): AgentChannelView['setup'] {
    try { return this.options.setup?.(); } catch { return undefined; }
  }

  private clock(): number { return this.options.clock?.() ?? Date.now(); }

  private publish(): void {
    if (this.disposed) return;
    try { this.options.publishView?.(this.view()); } catch { /* Controls may be gone. */ }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
