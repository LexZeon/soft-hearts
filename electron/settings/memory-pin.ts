// I-222: the pin that keeps her memory where it is when the chat model changes (shared/foundation/memory-connection.ts says what it is).
// Owned by the settings store (electron/settings/settings.ts):
// - load: a settings.json that has `provider.memoryModel` keeps it; one saved before 0.2.0 gets the model its memory is filed under today
//   (what validateProvider makes of the stored provider, exactly what memoryProviderScope hashed before), written back into the file
//   at once, before any window or the internal channel can save a new chat model;
// - every save (windows, the channel's chat_model, 恢复默认设置, any host write): the pin the store holds, whatever the new value says.
// A backup restored as files brings its own pin with its memories; the character-card export never carries settings.
import { validateProvider } from './validation';
import type { AppSettings } from '../../shared/foundation/settings';

/** The pin a stored settings.json provider has (`fresh`: it had none and this is the one it gets now). */
export function storedMemoryPin(rawProvider: unknown): { model: string; fresh: boolean } {
  const provider = rawProvider && typeof rawProvider === 'object' && !Array.isArray(rawProvider) ? rawProvider as Record<string, unknown> : {};
  if (typeof provider.memoryModel === 'string') return { model: provider.memoryModel.slice(0, 200).trim(), fresh: false };
  return { model: validateProvider(rawProvider).model, fresh: true };
}

/** The stored file with the pin added and nothing else changed (written once, right after the first load that pinned it). */
export function withStoredMemoryPin(raw: Record<string, unknown>, model: string): Record<string, unknown> {
  const provider = raw.provider && typeof raw.provider === 'object' && !Array.isArray(raw.provider) ? raw.provider as Record<string, unknown> : {};
  return { ...raw, provider: { ...provider, memoryModel: model } };
}

/** `next` with the store's pin, whatever `next` carries (a save can change the chat model, never where her memory is filed). */
export function keepMemoryPin(next: AppSettings, current: AppSettings): AppSettings {
  const pin = typeof current.provider.memoryModel === 'string' ? current.provider.memoryModel : current.provider.model;
  return next.provider.memoryModel === pin ? next : { ...next, provider: { ...next.provider, memoryModel: pin } };
}
