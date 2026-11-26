/**
 * Node transforms: each glTF node's world matrix, and its "model" matrix in Three's space for the PMX (VRM 0.x turned 180°
 * about Y so every model faces +Z, then scaled to PMX units).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Glb } from './glb';

export interface SceneNodes {
  names: string[];
  parent: Int32Array;
  /** World matrices in glTF space (metres). */
  world: Matrix4[];
  /** World matrices in the PMX's Three space: facing fixed, scaled to PMX units. */
  model: Matrix4[];
  /** What was applied after `world`: model = toModel · world. */
  toModel: Matrix4;
}

export function sceneNodes(glb: Glb, facing: 1 | -1, unitsPerMeter: number): SceneNodes {
  const nodes = glb.json.nodes ?? [];
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((node, index) => { for (const child of node.children ?? []) if (child >= 0 && child < nodes.length) parent[child] = index; });
  const local = nodes.map(node => {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return new Matrix4().fromArray(node.matrix);
    const t = node.translation ?? [0, 0, 0], r = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
    return new Matrix4().compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]).normalize(), new Vector3(s[0], s[1], s[2]));
  });
  const world: Matrix4[] = new Array(nodes.length);
  const resolve = (index: number, depth: number): Matrix4 => {
    if (world[index]) return world[index];
    if (depth > nodes.length) throw new Error('glTF node hierarchy has a cycle');
    world[index] = parent[index] >= 0 ? resolve(parent[index], depth + 1).clone().multiply(local[index]) : local[index].clone();
    return world[index];
  };
  for (let index = 0; index < nodes.length; index++) resolve(index, 0);
  const toModel = new Matrix4().makeScale(unitsPerMeter, unitsPerMeter, unitsPerMeter);
  if (facing === -1) toModel.multiply(new Matrix4().makeRotationY(Math.PI));
  return { names: nodes.map(node => node.name ?? ''), parent, world, model: world.map(matrix => toModel.clone().multiply(matrix)), toModel };
}

export const originOf = (matrix: Matrix4): Vector3 => new Vector3().setFromMatrixPosition(matrix);
