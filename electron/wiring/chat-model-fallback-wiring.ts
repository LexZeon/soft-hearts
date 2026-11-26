// I-222 step 4: when Claude Code refuses the
// implied Opus of an empty chat model, the chat model is saved as 跟随 Claude Code 的默认 (electron/brain/chat-model-fallback.ts decides
// when; this saves it). Through the settings mutation queue like any save; the settings store keeps the memory pin, so her memory does
// not move; the windows get the new settings (the settings page then shows the follow choice). Wired by the settings part's register.
// No module-level side effects.
import { chatModelFallbackSettled, followClaudeCodeAfterRefusal, observeChatModelFallback } from '../brain/chat-model-fallback'; // the brain part's own wiring piece (called from the settings part's register)
import type { AppSettings } from '../../shared/foundation/settings';

export interface ChatModelFallbackNeeds {
  store(): { current: AppSettings; persist(next: AppSettings): Promise<unknown> } | undefined;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  /** The settings now in the store, to every window. */
  published(settings: AppSettings): void;
  log(line: string): void;
}

export function wireChatModelFallback(needs: ChatModelFallbackNeeds): void {
  observeChatModelFallback(() => {
    void needs.mutate(async () => {
      const store = needs.store();
      const next = store ? followClaudeCodeAfterRefusal(store.current) : null;
      if (!store || !next) { chatModelFallbackSettled(false); return; }
      await store.persist(next);
      chatModelFallbackSettled(true);
      needs.published(store.current);
      needs.log('chat model: the implied Opus was refused; saved as follow-default (I-222)');
    }).catch(() => { needs.log('chat model: the follow choice could not be saved; this run leaves --model out'); });
  });
}
