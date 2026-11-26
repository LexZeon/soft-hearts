// Which connection her memory is filed under (I-222, docs/claude/2026-11-26-chat-model-default.md). Every memory store keeps things
// under { characterId, providerScope }; the scope is a hash of [kind, base URL, model] (electron/foundation/memory-provider-scope.ts).
// Before 0.2.0 that model was the chat model itself, so choosing another chat model moved her to an empty memory. Since 0.2.0 the
// model part is `provider.memoryModel`: pinned once, at the first start after the upgrade, to what the chat model was then (so nobody's
// memory moves), and never changed by choosing a chat model. Kind and base URL stay in the scope as before. Pure, so the windows use it too.
import type { ProviderConfig } from '../foundation/settings';

type ScopeProvider = Pick<ProviderConfig, 'kind' | 'baseUrl' | 'model' | 'memoryModel'>;

/** The model name the memory is filed under: the pin; a provider without one (made before the pin existed) files under its chat model. */
export function memoryScopeModel(provider: Pick<ProviderConfig, 'model' | 'memoryModel'>): string {
  return typeof provider.memoryModel === 'string' ? provider.memoryModel : provider.model;
}

/** What the memory scope hashes, in this order (the order and the base URL's trimming are what every stored scope was made with). */
export function memoryScopeParts(provider: ScopeProvider): [string, string, string] {
  return [provider.kind, provider.baseUrl.trim().replace(/\/$/, ''), memoryScopeModel(provider)];
}

/**
 * A settings change moved her to another memory (the windows then clear the chat page and reset the memory panel). Choosing a chat model
 * never does. A side that has no pin (a window's copy from before it existed) is read with the other side's pin.
 */
export function memoryConnectionChanged(before: ScopeProvider, after: ScopeProvider): boolean {
  const pin = typeof after.memoryModel === 'string' ? after.memoryModel : before.memoryModel;
  const key = (provider: ScopeProvider) => JSON.stringify(memoryScopeParts(typeof provider.memoryModel === 'string' || pin === undefined ? provider : { ...provider, memoryModel: pin }));
  return key(before) !== key(after);
}
