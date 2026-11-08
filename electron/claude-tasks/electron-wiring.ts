// Electron side of R20: shim path, native first-run notice, window plumbing. electron/main.ts
// only passes closures it already has and calls `register(host, ...)` from registerIPC.
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import path from 'node:path';
import type { AppSettings } from '../../shared/contracts';
import type { CodexTaskEvent } from '../../shared/codex-tasks';
import { ClaudeTaskSwitch, registerClaudeTaskIpc, type Registrar } from './ipc';
import type { ShimLaunch } from './process';
import { ClaudeTaskService } from './service';

export interface ClaudeTasksWiring {
  profileDirectory: string;
  settings(): AppSettings;
  controls(): BrowserWindow | null;
  showControls(): void;
  broadcast(channel: string, value: unknown): void;
}

export function taskShimLaunch(): ShimLaunch {
  const shim = app.isPackaged
    ? path.join(process.resourcesPath, 'agent-channel', 'soft-hearts-task-mcp.mjs')
    : path.join(app.getAppPath(), 'scripts', 'soft-hearts-task-mcp.mjs');
  // The app's own Electron runs the shim as plain Node; no separate Node install is needed.
  return { command: process.execPath, args: [shim], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function firstRunNotice(platform: NodeJS.Platform = process.platform): Pick<MessageBoxOptions, 'title' | 'message' | 'detail'> {
  return {
    title: 'soft hearts · 允许桌宠通过 Claude Code 帮你做事',
    message: '开启前请先看一下：',
    detail: [
      '· 桌宠会把你交代的事交给你本机的 Claude Code，只在你选定的一个文件夹里做。',
      '· 读取这个文件夹里的文件会自动放行；修改文件和运行命令，每一次都会先在控制窗口里问你，120 秒不回应就算拒绝。',
      '· 不能联网查资料，也不能碰文件夹以外的文件。但你批准的命令会以你的身份运行。',
      platform === 'win32'
        ? '· 注意：Windows 上的 Claude Code 没有沙箱。批准一条命令，就等于你自己在终端里运行它。'
        : '· 注意：任务没有启用沙箱。批准一条命令，就等于你自己在终端里运行它。',
      '· 用的是你自己的 Claude 额度。随时可以在「Claude 任务」里关掉。',
    ].join('\n'),
  };
}

export class ClaudeTasksHost {
  readonly toggle: ClaudeTaskSwitch;
  readonly service: ClaudeTaskService;
  constructor(private readonly wiring: ClaudeTasksWiring) {
    this.toggle = new ClaudeTaskSwitch(wiring.profileDirectory);
    const live = () => { const win = wiring.controls(); return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win : null; };
    this.service = new ClaudeTaskService({
      state: () => ({ enabled: this.toggle.enabled, folder: wiring.settings().agent.workingDirectory }),
      model: () => wiring.settings().agent.model,
      shim: taskShimLaunch(),
      emit: (event: CodexTaskEvent) => { live()?.webContents.send('desk:codex-task-event', event); },
      surface: () => { if (!live()) return false; wiring.showControls(); return true; },
    });
    void this.toggle.load().then(enabled => { if (enabled) wiring.broadcast('desk:claude-tasks', { enabled }); });
  }

  list() { return this.service.list(); }
  interrupt(taskId: string) { return this.service.interrupt(taskId); }
  close() { return this.service.close(); }

  register(host: Registrar, openTaskConfirmation: (prompt: unknown) => void): void {
    registerClaudeTaskIpc(host, {
      service: this.service, toggle: this.toggle, openTaskConfirmation,
      broadcast: state => this.wiring.broadcast('desk:claude-tasks', state),
      confirmEnable: async () => {
        const parent = this.wiring.controls();
        const options: MessageBoxOptions = { type: 'warning', ...firstRunNotice(), buttons: ['取消', '开启'], defaultId: 0, cancelId: 0, noLink: true };
        const result = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return result.response === 1;
      },
    });
  }
}
