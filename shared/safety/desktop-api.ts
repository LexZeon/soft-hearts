// 连接、任务和安全 (safety): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type {
  CodexApprovalDecision, CodexTaskCapabilities, CodexTaskContinue, CodexTaskDetails, CodexTaskEvent, CodexTaskStart, CodexTaskSummary,
} from '../safety';

export interface SafetyDesktopAPI {
  listCodexTasks(): Promise<CodexTaskSummary[]>;
  readCodexTask(taskId: string): Promise<CodexTaskDetails>;
  startCodexTask(request: CodexTaskStart): Promise<CodexTaskSummary>;
  continueCodexTask(request: CodexTaskContinue): Promise<CodexTaskSummary>;
  interruptCodexTask(taskId: string): Promise<void>;
  respondCodexApproval(taskId: string, approvalId: string, decision: CodexApprovalDecision): Promise<void>;
  codexTaskCapabilities(): Promise<CodexTaskCapabilities>;
  onCodexTaskEvent(callback: (event: CodexTaskEvent) => void): () => void;
  proposeCodexTask(prompt: string): Promise<void>;
  onCodexTaskProposal(callback: (prompt: string) => void): () => void;
  /** R20 opt-in switch (off by default). Turning it on shows a native first-run notice. */
  setClaudeTasksEnabled(enabled: boolean): Promise<CodexTaskCapabilities>;
  claudeTasksEnabled(): Promise<boolean>;
  onClaudeTasks(callback: (state: { enabled: boolean }) => void): () => void;
  selectDirectory(): Promise<string | null>;
  /** Agent internal channel (off by default): control window toggle and status. */
  getAgentChannel(): Promise<import('../safety').AgentChannelView>;
  setAgentChannelEnabled(enabled: boolean): Promise<import('../safety').AgentChannelView>;
  /** I-014 "三方互通" (on by default, remembered once the user turns it off), 「重新接上」 Claude Code, 「撤回」, the recycle bin. */
  setAgentInterconnect(enabled: boolean): Promise<import('../safety').AgentChannelView>;
  relinkAgentClaudeCode(): Promise<import('../safety').AgentChannelView>;
  /** I-061 「复制诊断信息」: the plain-text block to copy (shared/safety/diagnostics.ts); closed values only, nothing is sent anywhere. */
  getDiagnostics(): Promise<string>;
  /** Overhaul step 7 一部分关了: which units the part runner switched off alone (read only; closed words: shared/foundation/part-health.ts). Control window only. */
  getPartHealth(): Promise<import('../foundation/ports').PartHealthView>;
  onPartHealth(callback: (view: import('../foundation/ports').PartHealthView) => void): () => void;
  undoAgentAction(id: string): Promise<import('../safety').AgentChannelView>;
  restoreRecycledMemory(id: string): Promise<import('../safety').AgentChannelView>;
  setRecycleDays(days: number): Promise<import('../safety').AgentChannelView>;
  onAgentChannel(callback: (view: import('../safety').AgentChannelView) => void): () => void;
  /** "由 Claude 操作" notices, sent to both windows. */
  onAgentChannelNotice(callback: (notice: import('../safety').AgentChannelNotice) => void): () => void;
  /** Closed set of control-window actions (play a preview, voice preview). */
  onAgentChannelAction(callback: (action: import('../safety').AgentChannelRendererAction) => void): () => void;
  /** I-071 v2 第二步 Claude 助手 (control window only): the conversation, one turn at a time, its popup answers and undo. */
  assistantGet(): Promise<import('../safety').AssistantView>;
  /** `choiceId`: the user clicked one of that set's buttons (`text` is the button's words). */
  assistantSend(text: string, choiceId?: string): Promise<import('../safety').AssistantView>;
  assistantCancel(): Promise<import('../safety').AssistantView>;
  assistantClear(): Promise<import('../safety').AssistantView>;
  assistantSetPrefs(prefs: Partial<import('../safety').AssistantPrefs>): Promise<import('../safety').AssistantView>;
  assistantAnswer(id: string, allow: boolean): Promise<void>;
  assistantUndo(id: string): Promise<import('../safety').AssistantView>;
  /** I-071 v2 第三步: the 角色页's 「转成英文版 / 中文版」 (control window only): the Claude 助手 starts with that request. */
  assistantConvertCharacter(id: string): Promise<import('../safety').AssistantView>;
  assistantCancelConversion(id: string): Promise<boolean>;
  onAssistant(callback: (event: import('../safety').AssistantEvent) => void): () => void;
  /**
   * I-117 (electron/safety/wiring.ts): the app's help card outside her role, in both windows (desk:safety-card); the card as it is now
   * for a window that opens later; 「我现在安全」 or 「关闭」 for the card on screen (an answer for an older card is ignored).
   */
  onSafetyCard(callback: (view: import('../safety').SafetyCardView) => void): () => void;
  getSafetyCard(): Promise<import('../safety').SafetyCardView>;
  safetyCardAnswer(answer: import('../safety').SafetyCardAnswer): Promise<import('../safety').SafetyCardView>;
  /**
   * D2 developer test commands ("测试：xxx", electron/safety/test-commands/): the window asks with the literal text; the host answers whether
   * it was a command (developer mode on and "测试：" prefix). Not handled: the window sends it as ordinary chat. The note lines
   * arrive on `onTestNote`; `onTestEffect` asks the stage to do one closed-set thing. Nothing here is chat and nothing is archived.
   */
  runTestCommand(text: string): Promise<import('../safety').TestCommandOutcome>;
  onTestNote(callback: (note: import('../safety').TestCommandNote) => void): () => void;
  onTestEffect(callback: (effect: import('../safety').TestEffect) => void): () => void;
}
