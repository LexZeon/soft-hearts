// Which connection a memory belongs to: the scope key the chat archive, the user profiles and the voice chat agree on (moved here from
// electron/companion.ts, now electron/brain/companion.ts, which re-exports it; wiring rewrite step 2, docs/claude/2026-11-16-wiring-steps-0-2.md).
import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../shared/foundation/settings';
import { memoryScopeParts } from '../../shared/foundation/memory-connection';

/**
 * I-222: [kind, base URL, model] as before, but the model part is the pinned `provider.memoryModel`, not the chat model
 * (shared/foundation/memory-connection.ts), so choosing a chat model keeps her memory. The hash of an unchanged profile is the same as before.
 */
export function memoryProviderScope(provider: ProviderConfig): string {
  return createHash('sha256').update(JSON.stringify(memoryScopeParts(provider))).digest('hex');
}
