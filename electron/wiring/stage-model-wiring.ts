// 舞台's wiring, what is known about the model (split from electron/wiring/stage-wiring.ts, docs/claude/2026-11-17-split-stage-wiring.md;
// the lines moved from electron/main.ts in step 4g, docs/claude/2026-11-16-wiring-step-4g.md). The statements are the ones main.ts had.
// - The model profile cache (keyed by the model's content hash; the renderer computes, the host only validates and stores).
// - I-024 模型体检: the per-model records, haiku's one read-only look at the model's part names (only while Claude is available), and
//   试一下 on the companion (only the companion answers; a hidden companion is not asked).
// - The physics switches (their own file beside the settings; only the control window may persist them).
// - Their ready-chain steps and handlers (registerStageModelHandlers, registerStagePhysicsHandlers: stage-wiring.ts's register calls them
//   in their old places, inside the agent channel's recorder). The Gene check's handler (isBehaviorModelSupported) is here with them.
// Reads `needs` from stage-wiring.ts as a live binding. No module-level side effects: nothing here runs on import.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CapabilityPreviewRelay, ModelCapabilityHost, ModelCapabilityStore, ModelPhysicsSettingsStore, ModelProfileStore } from '../stage';
import { chatAvailability } from '../brain';
import { quickLineWithClaude } from '../initiative';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { broadcast } from './shell-wiring';
import { blushCalibrations } from './mood-wiring';
import { needs } from './stage-wiring';
import { verifyVisualGeneTarget } from './stage-body-wiring';
import { startUnit } from './parts-wiring';
import { physicsWithTuning, registerPhysicsLabHandlers, startPhysicsTuning } from './physics-lab-wiring';
import { connectUnboundCapabilities } from './unbound-wiring';


let modelProfiles: ModelProfileStore;
/** I-024 模型体检 (electron/stage/model-capability-host.ts): per-model records, haiku's one look at part names, 试一下 on the companion. */
export let modelCapabilities: ModelCapabilityHost | null = null;
let capabilityPreview: CapabilityPreviewRelay | null = null;
export let modelPhysicsSettings: ModelPhysicsSettingsStore;

// ---- ready-chain steps (electron/main.ts calls each where its lines ran; the wiring golden reads the body in place) ----
/** Ready-chain step: the model physics switches (their own file beside the settings). */
export async function startPhysicsSettings(store: SettingsStore): Promise<void> {
  await startUnit('stage', 'physics-settings', async () => { // overhaul step 7: this unit's start, through the part runner
  modelPhysicsSettings = new ModelPhysicsSettingsStore(path.join(store.directory, 'physics-settings.json'));
  await modelPhysicsSettings.load();
  await startPhysicsTuning(store.directory); // R01 物理调参台: this model's saved tuning (physics-tuning.json, keyed by content hash)
  });
}
/** Ready-chain step: the model profile cache (keyed by the model's content hash). */
export async function startModelProfiles(store: SettingsStore): Promise<void> {
  await startUnit('stage', 'model-profile', async () => { // overhaul step 7: this unit's start, through the part runner
  modelProfiles = new ModelProfileStore(store.directory); await modelProfiles.load();
  });
}
/** Ready-chain step (I-024 模型体检): the records, haiku's one read-only look at the model's part names, and 试一下 on the companion. */
export async function startModelCapabilities(store: SettingsStore): Promise<void> {
  await startUnit('stage', 'model-capability', async () => { // overhaul step 7: this unit's start, through the part runner
      const capabilityStore = new ModelCapabilityStore(store.directory); await capabilityStore.load();
      modelCapabilities = new ModelCapabilityHost({ store: capabilityStore,
        current: async () => {
          const model = store.current.model, key = model ? await blushCalibrations.keyForModel(model.path) : null;
          if (model?.path !== store.current.model?.path) throw new Error('模型已切换，请重新读取模型体检。');
          return { modelKey: key, modelUrl: model?.url ?? '' };
        },
        profile: async key => { await modelProfiles.flush(); return modelProfiles.get(key); },
        available: () => chatAvailability.isAvailable(),
        ask: (prompt, systemPrompt, signal) => quickLineWithClaude(prompt, systemPrompt, signal),
        developerMode: () => !!needs.companion?.mood.isDeveloperMode(),
        log: line => console.info(line),
        broadcast: update => broadcast('desk:model-capabilities', update) });
      const host = modelCapabilities;
      connectUnboundCapabilities(() => host.view()); // I-154 follow-up: her full-screen face reads the same record (read only)
      capabilityPreview = new CapabilityPreviewRelay({ id: randomUUID,
        petSender: () => { const { pet } = needs; /* read when called */ return pet && !pet.isDestroyed() ? pet.webContents.id : null; },
        send: request => {
          const { pet } = needs; // read when called
          if (!pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized()) return false;
          pet.webContents.send('desk:model-capability-preview', request); return true;
        } });
  });
}

/** The Gene check, the model profile and the I-024 model check's handlers; stage-wiring.ts's register calls this in their old place. */
export function registerStageModelHandlers(host: PartIpc['host'], scopedHost: PartIpc['scopedHost']): void {
      host('isBehaviorModelSupported', async () => {
        return verifyVisualGeneTarget();
      }, false);
      // Model profile cache: keyed by the same content hash; the renderer computes, the host only validates and stores.
      host('getModelProfile', async () => {
        const { store, motionFits } = needs; // read when called
        const model = store.current.model, key = model ? await blushCalibrations.keyForModel(model.path) : null;
        if (model?.path !== store.current.model?.path) throw new Error('模型已切换，请重新读取模型档案。');
        // I-024: haiku's checked matches ride along; the stage fills them into the cached profile's empty slots (src/stage/model-profile.ts).
        return { modelKey: key, modelUrl: model?.url ?? '', profile: modelProfiles.get(key), haiku: modelCapabilities?.haikuFor(key) ?? null, motionFits: motionFits?.get(key) ?? null };
      }, false);
      host('saveModelProfile', async (modelKey, profile) => {
        const { store } = needs; // read when called
        const model = store.current.model?.path, key = model ? await blushCalibrations.keyForModel(model) : null;
        return !!key && key === modelKey && model === store.current.model?.path && modelProfiles.set(key, profile);
      }, false);
      // I-024 模型体检: both windows read and check (haiku sees only the model's own part names, once per model); the user's
      // on/off and 试一下 come from the character page (control window only); only the companion answers 试一下.
      const capabilities = () => { if (!modelCapabilities || !capabilityPreview) throw new Error('模型体检尚未就绪。'); return { host: modelCapabilities, preview: capabilityPreview }; };
      host('getModelCapabilities', () => capabilities().host.view(), false);
      host('askModelCapabilityNames', (modelKey, request) => capabilities().host.ask(modelKey, request), false);
      host('saveModelCapabilityCheck', (modelKey, matches) => capabilities().host.saveCheck(modelKey, matches), false);
      host('setModelCapabilityChoice', (modelKey, id, choice) => capabilities().host.setChoice(modelKey, id, choice));
      host('previewModelCapability', id => capabilities().preview.request(id));
      scopedHost('reportModelCapabilityPreview', (sender, requestId, ok) => capabilities().preview.report(sender, requestId, ok), false);
}

/** The physics switches' handlers; stage-wiring.ts's register calls this in their old place. */
export function registerStagePhysicsHandlers(host: PartIpc['host']): void {
      // R01: the windows that show her get the switches plus the current model's lab tuning (none: exactly as before).
      host('getModelPhysicsSettings', () => physicsWithTuning(modelPhysicsSettings.current), false);
      // Only the controls main frame may persist switches. Publish after the
      // independent sidecar commit; older settings forms never write this file.
      host('setModelPhysicsSettings', async (input: unknown) => {
        if (input === undefined) return modelPhysicsSettings.current;
        const accepted = await physicsWithTuning(await modelPhysicsSettings.persist(input));
        broadcast('desk:model-physics-settings', accepted);
        return accepted;
      });
      registerPhysicsLabHandlers(host); // R01 物理调参台 (electron/wiring/physics-lab-wiring.ts): control window, developer mode
}
