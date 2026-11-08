import type { EmojiId } from './single-emoji';
export interface StickerReference { id:string; png:string; width:number; height:number; }
export interface StickerResult { id:string; intent:EmojiId; png:string; }
export interface StickerAsset { id:string; intent:EmojiId; }
export interface CharacterStickerView {
  connected:boolean; reason:string; phase:'idle'|'reference'|'generating'|'result'|'saved'|'failed';
  reference:StickerReference|null; result:StickerResult|null; saved:StickerAsset[];
}
export interface StickerReferenceChallenge { id:string; modelUrl:string; }
export interface StickerCapture { png:string; modelUrl:string; loadGeneration:number; }
export interface CharacterStickerPorts {
  get():Promise<CharacterStickerView>; prepare():Promise<CharacterStickerView>;
  generate(referenceId:string,intent:EmojiId):Promise<CharacterStickerView>;
  save(resultId:string):Promise<CharacterStickerView>; preview(assetId:string):Promise<boolean>;
  cancel():Promise<CharacterStickerView>; changed(callback:(value:CharacterStickerView)=>void):()=>void;
}
