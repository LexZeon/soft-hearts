// 声音's wiring: in a call her reply is read sentence by sentence through the same plan typed chat uses (I-091 step 4,
// electron/voice/voice-call/streaming-speech.ts). Moved out of electron/wiring/voice-wiring.ts unchanged on 2026-11-24 (I-209 stage voice,
// docs/claude/2026-11-24-i209-stage-voice.md: that file stays under the 40 KB limit); the statements are the ones wireVoice had, and what
// they read comes in through `links`, read when called. No module-level side effects.
import { characterTtsConfig, type ReadingCancelBy } from '../../shared/voice';
import { CallStreamingSpeech, characterSpeechPersona, type CompletedReplySpeech } from '../voice';
import type { VoiceCallHost } from '../voice/voice-call/host';
import { callPlaying } from '../voice/voice-call/playing';
import { freezeTurnSpeechStyle, type ReplySpeechStyles } from '../mood';
import type { VoiceNeeds } from './voice-wiring';

export interface CallSpeechLinks {
  needs: Pick<VoiceNeeds, 'store' | 'characterCards' | 'companion' | 'replyRhythm' | 'completedFatigueFeeling'>;
  plan: CompletedReplySpeech;
  styles: ReplySpeechStyles;
  voiceCall: VoiceCallHost;
  /** Her reply reading is still held or queued (replySpeechBusy), and audio still plays (speechPlaybackActivity.busy). */
  holding(): boolean;
  playback(): boolean;
  cancelled(by: ReadingCancelBy): void;
}

export function callStreamingSpeechFor(links: CallSpeechLinks): CallStreamingSpeech {
  const { needs, voiceCall, styles: replySpeechStyles } = links;
  return new CallStreamingSpeech({
    plan: links.plan,
    active: owner => voiceCall.on && voiceCall.controller.owner === owner && needs.store.current.voice.enabled && needs.store.current.provider.kind === 'claude',
    voice: () => ({ provider: characterTtsConfig(needs.store.current, needs.characterCards.getActive()).provider, firstChunk: needs.store.current.voice.firstChunk }),
    freeze: ({ sender, replyId, scope, userText }) => { // the same frozen voice and pace typed chat gives a turn when it accepts it
      const { characterCards, companion, store, replyRhythm, completedFatigueFeeling } = needs; // read when called
      replySpeechStyles.begin(sender, replyId, scope);
      const card = characterCards.getActive();
      freezeTurnSpeechStyle(replySpeechStyles, { owner: sender, replyId, scope, mood: companion.mood.get().snapshot, persona: characterSpeechPersona(card),
        fatigue: completedFatigueFeeling(scope, card.id), config: characterTtsConfig(store.current, card) });
      replyRhythm.freeze(() => ({ replyId, characterId: card.id, snapshot: companion.mood.get().snapshot, fatigue: completedFatigueFeeling(scope, card.id)?.phase ?? null,
        userText, userState: companion.userState.current(card.id)?.state ?? null, developerMode: companion.mood.isDeveloperMode() }));
    },
    started: replyId => voiceCall.noteSpeech(replyId),
    // (the 16:55 cuts): her reading in a call still sounds or is queued (the gate counts it as her speaking), and who cut a reading.
    playing: callPlaying({ call: () => voiceCall.on, holding: () => links.holding(), playback: () => links.playback() }),
    cancelled: by => links.cancelled(by),
  });
}
