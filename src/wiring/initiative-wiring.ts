// Renderer wiring, 她主动做的事: cards and notes under her reply, test notes, the host's stage cues, text memorials, her games and gestures on the companion and R20's offer (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText } from '../foundation/ui-language';
import { HerFolderNotes } from '../initiative'; // I-050 她的文件夹
import { ChatSettingCards } from '../brain';
import { TakeMeThereOffers, takeMeThereLeaf, takeMeThereFocusElement, flashTarget } from '../initiative';
import { ProactiveAgentOffer } from '../initiative';
import { RpsOverlay, petSayPorts, shownRects } from '../initiative';
import { FeedSnackClient } from '../initiative';
import { FeedLinePresenter } from '../initiative';
import { readSenseLineMessage } from '../../shared/senses';
import { GiveOverlay } from '../initiative'; // I-086
import { SelfLookMark } from '../initiative'; // I-085 step 4a: the little eye when she looks at you herself
import { HandsOverlay } from '../initiative'; // I-087 牵手、拉钩、击掌
import { SafetyCard } from '../safety'; // I-117 the help card outside her role, and 所在地区（求助信息用）
import { trimReplyHistory } from '../brain';
import { TestCommandNotes } from '../safety';
import { $, app, isPet, notify } from './shell-wiring';
import { controlNavigation, settings } from './settings-wiring';
import { composing, stage } from './stage-wiring';
import { heldLines, speech, voicePlaybackActive } from './voice-wiring';
import { activeChat, history, hostVisible, ordinaryReplyPresentation, rememberInitiative, setHistory } from './chat-wiring';
import { replyPresentation } from './chat-view-wiring';
import { petUI } from './pet-window-wiring';
import { characterPage } from './control-window-wiring'; // I-173: a card's 「更多」 for open_control_page
export let r20ProactiveOfferUI: ProactiveAgentOffer | null = null;
export let rpsOverlay: RpsOverlay | null = null; // G1 猜拳 (companion window only)
export let giveOverlay: GiveOverlay | null = null; // I-086 她也照顾你 (companion window only)
export let handsOverlay: HandsOverlay | null = null; // I-087 牵手、拉钩、击掌 (companion window only)
export let feedSnacks: FeedSnackClient | null = null; // I-019 喂食认图: the accepted snack's picture (companion window only)
export let testNotes: TestCommandNotes | null = null; // D2 developer test commands: the note lines under "测试：…"
/** Cards and notes under her reply, test notes, and the stage cues the host sends (reactions: companion only). */
export function wireReplyExtras(): void {
  // R41 chat settings card: plain host data → DOM (textContent only); a tap goes back to the host.
  const chatSettingCards = new ChatSettingCards({ choose: request => window.desktop.chooseChatSetting(request), error: message => notify(message, true),
    container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet, settledLifetimeMs: isPet ? 5_000 : undefined }); // R46: readable 5 s, then fades
  window.desktop.onChatSettingCard(card => chatSettingCards.present(card));
  // I-051 take-me-there: a button under her reply that only opens a control-window page (a closed set of ids; the host decides).
  const takeMeThereOffers = new TakeMeThereOffers({ go: request => window.desktop.takeMeThere(request), error: message => notify(message, true),
    container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet });
  window.desktop.onTakeMeThere(view => takeMeThereOffers.present(view));
  // I-050 her folder: a small note under her reply (what she put there) with a button that only shows the folder.
  const herFolderNotes = new HerFolderNotes({ open: request => window.desktop.openHerFolderFromNote(request), error: message => notify(message, true),
    container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet });
  window.desktop.onHerFolderNote(view => herFolderNotes.present(view));
  if (!isPet) window.desktop.onControlNavigate(request => {
    const leaf = takeMeThereLeaf(request?.destination);
    if (!leaf) return;
    controlNavigation?.navigate(leaf.page, leaf.target); // Reveals the page; never invokes anything.
    // I-173: an item named by the request (an element id; a card's 「更多」) is scrolled to and flashed; otherwise the page's own section.
    const named = !!(request?.anchor || request?.character);
    void takeMeThereFocusElement(request, leaf.target, { byId: id => document.getElementById(id), revealCardMenu: id => characterPage?.revealCardMenu(id) ?? Promise.resolve(null) })
      .then(element => { if (named) element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); flashTarget(element); });
  });
  testNotes = new TestCommandNotes({ container: () => isPet ? document.querySelector<HTMLElement>('.pet-chat') : $('messages'), prepend: isPet, lifetimeMs: isPet ? 15_000 : undefined });
  window.desktop.onTestNote(note => testNotes?.note(note));
  window.desktop.onTestEffect(effect => { if (effect === 'music-rejudge') stage?.rejudgeMusicNow(); }); // D2: a closed set of stage requests
  window.desktop.onExpressionPreview(recipe => { stage?.playExpression(recipe); }); // E1: every window's stage plays 惊喜 / 害羞 on its own model
  window.desktop.onHerAction(cue => { void stage?.playHerAction(cue); }); // 她的动作 (T-211): every window's stage; the companion answers the host
  if (isPet) window.desktop.onReaction(cue => { const id = (cue as { id?: unknown } | null)?.id, result = stage?.playReaction(cue) ?? 'unsupported'; if (typeof id === 'string') void window.desktop.reactionResult({ id, result }).catch(() => {}); }); // I-037: a reaction cue (the shy show); the stage decides, never restarts a running show
}
/** Her games and gestures on the companion (rps, give, self-look, hands, feeding lines) and the help card (both windows). */
export function mountPetOverlays(): void {
  // no-pet-ok: the selector below is the id of PetUI's answer bubble element
  if (isPet) { rpsOverlay = new RpsOverlay(app, window.desktop, { stage, avoid: () => shownRects(document.querySelectorAll('#pet-answer'), app.getBoundingClientRect()), say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, // G1: her game lines in the ordinary bubble and voice
    free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) }); void rpsOverlay.init(); }
  if (isPet) { giveOverlay = new GiveOverlay(app, window.desktop, stage, { blocked: () => !hostVisible || document.hidden }); giveOverlay.init(); } // I-086: her offer on the stage, the click target and her picture card
  if (isPet) new SelfLookMark(app, window.desktop, { blocked: () => !hostVisible || document.hidden }).init(); // I-085 step 4a
  new SafetyCard(document, { changed: callback => window.desktop.onSafetyCard(callback), get: () => window.desktop.getSafetyCard(), answer: value => window.desktop.safetyCardAnswer(value) }, isPet ? 'pet' : 'controls'); // I-117: the app's help card outside her role (both windows)
  if (isPet) { handsOverlay = new HandsOverlay(app, window.desktop, stage, { blocked: () => !hostVisible || document.hidden }); handsOverlay.init(); } // I-087: her hand reaching for your mouse, the target on her hand and the pat's emoji hint
  if (isPet) { feedSnacks = new FeedSnackClient(window.desktop); new FeedLinePresenter(window.desktop, { remember: rememberInitiative, // I-019: her line after a recognized feed
    say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) }); }
  if (isPet) new FeedLinePresenter({ onFeedLine: callback => window.desktop.onSenseLine(message => { if (!heldLines.sense(message)) callback(message); }), /* 2026-11-21: out in Unbound the line is in her bubble already; here it is only remembered and read */ feedLineDone: input => window.desktop.senseLineDone(input) }, { remember: rememberInitiative, read: readSenseLineMessage, // I-040: her short line after a look or a listen
    say: petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }) });
}
/** R20: her offer to help with a task, in the chat (both windows). */
export async function mountProactiveOffer(): Promise<void> {
  const r20Root = document.createElement('div'); r20Root.id = 'r20-proactive-offer';
  (isPet ? document.querySelector('.pet-chat') : $('messages').parentElement)?.append(r20Root);
  r20ProactiveOfferUI = new ProactiveAgentOffer(r20Root, window.desktop, {
    isPet,
    publish: async offer => {
      if (!petUI || !hostVisible || activeChat || replyPresentation.readoutPending || ordinaryReplyPresentation
        || voicePlaybackActive || $<HTMLTextAreaElement>('chat-input').value.trim()) throw Error(uiText('当前回复已变化，建议未显示。'));
      petUI.showAnswer(offer.question,true,offer.id);
      await window.desktop.updatePetReply({text:offer.question,state:'streaming'});
    },
    retract: id => { if (isPet) petUI?.hideAnswerFor(id); },
    presented: offer => {
      const at = Date.now();
      history.push({role:'assistant',content:offer.question,
        origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本轮对话的帮助提议']}});
      setHistory(trimReplyHistory(history));
      // The question stays displayed while this purpose-specific ticket awaits an answer.
    },
    error: message => notify(message,true),
  });
  await r20ProactiveOfferUI.init();
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setR20ProactiveOfferUI(value: typeof r20ProactiveOfferUI): void { r20ProactiveOfferUI = value; }
