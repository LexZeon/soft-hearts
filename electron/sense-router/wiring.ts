import type { Attachment, ChatMessage } from '../../shared/contracts';
import { WATCH_TIMELY_KNOBS, recentExchanges } from '../../shared/watch-timely';
import { SENSE_ROUTER_KNOBS, type SenseId, type SenseLineMessage, type SenseOn } from '../../shared/sense-router';
import { SenseRouterHost, type SenseRouterLogEntry, type SenseRouterPorts } from './host';
import { senseAskWithClaude, senseLineWithClaude } from './model';

/** What electron/main.ts supplies: closures read only when needed. */
export interface SenseRouterWiring {
  /** Tests and the knob: default SENSE_ROUTER_KNOBS.enabled. */
  enabled?(): boolean;
  on(): SenseOn;
  identity(): string;
  conversation(): string;
  capture(sense: 'camera' | 'screen', signal: AbortSignal): Promise<string | null>;
  heard(): string | null;
  character(): { id: string; persona: string; language: string } | null;
  mood(): string;
  /** The chat model setting when chat runs on Claude ('' = Claude Code's default), else null. */
  chatModel(): string | null;
  free(): boolean;
  petSender(): number | null;
  send(message: SenseLineMessage): boolean;
  speechStyle(id: string): void;
  archive(message: SenseLineMessage, current: () => boolean): Promise<void>;
  log?(entry: SenseRouterLogEntry): void;
  /** I-047: the "talking about the show" window (electron/listen-together). */
  watch?: SenseRouterPorts["watch"];
  /** Tests only. */
  ports?: Partial<SenseRouterPorts>;
}
type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

/** Which senses a chat turn's frames already bring her (the clear frames she was asked to take; the small 「发图片」 one is not one). */
export function coveredByFrames(frames: readonly Attachment[]): SenseId[] {
  const out: SenseId[] = [];
  for (const frame of frames) { const sense: SenseId = frame.source === 'screen' ? 'screen' : 'camera'; if (!out.includes(sense)) out.push(sense); }
  return out;
}

/**
 * I-040 看一眼、听一下 for the app: the host and its one IPC operation (senseLineDone: the pet window says her line was shown). The
 * brain calls are electron/sense-router/model.ts; the judgment rides on the reaction judge's call through `host.port`.
 */
export function createSenseRouter(wiring: SenseRouterWiring) {
  const host = new SenseRouterHost({
    enabled: wiring.enabled ?? (() => SENSE_ROUTER_KNOBS.enabled),
    on: wiring.on, identity: wiring.identity, conversation: wiring.conversation, capture: wiring.capture, heard: wiring.heard,
    ask: (prompt, systemPrompt, images, signal) => senseAskWithClaude(prompt, systemPrompt, images, signal),
    line: (prompt, signal) => { const model = wiring.chatModel(); return model === null ? null : senseLineWithClaude(prompt, model, signal); },
    watch: wiring.watch, character: wiring.character, mood: wiring.mood, free: wiring.free, publish: wiring.send, speechStyle: wiring.speechStyle, archive: wiring.archive,
    // Counts and timings only: never the words, a frame or a summary.
    log: wiring.log ?? (entry => { try { console.info('[soft hearts] sense router', JSON.stringify(entry)); } catch { /* Best effort. */ } }),
    ...wiring.ports,
  });
  const register = (scopedHost: Register) => {
    scopedHost('senseLineDone', (sender, value) => host.done(sender === wiring.petSender(), value), false);
  };
  return {
    host, register,
    /** The user's message (after the reaction host took it). Never throws into her chat. */
    /** `messages`: the chat so far, the user's current message last (I-047: the judgment sees the last few exchanges before it). */
    userTurn: (id: string, text: unknown, merged: boolean, frames: readonly Attachment[], messages?: readonly ChatMessage[]) => {
      try { host.userTurn(id, text, { merged, covered: coveredByFrames(frames), context: WATCH_TIMELY_KNOBS.enabled ? recentExchanges(messages) : [] }); } catch { /* Never into her chat. */ }
    },
    /** '' or "\n\n" + the one sentence for her first line (this turn only). */
    hint: (id: string, transcriptCovered: boolean) => { try { const line = host.firstLineHint(id, transcriptCovered ? ['transcript'] : []); return line ? `\n\n${line}` : ''; } catch { return ''; } },
    firstChar: (id: string) => { try { host.firstChar(id); } catch { /* Never into her chat. */ } },
    replyDone: (id: string, ok: boolean, text: string) => { try { host.replyDone(id, ok, text); } catch { /* Never into her chat. */ } },
    cancel: () => { try { host.cancel(); } catch { /* Best effort. */ } },
    dispose: () => host.dispose(),
  };
}
