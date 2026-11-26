// 她主动做的事 (initiative): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type {
  R20ProactiveOfferAcknowledgement, R20ProactiveOfferEvent, R20ProactiveOfferResponse, R20ProactiveOfferResult, R20ProactiveOfferState,
  R20ProactiveOfferView, RpsResponseRequest, RpsThrowRequest, RpsView,
} from '../initiative';

export interface InitiativeDesktopAPI {
  /** Inner loop switch (app setting) and, in developer mode, its last 20 diagnostic lines. */
  /** I-195 her own alarms (the user profile page): see the switch and her waiting alarms, flip the switch, cancel one ('all' = every one). */
  /** I-208: and the archive page's edit or delete of one of her margin notes ('object-note-edit' / 'object-note-delete'): the answer is in `objectNote`. */
  /** I-207: the same channel also carries a card's milestone ('milestone-view' / 'milestone-clear'): the view comes back in `milestone` (null: the card declares none). */
  herAlarms(request: import('../behaviors/alarms/interface').HerAlarmsRequest | import('../cards').CardMilestoneRequest | import('../cards').ObjectNoteRequest): Promise<import('../behaviors/alarms/interface').HerAlarmsView & { milestone?: import('../cards').CardMilestoneView | null; objectNote?: { changed: boolean } }>;
  getInnerLoop(): Promise<import('../initiative').InnerLoopView>;
  setInnerLoop(enabled: boolean): Promise<import('../initiative').InnerLoopView>;
  onInnerLoop(callback: (view: import('../initiative').InnerLoopView) => void): () => void;
  r20ProactiveOfferGet(): Promise<R20ProactiveOfferState>;
  r20ProactiveOfferAcknowledge(input: R20ProactiveOfferAcknowledgement): Promise<R20ProactiveOfferView | null>;
  r20ProactiveOfferRespond(input: R20ProactiveOfferResponse): Promise<R20ProactiveOfferResult>;
  r20ProactiveOfferEvents(callback: (event: R20ProactiveOfferEvent) => void): () => void;
  /** G1 猜拳 (electron/initiative/rps/host.ts): the companion window's game view, the user's hand (one input source), accept / decline / quit. */
  rpsGet(): Promise<RpsView | null>;
  rpsThrow(input: RpsThrowRequest): Promise<string>;
  rpsRespond(input: RpsResponseRequest): Promise<boolean>;
  rpsEvents(callback: (view: RpsView | null) => void): () => void;
  beginSurprisePreview(recipe?:import('../initiative').ManualEmotionRecipe):Promise<import('../initiative').SurprisePreviewGrant>;
  resolveSurprisePreview(id:string,stageGeneration:number):Promise<import('../initiative').SurprisePreviewGrant>;
  stopSurprisePreview(id?:string):Promise<void>;
  onSurprisePreviewCancelled(callback:(value:{id:string})=>void):()=>void;
  /** 「带我去」 (I-051): a tap asks the host to show the control window on one page of a closed set; it changes no setting. */
  takeMeThere(request: import('../initiative').TakeMeThereRequest): Promise<boolean>;
  onTakeMeThere(callback: (view: import('../initiative').TakeMeThereView) => void): () => void;
  /** Control window only: the host asks it to open this page and flash the item. */
  onControlNavigate(callback: (request: import('../initiative').ControlNavigateRequest) => void): () => void;
  /**
   * 她的文件夹 (I-050, electron/initiative/her-folder/): the control page (choose = the native folder dialog, the only way to turn it on;
   * the renderer never sends a path), restoring one item by its action id, and the note under her reply whose button only
   * shows the folder. Nothing here reads or runs a file.
   */
  getHerFolder(): Promise<import('../initiative').HerFolderView>;
  chooseHerFolder(): Promise<import('../initiative').HerFolderView>;
  turnOffHerFolder(): Promise<import('../initiative').HerFolderView>;
  restoreHerFolderItem(actionId: string): Promise<import('../initiative').HerFolderView>;
  openHerFolder(): Promise<boolean>;
  openHerFolderFromNote(request: { noteId: string }): Promise<boolean>;
  onHerFolder(callback: (view: import('../initiative').HerFolderView) => void): () => void;
  onHerFolderNote(callback: (view: import('../initiative').HerFolderNoteView) => void): () => void;
  /**
   * I-086 她也照顾你 (electron/initiative/give/): the companion window hears her offers and picture cards (desk:give), answers once per offer (taken /
   * not taken / interrupted), hands over the one picture rendered from her own stage, and asks to save a picture (the host opens the
   * native save dialog; the renderer never sends a path). The control window's "我们的小东西" page reads, shows and deletes records.
   */
  onGive(callback: (event: import('../initiative').GiveEvent) => void): () => void;
  /** I-085 step 4a (electron/initiative/self-look/): she really looked at you herself; the companion window lights its little eye mark for a moment (no content). */
  onSelfLook(callback: () => void): () => void;
  giveAnswer(answer: import('../initiative').GiveAnswer): Promise<boolean>;
  givePicture(input: { id: string; png: string }): Promise<boolean>;
  saveGivePicture(input: { id: string }): Promise<boolean>;
  /**
   * I-087 牵手、拉钩、击掌 (electron/initiative/hands/): the companion window hears her reaches (desk:hands: offer / cancel), answers each one (taken, then
   * for a hold let go; not taken; interrupted), and may say the mouse rested near her ({ use: 'hold' }; the host decides by mood).
   */
  onHands(callback: (event: import('../initiative').HandsEvent) => void): () => void;
  handsAnswer(answer: import('../initiative').HandsAnswer): Promise<boolean>;
  handsRequest(request: import('../initiative').HandsRequest): Promise<boolean>;
  getOurThings(): Promise<import('../initiative').OurThingsView>;
  ourThingPicture(id: string): Promise<string | null>;
  removeOurThing(id: string): Promise<import('../initiative').OurThingsView>;
  onOurThings(callback: (view: import('../initiative').OurThingsView) => void): () => void;
}
