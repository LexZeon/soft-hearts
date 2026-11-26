/**
 * The user's saved choices for the gates in shared/foundation/channel-defaults.ts: a small sidecar in the profile
 * (`channel-gates.json`, booleans only). Read once when the app starts; a missing or damaged file is "nothing chosen" (the
 * channel's default), never a failure. Only a window's explicit `set` writes it, one write at a time, atomically.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, type AtomicFileWriter } from '../foundation/atomic-file';
import { resolveTouchSoftWithGate, type JellyTuning } from '../../shared/stage/jelly-tuning';
import { CHANNEL_GATE_IDS, NO_GATE_CHOICES, channelGatesView, parseChannelGateChoices, resolveChannelGate,
  type ChannelGateChoices, type ChannelGateId, type ChannelGatesView, type GateChannel } from '../../shared/foundation/channel-defaults';

export const CHANNEL_GATES_FILE = 'channel-gates.json';

export class ChannelGatesStore {
  private choices: ChannelGateChoices = NO_GATE_CHOICES;
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(directory: string, private readonly channel: GateChannel, private readonly writeFile: AtomicFileWriter = atomicWriteFile,
    read: (file: string) => string = file => readFileSync(file, 'utf8')) {
    this.file = path.join(directory, CHANNEL_GATES_FILE);
    try {
      const raw: unknown = JSON.parse(read(this.file));
      if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version === 1) this.choices = parseChannelGateChoices(raw);
    } catch { this.choices = NO_GATE_CHOICES; }
  }

  /** The gate as it is now: the user's saved choice, else the channel's default. */
  enabled(id: ChannelGateId): boolean { return resolveChannelGate(id, this.choices, this.channel); }
  view(): ChannelGatesView { return channelGatesView(this.choices, this.channel); }
  /** 「碰了才软」 as the windows get it: the user's saved choice, else the lab's saved choice, else the channel's default. */
  touchSoftFor(jelly: JellyTuning | null | undefined): { enabled: boolean; strength: number } {
    return resolveTouchSoftWithGate(jelly, this.view().touchSoft.saved, this.enabled('touchSoft'));
  }

  /** `on` true / false saves the choice; null forgets it (back to the channel's default). Unknown ids are refused. */
  set(id: unknown, on: unknown): Promise<ChannelGatesView> {
    if (typeof id !== 'string' || !(CHANNEL_GATE_IDS as readonly string[]).includes(id)) return Promise.reject(new Error('Unknown switch.'));
    if (on !== true && on !== false && on !== null) return Promise.reject(new Error('Invalid value.'));
    const run = async (): Promise<ChannelGatesView> => {
      const next = { ...this.choices, [id]: on } as ChannelGateChoices;
      await this.writeFile(this.file, JSON.stringify({ version: 1, ...next }, null, 2));
      this.choices = next;
      return this.view();
    };
    const result = this.writes.then(run, run);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}
