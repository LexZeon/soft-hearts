// Wiring for the channel-dependent defaults (shared/foundation/channel-defaults.ts, docs/claude/2026-11-19-stable-defaults.md): the user's
// saved choices live in the profile (electron/wiring/channel-gates-store-wiring.ts); the installed channel is the one electron/main.ts put on the
// command line. Nothing here starts anything: the store is made the first time somebody asks (with the profile folder), so it never runs
// before the profile folder is set.
// - unboundEntryAllowed(): the tray item, the control window's button and Ctrl+Alt+U read it (on in every channel since 2026-11-25; the user may switch it off).
// - touchSoftGate(): 「碰了才软」 (electron/wiring/physics-lab-wiring.ts).
// - registerChannelGates(host): the two handlers the settings page uses (getChannelGates, setChannelGates; declared by UNBOUND_PART).
import { app } from 'electron';
import { channelGateDefault, type ChannelGateId, type ChannelGatesView, type GateChannel } from '../../shared/foundation/channel-defaults';
import { ChannelGatesStore } from './channel-gates-store-wiring';
import type { PartIpc } from './ipc-wiring';

let store: ChannelGatesStore | null = null;
let listeners: Set<() => void> | null = null;

/** The installed channel ('stable' / 'development'), or '' for a source run or an unmanaged build. */
export function currentChannel(): GateChannel {
  try { const value = app.commandLine.getSwitchValue('soft-hearts-channel'); return value === 'stable' || value === 'development' ? value : ''; } catch { return ''; }
}

/** The store for this profile; made on first use. */
export function channelGates(directory: string): ChannelGatesStore {
  return store ??= new ChannelGatesStore(directory, currentChannel());
}

/** Before the store exists (nothing asked for the profile folder yet) a gate follows the channel; a saved choice is read as soon as it is made. */
export function gateEnabled(id: ChannelGateId): boolean { return store ? store.enabled(id) : channelGateDefault(id, currentChannel()); }
export function gateView(): ChannelGatesView | null { return store?.view() ?? null; }
export function unboundEntryAllowed(): boolean { return gateEnabled('unboundEntry'); }

/** Somebody who needs to follow a change (the tray, Unbound's control view, the windows that show her); returns the way to stop. */
export function onChannelGatesChanged(listener: () => void): () => void { (listeners ??= new Set()).add(listener); return () => { listeners?.delete(listener); }; }

/** The two window handlers; `directory` is the profile folder. A set tells everyone who follows (a failing listener never blocks the others). */
export function registerChannelGates(host: PartIpc['host'], directory: string): void {
  const gates = channelGates(directory);
  host('getChannelGates', () => gates.view());
  host('setChannelGates', async (id, on) => {
    const view = await gates.set(id, on);
    for (const listener of [...(listeners ?? [])]) { try { listener(); } catch { /* a follower's trouble is its own */ } }
    return view;
  });
}
