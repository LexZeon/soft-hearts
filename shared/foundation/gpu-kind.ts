/**
 * 显卡有没有用上 (2026-11-24): which graphics
 * chip draws her, in closed words. Pure: shared by the host's start row (electron/foundation/gpu-choice/) and the full-screen page's developer
 * readout (src/unbound/debug-lines.ts). A renderer string, a vendor id or a device list goes in; only a word from these lists comes out, so
 * nothing here can carry a driver path, a serial or a machine name into the journal.
 */

/** hardware: a real graphics chip draws; software: the CPU does (SwiftShader, llvmpipe, Microsoft's basic driver); unknown: no answer. */
export const GPU_KINDS = ['hardware', 'software', 'unknown'] as const;
export type GpuKind = (typeof GPU_KINDS)[number];
export const GPU_VENDORS = ['nvidia', 'amd', 'intel', 'qualcomm', 'apple', 'other'] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

/** PCI vendor ids of the families (Microsoft's basic render driver, 0x1414, is the CPU: it is neither). */
const VENDOR_IDS: Readonly<Record<number, GpuVendor>> = Object.freeze({ 0x10de: 'nvidia', 0x1002: 'amd', 0x1022: 'amd', 0x8086: 'intel', 0x8087: 'intel', 0x5143: 'qualcomm', 0x106b: 'apple' });
const SOFTWARE_VENDOR_IDS: readonly number[] = Object.freeze([0x1414, 0x1ae0]); // Microsoft basic render driver, Google SwiftShader
const SOFTWARE_WORDS = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|\bwarp\b|mesa offscreen|cpu/i;

export const SECOND_CHIP_WORDS = ['yes', 'no', 'unknown'] as const;
export type SecondChip = (typeof SECOND_CHIP_WORDS)[number];
/** The start row's fields ('gpu-start' in the experience journal, shared/stage/smooth-journal.ts checks them): closed words and two flags. */
export interface GpuStartRow { kind: GpuKind; vendor: GpuVendor; secondChip: SecondChip; asked: boolean; fellBack: boolean }

export const vendorOfId = (id: unknown): GpuVendor => (typeof id === 'number' && VENDOR_IDS[id]) || 'other';

/** The vendor family named in a renderer string ("ANGLE (NVIDIA, NVIDIA RTX …, D3D11)"). */
export function vendorOfString(text: unknown): GpuVendor {
  if (typeof text !== 'string') return 'other';
  if (/nvidia|geforce|quadro|\brtx\b/i.test(text)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/i.test(text)) return 'amd';
  if (/qualcomm|adreno/i.test(text)) return 'qualcomm';
  if (/apple/i.test(text)) return 'apple';
  if (/intel/i.test(text)) return 'intel';
  return 'other';
}

/** What a WebGL renderer string says: software when it names a CPU renderer, hardware when it names anything else, unknown when empty. */
export function classifyRenderer(text: unknown): { kind: GpuKind; vendor: GpuVendor } {
  if (typeof text !== 'string' || !text.trim()) return { kind: 'unknown', vendor: 'other' };
  if (SOFTWARE_WORDS.test(text)) return { kind: 'software', vendor: 'other' };
  return { kind: 'hardware', vendor: vendorOfString(text) };
}

/** The part of one entry of app.getGPUInfo('basic').gpuDevice read here. */
export interface GpuDeviceFacts { readonly vendorId?: unknown; readonly deviceString?: unknown }

/**
 * How many real graphics chips the machine lists (a second one means a laptop with a built-in and a separate chip): entries of a known
 * vendor family, not the CPU renderers; null when the list is missing (Electron could not tell).
 */
export function graphicsChips(devices: unknown): number | null {
  if (!Array.isArray(devices)) return null;
  let chips = 0;
  for (const device of devices as GpuDeviceFacts[]) {
    const id = device?.vendorId;
    if (typeof id !== 'number' || SOFTWARE_VENDOR_IDS.includes(id) || !VENDOR_IDS[id]) continue;
    chips++;
  }
  return chips;
}
