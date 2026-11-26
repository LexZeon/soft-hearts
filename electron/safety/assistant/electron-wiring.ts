// I-071 v2 第二步 Claude 助手: Electron glue. Created from agent-channel/electron-wiring.ts with the channel host, so
// electron/main.ts does not change. Every IPC method is control-window only (main.ts host()).
import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { AssistantEvent } from '../../../shared/safety/assistant';
import type { AgentChannelHost } from '../agent-channel/host';
import type { ShimLaunch } from './process';
import { AssistantService } from './service';
import { AssistantStore } from './store';

export interface AssistantWiring {
  host: AgentChannelHost;
  profileDirectory: string;
  controls(): BrowserWindow | null;
  register(method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean): void;
  uiLanguage?(): 'en' | 'zh-CN';
  /** I-071 v2 第三步: the conversion job, so a convert call shows its progress line. */
  conversion?: { view(): import('../../../shared/cards').ConversionJobView | null };
  /** I-144b: called once with the service; returns what 「清空」 runs instead (through the recycle bin), or null for the plain clear. */
  clearThroughBin?(service: AssistantService): (() => Promise<unknown>) | null;
}

export function assistantShimLaunch(): ShimLaunch {
  const shim = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-channel', 'soft-hearts-assistant-mcp.mjs')
    : path.join(app.getAppPath(), 'scripts', 'soft-hearts-assistant-mcp.mjs');
  // The app's own Electron runs the shim as plain Node; no separate Node install is needed.
  return { command: process.execPath, args: [shim], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Where read_handbook's manuals are (docs/ and handbook/ inside): the repository in a source checkout, resources/assistant-docs/ when packaged. */
export function handbookDocsRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'assistant-docs') : app.getAppPath();
}

export function createAssistant(wiring: AssistantWiring): AssistantService {
  const send = (event: AssistantEvent) => {
    const controls = wiring.controls();
    if (controls && !controls.isDestroyed() && !controls.webContents.isDestroyed()) controls.webContents.send('desk:assistant', event);
  };
  const service = new AssistantService({
    registry: surface => wiring.host.surfaceRegistry(surface),
    store: new AssistantStore(wiring.profileDirectory),
    shim: assistantShimLaunch(),
    emit: send,
    undo: id => wiring.host.undo(id),
    uiLanguage: () => wiring.uiLanguage?.() ?? 'zh-CN',
    ...(wiring.conversion ? { conversion: wiring.conversion } : {}),
  });
  wiring.register('assistantGet', () => service.view());
  wiring.register('assistantSend', (text: unknown, choiceId?: unknown) => service.send(text, choiceId));
  wiring.register('assistantCancel', () => service.cancel());
  const clearThroughBin = wiring.clearThroughBin?.(service) ?? null;
  wiring.register('assistantClear', async () => { if (!clearThroughBin) return service.clear(); await clearThroughBin(); return service.view(); });
  wiring.register('assistantSetPrefs', (prefs: unknown) => service.setPrefs(prefs));
  wiring.register('assistantAnswer', (id: unknown, allow: unknown) => { service.answer(id, allow); });
  wiring.register('assistantUndo', (id: unknown) => service.undo(id));
  app.once('before-quit', () => { void service.dispose(); });
  return service;
}
