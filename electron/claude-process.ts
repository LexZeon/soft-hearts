import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StreamEvent } from '../shared/contracts';
import { CLAUDE_EMPTY_MESSAGE, CLAUDE_FIRST_RESPONSE_TIMEOUT_MS, CLAUDE_REFUSED_MESSAGE, ClaudeStreamReader, claudeArguments, claudeEnvironment, claudeFailure, terminateClaude } from './claude';
import type { ReplyIncident } from '../shared/chat-incident';
import { PROFILE_FOLDER } from './profile';

type Emit = (type: StreamEvent['type'], text: string) => void;

/**
 * Why a turn failed. Only 'crash' (the process died or its pipe broke before
 * the turn finished) may be retried on a fresh process, and only when nothing
 * was shown yet. 'unsafe' is a safety stop (tools/MCP reported, tool use, no
 * isolation report) and is never retried.
 */
export type ClaudeTurnFailure = 'crash' | 'unsafe' | 'failed' | 'timeout' | 'closed';
export class ClaudeTurnError extends Error {
  /**
   * `detail`: the raw failure text behind `message`, for classification only (shared/claude-failure.ts); never displayed.
   * `incident`: the model refused, or answered with nothing (shared/chat-incident.ts); the chat then fails quietly.
   */
  constructor(message: string, readonly kind: ClaudeTurnFailure, readonly detail = '', readonly incident?: ReplyIncident) { super(message); }
}

export interface ClaudeProcessOptions {
  binary: string;
  /** Test seam only: arguments before Claude Code's own (tests run a script through node). The app never sets it. */
  binaryArgs?: readonly string[];
  model: string;
  systemPrompt: string;
  turnTimeoutMs?: number;
  /** X2: a turn that gets no answer at all within this window ends as offline (CLAUDE_FIRST_RESPONSE_TIMEOUT_MS). */
  firstResponseTimeoutMs?: number;
  /** How long an interrupted turn may take to send its closing result before the process is killed. */
  interruptGraceMs?: number;
  spawn?: typeof spawn;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** How a turn ended. `superseded`: stopped early by supersede(); `output` is what Claude streamed before it stopped. */
export interface ClaudeTurnResult { output: string; superseded: boolean }

interface Turn {
  reader: ClaudeStreamReader;
  live: boolean;
  /** supersede() asked Claude Code to stop this turn and it did not refuse. */
  superseding: boolean;
  settle(error: Error | null, result?: ClaudeTurnResult): void;
  timer: unknown;
  /** X2: the first-response window. */
  stall: unknown;
}

const defaultTimers = {
  set: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One long-lived `claude -p --input-format stream-json` process with the same
 * isolation flags, environment and empty folder as the per-message path. Turns
 * are strictly sequential: a user message is written only when the previous
 * turn's `result` has been read (or the process is gone), so every output
 * event belongs to exactly one turn. Claude Code reports `system/init` for
 * every turn; each one is checked again.
 *
 * Cancelling a turn stops its output at once (late deltas are dropped), sends
 * Claude Code's own stream-json interrupt control request, and drains until the
 * interrupted turn's `result`. If that does not arrive within the grace
 * period, or the CLI rejects the interrupt, the process is killed instead.
 *
 * Superseding a turn (R33, the user kept talking) sends the same interrupt but
 * keeps the turn live: see supersede(). Claude Code 2.1.316 never merges a user
 * message written mid-turn into that turn (it queues it as a whole new turn),
 * so the app never writes one; this is how a reply makes room for an addition.
 */
export class ClaudeChatProcess {
  readonly model: string;
  /** A clean init has been seen in this process. */
  verified = false;
  /** User messages written to this process (including interrupted ones). */
  turnsStarted = 0;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timers: NonNullable<ClaudeProcessOptions['timers']>;
  private turn: Turn | null = null;
  private draining: { request: string; timer: unknown; done: () => void } | null = null;
  private drained: Promise<void> = Promise.resolve();
  /** An outstanding supersede interrupt; the next user message waits for its control_response. */
  private control: { request: string; turn: Turn; timer: unknown; done: () => void; answered: boolean } | null = null;
  private controlled: Promise<void> = Promise.resolve();
  private closed = false;
  private exited = false;
  private stderr = '';
  private buffer = '';
  private spawnError: NodeJS.ErrnoException | null = null;

  static async start(options: ClaudeProcessOptions): Promise<ClaudeChatProcess> {
    const root = path.join(os.tmpdir(), PROFILE_FOLDER, 'claude-chat');
    await mkdir(root, { recursive: true, mode: 0o700 });
    // An empty, throwaway folder: nothing for Claude Code to discover or read.
    const directory = await mkdtemp(path.join(root, 'session-'));
    return new ClaudeChatProcess(options, directory);
  }

  private constructor(private readonly options: ClaudeProcessOptions, private readonly directory: string) {
    this.model = options.model;
    this.timers = options.timers ?? defaultTimers;
    this.child = (options.spawn ?? spawn)(options.binary, [...(options.binaryArgs ?? []), ...claudeArguments({ model: options.model }, options.systemPrompt)], {
      cwd: directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnvironment(),
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.data(chunk));
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.child.stdin.on('error', () => this.close('crash'));
    this.child.once('error', error => { this.spawnError = error as NodeJS.ErrnoException; this.close('crash'); });
    this.child.once('close', () => {
      if (this.buffer.trim()) this.line(this.buffer);
      this.buffer = '';
      this.exited = true;
      this.close('crash');
      void rm(this.directory, { recursive: true, force: true }).catch(() => {});
    });
  }

  /** Usable for another turn (not closed, not currently in a turn). Draining counts as busy until it settles. */
  get alive(): boolean { return !this.closed; }
  get busy(): boolean { return !!this.turn || !!this.draining || !!this.control; }

  /**
   * Resolves once an interrupted turn has drained and any supersede interrupt
   * has been answered (or the process is gone): only then may the next user
   * message be written, so a late interrupt can never land on it.
   */
  settled(): Promise<void> { return Promise.all([this.drained, this.controlled]).then(() => {}); }

  /**
   * Writes one stream-json user message and resolves with the turn's text.
   * Deltas go to `emit` only while the turn is live; an abort rejects at once.
   */
  async run(input: string, signal: AbortSignal, emit: Emit): Promise<string> {
    return (await this.runTurn(input, signal, emit)).output;
  }

  /**
   * R33: stops the live turn early because the user added to the same utterance.
   * Sends Claude Code's own interrupt control request, but unlike a cancel the
   * turn stays live: everything Claude streamed before it stopped (including
   * text already in the pipe) is still delivered, because Claude Code keeps it
   * in its context with "[Request interrupted by user]", and the screen must
   * agree with what Claude knows it said. runTurn() then resolves with
   * `superseded: true` and that partial output. If the turn had already
   * finished when Claude Code read the interrupt, it resolves normally
   * (`superseded: false`); an interrupt on an idle process does nothing (both
   * checked on 2.1.316). At most one request per turn; false when there is no
   * live turn to stop. If Claude Code accepts but sends no result within the
   * grace period, the process is killed like a cancel that is not answered.
   */
  supersede(): boolean {
    const turn = this.turn;
    if (!turn || !turn.live || turn.superseding || this.closed || this.draining || this.control) return false;
    const request = `supersede-${randomUUID()}`;
    let done!: () => void;
    this.controlled = new Promise<void>(resolve => { done = resolve; });
    const control = { request, turn, timer: null as unknown, done, answered: false };
    control.timer = this.timers.set(() => {
      if (this.control !== control) return;
      if (this.turn === turn) this.close('closed'); else this.finishControl();
    }, this.options.interruptGraceMs ?? 3_000);
    this.control = control;
    turn.superseding = true;
    if (!this.write(JSON.stringify({ type: 'control_request', request_id: request, request: { subtype: 'interrupt' } }) + '\n')) {
      this.close('crash');
      return false;
    }
    return true;
  }

  /** run(), also telling whether supersede() stopped the turn early. */
  runTurn(input: string, signal: AbortSignal, emit: Emit): Promise<ClaudeTurnResult> {
    if (this.closed) return Promise.reject(new ClaudeTurnError('Claude Code 进程已结束。', 'crash'));
    if (this.busy) return Promise.reject(new ClaudeTurnError('上一轮 Claude 回复还没结束。', 'failed'));
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('已停止。'));
    return new Promise<ClaudeTurnResult>((resolve, reject) => {
      let settled = false;
      // Rejecting on abort happens here, synchronously, so the host task ends
      // promptly; the process keeps draining the interrupted turn by itself.
      const onAbort = () => {
        this.interrupt();
        turn.settle(signal.reason instanceof Error ? signal.reason : new Error('已停止。'));
      };
      const turn: Turn = {
        reader: new ClaudeStreamReader((type, text) => { if (turn.live) emit(type, text); }, { verified: this.verified }),
        live: true,
        superseding: false,
        timer: null,
        stall: null,
        settle: (error, result) => {
          if (settled) return;
          settled = true;
          turn.live = false;
          this.timers.clear(turn.timer);
          this.timers.clear(turn.stall);
          signal.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve(result ?? { output: '', superseded: false });
        },
      };
      this.turn = turn;
      this.turnsStarted++;
      turn.timer = this.timers.set(() => {
        turn.settle(new ClaudeTurnError('Claude 回复超时，已停止。', 'timeout'));
        this.close('timeout');
      }, this.options.turnTimeoutMs ?? 120_000);
      // X2: offline Claude Code retries silently for minutes; no answer at all in this window is "offline".
      // A 'failed' turn, not 'timeout': two timeouts would degrade the warm session for the whole run.
      const firstResponseMs = this.options.firstResponseTimeoutMs ?? CLAUDE_FIRST_RESPONSE_TIMEOUT_MS;
      turn.stall = this.timers.set(() => {
        if (this.turn !== turn || !turn.live || turn.superseding || !turn.reader.noResponse(firstResponseMs)) return;
        this.fail(turn.reader.failure, 'failed', turn.reader.failureDetail);
      }, firstResponseMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if (!this.write(input)) turn.settle(new ClaudeTurnError('Claude Code 进程已结束。', 'crash'));
    });
  }

  /** Ends the process for good. Any live turn fails with `kind`. */
  close(kind: ClaudeTurnFailure = 'closed'): void {
    const turn = this.turn;
    this.turn = null;
    if (turn?.live) turn.settle(this.closeError(kind));
    this.finishDrain();
    this.finishControl();
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* Already closed. */ }
    terminateClaude(this.child, () => this.exited);
  }

  private closeError(kind: ClaudeTurnFailure): Error {
    if (this.spawnError?.code === 'ENOENT')
      return new ClaudeTurnError('无法启动 Claude Code，请确认已安装并能在终端运行 claude。', 'crash');
    if (kind === 'crash') {
      const detail = this.stderr.trim();
      return new ClaudeTurnError(detail ? claudeFailure(detail) : 'Claude Code 意外退出，已停止。', 'crash', detail.slice(0, 2000));
    }
    if (kind === 'timeout') return new ClaudeTurnError('Claude 回复超时，已停止。', 'timeout');
    return new ClaudeTurnError('这轮聊天所属的角色或对话已改变。', kind);
  }

  private interrupt(): void {
    const turn = this.turn;
    if (!turn || this.closed || this.draining) return;
    turn.live = false;
    let done!: () => void;
    this.drained = new Promise<void>(resolve => { done = resolve; });
    const timer = this.timers.set(() => this.close('closed'), this.options.interruptGraceMs ?? 3_000);
    // A supersede interrupt for this turn is already on its way: never send a
    // second one (it could reach Claude Code after the turn ended). Drain on it.
    if (this.control?.turn === turn) { this.draining = { request: this.control.request, timer, done }; return; }
    const request = `interrupt-${randomUUID()}`;
    this.draining = { request, timer, done };
    if (!this.write(JSON.stringify({ type: 'control_request', request_id: request, request: { subtype: 'interrupt' } }) + '\n'))
      this.close('closed');
  }

  private finishDrain(): void {
    const draining = this.draining;
    if (!draining) return;
    this.draining = null;
    this.timers.clear(draining.timer);
    draining.done();
  }

  private finishControl(): void {
    const control = this.control;
    if (!control) return;
    this.control = null;
    this.timers.clear(control.timer);
    control.done();
  }

  private write(line: string): boolean {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    try { this.child.stdin.write(line); return true; } catch { return false; }
  }

  private data(chunk: string): void {
    this.buffer += chunk;
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      this.line(line);
    }
    if (this.buffer.length > 2_000_000) this.fail('Claude 返回的数据过大。', 'failed');
  }

  private fail(message: string, kind: ClaudeTurnFailure, detail = ''): void {
    const turn = this.turn;
    this.turn = null;
    turn?.settle(new ClaudeTurnError(message, kind, detail));
    this.close(kind);
  }

  private line(line: string): void {
    if (!line.trim()) return;
    if (line.length > 2_000_000) { this.fail('Claude 返回的数据过大。', 'failed'); return; }
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'control_response') {
      const response = event.response ?? {};
      const control = this.control;
      if (control && response.request_id === control.request) {
        // Refused: the turn simply runs to its own end. Accepted: done once its
        // turn has ended too (until then the grace timer guards the result).
        if (response.subtype !== 'success') control.turn.superseding = false;
        control.answered = true;
        if (response.subtype !== 'success' || this.turn !== control.turn) this.finishControl();
      }
      if (this.draining && response.request_id === this.draining.request && response.subtype !== 'success') this.close('closed');
      return;
    }
    const turn = this.turn;
    if (!turn) {
      // Output with no turn to own it means the stream is out of step: stop.
      if (['stream_event', 'assistant', 'result'].includes(event.type)) this.close('closed');
      return;
    }
    if (this.draining) {
      // Everything until the interrupted turn's result belongs to that turn and
      // is dropped (the turn is no longer live, so no text is shown). It is still
      // checked like a live turn: a tool report in an init, or a tool-use block in
      // a stream event or message, ends the process instead of letting it serve
      // another turn (X-087).
      if (event.type === 'result') { this.turn = null; this.finishDrain(); this.turnEnded(turn); return; }
      if (turn.reader.consumeEvent(event) === 'stop' && turn.reader.unsafe) this.close('unsafe');
      return;
    }
    if (event.type === 'result' && turn.superseding && event.subtype !== 'success') {
      // Stopped by supersede(): Claude Code keeps what it streamed (and knows it
      // was interrupted); the caller gets exactly that, possibly nothing.
      this.turn = null;
      this.turnEnded(turn);
      turn.settle(null, { output: turn.reader.output, superseded: true });
      return;
    }
    const verdict = turn.reader.consumeEvent(event);
    if (turn.reader.initialized) this.verified = true;
    if (verdict === 'stop') {
      this.fail(turn.reader.failure || 'Claude Code 未能完成回复。', turn.reader.unsafe ? 'unsafe' : 'failed', turn.reader.failureDetail);
      return;
    }
    if (event.type !== 'result') return;
    this.turn = null;
    this.turnEnded(turn);
    if (turn.reader.refused) {
      // The model refused this reply. Whatever it printed instead (a notice, a partial text) is not shown as an answer;
      // the process stays alive but the session layer drops this conversation's process like after any failed turn.
      turn.settle(new ClaudeTurnError(CLAUDE_REFUSED_MESSAGE, 'failed', '', 'refusal'));
      return;
    }
    if (!turn.reader.output.trim()) {
      turn.settle(new ClaudeTurnError(CLAUDE_EMPTY_MESSAGE, 'failed', '', 'empty'));
      this.close('failed');
      return;
    }
    // A supersede that arrived after Claude Code had finished: the full reply stands.
    turn.settle(null, { output: turn.reader.output, superseded: false });
  }

  /** A turn's result was read: an answered supersede interrupt for it is now fully done. */
  private turnEnded(turn: Turn): void {
    if (this.control?.turn === turn && this.control.answered) this.finishControl();
  }
}
