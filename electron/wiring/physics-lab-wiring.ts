// 舞台's wiring, R01 物理调参台 (docs/claude/2026-11-17-physics-lab.md): the per-model physics tuning (its own sidecar, keyed by the
// model's content hash) and the developer-only lab window.
// - The windows that show her get the physics switches plus the current model's tuning (physicsWithTuning); the switches' own file
//   never carries one. With no saved tuning nothing changes.
// - The lab opens only from the control window, only in developer mode. It answers only its own main frame (physics-lab-window.ts).
// - A save or a removal reaches the companion (the settings broadcast) and Unbound (its scene, through syncUnbound).
// Reads `needs` from stage-wiring.ts as a live binding. No module-level side effects.
import { app } from 'electron';
import path from 'node:path';
import type { ModelPhysicsSettings } from '../../shared/stage/model-physics';
import type { PhysicsLabModel } from '../../shared/stage/physics-lab';
import type { ModelPhysicsTuning } from '../../shared/stage/physics-tuning';
import { PhysicsLabWindow } from '../stage/physics-lab-window';
import { labAllowed } from '../stage/physics-lab-guard';
import { PhysicsTuningStore } from '../stage/physics-tuning-store';
import type { PartIpc } from './ipc-wiring';
import { broadcast } from './shell-wiring';
import { blushCalibrations } from './mood-wiring';
import { needs } from './stage-wiring';
import { modelPhysicsSettings } from './stage-model-wiring';
import { syncUnbound } from './unbound-wiring';
import { channelGates, onChannelGatesChanged } from './channel-gates-wiring';

export let physicsTuning: PhysicsTuningStore | null = null;
let lab: PhysicsLabWindow | null = null;
/** The last answer for the model the store's settings point at (Unbound reads it synchronously). */
let cached: { path: string; tuning: ModelPhysicsTuning | null } | null = null;

/**
 * I-136 5d 碰了才软: a choice the user saved in settings, else the lab's saved choice, else the channel's default (on in development and
 * source runs, off in stable until the user switches it on; shared/foundation/channel-defaults.ts).
 */
function touchSoftFor(tuning: ModelPhysicsTuning | null): { enabled: boolean; strength: number } {
  return channelGates(needs.store.directory).touchSoftFor(tuning?.jelly);
}

/** Ready-chain (inside startPhysicsSettings): the tuning sidecar beside the settings. */
export async function startPhysicsTuning(directory: string): Promise<void> {
  physicsTuning = new PhysicsTuningStore(directory);
  await physicsTuning.load();
  onChannelGatesChanged(() => void publish()); // the 「碰了才软」 switch in settings reaches the windows like a lab save
}

async function currentKey(): Promise<{ path: string; key: string } | null> {
  const model = needs.store.current.model;
  if (!model) return null;
  const key = await blushCalibrations.keyForModel(model.path);
  if (needs.store.current.model?.path !== model.path) throw new Error('模型已切换，请重新读取。');
  return { path: model.path, key };
}

/** The switches plus this model's tuning (`tuning: null` when there is none, so a window drops an old one). */
export async function physicsWithTuning(settings: ModelPhysicsSettings): Promise<Omit<ModelPhysicsSettings, 'tuning'> & { tuning: ModelPhysicsTuning | null }> {
  const { tuning: _ignored, ...switches } = settings;
  let tuning: ModelPhysicsTuning | null = null;
  try {
    const current = await currentKey();
    tuning = current ? physicsTuning?.get(current.key) ?? null : null;
    cached = current ? { path: current.path, tuning } : null;
  } catch { tuning = null; }
  return { ...switches, tuning, touchSoft: touchSoftFor(tuning) };
}

/** Synchronous, for Unbound's scene: the switches plus the last known tuning of the model the settings point at. */
export function physicsForWindows(): ModelPhysicsSettings | undefined {
  const settings = modelPhysicsSettings?.current;
  if (!settings) return undefined;
  const path = needs?.store.current.model?.path;
  const tuning = cached && cached.path === path ? cached.tuning : null;
  return { ...settings, ...(tuning ? { tuning } : {}), touchSoft: touchSoftFor(tuning) };
}

async function publish(): Promise<void> {
  broadcast('desk:model-physics-settings', await physicsWithTuning(modelPhysicsSettings.current));
  syncUnbound();
  lab?.changed();
}

function labModel(): Promise<PhysicsLabModel> {
  return (async () => {
    const settings = modelPhysicsSettings.current;
    const withTuning = await physicsWithTuning(settings);
    const { tuning: _ignored, ...switches } = settings;
    return { modelUrl: needs.store.current.model?.url ?? null, settings: switches, tuning: withTuning.tuning };
  })();
}

/** The lab's handler (control window only, developer mode only); stage-model-wiring.ts registers it beside the physics switches. */
export function registerPhysicsLabHandlers(host: PartIpc['host']): void {
  host('openPhysicsLab', async () => {
    labAllowed(!!needs.companion?.mood.isDeveloperMode());
    lab ??= new PhysicsLabWindow({
      page: () => ({ devUrl: !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined, electronDir: __dirname, distDir: path.join(__dirname, '../dist') }),
      model: labModel,
      save: async input => {
        labAllowed(!!needs.companion?.mood.isDeveloperMode());
        const current = await currentKey();
        if (!current || !physicsTuning) throw new Error('没有当前模型，无法保存物理调参。');
        const stored = await physicsTuning.set(current.key, input);
        await publish();
        return stored;
      },
      clear: async () => {
        const current = await currentKey();
        const removed = !!current && !!physicsTuning && await physicsTuning.remove(current.key);
        await publish();
        return removed;
      },
    });
    return lab.open();
  });
}

/** Before quit. */
export function releasePhysicsLab(): void { lab?.close(); lab = null; }
