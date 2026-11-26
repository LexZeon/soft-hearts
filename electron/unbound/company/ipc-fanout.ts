/**
 * I-209 step 3: several full-screen Unbound hosts answer the same page requests (each character's page asks on the same channels). Electron's
 * ipcMain takes one handler per channel, so this stands between: each host gets its own port (`port()`), registers on it as it always did,
 * and a request goes to the port whose windows sent it (the sender's webContents id). Nobody's window: refused, as a request from a stranger
 * always was ('请求来源未授权。'). Each host still checks the window and its top frame itself (host.ts `owner`), so a port can never answer
 * for a window it did not make even if this table were wrong.
 */
import type { UnboundIpcEvent, UnboundIpcMain } from '../host-ports';

type Listener = (event: UnboundIpcEvent, ...args: unknown[]) => unknown;

/** One host's view of ipcMain, and the windows it made (their webContents ids). */
export interface FanoutPort {
  readonly ipcMain: UnboundIpcMain;
  /** A window this host made (its requests come to this port from now on). */
  own(webContentsId: number): void;
  /** That window is gone. */
  disown(webContentsId: number): void;
  /** Whether a request from this sender is this port's. */
  owns(webContentsId: number): boolean;
}

export class IpcFanout {
  private readonly routes = new Map<string, Map<FanoutPort, Listener>>();
  constructor(private readonly ipcMain: UnboundIpcMain) {}

  port(): FanoutPort {
    const ids = new Set<number>(), fanout = this;
    const port: FanoutPort = {
      ipcMain: {
        handle: (channel, listener) => fanout.add(channel, port, listener),
        removeHandler: channel => fanout.remove(channel, port),
      },
      own: id => { ids.add(id); }, disown: id => { ids.delete(id); }, owns: id => ids.has(id),
    };
    return port;
  }

  /** Channels with at least one port registered (tests). */
  get channels(): string[] { return [...this.routes.keys()]; }

  private add(channel: string, port: FanoutPort, listener: Listener): void {
    let table = this.routes.get(channel);
    if (!table) {
      table = new Map();
      this.routes.set(channel, table);
      const routed = table;
      this.ipcMain.handle(channel, (event, ...args) => {
        const sender = event?.sender?.id;
        for (const [candidate, run] of routed) if (typeof sender === 'number' && candidate.owns(sender)) return run(event, ...args);
        throw new Error('请求来源未授权。');
      });
    }
    table.set(port, listener);
  }

  private remove(channel: string, port: FanoutPort): void {
    const table = this.routes.get(channel);
    if (!table) return;
    table.delete(port);
    if (table.size) return;
    this.routes.delete(channel);
    this.ipcMain.removeHandler(channel);
  }
}
