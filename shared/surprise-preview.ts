/** Closed host-issued identity for one temporary controls-only preview. */
export const SURPRISE_CLIP_ID='original-surprise-offline-001' as const;
export const SURPRISE_REVISION=2 as const;
export const SHY_CLIP_ID='original-shy-offline-001' as const;
export const SHY_REVISION=1 as const;
export const SURPRISE_MODEL_SHA='0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37' as const;
export type ManualEmotionRecipe='surprise'|'shy';
export type SurprisePreviewGrant = {
  id:string;
  targetModelSha:typeof SURPRISE_MODEL_SHA;modelUrl:string;expiresAt:number;
} & ({clipId:typeof SURPRISE_CLIP_ID;revision:typeof SURPRISE_REVISION}|{clipId:typeof SHY_CLIP_ID;revision:typeof SHY_REVISION});
