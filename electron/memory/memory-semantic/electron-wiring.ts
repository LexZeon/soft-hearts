/**
 * Electron glue for "recall by meaning": the real utilityProcess, `net.fetch` for the download the user asked for by turning the switch on,
 * the saved switch, the backfill timer, and the control-window IPC. main.ts only creates this, hands the recall to the notebook and the
 * companion, and registers the IPC.
 */
import { net, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../../foundation/atomic-file';
import { ASR_COMPONENT_VERSION } from '../../senses';
import { PoseComponentStore, defaultComponentRoot, type FetchLike } from '../../senses';
import { POSE_COMPONENT_VERSION, posePlatform } from '../../senses';
import { MEMORY_SEMANTIC_KNOBS } from '../../../shared/memory/memory-semantic/knobs';
import type { SemanticRecallView } from '../../../shared/memory/memory-semantic/view';
import type { MemoryScope } from '../../../shared/memory/memory';
import { SemanticHost, type SemanticWorkerHandle } from './host';
import { SEMANTIC_MANIFEST, SEMANTIC_MODEL_VERSION } from './manifest';
import { SemanticRecall, prefetchWithin, type SemanticArchive } from './recall';
import { VectorStore } from './vectors';

/** What scripts/build-electron.mjs puts next to main.cjs. */
export const SEMANTIC_BUNDLE = Object.freeze({ worker: 'semantic-worker.cjs', licenses: 'semantic-licenses' });
export const SEMANTIC_SETTINGS_FILE = 'memory-semantic.json';

export interface ElectronSemanticOptions {
  /** dist-electron (where semantic-worker.cjs and semantic-licenses/ are). */
  directory: string;
  /** The profile directory (beside memories.jsonl): the saved switch and the vectors live here. */
  profileDirectory: string;
  publish(view: SemanticRecallView): void;
  archive: SemanticArchive & { noteScope(scope: MemoryScope): string };
  currentScope(): MemoryScope | null;
  userBusy(): boolean;
  /** Tests / smoke: a component root other than %LOCALAPPDATA%\soft-hearts-claude\components. */
  componentRoot?: string | null;
}

export interface SemanticParts {
  host: SemanticHost; recall: SemanticRecall; timer: ReturnType<typeof setInterval>;
  /** The user's line -> a vector, waited for at most knobs.pace.prefetchMs; never throws (CompanionService.setSemanticPrefetch). */
  prefetch(text: string): Promise<void>;
}

function workerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

export function createSemantic(options: ElectronSemanticOptions): SemanticParts {
  const platform = posePlatform();
  const root = options.componentRoot === undefined ? defaultComponentRoot() : options.componentRoot;
  const store = platform && root ? new PoseComponentStore({ root: path.join(root, 'semantic'), platform, manifest: SEMANTIC_MANIFEST, component: 'semantic',
    fetch: net.fetch as unknown as FetchLike, licenseDir: path.join(options.directory, SEMANTIC_BUNDLE.licenses),
    // The onnxruntime files are copied from an installed pose-sensing or speech component instead of downloaded again.
    reuseDirs: () => [path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform), path.join(root, 'asr', `asr-v${ASR_COMPONENT_VERSION}`, platform)] }) : null;
  const fork = (): SemanticWorkerHandle => {
    const child = utilityProcess.fork(path.join(options.directory, SEMANTIC_BUNDLE.worker), [], {
      serviceName: 'soft hearts recall by meaning', stdio: 'ignore', env: workerEnvironment() });
    return { postMessage: message => child.postMessage(message), onMessage: listener => { child.on('message', listener); },
      onExit: listener => { child.on('exit', listener); }, kill: () => { child.kill(); } };
  };
  const settingsFile = path.join(options.profileDirectory, SEMANTIC_SETTINGS_FILE);
  const vectors = new VectorStore(options.profileDirectory, SEMANTIC_MODEL_VERSION);
  const sharedDirs = platform && root ? [path.join(root, `pose-v${POSE_COMPONENT_VERSION}`, platform), path.join(root, 'asr', `asr-v${ASR_COMPONENT_VERSION}`, platform)] : [];
  // One memory-heavy-ish process: two threads are plenty for a few short sentences (about 3 ms each on the test ARM64 machine).
  const threads = Math.max(1, Math.min(2, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 4)));
  let recall: SemanticRecall | null = null;
  const host = new SemanticHost({
    store, fork, publish: options.publish, threads, sharedRuntime: () => sharedDirs.some(dir => existsSync(path.join(dir, 'installed.json'))),
    loadEnabled: async () => { try { return (JSON.parse(await readFile(settingsFile, 'utf8')) as { enabled?: unknown }).enabled === true; } catch { return false; } },
    saveEnabled: async on => { await atomicWriteFile(settingsFile, JSON.stringify({ version: 1, enabled: on })); if (!on) recall?.deactivate(); },
    removed: async () => { await recall?.forgetAll(); },
    progress: () => recall?.progress() ?? { indexed: 0, total: 0 },
  });
  recall = new SemanticRecall({
    store: vectors, archive: options.archive, embed: texts => host.embed(texts), active: () => host.ready, busy: options.userBusy,
    current: () => { const scope = options.currentScope(); return scope ? { characterId: scope.characterId, scope: options.archive.noteScope(scope) } : null; },
    changed: () => host.refreshView(),
  });
  // The backfill: nothing happens while the switch is off (`active`), the user is with her, or nothing is missing.
  const timer = setInterval(() => { void recall!.tick().catch(() => undefined); }, Math.max(1, MEMORY_SEMANTIC_KNOBS.pace.tickSeconds) * 1000);
  timer.unref?.();
  return { host, recall, timer, prefetch: text => prefetchWithin(recall!, text, MEMORY_SEMANTIC_KNOBS.pace.prefetchMs) };
}

/** main.ts's entry: a failure here leaves recall by meaning unavailable (recall stays as it was) instead of ending the app. */
export function createSemanticOrNull(options: ElectronSemanticOptions): SemanticParts | null {
  try { return createSemantic(options); }
  catch (error) { console.warn('按意思想起旧事没能建立：', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'); return null; }
}

type HostRegistrar = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;

/** Control-window IPC. Every reply is the fixed-shape view (enums and numbers only); no path ever leaves the host. */
export function registerSemanticControls(host: HostRegistrar, semantic: () => SemanticHost | null): void {
  const required = () => { const value = semantic(); if (!value) throw new Error('按意思想起旧事没能准备好。'); return value; };
  host('getSemanticRecall', () => required().view(), false);
  host('setSemanticRecall', (on: unknown) => required().setEnabled(on === true));
  host('retrySemanticDownload', () => required().download());
  host('cancelSemanticDownload', () => { required().cancelDownload(); });
  host('removeSemanticRecall', () => required().remove());
}
