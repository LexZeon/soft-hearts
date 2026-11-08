// The host steps the agent channel adds on top of the app's own IPC handlers (moved out of
// electron/main.ts so they can be tested). Each change is committed through the host's single
// mutation queue and re-checks the agent call's guard right before it takes effect: a call
// abandoned because the channel closed while it waited (for the queue, for the asset
// registration, for the file read) never commits. A change that already ran stays (X-090,
// semantics). No Electron import here.
import type { AssetRef } from '../../shared/contracts';
import type { CharacterCardState } from '../../shared/character-cards';
import type { CharacterCardUpdateOutcome } from '../../shared/character-card-update';
import type { MutationQueue } from '../mutation-queue';
import type { CommitResult } from './app-tools';
import type { AgentHostWiring } from './bridge';
import type { AgentCommitGuard } from './registry';

type PetBooleanAction = 'pet.set-always-on-top' | 'pet.set-follow-mouse';

/** Closures main.ts already has. None of them queues or guards anything by itself. */
export interface AgentHostActionPorts {
  mutations: MutationQueue;
  /** assets.register: resolves the file and only then grants the renderer its folder; `guard` runs just before that grant. */
  registerAsset(file: string, guard: AgentCommitGuard): Promise<AssetRef>;
  /** Same steps as selectAsset('model'): a new motion-selection generation ... */
  noteModelSelection(): void;
  /** ... then the persisted model with motions cleared (runs inside the queue). */
  persistModel(asset: AssetRef): Promise<void>;
  sync(): void;
  /** main.ts importCharacterCardContent: queues its own change synchronously. */
  importCharacterCard(content: string): Promise<CharacterCardState>;
  /** C3, main.ts updateCharacterCardContent: the in-place update; queues its own change synchronously too. */
  updateCharacterCard?(id: string, content: string, expected: string): Promise<CharacterCardUpdateOutcome>;
  /** The companion command commits (run inside the queue). */
  commitPetBoolean(value: boolean, actionId: PetBooleanAction): Promise<CommitResult>;
  commitReadoutVolume(percent: number): Promise<CommitResult>;
  commitBreath(percent: number): Promise<CommitResult>;
}

export type AgentHostActions = Pick<AgentHostWiring, 'admit' | 'loadModel' | 'importCharacterCard' | 'updateCharacterCard' | 'commitPetBoolean' | 'commitReadoutVolume' | 'commitBreath'>;

export function agentHostActions(ports: AgentHostActionPorts): AgentHostActions {
  const { mutations } = ports;
  return {
    admit: (guard, run) => mutations.guarded(guard, run),
    loadModel: async (file, guard) => {
      const asset = await ports.registerAsset(file, guard);
      guard();
      ports.noteModelSelection();
      await mutations.run(() => ports.persistModel(asset), guard);
      ports.sync();
      return asset;
    },
    importCharacterCard: (content, guard) => mutations.guarded(guard, () => ports.importCharacterCard(content)),
    ...(ports.updateCharacterCard ? {
      updateCharacterCard: (id: string, content: string, expected: string, guard: AgentCommitGuard) =>
        mutations.guarded(guard, () => ports.updateCharacterCard!(id, content, expected)),
    } : {}),
    commitPetBoolean: (value, actionId, guard) => mutations.run(() => ports.commitPetBoolean(value, actionId), guard),
    commitReadoutVolume: (percent, guard) => mutations.run(() => ports.commitReadoutVolume(percent), guard),
    commitBreath: (percent, guard) => mutations.run(() => ports.commitBreath(percent), guard),
  };
}
