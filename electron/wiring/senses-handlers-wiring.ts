// 感知's handlers that were still written in electron/main.ts's registerIPC (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md),
// moved unchanged: the offline components' import dialogs (I-001 local pose sensing, I-135 the face check, the local voice recognizer),
// I-016 the developer's listen-kind line and I-077 step 2 the song memory. electron/main.ts calls registerSensesHandlers where those lines
// were, inside the agent channel's recorder (the wiring golden pins the handlers, their flags and what the recorder sees).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { dialog, type BrowserWindow } from 'electron';
import { t } from '../../shared/foundation/ui-language';
import type { ListenKindSource, SongMemoryHost } from '../senses';
import { registerPoseControls } from '../senses/pose/electron-wiring';
import { registerFaceControls } from '../senses/face/electron-wiring'; // I-135 认出"不是你"
import { registerLocalAsrControls } from '../senses/asr/electron-wiring';
import type { PartIpc } from './ipc-wiring';
import { faceCheck, localAsr, poseSensing, type SensesProvides } from './senses-wiring';
import { field, type MemoryProvides } from './memory-wiring';

/** What the handlers read (the part table in electron/main.ts gives getters). */
export interface SensesHandlersNeeds {
  readonly controls: BrowserWindow | null;
  readonly pet: BrowserWindow | null;
  readonly media: SensesProvides['media'];
  mediaChanged: SensesProvides['mediaChanged'];
  readonly listenKind: ListenKindSource;
  readonly songMemory: SongMemoryHost;
  /** 记忆: the songs' clear goes through the recycle bin (I-144). */
  readonly songsBin: MemoryProvides['songsBin'];
}

export function registerSensesHandlers(ipc: PartIpc, needs: SensesHandlersNeeds): void {
  const { host, scopedHost } = ipc;
  // What the handlers read: each is set before the ready chain registers (registerIPC, after both windows exist) and not replaced later;
  // the dialogs' parent window and the voice switch are read when used.
  const { pet, controls, listenKind, songMemory, songsBin } = needs;
  registerPoseControls(host, () => poseSensing, async () => { const r = await dialog.showOpenDialog(needs.controls!, { title: t('导入离线感知组件'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('感知组件'), extensions: ['zip', 'tgz', 'onnx'] }] }); return r.canceled ? [] : r.filePaths; });
  registerFaceControls(host, () => faceCheck?.host ?? null, async () => { const r = await dialog.showOpenDialog(needs.controls!, { title: t('导入离线感知组件'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('感知组件'), extensions: ['onnx', 'zip', 'tgz'] }] }); return r.canceled ? [] : r.filePaths; }); // I-135
  registerLocalAsrControls(host, () => localAsr, async () => { const r = await dialog.showOpenDialog(needs.controls!, { title: t('导入离线识别组件'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('识别组件'), extensions: ['onnx', 'txt', 'tgz'] }] }); return r.canceled ? [] : r.filePaths; },
    () => { const { media, mediaChanged } = needs; /* read when called */ if (!media.state.voiceInput) return; const previous = { ...media.state }; media.update({ voiceInput: false }, media.state.voiceOwner ?? 'controls'); mediaChanged(previous); });
  scopedHost('readListenKind', sender => sender === pet?.webContents.id ? listenKind.panelLine() : '', false); // I-016: the developer line
  scopedHost('songMemory', (sender, request) => controls && sender === controls.webContents.id && field(request, 'op') === 'clear' ? songsBin.clear().then(outcome => ({ cleared: outcome.count })) : songMemory.handle(sender === pet?.webContents.id ? 'pet' : sender === controls?.webContents.id ? 'control' : 'other', request), false); // I-077 step 2
}
