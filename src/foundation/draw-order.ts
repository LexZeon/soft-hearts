/**
 * Draw order of a model's materials (docs/claude/2026-11-20-mumi-brow-clip.md).
 *
 * An MMD model is drawn material by material in file order, with alpha blending and depth writes and no alpha test (MMDLoader).
 * The order is part of how the model looks: the face skin first, then brows and eye lines on it, then the hair over them. A
 * transparent texel of a brow or a hair strand still writes depth, so whatever is drawn after it and behind it is cut away there.
 *
 * Three keeps that order only by accident: its opaque list sorts by material id, and MMDLoader happens to make the materials in file
 * order. A material swapped in later (the painted blush and the tears put a patched clone of the face skin in its place) has a newer,
 * larger id, so the face skin moved to after the brows and the hair: where a brow quad or a hair strand is see-through, the face
 * behind it was cut away and the desktop showed through (white or black blocks above the eyes).
 *
 * The rule here, for every model and both engines: a material that stands in for another keeps the other's place in the draw
 * order (`keepDrawPlace`), and every renderer that draws her sorts its opaque list by that place (`fileOrderRenderer`). Everything
 * else is three's own opaque sort, unchanged; the transparent list is not touched (its sort never looks at material ids).
 */
import type { Material, WebGLRenderer } from 'three';

const places = new WeakMap<Material, number>();

/** The material's place in the draw order: its own id, or the place of the material it stands in for. */
export function drawPlace(material: Material): number {
  return places.get(material) ?? material.id;
}

/** `stand` (a clone, a patched copy) is drawn where `original` was. Chains: a stand-in for a stand-in keeps the first place. */
export function keepDrawPlace(stand: Material, original: Material): void {
  if (stand !== original) places.set(stand, drawPlace(original));
}

/** The fields of three's render item the opaque sort reads. */
export interface SortableRenderItem { groupOrder: number; renderOrder: number; material: Material; z: number; id: number }

/** Three's painterSortStable (r170), with the material's draw place where three reads the material id. */
export function fileOrderOpaqueSort(a: SortableRenderItem, b: SortableRenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const placeA = drawPlace(a.material), placeB = drawPlace(b.material);
  if (placeA !== placeB) return placeA - placeB;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/** Every WebGLRenderer that may draw her is made through this (tests/draw-order.test.ts checks src/ for it). */
export function fileOrderRenderer<T extends Pick<WebGLRenderer, 'setOpaqueSort'>>(renderer: T): T {
  renderer.setOpaqueSort(fileOrderOpaqueSort as unknown as Parameters<WebGLRenderer['setOpaqueSort']>[0]);
  return renderer;
}
