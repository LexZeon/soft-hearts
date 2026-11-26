// I-071 v2 第二步 Claude 助手: one conversation, one turn at a time. Each turn is a fresh `claude -p` process
// (electron/safety/assistant/process.ts) given the earlier conversation as text, so a new model or effort takes effect on the next
// message. Its only tools come over a per-turn endpoint (endpoint.ts) into the channel host's surface registry: the same tools,
// tiers, undo slot and audit log as the internal channel, with every confirm-tier call opening the panel's popup.
// "停止" ends the turn at once: calls not yet committed are abandoned, an open popup closes, the process tree is killed.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ASSISTANT_CHOICES_TOOL, ASSISTANT_NOTICE_LIMIT, assistantActionOf, assistantTurnPrompt, validateAssistantPrefs, validateAssistantText, validateChoicesInput,
  type AssistantAction, type AssistantConfirmView, type AssistantEvent, type AssistantMessage, type AssistantPart, type AssistantPrefs, type AssistantView,
} from '../../../shared/safety/assistant';
import type { AgentUndoView } from '../../../shared/safety/agent-channel';
import { CONVERSION_INTRO_NEXT_KEY as INTRO_NEXT_KEY, enforceExtraBy, type ConversionJobView } from '../../../shared/cards';
import { fullWidthChinese } from '../../../shared/foundation/fullwidth-punctuation';
import { claudeFailure, ClaudeGateWatch, claudeStartGate, ClaudeStartPausedError, findClaude, terminateClaude, type ClaudeGatePass, type ClaudeStartGate } from '../../brain';
import type { AgentSurfaceOptions } from '../agent-channel/host';
import type { AgentCallResult, AgentCallSummary, AgentConfirmRequest, AgentToolRegistry } from '../agent-channel/registry';
import { assistantToolList, openAssistantEndpoint, type AssistantEndpoint } from './endpoint';
import { assistantArguments, assistantEnvironment, AssistantStreamReader, type ShimLaunch } from './process';
import { ASSISTANT_SYSTEM_PROMPT } from './prompt';
import { cleanHistory, type AssistantStore } from './store';
import { ASSISTANT_CLI_NAME } from '../../../shared/foundation/assistant-name';

export interface AssistantServiceOptions {
  /** The channel host's surfaceRegistry (agent-channel/host.ts). */
  registry(surface: AgentSurfaceOptions): AgentToolRegistry;
  store: Pick<AssistantStore, 'loadPrefs' | 'savePrefs' | 'loadHistory' | 'saveHistory' | 'clearHistory'>;
  shim: ShimLaunch;
  emit(event: AssistantEvent): void;
  /** The channel host's undo (the user's own click: no channel guard). */
  undo(id: string): Promise<unknown>;
  uiLanguage?(): 'en' | 'zh-CN';
  /** I-071 v2 第三步: the conversion job (electron/cards/character-convert/); a convert call this conversation made shows its progress here. */
  conversion?: { view(): ConversionJobView | null };
  findClaude?(): Promise<string>;
  /** Test seams: run a fake Claude through node. The app never sets them. */
  binary?: string;
  leadingArgs?: readonly string[];
  env?(): NodeJS.ProcessEnv;
  tempRoot?: string;
  platform?: NodeJS.Platform;
  turnTimeoutMs?: number;
  firstResponseMs?: number;
  confirmTimeoutMs?: number;
  /** Test seam: the start gate (I-202, electron/brain/claude-start-gate.ts). The app always uses the shared one. */
  gate?: ClaudeStartGate;
}

interface Turn {
  message: AssistantMessage;
  prefs: AssistantPrefs;
  live: boolean;
  stopped: boolean;
  kill(): void;
  done: Promise<void>;
  newParagraph: boolean;
  /** Resolves true once Claude Code's init report passed, false when the turn ends first: no tool runs before that. */
  verified: Promise<boolean>;
  verify(ok: boolean): void;
}

const BUSY = '上一句还没回完。可以先点“停止”。';

export class AssistantService {
  readonly registry: AgentToolRegistry;
  private messages: AssistantMessage[] = [];
  private prefs: AssistantPrefs = validateAssistantPrefs({});
  private turn: Turn | null = null;
  private confirmation: { view: AssistantConfirmView; resolve(allow: boolean): void } | null = null;
  /** The action whose undo slot is the host's current one, as far as this conversation knows. */
  private undoable: AssistantAction | null = null;
  private readonly ready: Promise<void>;
  private disposed = false;

  constructor(private readonly options: AssistantServiceOptions) {
    this.registry = options.registry({
      enabled: () => !this.disposed && this.turn?.live === true,
      confirm: (request, signal) => this.confirm(request, signal),
      called: (summary, undo) => this.called(summary, undo),
      ...(options.confirmTimeoutMs ? { confirmTimeoutMs: options.confirmTimeoutMs } : {}),
    });
    this.ready = (async () => {
      this.prefs = await options.store.loadPrefs().catch(() => this.prefs);
      this.messages = await options.store.loadHistory().catch(() => []);
    })();
  }

  get busy(): boolean { return !!this.turn; }
  /** The model and effort chosen now (the conversion uses the same). */
  get currentPrefs(): AssistantPrefs { return { ...this.prefs }; }

  /**
   * I-071 v2 第三步: a conversion changed. The line this conversation shows for it (if any) follows; the final state is kept in the
   * history. A conversion started elsewhere (the external channel) is not shown here.
   */
  conversionChanged(job: ConversionJobView): void {
    let found = false;
    for (const message of this.messages) for (const part of message.parts)
      if (part.kind === 'conversion' && part.job.id === job.id) { part.job = structuredClone(job); found = true; }
    if (!found) return;
    this.emit({ type: 'conversion', job: structuredClone(job) });
    if (job.state !== 'running' && !this.turn) void this.persist();
  }

  async view(): Promise<AssistantView> { await this.ready; return this.snapshot(); }

  /** Starts a turn and returns at once; the reply streams as events. `choiceId`: the user clicked a button of that set. */
  async send(raw: unknown, choiceId?: unknown): Promise<AssistantView> {
    await this.ready;
    if (this.disposed) throw new Error('助手已经关闭。');
    if (this.turn) throw new Error(BUSY);
    const text = validateAssistantText(raw);
    if (choiceId !== undefined) this.answerChoices(choiceId, text);
    const earlier = [...this.messages];
    const user: AssistantMessage = { id: randomUUID(), role: 'user', at: Date.now(), parts: [{ kind: 'text', text }] };
    const reply: AssistantMessage = { id: randomUUID(), role: 'assistant', at: Date.now(), parts: [], status: 'streaming' };
    this.messages.push(user, reply);
    let verify: (ok: boolean) => void = () => {};
    const verified = new Promise<boolean>(resolve => { verify = resolve; });
    const turn: Turn = { message: reply, prefs: { ...this.prefs }, live: true, stopped: false, kill: () => {}, done: Promise.resolve(), newParagraph: false,
      verified, verify: ok => verify(ok) };
    this.turn = turn;
    this.emit({ type: 'state', view: this.snapshot() });
    const prompt = assistantTurnPrompt(earlier, text, this.options.uiLanguage?.() ?? 'zh-CN');
    turn.done = this.run(turn, prompt);
    return this.snapshot();
  }

  /** Waits for the running turn (tests, quitting). */
  async idle(): Promise<void> { await this.turn?.done; }

  /** 「停止」: nothing not yet committed takes effect; an open popup closes; the process tree ends. */
  cancel(): AssistantView {
    const turn = this.turn;
    if (turn && turn.live) {
      turn.live = false;
      turn.stopped = true;
      this.registry.revoke();
      turn.kill();
    }
    return this.snapshot();
  }

  async clear(): Promise<AssistantView> {
    await this.ready;
    if (this.turn) throw new Error(BUSY);
    this.messages = [];
    this.undoable = null;
    await this.options.store.clearHistory();
    this.emit({ type: 'state', view: this.snapshot() });
    return this.snapshot();
  }

  /** I-144b 「清空」 through the recycle bin: the conversation as it is kept now (copies); refused while a turn runs. Nothing changes. */
  async historyCopy(): Promise<AssistantMessage[]> {
    await this.ready;
    if (this.turn) throw new Error(BUSY);
    return structuredClone(this.messages.filter(message => message.status !== 'streaming'));
  }
  /** Puts a conversation historyCopy copied back; resolves to the one it replaced (the caller keeps that in the bin). Refused while a turn runs. */
  async restoreHistory(messages: unknown): Promise<AssistantMessage[]> {
    await this.ready;
    if (this.turn) throw new Error(BUSY);
    const back = cleanHistory({ version: 1, messages });
    if (!Array.isArray(messages) || back.length !== messages.length) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
    const replaced = structuredClone(this.messages.filter(message => message.status !== 'streaming'));
    await this.options.store.saveHistory(back);
    this.messages = back; this.undoable = null;
    this.emit({ type: 'state', view: this.snapshot() });
    return replaced;
  }

  async setPrefs(value: unknown): Promise<AssistantView> {
    await this.ready;
    const next = validateAssistantPrefs(value, this.prefs);
    await this.options.store.savePrefs(next);
    this.prefs = next;
    this.emit({ type: 'state', view: this.snapshot() });
    return this.snapshot();
  }

  /** The popup's answer: only the open one, only once, only from the control window (IPC is control-only). */
  answer(id: unknown, allow: unknown): void {
    const open = this.confirmation;
    if (!open || typeof id !== 'string' || id !== open.view.id) return;
    this.confirmation = null;
    open.resolve(allow === true);
  }

  /** The 「撤回」 on an action line: the host's own undo (the user's click). */
  async undo(id: unknown): Promise<AssistantView> {
    await this.ready;
    if (typeof id !== 'string') throw new Error('撤回编号不正确。');
    const action = this.findAction(id);
    await this.options.undo(id);
    if (action) { action.undone = true; delete action.undoId; if (this.undoable === action) this.undoable = null; }
    await this.persist();
    this.emit({ type: 'state', view: this.snapshot() });
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.idle().catch(() => {});
  }

  private snapshot(): AssistantView {
    return { messages: structuredClone(this.messages), busy: !!this.turn, prefs: { ...this.prefs } };
  }

  private emit(event: AssistantEvent): void { try { this.options.emit(event); } catch { /* The window may be gone. */ } }

  private answerChoices(choiceId: unknown, text: string): void {
    for (const message of this.messages) for (const part of message.parts)
      if (part.kind === 'choices' && part.choices.id === choiceId) {
        if (part.choices.answered) throw new Error('这组按钮已经选过了。');
        if (!part.choices.options.includes(text)) throw new Error('选的不是这组按钮里的一个。');
        part.choices.answered = text;
        return;
      }
    throw new Error('这组按钮已经不在了。');
  }

  private findAction(undoId: string): AssistantAction | null {
    for (const message of this.messages) for (const part of message.parts)
      if (part.kind === 'action' && part.action.undoId === undoId) return part.action;
    return null;
  }

  private push(turn: Turn, part: AssistantPart): void {
    turn.message.parts.push(part);
    this.emit({ type: 'part', messageId: turn.message.id, part: structuredClone(part) });
  }

  private text(turn: Turn, text: string): void {
    if (!turn.live) return;
    const last = turn.message.parts.at(-1);
    if (last?.kind === 'text' && !turn.newParagraph) last.text += text;
    else { turn.newParagraph = false; this.push(turn, { kind: 'text', text: '' }); (turn.message.parts.at(-1) as { text: string }).text = text; }
    this.emit({ type: 'text', messageId: turn.message.id, text });
  }

  /** Every finished call of this surface: one line, written from the registry's result (never the model's words). */
  private called(summary: AgentCallSummary, undo?: AgentUndoView): void {
    const turn = this.turn;
    if (!turn) return;
    if (summary.tool === 'undo_last_action' && summary.outcome === 'allowed' && this.undoable) {
      this.undoable.undone = true; delete this.undoable.undoId; this.undoable = null;
    }
    const action = assistantActionOf(summary, undo?.id);
    // The host keeps one undo slot: a newer change replaces (or, without its own way back, clears) it.
    if (summary.outcome === 'allowed' && summary.tier !== 'read' && summary.tool !== 'undo_last_action') {
      if (this.undoable) delete this.undoable.undoId;
      this.undoable = action.undoId ? action : null;
    }
    turn.newParagraph = true;
    this.push(turn, { kind: 'action', action });
    // Older lines may have lost their 「撤回」: the panel redraws from the whole view.
    if (summary.tier !== 'read') this.emit({ type: 'state', view: this.snapshot() });
  }

  private confirm(request: AgentConfirmRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.turn?.live) return Promise.resolve(false);
    const view: AssistantConfirmView = { id: randomUUID(), title: request.title.slice(0, 200), detail: request.detail.slice(0, 2000),
      toolTitle: request.toolTitle.slice(0, 60), buttons: request.buttons ? [request.buttons[0], request.buttons[1]] : ['不允许', '允许'], timeoutMs: request.timeoutMs };
    return new Promise<boolean>(resolve => {
      const close = () => {
        if (this.confirmation?.view.id === view.id) this.confirmation = null;
        this.emit({ type: 'confirm-closed', id: view.id });
        resolve(false);
      };
      signal.addEventListener('abort', close, { once: true });
      this.confirmation = { view, resolve: allow => { signal.removeEventListener('abort', close); this.emit({ type: 'confirm-closed', id: view.id }); resolve(allow); } };
      this.emit({ type: 'confirm', request: view });
    });
  }

  private async callTool(turn: Turn, tool: unknown, args: unknown): Promise<AgentCallResult> {
    const closed: AgentCallResult = { ok: false, error: { code: 'channel_off', message: '这一轮已经停止，没有执行。' } };
    // Nothing runs before Claude Code proved its isolation (init report), or after the turn stopped.
    if (!turn.live || this.turn !== turn || !await turn.verified || !turn.live) return closed;
    if (tool === ASSISTANT_CHOICES_TOOL) {
      let input: { question: string; options: string[] };
      try { input = validateChoicesInput(args); } catch (error) { return { ok: false, error: { code: 'invalid_input', message: (error as Error).message } }; }
      turn.newParagraph = true;
      // Fix 6: full-width marks in the Chinese question and labels (the prompt asks for them; the model slipped in the sixth test).
      const options = input.options.map(fullWidthChinese);
      this.push(turn, { kind: 'choices', choices: { id: randomUUID(), question: fullWidthChinese(input.question), options: new Set(options).size === options.length ? options : input.options } });
      return { ok: true, result: '按钮已经显示在聊天框里，用户选的会作为下一条消息发来。现在用一两句话把答案说清楚（这一项是什么、有哪些选项、现在是什么、出处），说完就结束这一轮，不要再调用工具。' };
    }
    // Fix 6: only the user's own typed words can make an extra name "你补的" (the model once marked its own find that way).
    const result = await this.registry.call(tool, tool === 'convert_character_language' ? enforceExtraBy(args, this.userTypedTexts()) : args);
    if (tool === 'prepare_character_conversion' && result.ok && turn.live) return this.showConversionIntro(turn, result);
    if (tool === 'convert_character_language' && result.ok && turn.live) {
      const job = this.options.conversion?.view();
      if (job && job.id === (result.result as { jobId?: unknown } | null)?.jobId) { turn.newParagraph = true; this.push(turn, { kind: 'conversion', job }); }
    }
    return result;
  }

  /**
   * I-071 fix 5: in four isolated tests the model never showed the prepared intro (what is carried, what not, the exact number of
   * calls) before asking names; the button tool's reply won over the prompt. So the software shows it itself, as its own line, the
   * moment prepare_character_conversion returns (once per conversion: not again until a conversion line follows), and the model
   * gets the result without `intro` / `introNext`, told that it was shown.
   */
  private showConversionIntro(turn: Turn, result: AgentCallResult & { ok: true }): AgentCallResult {
    const value = result.result as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || typeof value.intro !== 'string' || !value.intro.trim()) return result;
    const text = value.intro.trim().slice(0, ASSISTANT_NOTICE_LIMIT);
    if (!this.introShown(text)) { turn.newParagraph = true; this.push(turn, { kind: 'notice', text }); }
    const { intro: _intro, [INTRO_NEXT_KEY]: _next, ...rest } = value;
    return { ok: true, result: { ...rest, introShown: 'soft hearts 已经把 intro（会新建什么、带什么、不带什么、准确的调用次数）作为软件自己的一段话显示给用户了。不要重复它，也不要另说别的次数；直接按 next 开始。' } };
  }

  /** What the user typed in this conversation: their messages, without the labels of the buttons the assistant offered (it wrote those). */
  private userTypedTexts(): string[] {
    const labels = new Set<string>();
    for (const message of this.messages) for (const part of message.parts) if (part.kind === 'choices') for (const option of part.choices.options) labels.add(option.trim());
    const out: string[] = [];
    for (const message of this.messages) if (message.role === 'user') for (const part of message.parts)
      if (part.kind === 'text' && !labels.has(part.text.trim())) out.push(part.text);
    return out;
  }

  /** The same intro already shown since the last conversion line of this conversation. */
  private introShown(text: string): boolean {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const parts = this.messages[index]!.parts;
      for (let at = parts.length - 1; at >= 0; at--) {
        const part = parts[at]!;
        if (part.kind === 'conversion') return false;
        if (part.kind === 'notice' && part.text === text) return true;
      }
    }
    return false;
  }

  private async run(turn: Turn, prompt: string): Promise<void> {
    const options = this.options;
    const tempRoot = options.tempRoot ?? path.join(os.tmpdir(), 'soft-hearts-claude', 'assistant');
    let endpoint: AssistantEndpoint | null = null;
    let directory = '';
    let failure = '';
    try {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      endpoint = await openAssistantEndpoint({ launch: options.shim, platform: options.platform, tempRoot,
        handlers: { list: () => assistantToolList(this.registry.names()), call: (tool, args) => this.callTool(turn, tool, args) } });
      const args = assistantArguments({ mcpConfigFile: endpoint.mcpConfigFile, prefs: turn.prefs, systemPrompt: ASSISTANT_SYSTEM_PROMPT });
      const binary = options.binary ?? await (options.findClaude ?? findClaude)();
      // An empty, throwaway working folder: nothing for Claude Code to discover or read.
      directory = await mkdtemp(path.join(tempRoot, 'turn-'));
      if (!turn.live) return;
      // I-202: after the app starts or a long quiet stretch, one Claude Code process at a time until one has answered. 「停止」 ends the wait.
      const waiting = new AbortController();
      turn.kill = () => waiting.abort();
      let pass: ClaudeGatePass;
      try { pass = await (options.gate ?? claudeStartGate).enter({ signal: waiting.signal }); }
      catch (error) {
        if (error instanceof ClaudeStartPausedError) { failure = claudeFailure(error.detail); return; }
        if (turn.stopped) return;
        throw error;
      }
      turn.kill = () => {};
      if (!turn.live) { pass.release(); return; }
      try { failure = await this.stream(turn, binary, [...(options.leadingArgs ?? []), ...args], directory, prompt, pass); }
      finally { pass.release(); }
    } catch (error) {
      failure = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? `无法启动 ${ASSISTANT_CLI_NAME}，请确认已安装并能在终端运行 claude。`
        : error instanceof Error ? error.message.slice(0, 300) : '助手没能完成这次回复。';
    } finally {
      turn.live = false;
      turn.verify(false);
      this.registry.revoke();
      if (this.confirmation) { const open = this.confirmation; this.confirmation = null; open.resolve(false); }
      await endpoint?.close().catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      const message = turn.message;
      if (turn.stopped) message.status = 'stopped';
      else if (failure) { message.status = 'failed'; message.error = failure; }
      else message.status = 'done';
      message.parts = message.parts.filter(part => part.kind !== 'text' || part.text.trim());
      for (const part of message.parts) if (part.kind === 'text') part.text = fullWidthChinese(part.text); // fix 6
      if (this.turn === turn) this.turn = null;
      await this.persist();
      this.emit({ type: 'state', view: this.snapshot() });
    }
  }

  /** Runs one process; resolves with a failure message ('' when the turn finished well). */
  private stream(turn: Turn, binary: string, args: string[], cwd: string, prompt: string, pass: ClaudeGatePass): Promise<string> {
    const child: ChildProcess = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: this.options.env?.() ?? assistantEnvironment() });
    const gate = new ClaudeGateWatch(pass); // I-202: the first streaming event opens the start gate; a lost login pauses it
    let closed = false, stopping = false, buffer = '', stderr = '';
    // Any stop (safety, failure, timeout, 停止) closes the tools at once, before the process is gone.
    const stop = () => {
      if (stopping || closed) return;
      stopping = true; turn.live = false; turn.verify(false); this.registry.revoke();
      terminateClaude(child, () => closed);
    };
    turn.kill = stop;
    const reader = new AssistantStreamReader({
      text: text => { if (!stopping) this.text(turn, text); },
      boundary: () => { turn.newParagraph = true; },
      thinking: on => { if (!stopping) this.emit({ type: 'thinking', messageId: turn.message.id, on }); },
      verified: () => { if (!stopping) turn.verify(true); },
    });
    const consume = (line: string) => {
      if (line.length > 2_000_000) { reader.failure ||= '助手返回的数据过大。'; stop(); return; }
      gate.line(line);
      if (reader.consume(line) === 'stop') stop();
    };
    const overall = setTimeout(() => { reader.failure ||= '助手这次回复太久，已停止。'; stop(); }, this.options.turnTimeoutMs ?? 15 * 60_000);
    const stall = setTimeout(() => { if (reader.noResponse()) stop(); }, this.options.firstResponseMs ?? 60_000);
    stall.unref?.();
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); consume(line); }
      if (buffer.length > 2_000_000) { reader.failure ||= '助手返回的数据过大。'; stop(); }
    });
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const input = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
    return new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        closed = true;
        if (reader.refused.length) turn.message.refusedTools = reader.refused.slice(0, 8);
        clearTimeout(overall); clearTimeout(stall);
        if (buffer.trim()) consume(buffer);
        gate.end(!turn.stopped && (!!reader.failure || !reader.finished), stderr);
        if (turn.stopped) { resolve(''); return; }
        if (reader.failure) { resolve(reader.failure); return; }
        if (!reader.finished) { resolve(code === 0 ? '助手没有回完就结束了。' : claudeFailure(stderr) || `${ASSISTANT_CLI_NAME} 运行失败（退出码 ${code ?? '未知'}）。`); return; }
        resolve('');
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    });
  }

  private async persist(): Promise<void> {
    try { await this.options.store.saveHistory(this.messages.filter(message => message.status !== 'streaming')); } catch { /* Only the history after a restart is lost. */ }
  }
}
