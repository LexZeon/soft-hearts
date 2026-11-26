/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md): the face shapes a VRM has no preset for, found on the model's own data. Pure data,
 * read by the native VRM loading (src/stage/model-adapter/vrm.ts) for the engine's standard face (src/unbound/model/).
 *
 * The order a shape is looked for (the loader does it): a VRM expression of that name or one of its aliases (a custom expression such as
 * "cheekPuff"), then a morph target of the meshes by the same names (perfect-sync style faces carry ARKit names), then the VRoid stand-in
 * below (VRoid faces have no such expression; their Fcl_* part shapes make it up). A stand-in is used only when every target in it is on
 * the model; its weights are the bind weights (proportional: a half-closed eye is Fcl_EYE_Close at 0.5, never scaled up).
 *
 * The stand-ins are the VRM → PMX converter's mapping (electron/stage/model-import/vrm/mapping.ts: じと目, mouthPucker, 口角下げ), so a
 * VRoid model shows the same face natively as converted.
 */
import type { MorphSlot, NamedFaceShape } from '../../foundation/universal-skeleton';

export interface VrmFaceMix { readonly target: string; readonly weight: number }

/** Expression slots VRM has no preset for, made from VRoid part shapes. */
export const VRM_SLOT_MIXES: Readonly<Partial<Record<MorphSlot, readonly VrmFaceMix[]>>> = Object.freeze({
  jitome: Object.freeze([{ target: 'Fcl_EYE_Close', weight: 0.5 }]),
  // The う shape with a touch of the small mouth; more Fcl_MTH_Small makes the mouth vanish (the converter's note).
  mouthPucker: Object.freeze([{ target: 'Fcl_MTH_U', weight: 1 }, { target: 'Fcl_MTH_Small', weight: 0.1 }]),
});

/** The named face shapes of her face actions (cheekPuff, tongueOut …) that a VRoid face can make up from its part shapes. */
export const VRM_SHAPE_MIXES: Readonly<Partial<Record<NamedFaceShape, readonly VrmFaceMix[]>>> = Object.freeze({
  mouthCornersDown: Object.freeze([{ target: 'Fcl_MTH_Down', weight: 1 }]),
});
