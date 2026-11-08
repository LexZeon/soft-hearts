import { helpTopicFor, type ChatAvailabilityView } from '../shared/chat-availability';
import type { ChatAvailability } from './chat-availability';

/**
 * The repair buttons of the "needs attention" panel, as fixed operations. None of them takes an argument, none
 * runs a command, and the only things they can open are the three addresses below: two pages of Claude Code's
 * own documentation and Windows' own network settings page.
 */
export const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
export const CLAUDE_NETWORK_CONFIG_URL = 'https://code.claude.com/docs/en/network-config';
export const NETWORK_SETTINGS_URI = 'ms-settings:network';
const FIXED_TARGETS: ReadonlySet<string> = new Set([CLAUDE_SETUP_URL, CLAUDE_NETWORK_CONFIG_URL, NETWORK_SETTINGS_URI]);

export interface ChatAvailabilityHostDeps {
  availability: ChatAvailability;
  /** One small, tool-less Claude call with the current chat model. Resolves when Claude answered; throws otherwise. */
  probe(signal: AbortSignal): Promise<void>;
  /** Electron's shell.openExternal. Only ever called with one of the fixed targets above. */
  openExternal(target: string): Promise<void> | void;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export class ChatAvailabilityHost {
  private checking: Promise<ChatAvailabilityView> | null = null;
  constructor(private readonly deps: ChatAvailabilityHostDeps) {}

  view(): ChatAvailabilityView { return this.deps.availability.view(); }

  /**
   * "Retry": asks Claude one tiny question. It answers: chat is back (the panel clears). It does not: the
   * panel shows the newest reason. A press while one is running joins it. Nothing is said in the chat.
   */
  retry(): Promise<ChatAvailabilityView> {
    if (this.checking) return this.checking;
    const { availability } = this.deps;
    availability.setChecking(true);
    const run = (async () => {
      try {
        await this.deps.probe(AbortSignal.timeout(this.deps.timeoutMs ?? 45_000));
        availability.success();
      } catch (error) {
        availability.failure(error);
      } finally {
        availability.setChecking(false);
      }
      return availability.view();
    })().finally(() => { this.checking = null; });
    this.checking = run;
    return run;
  }

  /** The guide for the current problem: install and sign-in, or proxies and certificates. */
  async openHelp(): Promise<void> {
    await this.open(helpTopicFor(this.deps.availability.view().kind) === 'network-config' ? CLAUDE_NETWORK_CONFIG_URL : CLAUDE_SETUP_URL);
  }

  async openNetworkSettings(): Promise<void> {
    if ((this.deps.platform ?? process.platform) !== 'win32') throw new Error('这个设置页只在 Windows 上有。');
    await this.open(NETWORK_SETTINGS_URI);
  }

  private async open(target: string): Promise<void> {
    if (!FIXED_TARGETS.has(target)) throw new Error('不能打开这个地址。');
    await this.deps.openExternal(target);
  }
}

/** The IPC method names, and nothing else, the control window may use. */
export const CHAT_AVAILABILITY_METHODS = ['getChatAvailability', 'retryChatAvailability', 'openClaudeHelp', 'openNetworkSettings'] as const;

/**
 * Registers the four operations through `register` (main.ts passes its control-window-only `host`). Every one
 * refuses any argument at all: there is no parameter a window could use to choose what is opened or run.
 */
export function registerChatAvailabilityIpc(register: (method: string, operation: (...args: unknown[]) => unknown) => void, host: ChatAvailabilityHost): void {
  const fixed = (method: (typeof CHAT_AVAILABILITY_METHODS)[number], operation: () => unknown) =>
    register(method, (...args: unknown[]) => {
      if (args.length) throw new Error('这个操作不接受参数。');
      return operation();
    });
  fixed('getChatAvailability', () => host.view());
  fixed('retryChatAvailability', () => host.retry());
  fixed('openClaudeHelp', () => host.openHelp());
  fixed('openNetworkSettings', () => host.openNetworkSettings());
}
