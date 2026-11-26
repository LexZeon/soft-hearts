// Which connection a memory belongs to: the scope key the chat archive, the user profiles and the voice chat agree on (moved here from
// electron/companion.ts, now electron/brain/companion.ts, which re-exports it; wiring rewrite step 2, docs/claude/2026-11-16-wiring-steps-0-2.md).
import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../shared/foundation/settings';

export function memoryProviderScope(provider: ProviderConfig): string {
  return createHash('sha256').update(JSON.stringify([provider.kind, provider.baseUrl.trim().replace(/\/$/, ''), provider.model])).digest('hex');
}
