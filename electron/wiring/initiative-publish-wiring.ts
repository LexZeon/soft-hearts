// 主动's mood-publish steps (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md), moved from electron/main.ts unchanged:
// electron/wiring/mood-wiring.ts publishMood runs every part's step on each new view, in the order electron/main.ts gives
// wireMoodPublish (the wiring golden pins it, order.moodPublish). The steps' lines are the old ones word for word, so what they read
// has the old names here: other parts' live bindings are imported; the two functions only electron/main.ts has (the speech scope from
// 声音, the cue chain's claim from 主动's wire call) are bound by wireInitiativePublish, which main.ts calls before wireMoodPublish.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { MoodView } from '../../shared/mood';
import { claimedView } from '../initiative';
import type { InitiativeProvides } from './initiative-wiring';
import { proactiveSpeechGate, r20ProactiveOffers } from './initiative-wiring';
import { companion } from './brain-wiring';
import { broadcast } from './shell-wiring';
import { ambientComments } from './senses-wiring';
import { withBodyPose } from './stage-wiring';

/** What the steps read that only electron/main.ts has (the part table gives both; each is called when a step runs). */
export interface InitiativePublishNeeds {
  speechScope(): string;
  claimMoodCue: InitiativeProvides['claimMoodCue'];
}
let speechScope!: () => string;
let claimMoodCue!: InitiativeProvides['claimMoodCue'];

export function wireInitiativePublish(needs: InitiativePublishNeeds): void {
  speechScope = () => needs.speechScope();
  claimMoodCue = view => needs.claimMoodCue(view);
}

/** Mood publish step (主动): the proactive-speech gate keeps this context; one that cannot be read cancels it. */
export function publishGateScope(view: MoodView): void {
  try { proactiveSpeechGate.setScope(`${speechScope()}:${view.token}`); } catch { proactiveSpeechGate.cancel('context'); }
}
/** Mood publish step (主动): R20 offers follow her. */
export function publishR20(): void {
  r20ProactiveOffers?.sync();
}
/** Mood publish step (主动, then 舞台 and 感知): her cue gets one owner; the windows and the audio comment engines see the claimed view. */
export function publishCue(view: MoodView): void {
  // One cue, one owner (I-020 #10, I-087): the cue chain takes it (electron/wiring/initiative-wiring.ts CUE_CHAIN: her hand, then the opening choice);
  // the 1-second clock reads who owns it (moodCueOwner).
  const claimant=claimMoodCue(view);
  // The audio comment engines act only on a cue they can see, like the renderer.
  const visibleView=claimedView(view,claimant,companion.mood);
  broadcast('desk:mood',withBodyPose(visibleView)); ambientComments?.observe(visibleView);
}
