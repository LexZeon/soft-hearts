// Renderer wiring, 角色卡 greeting (2026-11-25, docs/claude/2026-11-25-greeting-on-switch.md): her card's own greeting, shown, read aloud and
// remembered. Moved out of chat-wiring.ts (its showCharacterGreeting keeps the history seed). The showing is src/brain/greeting-presenter.ts;
// whether it is shown at all on a switch or a start is src/brain/greeting-gate.ts (the host's word that she never opened with the user);
// the explicit "new conversation" shows it as the user asked.
import { mayShowOpeningGreeting, presentGreetingLine } from '../brain';
import { isPet } from './shell-wiring'; // no-pet-ok: the companion window flag, exported under this name
import { settings, windowVisibility } from './settings-wiring';
import { speech } from './voice-wiring';
import { addMessage, endReplySpeech } from './chat-view-wiring';
import { characterState } from './cards-wiring';
import { petUI } from './pet-window-wiring'; // no-pet-ok: the companion window's UI object, exported under this name
import { hostVisible, shown } from './chat-wiring';

/** The characters this window greeted already this run (the guard when the host cannot say, the archive being off). */
const greetedThisRun = new Set<string>();

/** On a switch or a start: the host's answer (getRecentChat) says her greeting is due: she never opened with the user, and nothing moved on meanwhile. */
export function openingGreetingFor(recent: Parameters<typeof mayShowOpeningGreeting>[0], requestedFor: string | null): boolean {
  return mayShowOpeningGreeting(recent, requestedFor, characterState?.activeId ?? null, greetedThisRun);
}

/** Her greeting in this window (see presentGreetingLine); the host archives the card's own text and writes one journal row. */
export function presentGreeting(): string | null {
  return presentGreetingLine({
    card: () => characterState?.cards.find(item => item.id === characterState!.activeId) ?? null,
    companionBubble: isPet && petUI ? (text, id, expectsSpeech) => { petUI!.showAnswer(text, true, id); petUI!.finishAnswer(text, id, expectsSpeech, true); } : null, // no-pet-ok: the same two names
    row: text => { addMessage('assistant', text); },
    // Read aloud when she can be heard: the window is shown (or its visibility is not known yet and nothing hides it).
    mayVoice: () => settings.voice.enabled && (shown() || (!hostVisible && windowVisibility.petVisible === null && !document.hidden)), // no-pet-ok: the tracker field is named petVisible
    stopSpeech: () => speech.stop(),
    speak: (text, id) => speech.speak(text, settings.voice, { replyId: id }),
    ended: id => endReplySpeech(id),
    remember: () => { void window.desktop.rememberGreeting?.().catch(() => {}); }, // I-134 new chat: only while new chat is on; once while it is her newest line
    newId: () => `greeting-${crypto.randomUUID()}`,
  }, greetedThisRun);
}
