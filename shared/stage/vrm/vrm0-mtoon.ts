/**
 * VRM 0.x MToon materials → the VRM 1.0 MToon extension (VRMC_materials_mtoon), so one MToon loader shows both (I-152 step 1; the
 * user agreed to show 0.x models in step 1). VRM 0.x keeps each MToon material's Unity shader properties in
 * extensions.VRM.materialProperties; this writes the equivalent 1.0 material definition into the glTF JSON before the materials
 * are read. Our own translation of the two published specifications (vrm-c/vrm-specification: 0.x materialProperties, 1.0
 * VRMC_materials_mtoon and its migration notes); nothing copied. Pure JSON in, JSON out: the input object is changed in place.
 *
 * Only "VRM/MToon" materials are translated. The 0.x unlit shaders (VRM/UnlitTexture …) already carry a glTF material with
 * KHR_materials_unlit, which the glTF loader shows as it is.
 */

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;
const num = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const vec4 = (value: unknown, fallback: [number, number, number, number]): [number, number, number, number] =>
  Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(v => typeof v === 'number' && Number.isFinite(v)) ? [value[0], value[1], value[2], value[3]] : fallback;
/** 0.x colours are gamma (sRGB) values; 1.0 factors are linear. */
const linear = (value: number) => Math.pow(Math.max(0, value), 2.2);
const linearRgb = (color: readonly number[]): [number, number, number] => [linear(color[0]), linear(color[1]), linear(color[2])];
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export interface Vrm0MtoonResult { translated: number; skipped: number }

/** Translates every 0.x MToon material of `json` (a parsed glTF with extensions.VRM) in place. */
export function translateVrm0Materials(json: Obj): Vrm0MtoonResult {
  const vrm = obj(obj(json.extensions)?.VRM);
  const materials = Array.isArray(json.materials) ? json.materials as unknown[] : [];
  const properties = Array.isArray(vrm?.materialProperties) ? vrm!.materialProperties as unknown[] : [];
  const textureCount = Array.isArray(json.textures) ? json.textures.length : 0;
  let translated = 0, skipped = 0;
  for (const value of properties) {
    const property = obj(value);
    if (!property || property.shader !== 'VRM/MToon') { skipped++; continue; }
    const index = materials.findIndex(material => obj(material)?.name === property.name);
    if (index < 0) { skipped++; continue; }
    const floats = obj(property.floatProperties) ?? {}, vectors = obj(property.vectorProperties) ?? {}, textures = obj(property.textureProperties) ?? {};
    const texture = (key: string, extra: Obj = {}): Obj | undefined => {
      const at = textures[key];
      return Number.isInteger(at) && (at as number) >= 0 && (at as number) < textureCount ? { index: at, ...extra } : undefined;
    };
    // _MainTex's Unity scale/offset (x, y, z, w = scaleX, scaleY, offsetX, offsetY) applies to every texture: KHR_texture_transform.
    const st = vec4(vectors._MainTex, [1, 1, 0, 0]);
    const transform: Obj = st[0] !== 1 || st[1] !== 1 || st[2] !== 0 || st[3] !== 0
      ? { extensions: { KHR_texture_transform: { offset: [st[2], st[3]], scale: [st[0], st[1]] } } } : {};
    const withTransform = (key: string, extra: Obj = {}) => texture(key, { ...transform, ...extra });

    const blendMode = num(floats._BlendMode, 0); // 0 opaque, 1 cutout, 2 transparent, 3 transparent with z-write
    const transparent = blendMode === 2 || blendMode === 3, cutout = blendMode === 1;
    const color = vec4(vectors._Color, [1, 1, 1, 1]);
    const shadeShift = num(floats._ShadeShift, 0), shadeToony = num(floats._ShadeToony, 0.9);
    // 1.0's shading shift and toony factors from 0.x's (the specification's migration formulas).
    const shadingToonyFactor = clamp01(shadeToony + (1 - shadeToony) * (0.5 + 0.5 * shadeShift));
    const shadingShiftFactor = -shadeShift - (1 - shadingToonyFactor);
    const outlineMode = num(floats._OutlineWidthMode, 0);
    const outlineWidthMode = outlineMode === 1 ? 'worldCoordinates' : outlineMode === 2 ? 'screenCoordinates' : 'none';
    // 0.x world outline widths are centimetres; screen widths are a percentage of half the screen height.
    const outlineWidthFactor = outlineMode === 1 ? num(floats._OutlineWidth, 0) * 0.01 : outlineMode === 2 ? num(floats._OutlineWidth, 0) * 0.005 : 0;
    const renderQueue = num(property.renderQueue, transparent ? 3000 : 2000);
    const mtoon: Obj = {
      specVersion: '1.0',
      transparentWithZWrite: blendMode === 3,
      renderQueueOffsetNumber: transparent ? Math.max(-9, Math.min(9, Math.round(renderQueue - 3000))) : 0,
      shadeColorFactor: linearRgb(vec4(vectors._ShadeColor, [0.97, 0.81, 0.86, 1])),
      ...(texture('_ShadeTexture') ? { shadeMultiplyTexture: withTransform('_ShadeTexture') } : {}),
      shadingShiftFactor, shadingToonyFactor,
      giEqualizationFactor: clamp01(1 - num(floats._IndirectLightIntensity, 0.1)),
      ...(texture('_SphereAdd') ? { matcapFactor: [1, 1, 1], matcapTexture: texture('_SphereAdd') } : { matcapFactor: [0, 0, 0] }),
      parametricRimColorFactor: linearRgb(vec4(vectors._RimColor, [0, 0, 0, 1])),
      ...(texture('_RimTexture') ? { rimMultiplyTexture: withTransform('_RimTexture') } : {}),
      rimLightingMixFactor: num(floats._RimLightingMix, 0),
      parametricRimFresnelPowerFactor: num(floats._RimFresnelPower, 1),
      parametricRimLiftFactor: num(floats._RimLift, 0),
      outlineWidthMode, outlineWidthFactor,
      ...(texture('_OutlineWidthTexture') ? { outlineWidthMultiplyTexture: withTransform('_OutlineWidthTexture') } : {}),
      outlineColorFactor: linearRgb(vec4(vectors._OutlineColor, [0, 0, 0, 1])),
      outlineLightingMixFactor: num(floats._OutlineColorMode, 0) === 1 ? num(floats._OutlineLightingMix, 1) : 0,
      ...(texture('_UvAnimMaskTexture') ? { uvAnimationMaskTexture: withTransform('_UvAnimMaskTexture') } : {}),
      uvAnimationScrollXSpeedFactor: num(floats._UvAnimScrollX, 0),
      uvAnimationScrollYSpeedFactor: -num(floats._UvAnimScrollY, 0), // Unity's v runs the other way
      uvAnimationRotationSpeedFactor: num(floats._UvAnimRotation, 0),
    };
    const emission = linearRgb(vec4(vectors._EmissionColor, [0, 0, 0, 1]));
    const material: Obj = {
      name: property.name,
      alphaMode: transparent ? 'BLEND' : cutout ? 'MASK' : 'OPAQUE',
      ...(cutout ? { alphaCutoff: num(floats._Cutoff, 0.5) } : {}),
      doubleSided: num(floats._CullMode, 2) === 0,
      pbrMetallicRoughness: { baseColorFactor: [...linearRgb(color), color[3]], ...(texture('_MainTex') ? { baseColorTexture: withTransform('_MainTex') } : {}), metallicFactor: 0, roughnessFactor: 0.9 },
      ...(texture('_BumpMap') ? { normalTexture: withTransform('_BumpMap', { scale: num(floats._BumpScale, 1) }) } : {}),
      emissiveFactor: emission,
      ...(texture('_EmissionMap') ? { emissiveTexture: withTransform('_EmissionMap') } : {}),
      extensions: { VRMC_materials_mtoon: mtoon },
    };
    materials[index] = material;
    translated++;
  }
  if (translated) {
    const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed as unknown[] : (json.extensionsUsed = []) as unknown[];
    for (const name of ['VRMC_materials_mtoon', 'KHR_texture_transform']) if (!used.includes(name)) used.push(name);
  }
  return { translated, skipped };
}
