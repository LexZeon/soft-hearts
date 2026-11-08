/**
 * 她的动作 on a model that is not the reviewed Gene: the stage's own playHerAction (her-action.ts and MmdStage), with its loader
 * (the real MMDLoader VMD parser and AnimationBuilder), the stage's retarget hook and fit check, and its part checks. Nothing is
 * faked but the transport of the bundled bytes. Used by tests/her-action-models.test.ts and tests/t213-model-adaptation.test.ts.
 */
import { readFile } from 'node:fs/promises';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { buildModelProfile, type ModelProfile, type StandardBone } from '../../shared/model-profile';
import { HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome } from '../../shared/her-actions';
import { MmdStage } from '../../src/stage/MmdStage';
import { HerActionPlayer } from '../../src/stage/her-action';
import { StageMotionRetarget, clearRetargetCache } from '../../src/stage/motion-retarget';
import { EMPTY_CONTACT } from '../../src/stage/mood-feedback';
import { catalogMotionFile } from './gene-stage-harness';
import { profileInput, toThreeMesh, type ModelData } from './model-fixtures';

export async function stageOn(data: ModelData, options: { fullSkin?: boolean; hide?: readonly StandardBone[] } = {}) {
  clearRetargetCache();
  const mesh = toThreeMesh(data, { fullSkin: options.fullSkin }), profile: ModelProfile = buildModelProfile(profileInput(data));
  const retarget = new StageMotionRetarget(mesh, profile, { reviewed: false });
  const hidden = new Set(options.hide ?? []);
  const modelProfile = { profile, bone: (slot: StandardBone) => {
    const entry = profile.bones.map[slot];
    return hidden.has(slot) || !entry ? undefined : mesh.skeleton.bones[entry.index];
  } };
  const cues = new Map<string, HerActionCue>(), reports: HerActionOutcome[] = [];
  const keys = ['window', 'document'] as const, previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, { document: { hidden: false }, window: { desktop: {
    resolveHerAction: async (cueId: string) => {
      const cue = cues.get(cueId)!;
      return { cueId, action: cue.action, packId: HER_ACTION_PACK, motionId: cue.action, sha256: HER_ACTION_SPECS[cue.action].sha256,
        durationMs: HER_ACTION_SPECS[cue.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${cue.action}.vmd` };
    },
    reportHerAction: async (outcome: HerActionOutcome) => { reports.push(outcome); },
  } } });
  type VmdLoader = { loadVMD(url: string, onLoad: (vmd: unknown) => void, onProgress?: unknown, onError?: (error: unknown) => void): void; _getParser(): { parseVmd(buffer: ArrayBuffer, leftToRight: boolean): unknown } };
  const loader = MMDLoader.prototype as unknown as VmdLoader, original = loader.loadVMD;
  loader.loadVMD = function (this: VmdLoader, url, onLoad, _progress, onError) {
    const id = /^mmd-asset:\/\/d{32}\/([a-z-]+)\.vmd$/.exec(url)?.[1];
    Promise.resolve().then(() => readFile(catalogMotionFile(HER_ACTION_PACK, id!))).then(bytes => {
      onLoad(this._getParser().parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, true));
    }).catch(error => onError?.(error));
  };
  const stage = Object.create(MmdStage.prototype) as any;
  Object.assign(stage, { mesh, herAction: new HerActionPlayer(mesh), herActionGeneration: 0, herActionInfo: null, modelProfile, motionRetarget: retarget,
    options: { transparent: true }, disposed: false, hostVisible: true, container: { clientWidth: 400, clientHeight: 560 }, moodContact: { ...EMPTY_CONTACT },
    controls: { interacting: false }, behaviorBlocked: false, musicEnabled: false, chatGestureBlocked: false, moodHeadBlocked: false, bodyManualPose: false,
    bodyManualGesture: false, bodyPreview: null, bodyPersonalize: null, surprisePreview: null, expressionShow: null, visualPreview: null, chatGesturePlayer: null,
    modelGeneration: 1 });
  let serial = 0;
  const play = async (action: HerActionId) => {
    const at = Date.now(), cue: HerActionCue = { id: `m${++serial}`, action, at, expiresAt: at + HER_ACTION_CUE_MS };
    cues.set(cue.id, cue);
    await stage.playHerAction(cue);
    return reports.find(report => report.cueId === cue.id)!;
  };
  const close = () => { loader.loadVMD = original; keys.forEach((key, index) => { const d = previous[index]; if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }); };
  return { stage, mesh, retarget, profile, play, close };
}
export type HerActionHarness = Awaited<ReturnType<typeof stageOn>>;
