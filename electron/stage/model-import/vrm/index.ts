// VRM → PMX converter (README.md here). Pure: bytes in, PMX bytes + textures + report out; the caller does the file I/O.
export { convertVrmToPmx, CONVERTER_VERSION, type ConversionReport, type ConversionResult, type ConvertOptions } from './convert';
export { VrmImportError } from './glb';
export { MAPPING_VERSION, STAGE_MORPH_NAMES, geneArmDownDeg, mergeMapping, type VrmPmxMapping } from './mapping';
export type { TextureFile } from './materials';
export { standardBoneName } from './skeleton';
