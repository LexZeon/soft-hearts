// 感知 · 只认你的声音 and listening for her name (Unbound v1 step 3, docs/claude/2026-11-17-unbound-step3.md). The voice-input wiring
// (electron/wiring/senses-voice-input-wiring.ts) gives its VoiceChatHost the two checks made here (`screen` before a clip is recognized,
// `wake` after) and registers the control-window handlers. The voiceprint host is made the first time it is needed (nothing here runs on
// import), reading the profile folder then.
import { safeStorage } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { wakeNames } from '../../shared/memory';
import type { VoiceCallOwner } from '../../shared/voice';
import { createVoiceprint } from '../senses/voiceprint/electron-wiring';
import { listensForName, screenClip, wakeFilter } from '../senses/voiceprint/gate';
import { NAME_CALL_SYSTEM, nameCallPrompt, parseNameCall } from '../senses/voiceprint/name-call';
import { poseConfidenceBand } from '../../shared/senses';
import { quickLineWithClaude } from '../initiative';
import type { VoiceprintHost } from '../senses/voiceprint/host';
import type { MediaRuntime } from '../senses/media-runtime';
import type { VoiceProvides } from './voice-wiring';
import { broadcast } from './shell-wiring';
import { lifeFeeds, noteUserTalked, unbound } from './unbound-wiring';
import type { SensesNeeds } from './senses-wiring';

let host: VoiceprintHost | null | undefined;
/** Run after every change of the voiceprint's view (listening for her name may begin or end). */
const changed: (() => void)[] = [];

/** The voiceprint host (made once, on first use); null when it could not be made. */
export function voiceprint(needs: Pick<SensesNeeds, 'store'>): VoiceprintHost | null {
  if (host !== undefined) return host;
  let ready = false;
  try { ready = !!needs.store?.directory; } catch { ready = false; }
  if (!ready) return null; // before the profile is open: asked again later, nothing cached
  try {
    host = createVoiceprint({ directory: __dirname, profileDirectory: needs.store.directory, secret: safeStorage, publish: view => { broadcast('desk:voiceprint', view); for (const listener of changed) try { listener(); } catch { /* one listener */ } } });
    void host.init().catch(() => undefined);
  } catch { host = null; }
  return host;
}

export interface VoiceprintGateNeeds {
  needs: SensesNeeds;
  /** 看's switches (made after the voice input, so read when used). */
  media(): MediaRuntime;
  voiceCall: VoiceProvides['voiceCall'];
  /** Recognition runs on this computer now (voiceRoute.engine === 'local' and the recognizer is ready). */
  localRecognition(): boolean;
}

/** The two checks for the VoiceChatHost (its `screen` and `wake` ports), and the window listening for her name for the call. */
export function voiceprintGate({ needs, media, voiceCall, localRecognition }: VoiceprintGateNeeds) {
  const asleep = () => { const fatigue = needs.companion?.mood.get().fatigue; return fatigue?.sleeping === true || fatigue?.phase === 'falling-asleep'; };
  // Out: entering counts (her companion window hides then, and that is when the call is told).
  // The conditions themselves: electron/senses/voiceprint/gate.ts listensForName (tested there).
  const listening = (owner: MediaOwner): boolean => listensForName({ out: !!unbound && unbound.state !== 'normal', voiceInput: media().state.voiceInput === true,
    voiceOwner: media().state.voiceOwner, voiceprintActive: !!voiceprint(needs)?.active, localRecognition: localRecognition(), asleep: asleep() }, owner);
  const names = (): string[] => {
    const card = needs.characterCards.getActive(), relationship = needs.companion?.relationship;
    if (relationship && !relationship.herNicknames(card.id).length) void relationship.ensure(card.id);
    return wakeNames({ herName: card.name ?? null, herNicknames: relationship?.herNicknames(card.id) ?? [] });
  };
  const wakeOwner = (): VoiceCallOwner | null => { const owner = media().state.voiceOwner; return !voiceCall.on && owner && listening(owner) ? owner : null; };
  voiceCall.listenForName(wakeOwner);
  changed.push(() => voiceCall.check());
  return {
    screen: (_owner: MediaOwner, wav: ArrayBuffer) => screenClip(voiceprint(needs), wav),
    wake: (owner: MediaOwner, text: string) => wakeFilter({ callOn: () => voiceCall.on, listening, names,
      startCall: async who => { try { return (await voiceCall.called(who)).on === true; } catch { return false; } },
      talkedNotToHer: () => noteUserTalked(), // Unbound step 4: the fact only (electron/wiring/unbound-wiring.ts)
      facingSure: () => { const s = lifeFeeds.pose() as { facing?: unknown; facingConfidence?: number } | null; return !!s && s.facing === 'toward' && poseConfidenceBand(s.facingConfidence) === 'sure'; },
      askCalling: async (name, sentence) => { // afternoon addition D: haiku, only that one sentence (it passed the voiceprint)
        const signal = AbortSignal.timeout(8_000);
        return parseNameCall((await quickLineWithClaude(nameCallPrompt(name, sentence), NAME_CALL_SYSTEM, signal)).text);
      } }, owner, text),
    wakeOwner,
  };
}
