import {
  Bone, Camera, Color, Group, Matrix3, Matrix4, ShaderMaterial, SkinnedMesh, Vector2, Vector3,
  type Material,
} from 'three';
import { DEFAULT_BLUSH_CALIBRATION, validateBlushCalibration, type BlushCalibration } from '../../shared/blush';

export type BlushPoint = [number, number, number];
export interface BlushAnchors {
  /** Frozen head-local reference points; eye-ball rotations never move these. */
  leftEye: BlushPoint;
  rightEye: BlushPoint;
  mouth: BlushPoint;
  leftCheek: BlushPoint;
  rightCheek: BlushPoint;
  leftNormal: BlushPoint;
  rightNormal: BlushPoint;
  forward: BlushPoint;
  up: BlushPoint;
  right: BlushPoint;
  eyeDistance: number;
  /** Original bone E remains the unit for every persisted calibration offset. */
  boneEyeDistance: number;
  /** 'model-profile': pinch-only anchors from the model profile's measured eyes and mouth (never used for blush or tears). */
  eyeReference: 'main-eye-geometry' | 'eye-bones' | 'model-profile';
  mouthEstimated: boolean;
  surfaceSource: 'named-face' | 'local-face';
  /** Only the cheek samples' reliable skin material groups may receive the decal. */
  materialIndices: number[];
}
export interface BlushAnchorProbe {
  supported: boolean;
  reason: string;
  anchors: BlushAnchors | null;
  calibration: BlushCalibration;
}
const finitePoint = (point: Vector3) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
const tuple = (point: Vector3): BlushPoint => [point.x, point.y, point.z];
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

interface SurfaceSample { point: Vector3; normal: Vector3 | null; materialIndex: number }
const faceName = (name: string) => /(?:顔|肌|face|skin|脸|膚)/i.test(name.normalize('NFKC'));
const excludedName = (name: string) => /(?:髪|hair|eye|brow|lash|目|眉|睫|blush|cheek|頬|青ざめ|shadow|歯|teeth|舌|tongue|口|lip|mouth)/i.test(name.normalize('NFKC'));
function supportedMaterial(material: Material | undefined): material is ShaderMaterial {
  if (!(material instanceof ShaderMaterial) || excludedName(material.name)) return false;
  return material.opacity > 0.2 && material.vertexShader.includes('#include <common>') && material.vertexShader.includes('#include <displacementmap_vertex>') &&
    material.vertexShader.includes('#include <skinning_vertex>') && material.fragmentShader.includes('#include <common>') &&
    material.fragmentShader.includes('#include <normal_fragment_maps>') && material.fragmentShader.includes('#include <map_fragment>') && material.fragmentShader.includes('vViewPosition');
}

const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) * fraction)];
};
interface VisibleEyes { midpoint: Vector3; spacing: number }
/** Only an explicitly named main eye surface, never arbitrary atlas or effect layers. */
function visibleEyes(mesh: SkinnedMesh, toHead: Matrix4, midpoint: Vector3, right: Vector3, up: Vector3, forward: Vector3, boneDistance: number): VisibleEyes | null {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material], normal = mesh.geometry.getAttribute('normal'), index = mesh.geometry.index;
  if (!normal || normal.itemSize !== 3 || !index) return null;
  const transform = toHead.clone().multiply(mesh.matrixWorld), normalTransform = new Matrix3().getNormalMatrix(transform);
  const candidates: { priority: number; value: VisibleEyes }[] = [];
  for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
    const material = materials[materialIndex], name = material.name.normalize('NFKC').trim().toLowerCase();
    const priority = name === '目' ? 0 : /^(?:瞳|瞳孔|虹彩|iris|pupils?)$/.test(name) ? 1 : /^(?:眼|眼睛|白目|eyes?)$/.test(name) ? 2 : -1;
    if (priority < 0 || material.opacity < 0.9) continue;
    const groups = mesh.geometry.groups.filter(group => group.materialIndex === materialIndex);
    if (!groups.length || groups.reduce((sum, group) => sum + group.count, 0) > 180_000) continue;
    const points = new Map<number, { point: Vector3; side: number; x: number; y: number }>();
    const read = (vertex: number) => {
      if (points.has(vertex)) return points.get(vertex)!;
      const point = mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(transform), delta = point.clone().sub(midpoint);
      const x = delta.dot(right), y = delta.dot(up), z = delta.dot(forward);
      const facing = new Vector3(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)).applyNormalMatrix(normalTransform).dot(forward);
      const side = finitePoint(point) && Math.abs(x) >= boneDistance * 0.15 && Math.abs(x) < boneDistance * 2.5 && Math.abs(y) < boneDistance * 1.1 &&
        z > boneDistance * 0.15 && z < boneDistance * 3 && facing > 0.2 ? x < 0 ? -1 : 1 : 0;
      const value = { point, side, x, y }; points.set(vertex, value); return value;
    };
    const halves = [-1, 1].map(side => {
      let area = 0; const center = new Vector3();
      for (const group of groups) for (let item = group.start; item + 2 < Math.min(index.count, group.start + group.count); item += 3) {
        const a = read(index.getX(item)), b = read(index.getX(item + 1)), c = read(index.getX(item + 2));
        if (a.side !== side || b.side !== side || c.side !== side) continue;
        const weight = Math.abs(b.point.clone().sub(a.point).cross(c.point.clone().sub(a.point)).dot(forward)) * 0.5;
        area += weight; center.addScaledVector(a.point.clone().add(b.point).add(c.point).multiplyScalar(1 / 3), weight);
      }
      const part = [...points.values()].filter(value => value.side === side);
      if (part.length < 12 || area < boneDistance * boneDistance * 0.01) return null;
      center.divideScalar(area);
      const trimmedX = (quantile(part.map(value => value.x), 0.05) + quantile(part.map(value => value.x), 0.95)) / 2;
      const trimmedY = (quantile(part.map(value => value.y), 0.05) + quantile(part.map(value => value.y), 0.95)) / 2;
      const offset = center.clone().sub(midpoint);
      if (Math.abs(offset.dot(right) - trimmedX) > boneDistance * 0.18 || Math.abs(offset.dot(up) - trimmedY) > boneDistance * 0.18) return null;
      return { center, area };
    });
    const [left, rightEye] = halves;
    if (!left || !rightEye || left.area / rightEye.area < 0.5 || left.area / rightEye.area > 2) continue;
    const spacing = rightEye.center.clone().sub(left.center).dot(right);
    const center = left.center.clone().add(rightEye.center).multiplyScalar(0.5), offset = center.clone().sub(midpoint);
    if (spacing < boneDistance * 0.75 || spacing > boneDistance * 3 || Math.abs(offset.dot(right)) > boneDistance * 0.25 || Math.abs(offset.dot(up)) > boneDistance * 0.3) continue;
    candidates.push({ priority, value: { midpoint: center, spacing } });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  if (!candidates.length || candidates.filter(value => value.priority === candidates[0].priority).length !== 1) return null;
  return candidates[0].value;
}

/**
 * I-038: the face's "up" lies in the face plane. Eye references sit at the eye bones or behind the iris, deeper than the
 * mouth on the face surface; left in, that depth difference tilts up (and so forward) and slides every cheek sample along
 * the tilted forward axis toward the eyes. Removes the component along the head's forward axis (in place). A reference
 * pair at one depth (the reviewed Gene: the mouth is estimated straight below the eyes) has none and is left as it is.
 */
export function levelFaceUp(up: Vector3, forward: Vector3): Vector3 {
  const tilt = up.dot(forward);
  if (Math.abs(tilt) > up.length() * 1e-6) up.addScaledVector(forward, -tilt);
  return up;
}

/**
 * Probe once on a loaded rest pose. No texture, screen, camera capture, model mutation or URL.
 * Without a mouth bone, a head-local mouth measured by the model profile (where the
 * open-mouth morph actually moves) is used; only without both is the mouth a ratio estimate.
 * This is not anatomical landmark detection.
 */
export function probeBlushAnchors(
  mesh: SkinnedMesh,
  head: Bone | undefined,
  eyes: readonly Bone[],
  mouthBone?: Bone,
  adjustment: Partial<BlushCalibration> = {},
  profileMouth?: Vector3 | null,
): BlushAnchorProbe {
  let calibration: BlushCalibration;
  try { calibration = validateBlushCalibration({ ...DEFAULT_BLUSH_CALIBRATION, ...adjustment }); }
  catch { return { supported: false, reason: '红晕校准参数不正确', anchors: null, calibration: { ...DEFAULT_BLUSH_CALIBRATION } }; }
  const fail = (reason: string): BlushAnchorProbe => ({ supported: false, reason, anchors: null, calibration });
  if (!head) return fail('程序红晕需要可识别的头骨');
  if (eyes.length < 2 || eyes[0] === eyes[1]) return fail('没有两个独立眼骨；両目控制骨不能代替左右眼定位');
  const position = mesh.geometry.getAttribute('position');
  if (!position || position.itemSize !== 3 || !Number.isSafeInteger(position.count) || position.count < 8 || position.count > 2_000_000) return fail('模型缺少可可靠采样的面部顶点');
  try {
    mesh.updateWorldMatrix(true, true); head.updateWorldMatrix(true, true); mesh.skeleton?.update();
    if (!Number.isFinite(head.matrixWorld.determinant()) || Math.abs(head.matrixWorld.determinant()) < 1e-12) return fail('头部变换不可用于局部定位');
    const worldToHead = head.matrixWorld.clone().invert();
    const local = (bone: Bone) => bone.getWorldPosition(new Vector3()).applyMatrix4(worldToHead);
    const eyePoints = eyes.map(local).filter(finitePoint);
    if (eyePoints.length < 2) return fail('眼骨位置不是有限坐标');
    // Prefer the widest real eye pair, without inventing eye positions from a central control.
    let pair = [eyePoints[0], eyePoints[1]], distance = pair[0].distanceTo(pair[1]);
    for (let a = 0; a < eyePoints.length; a++) for (let b = a + 1; b < eyePoints.length; b++) {
      const next = eyePoints[a].distanceTo(eyePoints[b]); if (next > distance) { distance = next; pair = [eyePoints[a], eyePoints[b]]; }
    }
    if (!Number.isFinite(distance) || distance < 1e-5) return fail('左右眼距不足，无法确定面部尺度');
    pair.sort((a, b) => a.x - b.x);
    const right = pair[1].clone().sub(pair[0]).normalize();
    if (Math.abs(right.y) > 0.55) return fail('眼位过于竖直，需要先校准头部参考');
    const initialUp = new Vector3(0, 1, 0).addScaledVector(right, -right.y).normalize();
    const boneMidpoint = pair[0].clone().add(pair[1]).multiplyScalar(0.5);
    const initialForward = right.clone().cross(initialUp).normalize(); if (initialForward.dot(boneMidpoint) < 0) initialForward.negate();
    // A larger eye reference must not silently switch an unknown face to a
    // nearby named body/skin layer. Establish ownership with the old bone E first.
    const boneReference = boneMidpoint.clone().addScaledVector(right, calibration.eyeOffsetX * distance).addScaledVector(initialUp, calibration.eyeOffsetY * distance);
    const boneLayoutDistance = distance * calibration.eyeSpacingScale;
    const measuredMouth = !mouthBone && profileMouth && finitePoint(profileMouth) ? profileMouth : null;
    const initialMouth = mouthBone ? local(mouthBone) : measuredMouth ? measuredMouth.clone() : boneReference.clone().addScaledVector(initialUp, -boneLayoutDistance * 0.9);
    initialMouth.addScaledVector(right, calibration.mouthOffsetX * distance).addScaledVector(initialUp, calibration.mouthOffsetY * distance);
    const boneCenter = boneReference.clone().lerp(initialMouth, 0.56);
    const initialCheeks = (preferNamed: boolean) => {
      const skin = collectFaceSamples(mesh, worldToHead, boneReference, right, initialUp, initialForward, boneLayoutDistance, preferNamed);
      return { skin, left: sampleCheek(boneCenter.clone().addScaledVector(right, -boneLayoutDistance * 0.54), skin.samples, right, initialUp, initialForward, boneLayoutDistance),
        right: sampleCheek(boneCenter.clone().addScaledVector(right, boneLayoutDistance * 0.54), skin.samples, right, initialUp, initialForward, boneLayoutDistance) };
    };
    let initial = initialCheeks(true);
    // I-038: a named skin material need not be the face (a body "肌"), and a face material may carry no known name. One
    // unnamed material that owns both cheeks is a face too; the eyes drawn on it are measured the same way.
    if ((!initial.left || !initial.right) && initial.skin.named) {
      const local = initialCheeks(false);
      if (local.left && local.right && local.left.materialIndex === local.right.materialIndex) initial = local;
    }
    const { skin: initialSkin, left: initialLeft, right: initialRight } = initial;
    const visible = initialLeft && initialRight && (initialSkin.named || initialLeft.materialIndex === initialRight.materialIndex)
      ? visibleEyes(mesh, worldToHead, boneMidpoint, right, initialUp, initialForward, distance) : null;
    const visibleSkin = visible ? new Set([initialLeft!.materialIndex, initialRight!.materialIndex]) : null;
    const midpoint = (visible?.midpoint ?? boneMidpoint).clone()
      .addScaledVector(right, calibration.eyeOffsetX * distance).addScaledVector(initialUp, calibration.eyeOffsetY * distance);
    const eyeDistance = (visible?.spacing ?? distance) * calibration.eyeSpacingScale;
    const leftEye = midpoint.clone().addScaledVector(right, -eyeDistance / 2);
    const rightEye = midpoint.clone().addScaledVector(right, eyeDistance / 2);
    const mouthEstimated = !mouthBone && !measuredMouth;
    const mouth = mouthBone ? local(mouthBone) : measuredMouth ? measuredMouth.clone() : midpoint.clone().addScaledVector(initialUp, -(visible ? distance : eyeDistance) * 0.9);
    mouth.addScaledVector(right, calibration.mouthOffsetX * distance).addScaledVector(initialUp, calibration.mouthOffsetY * distance);
    if (!finitePoint(mouth)) return fail('嘴部参考位置不是有限坐标');
    const up = midpoint.clone().sub(mouth).addScaledVector(right, -midpoint.clone().sub(mouth).dot(right));
    levelFaceUp(up, initialForward);
    const drop = up.length();
    if (drop < eyeDistance * 0.3 || drop > eyeDistance * 2 || up.dot(initialUp) < eyeDistance * 0.25) return fail('眼嘴距离不可靠，请校准眼睛或嘴部参考点');
    up.normalize();
    const forward = right.clone().cross(up).normalize();
    if (forward.dot(midpoint) < 0) forward.negate();
    if (!finitePoint(forward) || forward.lengthSq() < 0.9) return fail('无法确定脸部朝向');
    const center = midpoint.clone().lerp(mouth, 0.56), lateral = visible ? 0.60 : 0.54;
    let source = collectFaceSamples(mesh, worldToHead, midpoint, right, up, forward, eyeDistance);
    if (visibleSkin) source.samples = source.samples.filter(sample => visibleSkin.has(sample.materialIndex));
    let left = sampleCheek(center.clone().addScaledVector(right, -eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
    let rightCheek = sampleCheek(center.clone().addScaledVector(right, eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
    // A named body/skin material need not include the face. Try the same bounded
    // face neighborhood across geometry before declaring that a cheek is absent.
    if ((!left || !rightCheek) && source.named) {
      source = collectFaceSamples(mesh, worldToHead, midpoint, right, up, forward, eyeDistance, false);
      if (visibleSkin) source.samples = source.samples.filter(sample => visibleSkin.has(sample.materialIndex));
      left = sampleCheek(center.clone().addScaledVector(right, -eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
      rightCheek = sampleCheek(center.clone().addScaledVector(right, eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
    }
    if (source.samples.length < 8) return fail('眼位附近没有足够可靠的脸部表面，未自动放置红晕');
    if (!left || !rightCheek) return fail('一侧脸颊缺少可靠表面；请校准眼嘴点，不使用穿透深度兜底');
    const materialIndices = [...new Set([left.materialIndex, rightCheek.materialIndex])];
    if (!source.named && materialIndices.length > 1) return fail('双颊表面材质归属不一致，未自动给未知材质贴色');
    let lowerFaceEstimate = false;
    if (visible && mouthEstimated) {
      // Vertical anatomy is measured separately; widening displayed eyes must
      // not multiply the estimated eye-to-mouth distance by that same factor.
      const lower = source.samples.filter(sample => materialIndices.includes(sample.materialIndex))
        .map(sample => sample.point.clone().sub(midpoint).dot(initialUp)).filter(y => y < -distance * 0.15);
      if (lower.length >= 40) {
        const faceDrop = -quantile(lower, 0.05);
        if (faceDrop > distance * 1.2 && faceDrop < (visible.spacing * 2)) {
          const mouthDrop = clamp(faceDrop * 0.7, distance * 0.9, distance * 1.8);
          const nextMouth = midpoint.clone().addScaledVector(initialUp, -mouthDrop)
            .addScaledVector(right, calibration.mouthOffsetX * distance).addScaledVector(initialUp, calibration.mouthOffsetY * distance);
          const nextCenter = midpoint.clone().lerp(nextMouth, 0.56);
          const nextLeft = sampleCheek(nextCenter.clone().addScaledVector(right, -eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
          const nextRight = sampleCheek(nextCenter.clone().addScaledVector(right, eyeDistance * lateral), source.samples, right, up, forward, eyeDistance);
          if (nextLeft && nextRight && materialIndices.includes(nextLeft.materialIndex) && materialIndices.includes(nextRight.materialIndex)) { mouth.copy(nextMouth); left = nextLeft; rightCheek = nextRight; lowerFaceEstimate = true; }
        }
      }
    }
    const anchors: BlushAnchors = {
      leftEye: tuple(leftEye), rightEye: tuple(rightEye), mouth: tuple(mouth),
      leftCheek: tuple(left.point), rightCheek: tuple(rightCheek.point), leftNormal: tuple(left.normal), rightNormal: tuple(rightCheek.normal),
      forward: tuple(forward), up: tuple(up), right: tuple(right), eyeDistance, boneEyeDistance: distance, eyeReference: visible ? 'main-eye-geometry' : 'eye-bones', mouthEstimated, surfaceSource: source.named ? 'named-face' : 'local-face', materialIndices,
    };
    const reason = [visible ? '主眼几何校准；偏移单位仍为原眼骨距' : '眼骨参考；未确认可信主眼几何，可手动校准', mouthEstimated ? lowerFaceEstimate ? '嘴点按下脸表面比例估算，可校准' : '嘴点按眼距估算，可校准' : mouthBone ? '已用嘴骨参考' : '嘴点取自模型档案（口型 morph 的实际位置）', source.named ? '已确认脸部材质，使用局部双颊贴色' : '按双颊附近顶点确认同一局部皮肤材质，使用保守贴色', '实际遮挡与大角度表现仍需模型实测'].join('；');
    return { supported: true, reason, anchors, calibration };
  } catch { return fail('模型表面或骨架暂不可安全采样，未放置程序红晕'); }
}

function collectFaceSamples(mesh: SkinnedMesh, worldToHead: Matrix4, midpoint: Vector3, right: Vector3, up: Vector3, forward: Vector3, distance: number, preferNamed = true): { samples: SurfaceSample[]; named: boolean } {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const face = new Set<number>();
  for (let index = 0; index < materials.length; index++) {
    const name = materials[index].name.normalize('NFKC');
    if (faceName(name) && supportedMaterial(materials[index])) face.add(index);
  }
  const index = mesh.geometry.index;
  const selected = new Set<number>();
  if (preferNamed && face.size) for (const group of mesh.geometry.groups) {
    if (!face.has(group.materialIndex ?? 0)) continue;
    const end = Math.min(index?.count ?? mesh.geometry.getAttribute('position').count, group.start + group.count);
    for (let item = group.start; item < end; item++) selected.add(index ? index.getX(item) : item);
  }
  const named = selected.size > 0;
  const count = mesh.geometry.getAttribute('position').count;
  const candidates = named ? [...selected] : Array.from({ length: Math.ceil(count / Math.max(1, Math.ceil(count / 60_000))) }, (_, n) => n * Math.max(1, Math.ceil(count / 60_000)));
  const normal = mesh.geometry.getAttribute('normal');
  const transform = worldToHead.clone().multiply(mesh.matrixWorld);
  const normalTransform = new Matrix3().getNormalMatrix(transform);
  const samples: SurfaceSample[] = [];
  const point = new Vector3(), offset = new Vector3();
  const stride = Math.max(1, Math.ceil(candidates.length / 60_000));
  const owners = new Map<number, number>();
  const ambiguous = new Set<number>();
  const wanted = new Set(candidates);
  const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index?.count ?? count, materialIndex: 0 }];
  for (const group of groups) {
    const materialIndex = group.materialIndex ?? 0;
    if (!supportedMaterial(materials[materialIndex]) || (named && !face.has(materialIndex))) continue;
    const end = Math.min(index?.count ?? count, group.start + group.count);
    for (let item = group.start; item < end; item++) {
      const vertex = index ? index.getX(item) : item;
      if (!wanted.has(vertex)) continue;
      if (owners.has(vertex) && owners.get(vertex) !== materialIndex) ambiguous.add(vertex);
      else owners.set(vertex, materialIndex);
    }
  }
  for (let item = 0; item < candidates.length; item += stride) {
    const vertex = candidates[item];
    const materialIndex = owners.get(vertex);
    if (materialIndex === undefined || ambiguous.has(vertex)) continue;
    mesh.getVertexPosition(vertex, point).applyMatrix4(transform);
    if (!finitePoint(point)) continue;
    offset.copy(point).sub(midpoint);
    const x = offset.dot(right) / distance, y = offset.dot(up) / distance, z = offset.dot(forward) / distance;
    // Eye bones may be deep inside a large eye socket; depth is obtained from
    // the real face, not assumed to coincide with the eye-bone plane.
    if (Math.abs(x) > 1.3 || y > 0.25 || y < -1.55 || Math.abs(z) > 3) continue;
    let surfaceNormal: Vector3 | null = null;
    if (normal?.itemSize === 3 && normal.count === count) {
      surfaceNormal = new Vector3(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex)).applyNormalMatrix(normalTransform);
      if (!finitePoint(surfaceNormal) || surfaceNormal.dot(forward) < 0.2) continue;
    }
    samples.push({ point: point.clone(), normal: surfaceNormal, materialIndex });
  }
  return { samples, named };
}

function sampleCheek(target: Vector3, samples: SurfaceSample[], right: Vector3, up: Vector3, forward: Vector3, distance: number): { point: Vector3; normal: Vector3; materialIndex: number } | null {
  const nearby = samples.map(sample => {
    const offset = sample.point.clone().sub(target);
    const x = offset.dot(right), y = offset.dot(up), z = offset.dot(forward);
    return { ...sample, x, y, z, score: x * x + y * y + z * z * 0.06 };
  }).filter(sample => Math.abs(sample.x) <= distance * 0.3 && Math.abs(sample.y) <= distance * 0.28 && Math.abs(sample.z) <= distance * 3)
    .sort((a, b) => a.score - b.score).slice(0, 20);
  if (nearby.length < 4) return null;
  const ownership = new Map<number, number>();
  for (const sample of nearby) ownership.set(sample.materialIndex, (ownership.get(sample.materialIndex) ?? 0) + 1);
  const dominant = [...ownership].sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] < 4 || dominant[1] / nearby.length < 0.7) return null;
  let total = 0, depth = 0;
  const surfaceNormal = new Vector3();
  for (const sample of nearby) {
    if (sample.materialIndex !== dominant[0]) continue;
    const weight = 1 / (0.0025 * distance * distance + sample.x * sample.x + sample.y * sample.y);
    total += weight; depth += sample.z * weight;
    surfaceNormal.addScaledVector(sample.normal ?? forward, weight);
  }
  depth /= total; surfaceNormal.normalize();
  if (!Number.isFinite(depth) || !finitePoint(surfaceNormal) || surfaceNormal.dot(forward) < 0.35) return null;
  // This locates the color mask only. No plane or depth offset is created.
  const point = target.clone().addScaledVector(forward, depth);
  return finitePoint(point) ? { point, normal: surfaceNormal, materialIndex: dominant[0] } : null;
}

const VERTEX_DECLARATIONS = `
uniform mat4 shBlushMeshToHead;
varying vec3 vShBlushHead;
`;
const FRAGMENT_DECLARATIONS = `
uniform float shBlushAmount;
uniform vec2 shBlushRadius;
uniform float shBlushDepth;
uniform vec3 shBlushLeft;
uniform vec3 shBlushRight;
uniform vec3 shBlushAxisX;
uniform vec3 shBlushAxisY;
uniform vec3 shBlushForward;
uniform vec3 shBlushColor;
varying vec3 vShBlushHead;
float shBlushMask(vec3 center) {
  vec3 offset = vShBlushHead - center;
  vec2 p = vec2(dot(offset, shBlushAxisX), dot(offset, shBlushAxisY)) / shBlushRadius;
  float r = length(p);
  float edge = exp(-2.2 * r * r) * (1.0 - smoothstep(0.55, 1.0, r));
  float depth = 1.0 - smoothstep(shBlushDepth * 0.35, shBlushDepth, abs(dot(offset, shBlushForward)));
  return edge * depth;
}
`;
const FRAGMENT_COLOR = `
if (shBlushAmount > 0.0 && shBlushRadius.x > 0.0 && shBlushRadius.y > 0.0) {
  float mask = max(shBlushMask(shBlushLeft), shBlushMask(shBlushRight));
  float facing = gl_FrontFacing ? smoothstep(0.25, 0.7, dot(normalize(vViewPosition), normal)) : 0.0;
  diffuseColor.rgb = mix(diffuseColor.rgb, shBlushColor, mask * facing * shBlushAmount * 0.76);
}
`;
interface MaterialAttachment { index: number; source: ShaderMaterial; clone: ShaderMaterial }
export interface ProceduralBlushState {
  supported: boolean;
  reason: string;
  materialIndices: number[];
  materialNames: string[];
  amount: number;
  size: number;
  attached: boolean;
  compiled: number;
}

/** Local color on the actual skinned face surface; existing depth/alpha/lighting stay authoritative. */
export class ProceduralBlush {
  /** Empty inspection handle; the decal creates no geometry or foreground objects. */
  readonly group = new Group();
  private anchors: BlushAnchors;
  private disposed = false;
  private attachments: MaterialAttachment[] = [];
  private originalMaterials: Material | Material[];
  private installedMaterials: Material | Material[];
  private readonly compiled = new Set<ShaderMaterial>();
  private capability = true;
  private explanation = '真实脸部材质上的局部双颊贴色';
  private amount = 0;
  private size = 50;
  private readonly uniforms = {
    shBlushMeshToHead: { value: new Matrix4() }, shBlushAmount: { value: 0 }, shBlushRadius: { value: new Vector2() },
    shBlushDepth: { value: 0 }, shBlushLeft: { value: new Vector3() }, shBlushRight: { value: new Vector3() },
    shBlushAxisX: { value: new Vector3() }, shBlushAxisY: { value: new Vector3() }, shBlushForward: { value: new Vector3() },
    shBlushColor: { value: new Color('#ee6177') },
  };
  private readonly previousRender: SkinnedMesh['onBeforeRender'];
  private readonly renderHook: SkinnedMesh['onBeforeRender'];

  constructor(private readonly head: Bone, anchors: BlushAnchors, private readonly mesh: SkinnedMesh) {
    this.anchors = structuredClone(anchors);
    this.originalMaterials = mesh.material; this.installedMaterials = mesh.material;
    this.group.name = 'soft-hearts-procedural-blush'; this.group.visible = false;
    this.previousRender = mesh.onBeforeRender;
    const owner = this;
    this.renderHook = function (...args) {
      owner.previousRender.apply(this, args);
      if (owner.disposed) return;
      // Renderer has now updated the complete final pose, including mood/gaze/music.
      const determinant = owner.head.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) { owner.uniforms.shBlushAmount.value = 0; return; }
      owner.uniforms.shBlushMeshToHead.value.copy(owner.head.matrixWorld).invert().multiply(owner.mesh.matrixWorld);
      owner.uniforms.shBlushAmount.value = owner.capability && owner.size > 0 ? owner.amount : 0;
    };
    mesh.onBeforeRender = this.renderHook;
    this.configure(anchors);
  }

  get supported(): boolean { return this.capability && !this.disposed; }
  get reason(): string { return this.explanation; }

  configure(anchors: BlushAnchors): void {
    if (this.disposed) return;
    this.anchors = structuredClone(anchors);
    const indices = [...new Set(anchors.materialIndices)].sort((a, b) => a - b);
    if (!indices.length) { this.capability = false; this.explanation = '没有可靠脸部材质归属，未启用程序红晕'; this.uniforms.shBlushAmount.value = 0; return; }
    if (indices.join(',') !== this.attachments.map(value => value.index).join(',')) {
      this.restoreMaterials(); this.originalMaterials = this.mesh.material;
      const source = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
      this.capability = indices.length > 0 && indices.every(index => Number.isInteger(index) && supportedMaterial(source[index]));
      if (!this.capability) { this.explanation = '未确认可安全注入的脸部材质，未启用程序红晕'; this.uniforms.shBlushAmount.value = 0; return; }
      const next = [...source];
      for (const index of indices) {
        const original = source[index] as ShaderMaterial, clone = original.clone();
        // ShaderMaterial.clone clones textures too. Keep the original shared image
        // resources while keeping colors/vectors and all non-texture uniforms separate.
        for (const [name, uniform] of Object.entries(original.uniforms)) {
          if (uniform.value?.isTexture) clone.uniforms[name].value = uniform.value;
          else if (Array.isArray(uniform.value) && uniform.value.some(value => value?.isTexture))
            clone.uniforms[name].value = uniform.value.map(value => value?.isTexture ? value : value?.clone ? value.clone() : value);
        }
        const beforeCompile = original.onBeforeCompile, cacheKey = original.customProgramCacheKey;
        clone.onBeforeCompile = (shader, renderer) => {
          beforeCompile.call(clone, shader, renderer);
          if (!shader.vertexShader.includes('#include <displacementmap_vertex>') || !shader.vertexShader.includes('#include <common>') ||
            !shader.fragmentShader.includes('#include <normal_fragment_maps>') || !shader.fragmentShader.includes('#include <common>')) {
            this.capability = false; this.explanation = '脸部原着色器缺少所需接点，已停用程序红晕'; this.uniforms.shBlushAmount.value = 0; return;
          }
          Object.assign(shader.uniforms, this.uniforms);
          shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
            .replace('#include <displacementmap_vertex>', '#include <displacementmap_vertex>\nvShBlushHead = (shBlushMeshToHead * vec4(transformed, 1.0)).xyz;');
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
            .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_COLOR}`);
          this.compiled.add(clone);
        };
        clone.customProgramCacheKey = () => `${cacheKey.call(original)}:soft-hearts-local-blush-v1`;
        next[index] = clone; this.attachments.push({ index, source: original, clone });
      }
      this.installedMaterials = Array.isArray(this.originalMaterials) ? next : next[0];
      this.mesh.material = this.installedMaterials;
    }
    this.uniforms.shBlushLeft.value.fromArray(anchors.leftCheek); this.uniforms.shBlushRight.value.fromArray(anchors.rightCheek);
    this.uniforms.shBlushAxisX.value.fromArray(anchors.right).normalize(); this.uniforms.shBlushAxisY.value.fromArray(anchors.up).normalize();
    this.uniforms.shBlushForward.value.fromArray(anchors.forward).normalize(); this.uniforms.shBlushDepth.value = anchors.eyeDistance * 0.3;
    this.update(this.amount, this.size);
  }

  update(amount: number, size: number, _camera?: Camera): void {
    if (this.disposed) return;
    this.amount = Number.isFinite(amount) ? clamp(amount, 0, 1) : 0; this.size = Number.isFinite(size) ? clamp(size, 0, 100) : 0;
    this.uniforms.shBlushAmount.value = this.capability && this.size > 0 ? this.amount : 0;
    this.uniforms.shBlushRadius.value.set(this.anchors.eyeDistance * 0.3 * this.size / 50, this.anchors.eyeDistance * 0.17 * this.size / 50);
    this.group.visible = this.uniforms.shBlushAmount.value > 0;
  }

  getState(): ProceduralBlushState {
    return { supported: this.supported, reason: this.explanation, materialIndices: this.attachments.map(value => value.index), materialNames: this.attachments.map(value => value.source.name),
      amount: this.uniforms.shBlushAmount.value, size: this.size, attached: this.mesh.onBeforeRender === this.renderHook && this.attachments.length > 0 && !this.disposed, compiled: this.compiled.size };
  }

  private restoreMaterials(): void {
    if (this.mesh.material === this.installedMaterials) this.mesh.material = this.originalMaterials;
    else {
      const replacements = new Map<Material, Material>(this.attachments.map(value => [value.clone, value.source]));
      if (Array.isArray(this.mesh.material)) this.mesh.material = this.mesh.material.map(value => replacements.get(value) ?? value);
      else this.mesh.material = replacements.get(this.mesh.material) ?? this.mesh.material;
    }
    for (const { clone } of this.attachments) clone.dispose();
    this.attachments = []; this.compiled.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.group.visible = false; this.group.removeFromParent();
    this.uniforms.shBlushAmount.value = 0; this.restoreMaterials();
    if (this.mesh.onBeforeRender === this.renderHook) this.mesh.onBeforeRender = this.previousRender;
  }
}
