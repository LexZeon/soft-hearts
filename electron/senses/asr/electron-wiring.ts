/**
 * Electron glue for the local speech recognizer: the real utilityProcess, `net.fetch` for the user-requested download,
 * and the control-window IPC. main.ts only creates this, routes voice input through it and registers the IPC.
 */
import { app, net, utilityProcess, type MessagePortMain } from 'electron';
import { SILERO_VAD_RELATIVE, SMART_TURN_RELATIVE, loadSileroModel, loadSmartTurnModel } from '../../voice';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoseComponentStore, defaultComponentRoot, type FetchLike } from '../pose/component-store';
import { POSE_COMPONENT_VERSION, posePlatform } from '../../foundation/pose-manifest';
import type { LocalAsrView } from '../../../shared/senses/local-asr';
import type { MediaOwner } from '../media-runtime';
import { LocalAsrHost, type AsrWorkerHandle } from './host';
import { ASR_MANIFEST } from '../../foundation/asr-manifest';

/** What scripts/build-electron.mjs puts next to main.cjs for the local recognizer. */
export const ASR_BUNDLE = Object.freeze({ worker: 'asr-worker.cjs', licenses: 'asr-licenses' });

export interface ElectronLocalAsrOptions {
  /** dist-electron (where asr-worker.cjs and asr-licenses/ are). */
  directory: string;
  publish(view: LocalAsrView): void;
  promptRaised(owner: MediaOwner): void;
  /** Tests / smoke: a component root other than %LOCALAPPDATA%\soft-hearts-claude\components. */
  componentRoot?: string | null;
}

/** Only what the inference process needs to load system DLLs; no tokens, no user paths. */
function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function createLocalAsr(options: ElectronLocalAsrOptions): LocalAsrHost {
  const platform = posePlatform();
  const root = options.componentRoot === undefined ? defaultComponentRoot() : options.componentRoot;
  // Its own folder under the components root, so pose sensing's clean-up and this one never touch each other's files.
  const store = platform && root ? new PoseComponentStore({ root: path.join(root, 'asr'), platform, manifest: ASR_MANIFEST, component: 'asr',
    fetch: net.fetch as unknown as FetchLike, licenseDir: path.join(options.directory, ASR_BUNDLE.licenses),
    // The onnxruntime files are copied from an installed pose-sensing component instead of downloaded again.
    reuseDirs: () => [path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform)] }) : null;
  const fork = (): AsrWorkerHandle => {
    const child = utilityProcess.fork(path.join(options.directory, ASR_BUNDLE.worker), [], {
      serviceName: 'soft hearts speech recognition', stdio: 'ignore', env: workerEnvironment() });
    return {
      postMessage: (message, transfer) => child.postMessage(message, transfer as MessagePortMain[] | undefined),
      onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); },
      kill: () => { child.kill(); },
    };
  };
  // Two threads measured ~0.1 s per 5 s utterance on the test ARM64 machine; more only on bigger machines.
  const threads = Math.max(1, Math.min(4, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 3)));
  const poseDir = platform && root ? path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform) : null;
  // I-099: the call's Silero VAD, read from the app's own bundled assets (inside app.asar when packaged) and checked once.
  let vadModel: ReturnType<typeof loadSileroModel> | undefined;
  let turnModel: ReturnType<typeof loadSmartTurnModel> | undefined; // I-099/I-100: Smart Turn, likewise
  return new LocalAsrHost({ store, fork, publish: options.publish, promptRaised: options.promptRaised, threads: Math.max(2, threads),
    sharedRuntime: () => !!poseDir && existsSync(path.join(poseDir, 'installed.json')),
    vadModel: () => vadModel === undefined ? vadModel = loadSileroModel(path.join(app.getAppPath(), 'assets', 'bundled', ...SILERO_VAD_RELATIVE.split('/'))) : vadModel,
    turnModel: () => turnModel === undefined ? turnModel = loadSmartTurnModel(path.join(app.getAppPath(), 'assets', 'bundled', ...SMART_TURN_RELATIVE.split('/'))) : turnModel });
}

/** main.ts's entry: a failure here leaves the local recognizer unavailable (voice input says so) instead of ending the app. */
export function createLocalAsrOrNull(options: ElectronLocalAsrOptions): LocalAsrHost | null {
  try { return createLocalAsr(options); }
  catch (error) { console.warn('本机语音识别没能建立：', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'); return null; }
}

type HostRegistrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

/** Control-window IPC. Every reply is the fixed-shape view (enums and numbers only); no path ever leaves the host. */
export function registerLocalAsrControls(host: HostRegistrar, asr: () => LocalAsrHost | null, chooseFiles: () => Promise<string[]>,
  turnOffVoice: () => void): void {
  const required = () => { const value = asr(); if (!value) throw new Error('本机识别尚未就绪。'); return value; };
  host('getLocalAsr', () => required().view(), false);
  host('downloadLocalAsr', () => required().download());
  host('cancelLocalAsrDownload', () => { required().cancelDownload(); });
  host('dismissLocalAsrPrompt', () => required().dismissPrompt(), false);
  host('importLocalAsr', async () => {
    const files = await chooseFiles();
    const { result: _result, ...view } = await required().importFiles(files);
    return view;
  });
  host('removeLocalAsr', () => required().remove(turnOffVoice));
}
