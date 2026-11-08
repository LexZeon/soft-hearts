// Electron side of the agent channel: native confirmation dialog, window events and the
// shim launch line. electron/main.ts only passes closures it already has.
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import path from 'node:path';
import { discoverClaude } from '../../scripts/claude-discovery.mjs';
import { claudeEnvironment } from '../claude';
import { MemoryRecycleBin } from '../memory-recycle-bin';
import { createAppTools, settingExtras } from './app-tools';
import { createHostBridge, liveWindow, type AgentHostWiring } from './bridge';
import { autoLinkAllowed, linkClaudeCode, spawnClaudeRunner } from './claude-code-link';
import { AgentChannelHost } from './host';
import { createMemoryBridge, type RecoverableMemoryWiring } from './memory-bridge';
import { AgentConfirmLock, type AgentConfirmRequest, type AgentConfirmText } from './registry';
import { chatSettingApplier, type ChatSettingApplier, type ChatSettingFacts } from '../chat-settings';
import { agentServerName, setupSnippets, type ShimLaunch } from './setup-text';
import type { AgentChannelNotice } from '../../shared/agent-channel';
export { recordAgentOperations } from './bridge';
export type { RecoverableMemoryWiring } from './memory-bridge';

export interface AgentChannelWiring extends Omit<AgentHostWiring, 'version' | 'controls' | 'pet' | 'interconnected' | 'memories'> {
  profileDirectory: string;
  controls(): BrowserWindow | null;
  pet(): BrowserWindow | null;
  /** main.ts `host()`: registers a control-window-only IPC method. */
  register(method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean): void;
  /** The pet's own chat settings cards (electron/chat-settings.ts): applied through the same tool and tiers. */
  chatSettings?: { connect(apply: ChatSettingApplier, facts?: ChatSettingFacts): void };
  /** I-014 回收站: the stores behind delete_memories / restore_memories. */
  recoverable?: RecoverableMemoryWiring;
}

/** The running app's channel (one per process); null before createAgentChannel and in tests. */
let current: AgentChannelHost | null = null;

/**
 * I-014 "三方互通": true while it is on. Settings-window paths read it to skip their own second
 * confirmation (the user's click there is the consent). The pet's chat never reads it: what is read out of her chat
 * still asks.
 */
export function agentInterconnected(): boolean { return current?.interconnected === true; }

export function shimLaunch(profileDirectory: string): ShimLaunch {
  const shim = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-channel', 'soft-hearts-mcp.mjs')
    : path.join(app.getAppPath(), 'scripts', 'soft-hearts-mcp.mjs');
  // The app's own Electron runs the shim as plain Node, so no separate Node install is needed.
  return { command: process.execPath, args: [shim, '--profile', profileDirectory], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function confirmWithDialog(parent: BrowserWindow | null, request: AgentConfirmRequest, signal: AbortSignal): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'question', title: 'soft hearts · Claude 的请求', message: request.title,
    detail: `${request.detail}\n\n来自 Claude（内部通道：${request.toolTitle}）。${Math.round(request.timeoutMs / 1000)} 秒内不回应视为拒绝。`,
    buttons: request.buttons ? [...request.buttons] : ['拒绝', '允许'], defaultId: 0, cancelId: 0, noLink: true, signal,
  };
  const result = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
    ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return !signal.aborted && result.response === 1;
}

/** I-014: shown once after a change 三方互通 let through without its dialog; nothing waits for it. */
function informWithDialog(parent: BrowserWindow | null, text: AgentConfirmText): void {
  const options: MessageBoxOptions = { type: 'info', title: 'soft hearts · 由 Claude 操作', message: text.title, detail: text.detail,
    buttons: ['知道了'], defaultId: 0, cancelId: 0, noLink: true };
  const shown = parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
    ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  void shown.catch(() => {});
}

export function createAgentChannel(wiring: AgentChannelWiring): AgentChannelHost {
  let channel: AgentChannelHost | null = null;
  const bin = wiring.recoverable ? new MemoryRecycleBin(wiring.profileDirectory, Date.now, () => channel?.refresh()) : null;
  const memories = bin && wiring.recoverable ? createMemoryBridge(bin, wiring.recoverable) : undefined;
  const bridge = createHostBridge({ ...wiring, version: () => app.getVersion(), interconnected: () => channel?.interconnected === true,
    ...(memories ? { memories } : {}) });
  const tools = createAppTools(bridge);
  // The chat cards use the same tools; only the 体验记录 line says where the change came from.
  const chatTools = createAppTools(bridge, { settingVia: 'chat' });
  const confirm = (request: AgentConfirmRequest, signal: AbortSignal) => confirmWithDialog(wiring.controls(), request, signal);
  // One dialog at a time across the external channel and the chat settings cards.
  const confirmLock = new AgentConfirmLock();
  const publishNotice = (notice: AgentChannelNotice) => { for (const win of [wiring.controls(), wiring.pet()]) if (liveWindow(win)) win.webContents.send('desk:agent-channel-notice', notice); };
  const launch = () => shimLaunch(wiring.profileDirectory), name = agentServerName(wiring.profileDirectory);
  channel = new AgentChannelHost({
    profileDirectory: wiring.profileDirectory,
    tools,
    confirm,
    confirmLock,
    inform: text => informWithDialog(wiring.controls(), text),
    publishView: view => { const controls = wiring.controls(); if (liveWindow(controls)) controls.webContents.send('desk:agent-channel', view); },
    publishNotice,
    // I-025 体验记录: a user-words call names the item, the value and how long the words were (never the words).
    wordsUsed: use => { try { wiring.wordsUsed?.(use); } catch { /* A record never undoes a change. */ } },
    setup: () => setupSnippets(launch(), name),
    recycle: () => ({ days: bin?.retentionDays ?? 7, entries: bin?.summaries() ?? [] }),
    // I-014: the user's own Claude Code, found the same way the chat finds it; only the two real desktop profiles.
    linkClaudeCode: async (force, autoRegistered, repoint) => {
      const found = await discoverClaude().catch(() => ({ status: 'missing', path: null }));
      return linkClaudeCode({ name, launch: launch(), force,
        runner: found.status === 'found' && found.path ? spawnClaudeRunner(found.path, claudeEnvironment()) : null,
        allowed: autoLinkAllowed(wiring.profileDirectory, app.getPath('appData')),
        // An update installs into a new folder: this profile's own registration is pointed at this version.
        registeredBefore: autoRegistered.includes(name), repointPending: repoint.pending.includes(name),
        journal: pending => repoint.mark(name, pending) });
    },
  });
  current = channel;
  const host = channel;
  // Chat settings cards apply through the same set_setting tool, tiers and dialog (not the external switch, and never
  // without the dialog: 三方互通 does not reach what is read out of her chat).
  wiring.chatSettings?.connect(chatSettingApplier(chatTools, { confirm, confirmLock,
    notice: (_tool, title) => publishNotice({ title, at: Date.now() }), audit: entry => host.audit.record(entry) }),
  // I-025: the microphone and the local recognizer for the cards' current values and their detail line.
  { extras: () => settingExtras(bridge) });
  wiring.register('getAgentChannel', () => host.view());
  wiring.register('setAgentChannelEnabled', (enabled: unknown) => host.setEnabled(enabled));
  wiring.register('setAgentInterconnect', (enabled: unknown) => host.setInterconnect(enabled));
  wiring.register('relinkAgentClaudeCode', () => host.relinkClaudeCode());
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
  app.once('before-quit', () => { void host.dispose(); });
  void (async () => {
    if (bin) await bin.load().catch(() => {});
    await host.init();
  })().catch(() => {});
  // Expired recycle-bin entries go once an hour (and at every start).
  if (bin) setInterval(() => { void bin.purge().catch(() => {}); }, 60 * 60_000).unref?.();
  return host;
}
