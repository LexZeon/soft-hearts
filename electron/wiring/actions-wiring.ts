// 身体动作's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md):
// her actions (a test command's action to every stage, the companion's answer), body motion access, resolving a chat gesture's and a
// behaviour's motion, motion fits, and the motion library (tags, track coverage, preview, packs, layers, the bundled model, picking a
// model or motion file). Moved from electron/main.ts unchanged; what they read comes through ActionsNeeds (getters electron/main.ts
// gives, read when used). Its own state lives here (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md): the bundled
// assets, the motion library, the tag annotations and the motion fits (made by the ready steps startMotionStores and startMotionFits),
// the motion selection generation (saveMotionSelection, noteModelSelection) and the motion download's owner. The body model generation
// stays the stage's (needs.bodyModelGeneration). Pose, gesture and expression stay separate channels: nothing here merges them.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { t } from '../../shared/foundation/ui-language';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { AppSettings } from '../../shared/contracts';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { isMotionLayer, motionAssetBaseline, withMotionLayer, type MotionCatalog } from '../../shared/actions';
import motionTrackCoverageCatalog from '../../shared/actions/motion-catalog.json';
import { BodyMotionAccess, HerActionHost, MotionFitStore, MotionLibrary, MotionTrackCoverageHost, MotionWeightStore, resolveBehaviorMotionResource,
  resolveBodyMotionResource, resolveChatGestureResource, unverifiedCatalogHostSnapshot } from '../actions';
import { BundledAssets } from '../actions/bundled-assets';
import type { CompanionService } from '../brain';
import type { BlushCalibrationStore } from '../mood';
import { publicSettings, type SettingsStore } from '../settings';
import type { AssetRegistry } from '../foundation/assets';
import type { PartIpc } from './ipc-wiring';
import { startUnit, startUnitSync, type PartHandle } from './parts-wiring';
import { broadcast, windows } from './shell-wiring';
import { connectUnboundMotions, unboundShowsHer } from './unbound-wiring'; // batch C: her motions out in full-screen Unbound
import { herActionAnswerCounts } from '../unbound';
import { windowGestureRefusal } from '../../shared/brain';
import { MODEL_DIALOG_EXTENSIONS, isModelFileExtension } from '../../shared/foundation/model-format'; // I-152

/** What the actions wiring reads (getters electron/main.ts gives; each read when it is used). */
export interface ActionsNeeds {
  readonly pet: BrowserWindow | null;
  readonly controls: BrowserWindow | null;
  readonly store: SettingsStore;
  readonly companion: CompanionService;
  readonly petWindowDrag: { readonly active: boolean } | null;
  readonly blushCalibrations: BlushCalibrationStore;
  readonly assets: AssetRegistry;
  /** The stage's number (a new body model makes old receipts stale). */
  readonly bodyModelGeneration: number;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  sync(exclude?: number): void;
  /** 角色卡 C1: a loaded model picks its card. */
  adoptCharacterForModel(model: { path: string } | null | undefined): Promise<string | undefined>;
  /** The control window's command context (settings): the coverage answers only for the context it was asked in. */
  companionCommandContext(sender: number): string;
}
export interface ActionsProvides {
  /** 她的动作: a test command's action goes to every window's stage; the companion window answers. */
  readonly herActions: HerActionHost;
}

/** The factory Gene and the bundled motions (electron/actions/bundled-assets.ts), made by the ready chain (startMotionStores). */
export let bundledAssets: BundledAssets;
/** The motion library (packs, tags, previews, downloads), made by the ready chain (startMotionStores). */
export let motionLibrary: MotionLibrary;
/** The motion tag annotations (<profile>/motion-tag-annotations.json), made by the ready chain (startMotionStores). */
export let motionWeights: MotionWeightStore | undefined;
/** Universal skeleton step 1: each model's motion scores, made by the ready chain (startMotionFits). */
export let motionFits: MotionFitStore | null = null;
/** A changed model or motion moves this on: a preview, a download or a tag snapshot taken for the old one is stale. */
export let motionSelectionGeneration = 0;
/** The window whose motion download is running (one at a time); that window going away cancels it (the window steps below). */
export let motionDownloadOwner: number | null = null;
let partNeeds!: ActionsNeeds;

/** A model was picked another way (a card's model, the agent channel's load_model): the same step as selectAsset('model'). */
export function noteModelSelection(): void { motionSelectionGeneration++; }

/** Ready step (身体动作): the bundled assets, the motion library and the tag annotations, once the settings store is open. */
/** I-209 step 1: the app's asset registry, for an extra's model on the full-screen stage (set with the bundled assets). */
export let assetRegistry: AssetRegistry | null = null;
export function startMotionStores(store: SettingsStore, assets: AssetRegistry): void {
  assetRegistry = assets;
  const bundledDirectory = path.join(app.getAppPath(), "assets", "bundled");
  bundledAssets = new BundledAssets(bundledDirectory, assets);
  startUnitSync('actions', 'motion-library', () => { // overhaul step 7: the library and its tags are one unit; the bundled assets are core
  motionLibrary = new MotionLibrary(path.join(store.directory, "library", "motions"), { bundledDirectory,
    readMotionTagSnapshot: () => unverifiedCatalogHostSnapshot(motionSelectionGeneration, !partNeeds.controls || partNeeds.controls.isDestroyed()) });
  motionWeights = new MotionWeightStore(path.join(store.directory, 'motion-tag-annotations.json'), {
    assets: packId => motionLibrary.taggableAssets(packId),
  });
  });
}
/** Ready step (身体动作): the motion fits (universal skeleton step 1). */
export async function startMotionFits(store: SettingsStore): Promise<void> {
  await startUnit('actions', 'motion-fits', async () => { // overhaul step 7: this unit's start, through the part runner
  motionFits = new MotionFitStore(store.directory); await motionFits.load();
  });
}
/** Save step (身体动作): a changed model or motion makes motion selections made for the old ones stale. */
export function saveMotionSelection(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (JSON.stringify(motionAssetBaseline(next)) !== JSON.stringify(motionAssetBaseline(store.current)))
    motionSelectionGeneration++;
}
/** Window step (身体动作; electron/main.ts's wireWindowEvents gives the order): a hidden, closed or crashed window's tag annotation lease goes. */
export function dropMotionWeightsOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  motionWeights?.dropOwner(windowId);
}
/** Window step (身体动作): the closed window's motion download is cancelled. */
export function cancelClosedWindowDownload(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (motionDownloadOwner === windowId) motionLibrary.cancel();
}
/** Quit step (身体动作; electron/main.ts's wireQuit gives the order): a motion download in progress is cancelled. */
export function cancelMotionDownloads(): void {
  motionLibrary?.cancel();
}

export function wireActions(needs: ActionsNeeds): PartHandle<ActionsProvides> & { register(ipc: PartIpc): void } {
  partNeeds = needs;
  /** 她的动作 (T-211, Codex's actions): a test command's action goes to every window's stage; the companion window answers (electron/actions/her-action-host.ts). */
  // Batch C (docs/claude/2026-11-21-unbound-full-ACH.md): while she is out in full-screen Unbound she plays it there and only that window's answer counts.
  const herActions = new HerActionHost({ send: cue => broadcast('desk:her-action', cue),
    petVisible: () => (!!needs.pet && !needs.pet.isDestroyed() && needs.pet.isVisible() && !needs.pet.isMinimized()) || unboundShowsHer(),
    refuse: action => windowGestureRefusal(action, undefined, unboundShowsHer()), // 2026-11-24: the small window has no 「抱抱」 for now (one knob with the kiss and hug)
    library: { resolvePreview: (packId, motionId) => motionLibrary.resolvePreview(packId, motionId) }, register: file => needs.assets.register(file) });
  function herActionFromPet(sender: number, outcome: unknown): void {
    if (needs.pet && !needs.pet.isDestroyed() && sender === needs.pet.webContents.id && herActionAnswerCounts('companion', unboundShowsHer())) herActions.report(outcome);
  }
  return {
    id: 'actions',
    units: ['bundled-assets', 'her-actions', 'body-motion', 'gesture', 'behavior-motion', 'motion-fits', 'motion-library', 'motion-coverage', 'motion-packs', 'asset-pick'],
    /** Overhaul step 7: the bundled assets (her default model and rest pose) stay fatal; the library, its tags and the fits can be switched off alone. */
    core: ['bundled-assets'],
    ipc: { 'motion-library': ['getMotionLibrary', 'readMotionWeights', 'invalidateMotionWeightSelection', 'saveMotionWeights', 'searchMotionWeights', 'previewMotion', 'installMotionPack', 'clearMotionLayer', 'cancelMotionDownload'],
      'motion-fits': ['saveMotionFits'] },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: each is set before the ready chain registers (registerIPC) and not replaced later; the body model
      // generation is read through needs at each use, this part's own state (the motion stores and the two numbers above) at each use too.
      const { pet, controls, store, companion, petWindowDrag, blushCalibrations, assets, mutate, sync, adoptCharacterForModel, companionCommandContext } = needs;
      host('resolveHerAction', cueId => herActions.resolve(cueId), false); // 她的动作: both windows; only a live cue, only its pinned VMD.
      scopedHost('reportHerAction', (sender, outcome) => herActionFromPet(sender, outcome), false); // only the companion window's answer counts.
      const bodyAccessFor = (authorize: (sender: number) => boolean, visible: () => boolean) => new BodyMotionAccess({
        authorizePet: authorize, visible, // no-pet-ok: BodyMotionAccess keeps its port name (the companion window by default; her full-screen window below)
        generation: () => needs.bodyModelGeneration,
        model: () => store.current.model,
        view: () => companion.mood.get(),
        prepare: (token, targetVerified, observation) => companion.mood.prepareBodyPresentation(token, targetVerified, observation),
        observeStage: (token, observation) => companion.mood.observeBodyStage(token, observation),
        invalidateStage: token => companion.mood.cancelBodyPresentation(token),
        cue: (cueId, token) => {
          const cue = companion.mood.getBodyCue(cueId, token, true);
          if (!cue) throw new Error('身体动作已结束或作用域已切换。');
          return cue;
        },
        verifyModel: async model => {
          try { return typeof await blushCalibrations.keyForModel(model.path) === 'string'; } // I-038: any read model; the stage judges each motion
          catch { return false; }
        },
        resolve: (cue, stillCurrent) => resolveBodyMotionResource(motionLibrary, cue, { stillCurrent }),
        register: file => assets.register(file),
      });
      const bodyAccess = bodyAccessFor(sender => !!pet && !pet.isDestroyed() && !pet.webContents.isDestroyed() && sender === pet.webContents.id,
        () => !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized() && store.current.pet.visible && !petWindowDrag?.active);
      // Batch C: her full-screen window's own access (its bridge took the request only from the window she is shown in); only while she is out.
      const unboundBody = bodyAccessFor(() => unboundShowsHer(), () => unboundShowsHer());
      scopedHost('getBehaviorBodyPlan', (sender, token, observation) => bodyAccess.getPlan(sender, token, observation), false);
      scopedHost('resolveBehaviorBody', (sender, cueId, token) => bodyAccess.resolve(sender, cueId, token), false);
      const resolveChatGesture = async (cueId: unknown, token: unknown) => {
        const current = () => {
          const view = companion.mood.get();
          if (typeof cueId !== 'string' || typeof token !== 'string' || view.token !== token || !view.expressions
            || !view.gesture || view.gesture.id !== cueId || view.gesture.expiresAt <= Date.now())
            throw new Error('会话动作已结束或角色已切换。');
          return view.gesture;
        };
        const cue = current();
        const resource = await resolveChatGestureResource(motionLibrary, cue);
        current();
        const asset = await assets.register(resource.path);
        current();
        const { path: _localPath, ...metadata } = resource;
        return { ...metadata, url: asset.url };
      };
      host('resolveChatGesture', resolveChatGesture, false);
      const resolveBehaviorMotion = async (cueId: unknown, token: unknown) => {
        const current = () => {
          const view = companion.mood.get();
          const cue = [view.behavior?.state, view.behavior?.reaction].find(value => value?.id === cueId);
          if (typeof cueId !== 'string' || typeof token !== 'string' || view.token !== token || !view.expressions
            || !cue || cue.expiresAt <= Date.now()) throw new Error('自动表情已结束或角色已切换。');
          return cue;
        };
        const cue = current();
        const resource = await resolveBehaviorMotionResource(motionLibrary, cue);
        const stillCurrent = () => {
          const value = current();
          if (value.bindingId !== cue.bindingId || value.kind !== cue.kind || value.stateKey !== cue.stateKey)
            throw new Error('自动表情已失效。');
        };
        stillCurrent();
        const asset = await assets.register(resource.path);
        stillCurrent();
        const { path: _localPath, ...metadata } = resource;
        return { ...metadata, url: asset.url };
      };
      host('resolveBehaviorMotion', resolveBehaviorMotion, false);
      // Batch C: the same reads for her full-screen window (electron/unbound/motion-bridge.ts takes each only from the window she is shown in).
      connectUnboundMotions({ resolveChatGesture, resolveBehaviorMotion, resolveHerAction: cueId => herActions.resolve(cueId),
        reportHerAction: outcome => { if (herActionAnswerCounts('unbound', unboundShowsHer())) herActions.report(outcome); },
        bodyPlan: (token, observation) => unboundBody.getPlan(0, token as string, observation), resolveBody: (cueId, token) => unboundBody.resolve(0, cueId as string, token as string) });
      // Universal skeleton step 1: the scan (controls window) stores this model's motion scores; same content key, part words and numbers only.
      host('saveMotionFits', async (modelKey, record) => {
        const model = store.current.model?.path, key = model ? await blushCalibrations.keyForModel(model) : null;
        return !!key && key === modelKey && model === store.current.model?.path && !!motionFits && motionFits.set(key, record);
      });
      host("selectAsset", async (kind: unknown, layer: unknown) => {
        if (kind !== "model" && kind !== "motion")
          throw new Error("资源类型不正确。");
        if (layer !== undefined && (!isMotionLayer(layer) || kind !== "motion"))
          throw new Error("动作通道不正确。");
        const selected = await dialog.showOpenDialog(controls!, {
          title:
            kind === "model" ? t("选择模型（MMD 或 VRM，保留同目录纹理）") : t("选择 MMD 动作"),
          properties: ["openFile"],
          filters: [
            {
              name: kind === "model" ? t("模型（MMD / VRM）") : t("MMD 动作"),
              extensions: kind === "model" ? [...MODEL_DIALOG_EXTENSIONS] : ["vmd"], // I-152: .vrm too
            },
          ],
        });
        if (selected.canceled || !selected.filePaths[0]) return null;
        const extension = path.extname(selected.filePaths[0]).toLowerCase();
        if (!(kind === "model" ? isModelFileExtension(extension) : extension === ".vmd"))
          throw new Error("不支持的资源格式。");
        const asset = await assets.register(selected.filePaths[0]);
        motionSelectionGeneration++;
        await mutate(async () => {
          await store.persist(kind === "model"
            ? { ...store.current, model: asset, motion: null, motionLayers: undefined }
            : isMotionLayer(layer) ? withMotionLayer(store.current, layer, asset)
            : { ...store.current, motion: asset, motionLayers: undefined });
          if (kind === 'model') await adoptCharacterForModel(asset); // C1: the model picks its card
        });
        sync();
        return asset;
      });
      const motionTrackCoverage = new MotionTrackCoverageHost({ catalog: motionTrackCoverageCatalog as MotionCatalog,
        context: sender => !controls || controls.isDestroyed() || controls.webContents.id !== sender
          || !controls.isVisible() || controls.isMinimized() ? null : companionCommandContext(sender) + ':' + needs.bodyModelGeneration,
        modelIdentity: async () => { const model = store.current.model; if (!model) return null;
          try { return await blushCalibrations.keyForModel(model.path); } catch { return null; } },
        resolve: (packId, motionId) => motionLibrary.resolvePreview(packId, motionId),
      });
      scopedHost('motionTrackCoverageRead', (sender, ...args: unknown[]) => {
        if (args.length !== 1) throw Error('轨道覆盖查询参数不正确。');
        return motionTrackCoverage.read(sender, args[0]);
      });
      host("getMotionLibrary", (...args: unknown[]) => {
        if (args.length > 1) throw new Error('动作标签查询只接受一个可选偏好对象。');
        return args.length === 0 ? motionLibrary.getStatus() : motionLibrary.getStatus(args[0]);
      });
      scopedHost('readMotionWeights', (sender, ...args: unknown[]) => {
        if (args.length !== 2 || !motionWeights) throw Error('动作标签请求不正确。');
        return motionWeights.read(sender, args[0], args[1]);
      });
      scopedHost('invalidateMotionWeightSelection', (sender, ...args: unknown[]) => {
        if (args.length !== 1 || !motionWeights) throw Error('动作标签请求不正确。');
        motionWeights.invalidateSelection(sender, args[0]);
      });
      scopedHost('saveMotionWeights', (sender, ...args: unknown[]) => {
        if (args.length !== 1 || !motionWeights) throw Error('动作标签请求不正确。');
        return motionWeights.save(sender, args[0]);
      });
      scopedHost('searchMotionWeights', (_sender, ...args: unknown[]) => {
        if (args.length !== 1 || !motionWeights) throw Error('动作标签请求不正确。');
        return motionWeights.search(args[0]);
      });
      scopedHost("previewMotion", async (sender, packId, motionId) => {
        const generation = motionSelectionGeneration;
        const current = () => {
          if (generation !== motionSelectionGeneration || controls?.isDestroyed() || controls?.webContents.id !== sender)
            throw new Error("预览已取消，模型或动作已更换，请重新预览。");
        };
        current();
        const file = await motionLibrary.resolvePreview(packId, motionId);
        current();
        const asset = await assets.register(file);
        current();
        // Preview grants a local resource to the controls only; settings and companion playback are unchanged.
        return asset;
      });
      host("useBundledModel", () => mutate(async () => {
        motionSelectionGeneration++;
        motionLibrary.cancel();
        const defaults = await bundledAssets.getDefaultAssets();
        const saved = await store.persist({ ...store.current, ...defaults, motionLayers: undefined, camera: structuredClone(DEFAULT_SETTINGS.camera) });
        sync();
        // C1: the preinstalled Gene goes with the Gene card.
        return await adoptCharacterForModel(store.current.model) === undefined ? saved : publicSettings(store.current);
      }));
      // Her default stand when no pose is picked, read by both windows' stages (src/stage/rest-stand.ts; docs/claude/2026-11-21-window-idle-pose.md).
      host("getRestStand", () => bundledAssets.getDefaultMotion(), false);
      scopedHost("installMotionPack", async (sender, packId, motionId, layer) => {
        if (layer !== undefined && !isMotionLayer(layer)) throw new Error("动作通道不正确。");
        if (motionDownloadOwner !== null) throw new Error("上一项动作下载仍在进行，请等待或取消。");
        const generation = motionSelectionGeneration;
        motionDownloadOwner = sender;
        try {
          const file = await motionLibrary.install(packId, motionId, (progress) => {
            windows().find((win) => win.webContents.id === sender)?.webContents.send("desk:motion-download", progress);
          });
          return await mutate(async () => {
            const stale = () => generation !== motionSelectionGeneration || !windows().some((win) => win.webContents.id === sender);
            const expired = () => new Error("动作包已下载；操作已取消或模型/动作已更换，请重新启用。");
            if (stale()) throw expired();
            const asset = await assets.register(file);
            if (stale()) throw expired();
            const previousMotion = { motion: store.current.motion, motionLayers: store.current.motionLayers };
            await store.persist(isMotionLayer(layer) ? withMotionLayer(store.current, layer, asset)
              : { ...store.current, motion: asset, motionLayers: undefined });
            if (stale()) {
              await store.persist({ ...store.current, ...previousMotion });
              sync();
              throw expired();
            }
            motionSelectionGeneration++;
            sync();
            return asset;
          });
        } finally {
          motionDownloadOwner = null;
        }
      });
      host("clearMotionLayer", layer => mutate(async () => {
        if (!isMotionLayer(layer)) throw new Error("动作通道不正确。");
        motionSelectionGeneration++;
        motionLibrary.cancel();
        const saved = await store.persist(withMotionLayer(store.current, layer, null));
        sync();
        return saved;
      }));
      host("cancelMotionDownload", () => {
        if (motionDownloadOwner !== null) motionSelectionGeneration++;
        motionLibrary.cancel();
      });
    },
    provides: { herActions },
  };
}
