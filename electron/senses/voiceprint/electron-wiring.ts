/**
 * Electron glue for Unbound v1 step 3 「只认你的声音」: the real utilityProcess, `net.fetch` for the one model download the user asked for
 * by turning the switch on (every other address is refused: the runtime is only ever copied), `safeStorage` for the voiceprint, and the
 * control-window IPC. The voice-input wiring creates this lazily and asks it about each clip (electron/wiring/senses-voice-input-wiring.ts).
 */
import { net, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { VoiceprintView } from '../../../shared/senses/voiceprint';
import { ASR_COMPONENT_VERSION } from '../../foundation/asr-manifest';
import { POSE_COMPONENT_VERSION, posePlatform } from '../../foundation/pose-manifest';
import { PoseComponentStore, defaultComponentRoot, type FetchLike } from '../pose/component-store';
import { SEMANTIC_COMPONENT_VERSION } from '../../memory';
import { FACE_COMPONENT_VERSION } from '../face/manifest';
import type { SecretStorage } from '../../settings';
import { VoiceprintHost, type VoiceprintWorkerHandle } from './host';
import { VOICEPRINT_MANIFEST, approvedFetch } from './manifest';
import { VoiceprintDataStore } from './store';

/** What scripts/build-electron.mjs puts next to main.cjs. */
export const VOICEPRINT_BUNDLE = Object.freeze({ worker: 'voiceprint-worker.cjs', licenses: 'voiceprint-licenses' });

export interface ElectronVoiceprintOptions {
  /** dist-electron (where voiceprint-worker.cjs and voiceprint-licenses/ are). */
  directory: string;
  /** The profile directory: the saved switch and the encrypted voiceprint live here. */
  profileDirectory: string;
  secret: SecretStorage;
  publish(view: VoiceprintView): void;
  /** Tests / smoke: a component root other than %LOCALAPPDATA%\soft-hearts-claude\components. */
  componentRoot?: string | null;
}

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function createVoiceprint(options: ElectronVoiceprintOptions): VoiceprintHost {
  const platform = posePlatform();
  const root = options.componentRoot === undefined ? defaultComponentRoot() : options.componentRoot;
  const others = platform && root ? [path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform), path.join(root, 'asr', `asr-v${ASR_COMPONENT_VERSION}`, platform),
    path.join(root, 'semantic', `semantic-v${SEMANTIC_COMPONENT_VERSION}`, platform), path.join(root, 'face', `face-v${FACE_COMPONENT_VERSION}`, platform)] : [];
  const store = platform && root ? new PoseComponentStore({ root: path.join(root, 'voiceprint'), platform, manifest: VOICEPRINT_MANIFEST, component: 'voiceprint',
    fetch: approvedFetch(net.fetch as unknown as FetchLike), licenseDir: path.join(options.directory, VOICEPRINT_BUNDLE.licenses), reuseDirs: () => others }) : null;
  const fork = (): VoiceprintWorkerHandle => {
    const child = utilityProcess.fork(path.join(options.directory, VOICEPRINT_BUNDLE.worker), [], { serviceName: 'soft hearts voiceprint', stdio: 'ignore', env: workerEnvironment() });
    return { postMessage: message => child.postMessage(message), onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); }, kill: () => { child.kill(); } };
  };
  return new VoiceprintHost({ store, fork, publish: options.publish, threads: 1, data: new VoiceprintDataStore(options.profileDirectory, options.secret),
    sharedRuntime: () => others.some(dir => existsSync(path.join(dir, 'installed.json'))) });
}

type HostRegistrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

/**
 * Control-window IPC (main.ts's `host()` checks the sender is the control window). Every reply is the fixed-shape view; no path,
 * vector, score or sound ever leaves the host. Not part of the agent channel.
 */
export function registerVoiceprintControls(host: HostRegistrar, voiceprint: () => VoiceprintHost | null): void {
  const required = () => { const value = voiceprint(); if (!value) throw new Error('只认你的声音还没准备好。'); return value; };
  host('getVoiceprint', () => required().view());
  host('setVoiceprint', (on: unknown) => { if (typeof on !== 'boolean') throw new Error('开关值不正确。'); return required().setEnabled(on); });
  host('retryVoiceprintDownload', () => required().download());
  host('cancelVoiceprintDownload', () => { required().cancelDownload(); return required().view(); });
  host('startVoiceprintEnrol', () => required().startEnrol());
  host('cancelVoiceprintEnrol', () => required().cancelEnrol());
  host('deleteVoiceprint', () => required().deleteData());
  host('removeVoiceprintComponent', () => required().removeComponent());
}
