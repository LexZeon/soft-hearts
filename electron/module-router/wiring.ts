import { quickLineWithClaude } from '../inner-loop/model';
import { ModuleRouter, type ModuleRouterOptions } from './router';

/** What electron/main.ts supplies: closures read only when needed. */
export interface ModuleRouterWiring {
  /** chatAvailability.isAvailable(). */
  available(): boolean;
  /** The mood view's developer mode. */
  developerMode(): boolean;
  /** companion.mood.moduleRouterChanged(): the developer panel's line. */
  changed?(): void;
  /** Tests only: another small-model call. */
  ask?: ModuleRouterOptions['ask'];
}

/**
 * I-023 haiku 调度台 for the app. Brain interface (docs/claude/brain-interface.md): its one call is
 * electron/inner-loop/model.ts quickLineWithClaude (haiku, no tools, its own system prompt); nothing else here knows Claude.
 */
export function createModuleRouter(wiring: ModuleRouterWiring): ModuleRouter {
  return new ModuleRouter({
    ask: wiring.ask ?? (async (prompt, systemPrompt, signal) => (await quickLineWithClaude(prompt, systemPrompt, signal)).text),
    available: wiring.available, developerMode: wiring.developerMode, changed: wiring.changed,
  });
}
