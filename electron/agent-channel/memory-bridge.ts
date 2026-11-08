// I-014 回收站: the agent channel's delete_memories / restore_memories / list_recycle_bin and the panel's 「找回」 on top of
// electron/recoverable-forget.ts. main.ts supplies the stores and `change`, which runs each step on the host's mutation
// queue and takes care of a character whose chat is live (her turns stop, a fresh conversation starts after a forget).
// No Electron import.
import type { AgentRecyclePart } from '../../shared/agent-channel';
import type { MemoryRecycleBin } from '../memory-recycle-bin';
import { forgetRecoverably, restoreRecoverably, type RecoverableForgetPorts } from '../recoverable-forget';
import type { AgentMemoryBridge } from './app-tools';
import { AgentToolError, type AgentCommitGuard } from './registry';

export interface RecoverableMemoryWiring {
  providerScopes(): string[];
  chat(): RecoverableForgetPorts['chat'];
  profiles(): RecoverableForgetPorts['profiles'];
  /** I-048: her watch notes ride in the chat entry (electron/recoverable-forget.ts). */
  watch?(): RecoverableForgetPorts['watch'];
  /** Runs `run` on the host's mutation queue (re-checking `guard` when its turn comes). */
  change<T>(characterId: string, parts: readonly AgentRecyclePart[], mode: 'forget' | 'restore', guard: AgentCommitGuard, run: () => Promise<T>): Promise<T>;
}

export function createMemoryBridge(bin: MemoryRecycleBin, wiring: RecoverableMemoryWiring): AgentMemoryBridge {
  const ports = (): RecoverableForgetPorts => ({ providerScopes: () => wiring.providerScopes(), chat: wiring.chat(), profiles: wiring.profiles(), bin, watch: wiring.watch?.() });
  return {
    forget: (characterId, characterName, parts, guard) =>
      wiring.change(characterId, parts, 'forget', guard, () => { guard(); return forgetRecoverably(characterId, characterName, parts, ports()); }),
    restore: (entryId, guard) => {
      const entry = bin.summaries().find(item => item.id === entryId);
      if (!entry) return Promise.reject(new AgentToolError('unavailable', '回收站里没有这一项（可能已经找回或到期清理了）。'));
      return wiring.change(entry.characterId, [entry.part], 'restore', guard, () => { guard(); return restoreRecoverably(entryId, ports()); });
    },
    list: () => bin.summaries(),
    days: () => bin.retentionDays,
    setDays: (days, guard) => { guard(); return bin.setRetentionDays(days); },
  };
}
