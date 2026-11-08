import path from 'node:path';
import { HER_LIFE_TABLE, isHerLifeActivity } from '../../shared/her-life';
import type { MoodView } from '../../shared/mood-runtime';
import type { RpsView } from '../../shared/rps';
import { RpsHost, rpsMoodEvent, type RpsCharacterState, type RpsHostOptions } from './host';
import { RpsStore } from './store';
import { RPS_ROUTE } from '../../shared/rps-personality';
import type { RouterDecision } from '../../shared/module-router/interface';
import type { ModuleRouter } from '../module-router/router';

/** The active character as the game sees it, from the mood view (before a chat turn notes the user's return). */
export function rpsCharacterState(view: Pick<MoodView, 'characterId' | 'parameters' | 'snapshot' | 'fatigue' | 'herLife'> | null | undefined, persona: string): RpsCharacterState | null {
  if (!view?.characterId || !persona) return null;
  const activity = isHerLifeActivity(view.herLife?.activity) ? view.herLife!.activity : null;
  return { id: view.characterId, persona, parameters: view.parameters, snapshot: { primary: view.snapshot.primary, values: view.snapshot.values },
    fatigue: view.fatigue?.phase ?? null, herLife: activity, ...(activity && activity !== 'company' ? { herLifeChat: HER_LIFE_TABLE[activity].chat } : {}) };
}

export interface RpsWiring {
  /** The profile folder (rps.json lives there); read when needed. */
  directory(): string;
  mood(): MoodView | null;
  persona(): string;
  /** The pet window is shown and not minimized. */
  visible(): boolean;
  /** The user profile's "允许记录" (UserProfileStore view). */
  recording(): boolean;
  send(view: RpsView | null): void;
  /** CompanionService.mood.event with the character id. */
  moodEvent(event: ReturnType<typeof rpsMoodEvent>, characterId: string): void;
  interacted(characterId: string): void;
  chatBusy(): boolean;
  /** Her voice is still reading a reply (replySpeechBusy() or a playback lease). */
  speaking?(): boolean;
  /** Her words in a game: electron/inner-loop/model.ts quickLineWithClaude (the small model), its text. */
  quick?: RpsHostOptions['quick'];
  available?(): boolean;
  language?(): string;
  /** Freeze the voice style for one of her game lines (main.ts beginInitiativeSpeech for the pet window). */
  speechStyle?(sayId: string): void;
  localDate(ms: number): string;
  journal?: RpsHostOptions['journal'];
  /** I-023 haiku 调度台 (electron/module-router/router.ts): 猜拳 reads its verdict and reports who decided. Omitted: local words only. */
  router?: Pick<ModuleRouter, 'verdict' | 'decided'>;
  /** I-010 互动余额 (CompanionService.budget), read each time; null before the service exists. Omitted: the old fixed rules. */
  budget?: RpsHostOptions['budget'];
}

/** G1 猜拳 for the app: the store and the host, from closures electron/main.ts supplies. */
export function createRps(wiring: RpsWiring) {
  const store = new RpsStore({ file: () => path.join(wiring.directory(), 'rps.json') });
  const host = new RpsHost({ store,
    character: () => rpsCharacterState(wiring.mood(), wiring.persona()),
    visible: wiring.visible, recording: wiring.recording, localDate: wiring.localDate, publish: wiring.send,
    mood: (event, characterId) => wiring.moodEvent(rpsMoodEvent(event), characterId),
    chatBusy: wiring.chatBusy, speaking: wiring.speaking, interacted: wiring.interacted, quick: wiring.quick, available: wiring.available,
    language: wiring.language, speechStyle: wiring.speechStyle, journal: wiring.journal, ...(wiring.budget ? { budget: wiring.budget } : {}),
    ...(wiring.router ? { routed: (id: string) => wiring.router!.verdict(id, RPS_ROUTE.id),
      decided: (id: string, decision: RouterDecision) => wiring.router!.decided(id, RPS_ROUTE.id, decision) } : {}) });
  return { host, store, load: async () => { await store.load(); }, dispose: () => host.dispose() };
}
