// Renderer wiring, 记忆: the user profile (both windows) and the memory panels (control window).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { UserProfilePanel } from '../memory';
import { TextMemorialPanel } from '../memory';
import { AmbientTranscriptHistory } from '../senses';
import { ListenTogetherPanel } from '../senses'; // I-016 一起听
import { MemoryPanel } from '../memory';
import { SemanticRecallPanel } from '../memory'; // I-111 按意思想起旧事
import { $, isPet, notify } from './shell-wiring';
import { characterState } from './cards-wiring';
export let userProfilePanel: UserProfilePanel | null = null;
export const closeProfileForNotice = () => userProfilePanel?.close();
export let ambientTranscriptHistory: AmbientTranscriptHistory | null = null;
export let memoryPanel: MemoryPanel | null = null;
/** The user profile panel and its text memorials (both windows). */
export function mountUserProfile(): void {
  // I-144b 「最近删除的」 only in the control window: the recycle bin's operations are control-only, so in the companion window the
  // list's first read was refused ("请求来源未授权") at every start (found by the 11-17 candidate smoke). The companion gets no list.
  const recycle = isPet ? undefined : window.desktop;
  userProfilePanel = new UserProfilePanel($('user-profile-panel'), $<HTMLButtonElement>('user-profile-toggle'), window.desktop,
    message => notify(message, true), () => { $('notice-detail-panel').hidden = true; }, recycle, () => characterState?.activeId ?? '');
  userProfilePanel.setMemorials(new TextMemorialPanel(window.desktop, () => userProfilePanel?.refreshMemorials(), recycle, () => characterState?.activeId ?? '', message => notify(message, true)));
  if (!isPet) $('user-profile-toggle').onclick = () => userProfilePanel?.toggle();
  $('notice-details').addEventListener('click', closeProfileForNotice);
}
/** Control window only: the memory panels (memories, semantic recall, listen-together notes, recordings). */
export async function mountMemoryPanels(): Promise<void> {
  if (!isPet) {
    memoryPanel = new MemoryPanel($('memory-panel'), {
      list: query => window.desktop.listMemories(query),
      read: (id, query) => window.desktop.readMemory(id, query),
      edit: (id, patch) => window.desktop.editMemory(id, patch),
      remove: id => window.desktop.deleteMemory(id),
      recycle: window.desktop, currentCharacterId: () => characterState?.activeId ?? '',
      note: id => window.desktop.readMemoryNote(id), removeNote: id => window.desktop.deleteMemoryNote(id), // I-021: her note, read only; delete just the note
      config: () => window.desktop.getMemoryConfig(),
      configure: config => window.desktop.setMemoryConfig(config),
      error: message => notify(message, true),
    });
    await memoryPanel.init();
    window.desktop.onMemoryChanged(() => void memoryPanel?.refresh());
    const semanticSection = document.createElement('section'); semanticSection.id = 'semantic-recall'; // I-111: the switch sits under the 聊天记忆 hint, above the search row
    $('memory-panel').insertBefore(semanticSection, $('memory-panel').querySelector('.memory-tools'));
    new SemanticRecallPanel(semanticSection, { get: () => window.desktop.getSemanticRecall(), changed: callback => window.desktop.onSemanticRecall(callback), set: on => window.desktop.setSemanticRecall(on),
      retry: () => window.desktop.retrySemanticDownload(), cancel: () => window.desktop.cancelSemanticDownload(), remove: () => window.desktop.removeSemanticRecall(), error: message => notify(message, true) });
    const listenSection = document.createElement('section'); listenSection.id = 'listen-together-panel'; $('memory-panel').append(listenSection); // I-016: her notes, the raw count and clear
    const listenPanel = new ListenTogetherPanel(listenSection, { view: () => window.desktop.getListenTogetherView(), clearRaw: () => window.desktop.clearListenRaw(), deleteNote: id => window.desktop.deleteListenNote(id), recycle: window.desktop, currentCharacterId: () => characterState?.activeId ?? '', onError: message => notify(message, true), confirm: message => window.confirm(message),
      songs: { count: () => window.desktop.songMemory({ op: 'count' }).then(r => r && 'count' in r ? r.count : 0), clear: () => window.desktop.songMemory({ op: 'clear' }).then(r => r && 'cleared' in r ? r.cleared : 0) } }); // I-077 step 2
    await listenPanel.init(); window.desktop.onListenTogetherChanged(() => void listenPanel.refresh());
    const audioHistory = document.createElement('section'); audioHistory.id = 'ambient-transcript-history';
    $('memory-panel').append(audioHistory);
    ambientTranscriptHistory = new AmbientTranscriptHistory(audioHistory, {
      list: query => window.desktop.listAmbientTranscripts(query), read: id => window.desktop.readAmbientTranscript(id),
      comments: id => window.desktop.readAmbientComments(id), remove: id => window.desktop.deleteAmbientTranscript(id), recycle: window.desktop, currentCharacterId: () => characterState?.activeId ?? '',
      onError: message => notify(message, true),
    });
    await ambientTranscriptHistory.init();
    window.desktop.onAmbientTranscriptChanged(() => void ambientTranscriptHistory?.refresh());
  }
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setUserProfilePanel(value: typeof userProfilePanel): void { userProfilePanel = value; }
