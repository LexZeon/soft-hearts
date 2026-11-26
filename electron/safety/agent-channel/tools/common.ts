// What every tool slice shares (docs/claude/2026-11-17-app-tools-split.md): the error helpers, the options createAppTools takes, and
// createToolContext, the helpers that were createAppTools's own constants (the card lookup, 三方互通, the settings extras, the guarded
// renderer request, the files port). One context per createAppTools call, so each call's tools share one set, as before.
import { AGENT_TOOLS, type AgentChannelRendererAction, type AgentSettingId } from '../../../../shared/safety/agent-channel';
import type { HandbookDocs } from '../../assistant/docs';
import { AgentToolError, type AgentCallContext, type AgentCommitGuard } from '../registry';
import { nodeFileSystem, type FileSystemPort } from '../validate';
import { fileBytesFrom, nodeFileBytes, type FileBytesPort } from '../file-binding';
import type { AgentAppBridge } from './app-bridge';
import { type SettingExtras, settingValue, settingExtras } from './setting-values';

export const title = (name: string) => AGENT_TOOLS.find(tool => tool.name === name)?.title ?? name;
export const unavailable = (message: string) => new AgentToolError('unavailable', message);
export const invalidInput = (message: string) => new AgentToolError('invalid_input', message);

export interface AppToolOptions {
  fs?: FileSystemPort; platform?: NodeJS.Platform; readText?(file: string): Promise<string>;
  /** T-239 + X-435: how a confirmed file's bytes are read, once, after the OK (default: the real files; or through a given readText). */
  fileBytes?: FileBytesPort;
  /** Who calls these tools: the external channel (default) or the companion's chat setting cards (electron/brain/chat-settings.ts). */
  settingVia?: 'agent' | 'chat';
  /**
   * I-071 v2: the manuals that ship with the app (shared/safety/handbook-docs.ts finds them by folder), for read_handbook's doc/find.
   * Only ids from its own listing are ever read; absent: those parts of read_handbook say they are unavailable.
   */
  docs?: HandbookDocs;
}

/** The helpers every slice shares, made once per createAppTools call (they were createAppTools's own constants). */
export function createToolContext(bridge: AgentAppBridge, options: AppToolOptions = {}) {
  const fs = options.fs ?? nodeFileSystem, platform = options.platform ?? process.platform, via = options.settingVia ?? 'agent';
  const readText = options.readText;
  const fileBytes: FileBytesPort = options.fileBytes
    ?? (readText ? fileBytesFrom(async file => Buffer.from(await readText(file), 'utf8')) : nodeFileBytes);
  const card = (id: string) => {
    const found = bridge.characters().cards.find(item => item.id.toLowerCase() === id);
    if (!found) throw new AgentToolError('invalid_input', '没有这张角色卡，请先用 list_characters 查看。');
    return found;
  };
  const setReadAloud = async (enabled: boolean, guard: AgentCommitGuard) => {
    const current = bridge.settings();
    if (current.voice.enabled !== enabled) await bridge.saveSettings({ ...current, voice: { ...current.voice, enabled } }, guard);
    return bridge.settings().voice.enabled;
  };
  /** I-014: 三方互通 is on right now (a failing reader means off). */
  const interconnected = () => { try { return bridge.interconnected?.() === true; } catch { return false; } };
  // I-025: the microphone's state is read only with 三方互通 on (as get_status shows perception only then).
  const extras = (): SettingExtras => { const more = settingExtras(bridge); return interconnected() ? more : { ...more, voiceInput: null }; };
  const valueOf = (id: AgentSettingId) => settingValue(id, bridge.settings(), bridge.characters(), extras());
  const activeId = () => bridge.characters().activeId;
  /** T-239: a request bound to one card by id still has that card (a card deleted while the dialog was open is not looked up again). */
  const targetCardStill = (target: { id: string; name: string }): void => {
    if (!bridge.characters().cards.some(item => item.id === target.id)) throw unavailable(`「${target.name}」这张角色卡已经不在了，什么都没做。`);
  };
  /** Renderer requests are sent synchronously; the check is the last step before sending. */
  const rendererAction = (action: AgentChannelRendererAction, context: AgentCallContext) => {
    context.check();
    return bridge.rendererAction(action);
  };
  const controlsReady = (needsVisible: boolean) => {
    const controls = bridge.windows().controls;
    if (!controls || (needsVisible && (!controls.visible || controls.minimized)))
      throw unavailable(needsVisible ? '请先打开控制窗口的“外观”页，让模型预览显示出来。' : '控制窗口尚未就绪。');
  };
  /** 2026-11-24: Drama 3's spending this month (numbers only; null when unreadable) and the clock prices are read at. */
  const readBudget = () => { try { return bridge.fishBudget?.() ?? null; } catch { return null; } };
  const now = () => new Date(bridge.now?.() ?? Date.now());
  return { bridge, options, fs, platform, via, fileBytes, card, setReadAloud, interconnected, extras, valueOf, activeId, targetCardStill, rendererAction, controlsReady, readBudget, now };
}
export type ToolContext = ReturnType<typeof createToolContext>;
