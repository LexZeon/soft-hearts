// I-014 回收站: the agent channel's delete_memories / restore_memories / list_recycle_bin and the panel's 「找回」 on top of
// electron/memory/recoverable-forget.ts. main.ts supplies the stores and `change`, which runs each step on the host's mutation
// queue and takes care of a character whose chat is live (her turns stop, a fresh conversation starts after a forget).
// No Electron import.
import type { AgentRecyclePart, AgentRecycleSummary } from '../../../shared/safety/agent-channel';
import type { MemoryRecycleBin } from '../../memory';
import { forgetRecoverably, restoreRecoverably, type RecoverableForgetPorts } from '../../memory/recoverable-forget'; // direct: through ../../memory (the index) this would close an import cycle (docs/claude/2026-11-16-overhaul-parts-2.md)
import type { AgentMemoryBridge } from './app-tools';
import { AgentToolError, type AgentCommitGuard } from './registry';

export interface RecoverableMemoryWiring {
  providerScopes(): string[];
  chat(): RecoverableForgetPorts['chat'];
  profiles(): RecoverableForgetPorts['profiles'];
  /** I-048: her watch notes ride in the chat entry (electron/memory/recoverable-forget.ts). */
  watch?(): RecoverableForgetPorts['watch'];
  /** 边说边演: what describes her replies rides in the chat entry (electron/memory/recoverable-forget.ts). */
  beats?(): RecoverableForgetPorts['beats'];
  /** I-144: her plans, look-backs, her note and the moving memory ride in the profile entry (electron/memory/recycle-wiring.ts). */
  profileExtras?(): RecoverableForgetPorts['profileExtras'];
  /** I-144: an entry of another kind (a deleted character, one note) is found back through the recycle host (electron/memory/recycle-wiring.ts). */
  restoreOther?(entryId: string): Promise<{ restored: AgentRecycleSummary; failed: readonly string[]; replaced: AgentRecycleSummary | null }>;
  /** Runs `run` on the host's mutation queue (re-checking `guard` when its turn comes). */
  change<T>(characterId: string, parts: readonly AgentRecyclePart[], mode: 'forget' | 'restore', guard: AgentCommitGuard, run: () => Promise<T>): Promise<T>;
}

export function createMemoryBridge(bin: MemoryRecycleBin, wiring: RecoverableMemoryWiring): AgentMemoryBridge {
  const ports = (): RecoverableForgetPorts => ({ providerScopes: () => wiring.providerScopes(), chat: wiring.chat(), profiles: wiring.profiles(), bin, watch: wiring.watch?.(), beats: wiring.beats?.(), profileExtras: wiring.profileExtras?.() });
  return {
    forget: (characterId, characterName, parts, guard) =>
      wiring.change(characterId, parts, 'forget', guard, () => { guard(); return forgetRecoverably(characterId, characterName, parts, ports()); }),
    restore: (entryId, guard) => {
      const entry = bin.summaries().find(item => item.id === entryId);
      if (!entry) return Promise.reject(new AgentToolError('unavailable', '回收站里没有这一项（可能已经找回或到期清理了）。'));
      if (entry.part !== 'chat' && entry.part !== 'profile') {
        if (!wiring.restoreOther) return Promise.reject(new AgentToolError('unavailable', '这个版本还不能找回这一种。'));
        try { guard(); } catch (error) { return Promise.reject(error); }
        return wiring.restoreOther(entry.id).then(outcome => {
          if (outcome.failed.length) throw new AgentToolError('unavailable', '有一部分没能找回；回收站里还留着这一项，可以再试一次。');
          return { restored: outcome.restored, count: outcome.restored.count, replaced: outcome.replaced };
        });
      }
      const part = entry.part;
      return wiring.change(entry.characterId, [part], 'restore', guard, () => { guard(); return restoreRecoverably(entryId, ports()); });
    },
    list: () => bin.summaries(),
    days: () => bin.retentionDays,
    setDays: (days, guard) => { guard(); return bin.setRetentionDays(days); },
  };
}
