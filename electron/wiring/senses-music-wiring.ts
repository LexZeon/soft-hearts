// 感知's music settings (M1: how strongly she dances, always dance), moved from electron/main.ts unchanged (wiring rewrite step 5,
// docs/claude/2026-11-17-wiring-step-5.md): the store, made in the ready chain where it was (startMusicSettings; the wiring golden expands
// it in place), and its two handlers, registered where they were inside the agent channel's recorder (registerMusicSettings).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import path from 'node:path';
import { MusicSettingsStore } from '../senses';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { broadcast } from './shell-wiring';
import { startUnit } from './parts-wiring';
import { senseFeeds } from './unbound-wiring';

/** M1: the music settings (a file of their own in the profile); made in the ready chain. */
export let musicSettings: MusicSettingsStore;

/** Ready-chain step (感知): the music settings, after the model physics switches and before the single emoji's settings. */
export async function startMusicSettings(store: SettingsStore): Promise<void> {
  await startUnit('senses', 'music-settings', async () => { // overhaul step 7: this unit's start, through the part runner
  musicSettings = new MusicSettingsStore(path.join(store.directory, 'music-settings.json'));
  await musicSettings.load();
  });
}

export function registerMusicSettings(ipc: PartIpc): void {
  const { host } = ipc;
  senseFeeds.musicSettings = () => musicSettings?.current ?? null; // 2026-11-24: her full-screen music follows the same settings (electron/unbound/sense-bridge.ts)
  host('getMusicSettings', () => musicSettings.current, false);
  host('setMusicSettings', async (input: unknown) => {
    if (input === undefined) return musicSettings.current;
    const accepted = await musicSettings.persist(input);
    broadcast('desk:music-settings', accepted);
    return accepted;
  });
}
