// 主动's surprise / shy preview (the control window's Gene-only preview lease, electron/initiative/surprise-preview-host.ts), moved from
// electron/main.ts unchanged (wiring rewrite step 5, docs/claude/2026-11-17-wiring-step-5.md): the host, made while electron/main.ts is
// evaluated where it was (wireSurprisePreview), and its three handlers, control window only, registered where they were inside the agent
// channel's recorder (registerSurprisePreview). A closed, hidden, minimized or reloaded control window stops its preview (electron/main.ts
// windowEvents reads `surprisePreviewHost`, this file's live binding).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import { SurprisePreviewHost } from '../initiative';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { bodyModelGeneration, verifyVisualGeneTarget } from './stage-wiring';

/** What the host reads (the part table in electron/main.ts gives getters; read when used). */
export interface SurprisePreviewNeeds {
  readonly store: SettingsStore | undefined;
  readonly controls: BrowserWindow | null;
}

export let surprisePreviewHost: SurprisePreviewHost | undefined;

/** electron/main.ts calls this while it is evaluated, where the host was made. */
export function wireSurprisePreview(needs: SurprisePreviewNeeds): void {
  surprisePreviewHost=new SurprisePreviewHost({
    context:owner=>{
      const { store, controls } = needs; // read when called
      const model=store?.current.model,win=controls;
      if(!model||!win||win.isDestroyed()||win.webContents.id!==owner)return null;
      return {modelKey:JSON.stringify([bodyModelGeneration,model.path,model.url]),modelUrl:model.url,visible:win.isVisible()&&!win.isMinimized()};
    },
    verifyTarget:verifyVisualGeneTarget,
    cancelled:(owner,id)=>{const { controls } = needs; /* read when called */ if(controls&&!controls.isDestroyed()&&controls.webContents.id===owner)controls.webContents.send('desk:surprise-preview-cancelled',{id});},
  });
}

export function registerSurprisePreview(ipc: PartIpc): void {
  const { scopedHost } = ipc;
  scopedHost('beginSurprisePreview',(sender,...args)=>{if(args.length>1||(args.length===1&&args[0]!=='surprise'&&args[0]!=='shy'))throw Error('预览参数不正确。');return surprisePreviewHost!.begin(sender,args[0]);});
  scopedHost('resolveSurprisePreview',(sender,...args)=>{if(args.length!==2)throw Error('预览身份不正确。');return surprisePreviewHost!.resolve(sender,args[0],args[1]);});
  scopedHost('stopSurprisePreview',(sender,...args)=>{if(args.length>1||(args[0]!==undefined&&typeof args[0]!=='string'))throw Error('预览身份不正确。');surprisePreviewHost!.stop(sender,args[0]);});
}
