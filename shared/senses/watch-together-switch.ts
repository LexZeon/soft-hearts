// I-187 和她一起看, one switch: one click turns on the screen AND the dialogue, or (when both
// are on) turns both off. The click is the user's consent for exactly these two, so this module only ever asks the host for:
//   - screen sharing ({ screenSharing }), never the camera or voice input;
//   - the computer's sound with words for watching ({ source: 'system-audio', purpose: 'movie' }), never the microphone and never
//     「和她一起听」's music purpose (it stays the user's own choice; the two share one capture).
// Turning it off stops the dialogue first, so a refused screen change can never leave her hearing (scripts/dev/mutations/senses.json).

import type { RuntimeState } from '../foundation/runtime-state';
import type { SensesDesktopAPI } from './desktop-api';
import type { AudioReadingAck, AudioReadingIntent } from '../voice';
import { watchTogetherPlan } from './watch-together-state';

export type WatchTogetherApi = Pick<SensesDesktopAPI, 'setRuntimeState'> & { setAudioReadingIntent(value: AudioReadingIntent): Promise<AudioReadingAck> };

/** Applies one click. `explain` gets the host's reply to the screen change (a refusal says why); errors are thrown after both tries. */
export async function switchWatchTogether(api: WatchTogetherApi, facts: { screen: boolean; dialogue: boolean },
  explain: (reply: RuntimeState) => void = () => {}): Promise<boolean> {
  const plan = watchTogetherPlan(facts);
  const errors: unknown[] = [];
  const dialogue = async () => {
    if (plan.dialogue === null) return;
    try { await api.setAudioReadingIntent({ source: 'system-audio', purpose: 'movie', enabled: plan.dialogue }); } catch (error) { errors.push(error); }
  };
  const screen = async () => {
    if (plan.screen === null) return;
    try { explain(await api.setRuntimeState({ screenSharing: plan.screen })); } catch (error) { errors.push(error); }
  };
  if (plan.target) { await screen(); await dialogue(); } else { await dialogue(); await screen(); }
  if (errors.length) throw errors[0];
  return plan.target;
}
