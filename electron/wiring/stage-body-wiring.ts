// 舞台's wiring, her body (split from electron/wiring/stage-wiring.ts, docs/claude/2026-11-17-split-stage-wiring.md; the lines moved from
// electron/main.ts in step 4g, docs/claude/2026-11-16-wiring-step-4g.md). The statements are the ones main.ts had.
// - The body model generation: another body model (or the companion's page reloaded) makes every receipt and preview for the old one stale
//   (bumpBodyModelGeneration, syncBodyModel); another motion selection stops previews (syncBodySelection).
// - The Gene receipt (verifyVisualGeneTarget, verifyModelTarget) and the body pose in the published mood view (withBodyPose: only with a
//   current receipt, never a retired cue, never while an edit is being saved).
// - Personalize visual (brow / eye, expressions) and body authoring, their per-card stores (ready-chain steps) and their handlers
//   (registerStageAuthoringHandlers, called by stage-wiring.ts's register in the old order): their Claude calls are chat calls, never writable;
//   saving, research and the switches come only from the control window (the authoring hosts check the sender).
// Reads `needs` and the retired cues from stage-wiring.ts as live bindings. No module-level side effects: nothing here runs on import.
import { app, dialog, nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AppSettings } from '../../shared/contracts';
import type { MoodView } from '../../shared/mood';
import { compileCharacterPersona } from '../../shared/cards';
import { bodyPoseBinding, bodyPoseChoices, selectBodyPosePresentation } from '../../shared/stage';
import { VISUAL_GENE_SHA } from '../../shared/stage/personalize-visual';
import { bodyBindingForProfile, PersonalizeBodyAuthoring, PersonalizeBodyStore, PersonalizeVisualAuthoring } from '../stage';
import { streamClaude } from '../brain';
import { chatModelLabel } from '../../shared/brain'; // I-222: 'Opus' for an empty chat model
import { readSelectedVisualImage, VisualBehaviorStore } from '../senses';
import { resolveBehaviorMotionResource } from '../actions';
import type { CharacterCardStore } from '../cards';
import type { SettingsStore } from '../settings';
import { PROFILE_FOLDER } from '../profile';
import type { PartIpc } from './ipc-wiring';
import { windows } from './shell-wiring';
import { visionSupported } from './senses-wiring';
import { blushCalibrations } from './mood-wiring';
import { needs, retiredBodyPoseCues, type StageNeeds } from './stage-wiring';
import { startUnit, startUnitSync } from './parts-wiring';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';


export let visualAuthoring: PersonalizeVisualAuthoring | undefined;
export let visualBehaviors: VisualBehaviorStore | undefined;
export let bodyAuthoring: PersonalizeBodyAuthoring | undefined;
let bodyBehaviors: PersonalizeBodyStore | undefined;
let bodyPosePublishingBlocked = false;
export let visualGeneReceipt: { path:string; url:string; generation:number } | null = null;
/** Another body model (or the companion's page reloaded) makes every receipt and preview for the old one stale. */
export let bodyModelGeneration = 0;
let bodyModelKey = '';
let bodySelectionKey: string | null = null;

/** secureWindow's subscriber (electron/main.ts windowEvents): the companion's page reloaded or its renderer is gone. */
export function bumpBodyModelGeneration(): void {
  bodyModelGeneration++;
}

export function withBodyPose(view:MoodView):MoodView {
  const { store } = needs; // read when called
  const model=store?.current.model,receipt=visualGeneReceipt;
  const profile=bodyBehaviors?.effectiveProfile(view.characterId);
  const verified=!!model&&!!receipt&&receipt.generation===bodyModelGeneration&&receipt.path===model.path&&receipt.url===model.url;
  const binding=verified&&profile?bodyBindingForProfile(bodyPoseBinding(profile.bindingId,VISUAL_GENE_SHA),profile):null;
  const pose=selectBodyPosePresentation(profile,binding,verified?VISUAL_GENE_SHA:null,model?.url??null,view.behavior,Date.now());
  return {...view,bodyPose:pose&&!bodyPosePublishingBlocked&&!retiredBodyPoseCues.has(`${view.token}:${pose.cueId}`)?pose:null};
}
// 设置: sync fans a settings change out to every part, step by step in the order electron/main.ts gives (electron/wiring/
// settings-wiring.ts wireSettingsSync; the wiring golden pins it). The steps are the stage's old lines, unchanged.
/** Sync step (舞台): another body model makes every receipt and preview for the old one stale. */
export function syncBodyModel(s: AppSettings): void {
  const { surprisePreviewHost, companion } = needs; // read when called
  const bodyKey = JSON.stringify([s.model?.path ?? null, s.model?.url ?? null]);
  if (bodyKey !== bodyModelKey) {
    surprisePreviewHost?.invalidate();
    bodyModelGeneration++;
    bodyModelKey = bodyKey;
    visualGeneReceipt = null;
    visualAuthoring?.invalidate();
    bodyAuthoring?.invalidate();
    companion?.mood.cancelBodyPresentation();
  }
}
/** Sync step (舞台): another motion selection stops previews made with the old one. */
export function syncBodySelection(s: AppSettings): void {
  const { surprisePreviewHost, companion } = needs; // read when called
  const bodySelection = JSON.stringify([s.motion?.url ?? null, s.motionLayers ?? null]);
  if (bodySelectionKey !== null && bodySelection !== bodySelectionKey) {surprisePreviewHost?.invalidate();companion?.mood.cancelBodyPresentation();visualAuthoring?.stopPreviews();bodyAuthoring?.stopPreviews();}
  bodySelectionKey = bodySelection;
}
export async function verifyVisualGeneTarget():Promise<boolean> {
  const { store } = needs; // read when called
  const model=store.current.model,generation=bodyModelGeneration;
  if(!model)return false;
  const {path:modelPath,url:modelUrl}=model;
  try { const sha=await blushCalibrations.keyForModel(modelPath);
    if(generation!==bodyModelGeneration||store.current.model?.path!==modelPath||store.current.model.url!==modelUrl)return false;
    visualGeneReceipt={path:modelPath,url:modelUrl,generation};return sha===VISUAL_GENE_SHA; // I-038: the receipt is for any read model; true only on Gene
  }catch{return false;}
}
/** I-038: the current model as a target of Gene-authored picks (pose, brow/eye); its stage maps them onto the model or skips. */
async function verifyModelTarget():Promise<boolean>{const { store } = needs; /* read when called */ await verifyVisualGeneTarget();const m=store.current.model,r=visualGeneReceipt;return !!m&&!!r&&r.generation===bodyModelGeneration&&r.path===m.path&&r.url===m.url;}

// ---- ready-chain steps (electron/main.ts calls each where its lines ran; the wiring golden reads the body in place) ----
/** Ready-chain step: the personalize visual and body stores (per card). */
export async function startPersonalizeStores(store: SettingsStore, characterCards: CharacterCardStore): Promise<void> {
  await startUnit('stage', 'personalize-authoring', async () => { // overhaul step 7: this unit's start, through the part runner
  visualBehaviors = new VisualBehaviorStore(store.directory,()=>characterCards.publicState().cards.map(card=>card.id));
  await visualBehaviors.load();
  bodyBehaviors = new PersonalizeBodyStore(store.directory,()=>characterCards.publicState().cards.map(card=>card.id));
  await bodyBehaviors.load();
  });
}
/** Ready-chain step: personalize visual (brow / eye, expressions) and body authoring; their Claude calls are chat calls, never writable. */
export function startPersonalizeAuthoring(): void {
  startUnitSync('stage', 'personalize-authoring', () => { // overhaul step 7: this unit's start, through the part runner
      visualAuthoring = new PersonalizeVisualAuthoring(visualBehaviors!,{
        context:()=>{ const { store, characterCards, speechScope } = needs; /* read when called */ return ({characterId:characterCards.getActive().id,
          identity:createHash('sha256').update(JSON.stringify([speechScope(),store.current.provider,compileCharacterPersona(characterCards.getActive()),bodyModelGeneration,store.current.model?.url])).digest('hex'),
          codex:store.current.provider.kind==='claude',imageSupported:visionSupported,
          connectionLabel:`${ASSISTANT_NAME} · ${store.current.provider.kind==='claude'?chatModelLabel(store.current.provider.model):`当前未选择${ASSISTANT_NAME}`}`,
          modelUrl:store.current.model?.url??null}); },
        verifyTarget:verifyModelTarget,
        reserve:(owner,id,controller)=>needs.reserveCompanionAuthoring(owner,id,controller,'visual-authoring'),
        chooseImage:async signal=>{
          const { controls } = needs; // read when called
          signal.throwIfAborted();const selection=await dialog.showOpenDialog(controls!,{title:'选择一张用于眉眼研究的静态图片（选择不会发送）',properties:['openFile'],filters:[{name:'静态图片',extensions:['png','jpg','jpeg','webp']}]});
          signal.throwIfAborted();if(selection.canceled||selection.filePaths.length!==1)return null;
          return readSelectedVisualImage(selection.filePaths[0],signal,async(bytes,current)=>{
            current.throwIfAborted();const decoded=nativeImage.createFromBuffer(bytes);if(decoded.isEmpty())throw Error('Invalid selected image');
            const original=decoded.getSize();if(original.width>4096||original.height>4096||original.width*original.height>12_000_000)throw Error('Selected image dimensions');
            const ratio=Math.min(1,1600/Math.max(original.width,original.height));
            const image=ratio<1?decoded.resize({width:Math.max(1,Math.round(original.width*ratio)),height:Math.max(1,Math.round(original.height*ratio)),quality:'good'}):decoded;
            const size=image.getSize(),thumbRatio=Math.min(1,320/Math.max(size.width,size.height));
            const thumb=image.resize({width:Math.max(1,Math.round(size.width*thumbRatio)),height:Math.max(1,Math.round(size.height*thumbRatio)),quality:'good'});
            return {bytes:image.toJPEG(85),width:size.width,height:size.height,thumbnail:thumb.toJPEG(75)};
          });
        },
        stream:async(prompt,imageDataUrl,signal,append)=>{
          const { store } = needs; // read when called
          const provider={...store.current.provider};if(provider.kind!=='claude')throw Error(`Selected-image requires current ${ASSISTANT_NAME}`);
          await streamClaude({kind:'chat',model:provider.model,workingDirectory:path.join(store.directory,'chat'),writable:false,prompt,
            imageDataUrls:[imageDataUrl],imageTemporaryRoot:path.join(app.getPath('temp'),PROFILE_FOLDER,'selected-image-authoring')},signal,(type,text)=>{if(type==='delta')append(text);});
        },
        streamText:async(prompt,signal,append)=>{
          const { store } = needs; // read when called
          const provider={...store.current.provider};if(provider.kind!=='claude')throw Error(`文字组合仅使用当前 ${ASSISTANT_NAME} 连接。`);
          await streamClaude({kind:'chat',model:provider.model,workingDirectory:path.join(store.directory,'chat'),writable:false,prompt,
            imageDataUrls:[]},signal,(type,text)=>{if(type==='delta')append(text);});
        },
        resolvePreview:async preview=>{
          const { motionLibrary, assets } = needs; // read when called
          if(!await verifyModelTarget())throw Error('当前目标尚未通过眉眼内容验证。');
          const resource=await resolveBehaviorMotionResource(motionLibrary,preview.cue),asset=await assets.register(resource.path);
          const {path:_localPath,...metadata}=resource;return {...metadata,url:asset.url};
        },
        previewCancelled:(owner,id,token)=>windows().find(win=>win.webContents.id===owner)?.webContents.send('desk:visual-preview-cancelled',{id,token}),
        changed:id=>needs.companion?.mood.visualBehaviorChanged(id),
      });
      bodyAuthoring = new PersonalizeBodyAuthoring(bodyBehaviors!, {
        context:()=>{ const { store, characterCards, speechScope } = needs; /* read when called */ return ({characterId:characterCards.getActive().id,
          identity:createHash('sha256').update(JSON.stringify([speechScope(),store.current.provider,compileCharacterPersona(characterCards.getActive()),bodyModelGeneration,store.current.model?.url])).digest('hex'),
          codex:store.current.provider.kind==='claude',imageSupported:visionSupported,
          connectionLabel:`${ASSISTANT_NAME} · ${store.current.provider.kind==='claude'?chatModelLabel(store.current.provider.model):`当前未选择${ASSISTANT_NAME}`}`,
          modelUrl:store.current.model?.url??null}); },
        verifyTarget:async()=>await verifyModelTarget()?VISUAL_GENE_SHA:null,
        choices:bodyPoseChoices,binding:bodyPoseBinding,
        reserve:(owner,id,controller)=>needs.reserveCompanionAuthoring(owner,id,controller,'visual-authoring'),
        chooseImage:async signal=>{
          const { controls } = needs; // read when called
          signal.throwIfAborted();const selection=await dialog.showOpenDialog(controls!,{title:'选择一张用于身体姿态观察的静态图片（选择不会发送）',properties:['openFile'],filters:[{name:'静态图片',extensions:['png','jpg','jpeg','webp']}]});
          signal.throwIfAborted();if(selection.canceled||selection.filePaths.length!==1)return null;
          return readSelectedVisualImage(selection.filePaths[0],signal,async(bytes,current)=>{
            current.throwIfAborted();const decoded=nativeImage.createFromBuffer(bytes);if(decoded.isEmpty())throw Error('Invalid selected image');
            const original=decoded.getSize();if(original.width>4096||original.height>4096||original.width*original.height>12_000_000)throw Error('Selected image dimensions');
            const ratio=Math.min(1,1600/Math.max(original.width,original.height));
            const image=ratio<1?decoded.resize({width:Math.max(1,Math.round(original.width*ratio)),height:Math.max(1,Math.round(original.height*ratio)),quality:'good'}):decoded;
            const size=image.getSize(),thumbRatio=Math.min(1,320/Math.max(size.width,size.height));
            const thumb=image.resize({width:Math.max(1,Math.round(size.width*thumbRatio)),height:Math.max(1,Math.round(size.height*thumbRatio)),quality:'good'});
            return {bytes:image.toJPEG(85),width:size.width,height:size.height,thumbnail:thumb.toJPEG(75)};
          });
        },
        stream:async(prompt,imageDataUrl,signal,append)=>{
          const { store } = needs; // read when called
          const provider={...store.current.provider};if(provider.kind!=='claude')throw Error(`Selected-image requires current ${ASSISTANT_NAME}`);
          await streamClaude({kind:'chat',model:provider.model,workingDirectory:path.join(store.directory,'chat'),writable:false,prompt,
            imageDataUrls:[imageDataUrl],imageTemporaryRoot:path.join(app.getPath('temp'),PROFILE_FOLDER,'selected-image-authoring')},signal,(type,text)=>{if(type==='delta')append(text);});
        },
        previewCancelled:(owner,id,token)=>windows().find(win=>win.webContents.id===owner)?.webContents.send('desk:body-preview-cancelled',{id,token}),
        changed:id=>{
          const { companion } = needs; // read when called
          bodyPosePublishingBlocked=true;
          try{const current=companion?.mood.get();
            if(current?.characterId===id){
              for(const cue of [current.behavior?.state,current.behavior?.reaction])if(cue)retiredBodyPoseCues.add(`${current.token}:${cue.id}`);
              while(retiredBodyPoseCues.size>256)retiredBodyPoseCues.delete(retiredBodyPoseCues.values().next().value!);
            }
          }finally{bodyPosePublishingBlocked=false;}
          companion?.mood.bodyPoseChanged(id);
        },
      });
  });
}

/** Personalize visual and body authoring's handlers; stage-wiring.ts's register calls this in their old place, with the `mutate` it read from needs. */
export function registerStageAuthoringHandlers(scopedHost: PartIpc['scopedHost'], mutate: StageNeeds['mutate']): void {
      scopedHost('getVisualAuthoring',(sender,id)=>visualAuthoring!.get(sender,id));
      scopedHost('chooseVisualMaterial',(sender,id,revision)=>visualAuthoring!.choose(sender,id,revision));
      scopedHost('researchVisual',(sender,request)=>visualAuthoring!.research(sender,request));
      scopedHost('researchExpression',(sender,request)=>visualAuthoring!.researchExpression(sender,request));
      scopedHost('editExpression',(sender,request)=>visualAuthoring!.editExpression(sender,request));
      scopedHost('previewExpression',(sender,id,revision)=>visualAuthoring!.previewExpression(sender,id,revision));
      scopedHost('resolveExpressionPreview',(sender,id,token,generation)=>visualAuthoring!.resolveExpressionPreview(sender,id,token,generation));
      scopedHost('previewVisualBinding',(sender,id,revision,selection)=>visualAuthoring!.preview(sender,id,revision,selection));
      scopedHost('visualPreviewReceipt',(sender,request)=>visualAuthoring!.receipt(sender,request));
      scopedHost('resolveVisualPreview',(sender,id,token,generation)=>visualAuthoring!.resolvePreview(sender,id,token,generation));
      scopedHost('saveVisualBehavior',(sender,request)=>mutate(()=>visualAuthoring!.save(sender,request)));
      scopedHost('changeVisualBehavior',(sender,request)=>mutate(()=>visualAuthoring!.change(sender,request)));
      scopedHost('cancelVisualAuthoring',(sender,id)=>visualAuthoring?.close(sender,id));
      scopedHost('getBodyAuthoring',(sender,id)=>bodyAuthoring!.get(sender,id));
      scopedHost('chooseBodyMaterial',(sender,id,revision)=>bodyAuthoring!.choose(sender,id,revision));
      scopedHost('researchBody',(sender,request)=>bodyAuthoring!.research(sender,request));
      scopedHost('discardBodyAdvice',(sender,id,revision)=>bodyAuthoring!.discardAdvice(sender,id,revision));
      scopedHost('consumeBodyAdvice',(sender,id,revision,candidateId,side)=>bodyAuthoring!.consumeAdvice(sender,id,revision,candidateId,side));
      scopedHost('previewBodyBinding',(sender,id,revision,selection)=>bodyAuthoring!.preview(sender,id,revision,selection));
      scopedHost('previewFixedBodyBinding',(sender,id,revision,selection)=>bodyAuthoring!.previewFixed(sender,id,revision,selection));
      scopedHost('bodyPreviewReceipt',(sender,request)=>bodyAuthoring!.receipt(sender,request));
      scopedHost('resolveBodyPreview',(sender,id,token,generation)=>bodyAuthoring!.resolve(sender,id,token,generation));
      scopedHost('saveBodyBehavior',(sender,request)=>mutate(()=>bodyAuthoring!.save(sender,request)));
      scopedHost('changeBodyBehavior',(sender,request)=>mutate(()=>bodyAuthoring!.change(sender,request)));
      scopedHost('cancelBodyAuthoring',(sender,id)=>bodyAuthoring?.close(sender,id));
}
