/**
 * Which material is "the main eye surface" for the procedural blush's measured eye spacing (procedural-blush.ts visibleEyes).
 * Lower is better; -1: not an eye material. Only exact, explicit names count, never arbitrary atlas or effect layers
 * (a "FaceEyeline" or "EyeHighlight" layer is not one).
 *
 * - MMD names: 目 (Gene's), then 瞳 / iris / pupil, then 眼 / eye / 白目.
 * - VRoid names (a VRM converted to PMX, or a VRoid PMX export): `<model>_EyeIris_00_EYE` and `<model>_EyeWhite_00_EYE`, with a
 *   layer number between. The iris wins over the white, as 瞳 wins over 眼. Added because on such a model the eye bones sit
 *   at about a third of the real eye spacing, so without the eye surface the cheeks land under the nose (docs/claude/2026-11-19-mumi-pmx-face.md).
 */
export function eyeMaterialPriority(rawName: string): number {
  const name = rawName.normalize('NFKC').trim().toLowerCase();
  // ui-zh-ok: PMX material names, not interface text
  if (name === '目') return 0;
  // ui-zh-ok: PMX material names, not interface text
  if (/^(?:瞳|瞳孔|虹彩|iris|pupils?)$/.test(name)) return 1;
  if (/(?:^|_)eyeiris(?:_\d+)?(?:_eye)?$/.test(name)) return 1;
  // ui-zh-ok: PMX material names, not interface text
  if (/^(?:眼|眼睛|白目|eyes?)$/.test(name)) return 2;
  if (/(?:^|_)eyewhite(?:_\d+)?(?:_eye)?$/.test(name)) return 2;
  return -1;
}
