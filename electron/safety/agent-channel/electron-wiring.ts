// Electron side of the agent channel: native confirmation dialog, window events and the
// shim launch line. electron/main.ts only passes closures it already has.
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { discoverClaude } from '../../../scripts/claude-discovery.mjs';
import { CLAUDE_START_GATE, claudeEnvironment, claudeStartGate } from '../../brain';
import { MemoryRecycleBin } from '../../memory';
import { createAppTools, settingExtras } from './app-tools';
import { createHostBridge, liveWindow, type AgentHostWiring } from './bridge';
import { autoLinkAllowed, linkClaudeCode, spawnClaudeRunner } from './claude-code-link';
import { claudeVersionOf } from '../../../shared/safety/claude-link-diag';
import { buildDiagnostics, type DiagnosticFacts } from './diagnostics';
import { AgentChannelHost, type AgentLinkCheck } from './host';
import { createMemoryBridge, type RecoverableMemoryWiring } from './memory-bridge';
import { AgentConfirmLock, type AgentConfirmRequest, type AgentConfirmText, type AgentToolDefinition } from './registry';
import { chatSettingApplier } from '../../brain/chat-settings';
import type { ChatSettingApplier, ChatSettingFacts } from '../../brain';
import { senseCardApplier } from '../../senses';
import { agentServerName, setupSnippets, type ShimLaunch } from './setup-text';
import type { AgentChannelNotice, AgentToolDescriptor } from '../../../shared/safety/agent-channel';
import { resolveUiLanguage } from '../../../shared/foundation/ui-language';
import { createAssistant, handbookDocsRoot } from '../assistant/electron-wiring';
import { handbookDocsReader } from '../assistant/docs';
import type { AssistantService } from '../assistant/service';
import { createConversion, type ConversionWiring } from '../../cards/character-convert/electron-wiring';
import { createConversionTools } from '../../cards';
import type { ConversionService } from '../../cards';
import { seenWhileHeld } from '../../unbound';
import { ASSISTANT_NAME } from '../../../shared/foundation/assistant-name';
export { recordAgentOperations } from './bridge';
export type { RecoverableMemoryWiring } from './memory-bridge';

export interface AgentChannelWiring extends Omit<AgentHostWiring, 'version' | 'controls' | 'pet' | 'interconnected' | 'memories'> {
  profileDirectory: string;
  controls(): BrowserWindow | null;
  pet(): BrowserWindow | null;
  /** Unbound v1 step 2: she is out in Unbound, so her hidden companion window still counts as shown for the senses. */
  petHeld?(): boolean;
  /** main.ts `host()`: registers a control-window-only IPC method. */
  register(method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean): void;
  /** The companion's own chat settings cards (electron/brain/chat-settings.ts): applied through the same tool and tiers. */
  chatSettings?: { connect(apply: ChatSettingApplier, facts?: ChatSettingFacts): void };
  /** I-014 回收站: the stores behind delete_memories / restore_memories. */
  recoverable?: RecoverableMemoryWiring;
  /** I-144: the app's one recycle bin (electron/main.ts makes and loads it); absent: the channel makes its own, as before. */
  recycleBin?: MemoryRecycleBin;
  /**
   * I-144b: the Claude 助手's 「清空」 goes through the recycle bin. Called once with the assistant (main.ts keeps it to find a conversation
   * back); returns what 「清空」 runs instead of a plain clear, or null for the plain clear.
   */
  assistantRecycle?(assistant: AssistantService): (() => Promise<unknown>) | null;
  /** I-061: a link check finished; main.ts turns it into the experience journal's `claude-link` line (closed values only). */
  linkChecked?(check: AgentLinkCheck): void;
  /** I-061: the build commit, the installed channel and the journal's recent lines for 「复制诊断信息」. */
  diagnosticFacts?(): DiagnosticFacts;
  /** I-071 v2 第三步: the stores a 「转换成英文 / 中文角色」 reads (only) and writes for the new card (electron/cards/character-convert/). */
  conversion?: ConversionWiring;
  /** Tools made outside the shared catalog, with their listing (the dev-only voice_keep, electron/wiring/voice-keep-wiring.ts); empty or absent on stable builds. */
  extraTools?: { tools: readonly AgentToolDefinition[]; descriptors: readonly AgentToolDescriptor[] };
}

/** The running app's channel (one per process); null before createAgentChannel and in tests. */
let current: AgentChannelHost | null = null;

/**
 * I-014 "三方互通": true while it is on. Settings-window paths read it to skip their own second
 * confirmation (the user's click there is the consent). The companion's chat never reads it: what is read out of her chat
 * still asks.
 */
export function agentInterconnected(): boolean { return current?.interconnected === true; }

/** I-144: the recycle bin changed (electron/main.ts owns it): the channel's view is published again. */
export function agentChannelRefresh(): void { try { current?.refresh(); } catch { /* Status only. */ } }

/** I-071 v2 第三步 转换 (Codex X-435): the app's conversion service, for quitting (electron/cards/character-convert/quit.ts); null before createAgentChannel. */
let currentConversion: ConversionService | null = null;
export function appConversion(): ConversionService | null { return currentConversion; }

export function shimLaunch(profileDirectory: string): ShimLaunch {
  const shim = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-channel', 'soft-hearts-mcp.mjs')
    : path.join(app.getAppPath(), 'scripts', 'soft-hearts-mcp.mjs');
  // The app's own Electron runs the shim as plain Node, so no separate Node install is needed.
  return { command: process.execPath, args: [shim, '--profile', profileDirectory], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function confirmWithDialog(parent: BrowserWindow | null, request: AgentConfirmRequest, signal: AbortSignal): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'question', title: `soft hearts · ${ASSISTANT_NAME} 的请求`, message: request.title,
    detail: `${request.detail}\n\n来自 ${ASSISTANT_NAME}（内部通道：${request.toolTitle}）。${Math.round(request.timeoutMs / 1000)} 秒内不回应视为拒绝。`,
    buttons: request.buttons ? [...request.buttons] : ['拒绝', '允许'], defaultId: 0, cancelId: 0, noLink: true, signal,
  };
  const result = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
    ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return !signal.aborted && result.response === 1;
}

/** I-014: shown once after a change 三方互通 let through without its dialog; nothing waits for it. */
function informWithDialog(parent: BrowserWindow | null, text: AgentConfirmText): void {
  const options: MessageBoxOptions = { type: 'info', title: `soft hearts · 由 ${ASSISTANT_NAME} 操作`, message: text.title, detail: text.detail,
    buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true };
  const shown = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
    ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  void shown.catch(() => {});
}

export function createAgentChannel(wiring: AgentChannelWiring): AgentChannelHost {
  let channel: AgentChannelHost | null = null;
  const ownBin = !wiring.recycleBin;
  const bin = wiring.recycleBin ?? (wiring.recoverable ? new MemoryRecycleBin(wiring.profileDirectory, Date.now, () => channel?.refresh()) : null);
  const memories = bin && wiring.recoverable ? createMemoryBridge(bin, wiring.recoverable) : undefined;
  // Unbound v1 step 2: her companion window hidden only because she is out in Unbound counts as shown (set_perception asks).
  const bridge = createHostBridge({ ...wiring, pet: () => seenWhileHeld(wiring.pet(), wiring.petHeld ?? (() => false)), version: () => app.getVersion(), interconnected: () => channel?.interconnected === true,
    ...(memories ? { memories } : {}) });
  // I-071 v2: read_handbook also reads the guides that ship with the app (a fixed list, shared/safety/handbook-docs.ts).
  const docs = handbookDocsReader(handbookDocsRoot());
  // I-071 v2 第三步: the conversion's four tools ride on the same registry (prepare, convert with its popup, progress, cancel).
  let conversion: ConversionService | null = null;
  const tools = [...createAppTools(bridge, { docs }), ...(wiring.conversion ? createConversionTools(() => conversion) : []), ...(wiring.extraTools?.tools ?? [])];
  // The chat cards use the same tools; only the 体验记录 line says where the change came from.
  const chatTools = createAppTools(bridge, { settingVia: 'chat', docs });
  const confirm = (request: AgentConfirmRequest, signal: AbortSignal) => confirmWithDialog(wiring.controls(), request, signal);
  // One dialog at a time across the external channel and the chat settings cards.
  const confirmLock = new AgentConfirmLock();
  const publishNotice = (notice: AgentChannelNotice) => { for (const win of [wiring.controls(), wiring.pet()]) if (liveWindow(win)) win.webContents.send('desk:agent-channel-notice', notice); };
  const launch = () => shimLaunch(wiring.profileDirectory), name = agentServerName(wiring.profileDirectory);
  channel = new AgentChannelHost({
    profileDirectory: wiring.profileDirectory,
    tools, extraDescriptors: wiring.extraTools?.descriptors,
    confirm,
    confirmLock,
    inform: text => informWithDialog(wiring.controls(), text),
    publishView: view => { const controls = wiring.controls(); if (liveWindow(controls)) controls.webContents.send('desk:agent-channel', view); },
    publishNotice,
    // I-025 体验记录: a user-words call names the item, the value and how long the words were (never the words).
    wordsUsed: use => { try { wiring.wordsUsed?.(use); } catch { /* A record never undoes a change. */ } },
    setup: () => setupSnippets(launch(), name),
    linkChecked: check => wiring.linkChecked?.(check),
    recycle: () => ({ days: bin?.retentionDays ?? 7, entries: bin?.summaries() ?? [] }),
    // I-014: the user's own Claude Code, found the same way the chat finds it; only the two real desktop profiles.
    linkClaudeCode: async (force, autoRegistered, repoint) => {
      const found = await discoverClaude().catch(() => ({ status: 'missing', path: null }));
      // I-202: through the start gate like every Claude Code process, with the short hold (`claude mcp` / `--version` ask no model).
      const runner = found.status === 'found' && found.path ? spawnClaudeRunner(found.path, claudeEnvironment(), [], undefined,
        () => claudeStartGate.enter({ holdMs: CLAUDE_START_GATE.idleHoldMs })) : null;
      const allowed = autoLinkAllowed(wiring.profileDirectory, app.getPath('appData'));
      const link = await linkClaudeCode({ name, launch: launch(), force, runner, allowed,
        // An update installs into a new folder: this profile's own registration is pointed at this version.
        registeredBefore: autoRegistered.includes(name), repointPending: repoint.pending.includes(name),
        journal: pending => repoint.mark(name, pending) });
      // I-061: the version, learned with the same safe runner this check already used (`claude --version`, no shell, ten seconds at most).
      const version = runner && allowed ? claudeVersionOf((await runner(['--version'], 10_000).catch(() => null))?.stdout) : null;
      return version ? { ...link, claudeVersion: version } : link;
    },
  });
  current = channel;
  const host = channel;
  // Chat settings cards apply through the same set_setting tool, tiers and dialog (not the external switch, and never
  // without the dialog: 三方互通 does not reach what is read out of her chat).
  wiring.chatSettings?.connect(chatSettingApplier(chatTools, { confirm, confirmLock,
    notice: (_tool, title) => publishNotice({ title, at: Date.now() }), audit: entry => host.audit.record(entry) }),
  // I-025: the microphone and the local recognizer for the cards' current values and their detail line.
  { extras: () => settingExtras(bridge),
    // I-137: sense cards (asked for by the user's own message), switched through the user's own switches by the card's own registry.
    senses: { read: () => ({ perception: bridge.perception?.() ?? null, facePhase: bridge.faceCheckPhase?.() ?? null }),
      apply: senseCardApplier(bridge, { confirm, confirmLock, notice: (_tool, title, detail) => publishNotice({ title, ...(detail ? { detail } : {}), at: Date.now() }),
        audit: entry => host.audit.record(entry) }) } });
  wiring.register('getAgentChannel', () => host.view());
  wiring.register('setAgentChannelEnabled', (enabled: unknown) => host.setEnabled(enabled));
  wiring.register('setAgentInterconnect', (enabled: unknown) => host.setInterconnect(enabled));
  wiring.register('relinkAgentClaudeCode', () => host.relinkClaudeCode());
  // I-061: the text only; the control window copies it. Closed values (shared/safety/diagnostics.ts), nothing is sent anywhere.
  wiring.register('getDiagnostics', () => buildDiagnostics(host, { ...(wiring.diagnosticFacts?.() ?? { commit: null, channel: null, journalEnabled: false, entries: () => [] }), ...(bridge.partsOff ? { partsOff: bridge.partsOff } : {}) }, // step 7: which parts are off
    { version: app.getVersion(), platform: process.platform, release: os.release(), arch: process.arch }));
  wiring.register('undoAgentAction', (id: unknown) => host.undo(typeof id === 'string' ? id : '\0'));
  wiring.register('restoreRecycledMemory', async (id: unknown) => {
    if (!memories) throw new Error('这个版本还没有回收站。');
    if (typeof id !== 'string') throw new Error('回收站编号不正确。');
    await memories.restore(id.toLowerCase(), () => {});
    return host.view();
  });
  wiring.register('setRecycleDays', async (days: unknown) => {
    if (!bin) throw new Error('这个版本还没有回收站。');
    await bin.setRetentionDays(days);
    return host.view();
  });
  // I-071 v2 第二步: the in-app Claude 助手 on the same tools, tiers and undo slot (electron/safety/assistant/).
  const uiLanguage = (): 'en' | 'zh-CN' => { const preference = bridge.hostSettings?.()?.uiLanguage; return preference ? resolveUiLanguage(preference, app.getLocale()) : 'zh-CN'; };
  const assistant = createAssistant({ host, profileDirectory: wiring.profileDirectory, controls: wiring.controls, register: wiring.register, uiLanguage,
    conversion: { view: () => conversion?.view() ?? null }, clearThroughBin: service => wiring.assistantRecycle?.(service) ?? null });
  // I-071 v2 第三步 转换: uses the Claude 助手's model and thinking effort; its progress shows on the assistant's line for it.
  if (wiring.conversion) conversion = createConversion({ profileDirectory: wiring.profileDirectory, wiring: wiring.conversion, settings: () => bridge.settings(),
    saveSettings: (next, guard) => bridge.saveSettings(next, guard), modelChoice: () => assistant.currentPrefs, emit: view => assistant.conversionChanged(view),
    register: wiring.register, send: text => assistant.send(text), uiLanguage });
  currentConversion = conversion;
  app.once('before-quit', () => { void host.dispose(); });
  void (async () => {
    if (bin && ownBin) await bin.load().catch(() => {});
    await host.init();
  })().catch(() => {});
  // Expired recycle-bin entries go once an hour (and at every start).
  if (bin && ownBin) setInterval(() => { void bin.purge().catch(() => {}); }, 60 * 60_000).unref?.();
  return host;
}
