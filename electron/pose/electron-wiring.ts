/**
 * Electron glue for local pose sensing: the real utilityProcess, MessageChannelMain, sensor window,
 * `net.fetch` for the user-requested download, the host's own file dialog for offline import, battery state.
 * main.ts only creates this, forwards the camera switch and registers the control-window IPC below.
 */
import { app, MessageChannelMain, net, powerMonitor, utilityProcess, type MessagePortMain } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PoseSensingView, PoseSignal } from '../../shared/pose-signals';
import { POSE_BUNDLE } from './bundle-files';
import { buildPoseSensing } from './camera-gate';
import { PoseComponentStore, defaultComponentRoot, type FetchLike } from './component-store';
import { PoseSensingHost } from './host';
import { POSE_COMPONENT_VERSION, posePlatform } from './manifest';
import { ASR_COMPONENT_VERSION } from '../asr/manifest';
import { openSensorWindow } from './sensor-window';
import type { WorkerHandle } from './supervisor';

export interface ElectronPoseOptions {
  /** dist-electron (where pose-worker.cjs, pose-sensor-preload.cjs, pose-sensor.html and pose-licenses/ are). */
  directory: string;
  developerMode(): boolean;
  publish(view: PoseSensingView): void;
  disableCamera(): void;
  promptRaised(owner: 'controls' | 'pet'): void;
  trayChanged(sensing: boolean): void;
  onSignal?(signal: PoseSignal): void;
  /** Sensing started (true) or stopped (false): P1 第二阶段 forgets everything about the user at once when it stops. */
  onSensing?(on: boolean): void;
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

export function createElectronPoseSensing(options: ElectronPoseOptions): PoseSensingHost {
  const platform = posePlatform();
  const root = options.componentRoot === undefined ? defaultComponentRoot() : options.componentRoot;
  const store = platform && root ? new PoseComponentStore({ root, platform, fetch: net.fetch as unknown as FetchLike,
    licenseDir: path.join(options.directory, POSE_BUNDLE.licenses),
    // The same onnxruntime files may already be installed for local speech recognition (electron/asr/): copied after a hash check.
    reuseDirs: () => [path.join(root, 'asr', `asr-v${ASR_COMPONENT_VERSION}`, platform)] }) : null;
  const fork = (): WorkerHandle => {
    const child = utilityProcess.fork(path.join(options.directory, POSE_BUNDLE.worker), [], {
      serviceName: 'soft hearts pose sensing', stdio: 'ignore', env: workerEnvironment() });
    return {
      postMessage: (message, transfer) => child.postMessage(message, transfer as MessagePortMain[] | undefined),
      onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); },
      kill: () => { child.kill(); },
    };
  };
  const host = new PoseSensingHost({
    store, fork,
    channel: () => { const { port1, port2 } = new MessageChannelMain(); return { worker: port1, sensor: port2 }; },
    openSensor: (port, status) => openSensorWindow(port as MessagePortMain, status, options.directory),
    fingerprint: async () => {
      const info = await app.getGPUInfo('basic') as { gpuDevice?: { vendorId?: number; deviceId?: number; driverVersion?: string; active?: boolean }[] };
      const devices = (info.gpuDevice ?? []).map(d => [d.vendorId, d.deviceId, d.driverVersion ?? '', !!d.active]);
      return createHash('sha256').update(JSON.stringify([devices, process.arch, 'ort-1.31.1', POSE_COMPONENT_VERSION])).digest('hex');
    },
    publish: options.publish, disableCamera: options.disableCamera, promptRaised: options.promptRaised,
    trayChanged: on => { options.trayChanged(on); try { options.onSensing?.(on); } catch { /* Her reactions never block the switch. */ } },
    developerMode: options.developerMode, onSignal: options.onSignal,
  });
  const battery = () => host.supervisor.setPressure(powerMonitor.isOnBatteryPower());
  powerMonitor.on('on-battery', battery); powerMonitor.on('on-ac', battery);
  battery();
  return host;
}

/** main.ts's entry: a failure here leaves the camera refused ('unavailable') instead of ending the whole app. */
export function createPoseSensingOrNull(options: ElectronPoseOptions): PoseSensingHost | null {
  return buildPoseSensing(() => createElectronPoseSensing(options),
    error => console.warn('本地姿态感知没能建立，摄像头会保持关闭：', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'));
}

export { registerPoseControls } from './control-ipc';
export { poseCameraPolicy } from './camera-gate';
