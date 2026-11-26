// The synthetic torso with a bust on physics and a kinematic hand (moved from tests/chest-hand-collision.test.ts so other tests can use it
// without running that file's tests again).
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { PhysicsConstraint, PhysicsRigidBody } from '../../src/stage/physics-rig';

type V3 = [number, number, number];
const body = (boneIndex: number, type: number, position: V3, radius: number, groupIndex: number): PhysicsRigidBody => ({
  boneIndex, type, shapeType: 0, width: radius, height: 0, depth: 0, weight: type ? 1 : 0, position, rotation: [0, 0, 0], friction: 0.5, restitution: 0,
  positionDamping: 0.5, rotationDamping: 0.5, groupIndex, groupTarget: 65535 });
const joint = (a: number, b: number, position: V3): PhysicsConstraint => ({ rigidBodyIndex1: a, rigidBodyIndex2: b, position, rotation: [0, 0, 0],
  translationLimitation1: [0, 0, 0], translationLimitation2: [0, 0, 0], rotationLimitation1: [-0.6, -0.6, -0.6], rotationLimitation2: [0.6, 0.6, 0.6],
  springPosition: [0, 0, 0], springRotation: [20, 20, 20] });

/** A torso with a bust on physics and a right arm whose hand carries a kinematic collision body (as many MMD models have). */
export function chestHandBody(): { mesh: SkinnedMesh; chest: Bone; hand: Bone; elbow: Bone } {
  const specs: [string, number, V3][] = [
    ['センター', -1, [0, 9.2, 0]], ['上半身', 0, [0, 11.8, 0]], ['上半身2', 1, [0, 13.8, 0]],
    ['左胸', 2, [0.7, 14.2, 0.35]], ['左胸先', 3, [0.7, 14.2, 1.1]],
    ['右肩', 2, [-0.27, 15.77, 0]], ['右腕', 5, [-1.33, 15.36, 0]], ['右腕捩', 6, [-2.5, 14.6, 0]], ['右ひじ', 7, [-3.69, 13.77, 0]],
    ['右手捩', 8, [-4.9, 12.9, 0]], ['右手首', 9, [-6.25, 12.05, 0]],
  ];
  const bones = specs.map(([name, , position]) => { const bone = new Bone(); bone.name = name; return { bone, position }; });
  specs.forEach(([, parent, position], i) => {
    const local = parent >= 0 ? position.map((value, k) => value - specs[parent][2][k]) as V3 : position;
    bones[i].bone.position.set(...local);
    if (parent >= 0) bones[parent].bone.add(bones[i].bone);
  });
  const geometry = new BufferGeometry();
  const weighted = [1, 2, 3, 4, 8, 10];
  geometry.setAttribute('position', new Float32BufferAttribute(weighted.flatMap(index => specs[index][2]), 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(weighted.flatMap(index => [index, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weighted.flatMap(() => [1, 0, 0, 0]), 4));
  geometry.userData.MMD = {
    rigidBodies: [
      body(2, 0, [0, 13.9, -0.35], 0.75, 0),       // 0 torso (kinematic anchor)
      body(3, 1, [0.7, 14.2, 0.6], 0.42, 1),       // 1 bust
      body(4, 1, [0.7, 14.2, 1.05], 0.3, 1),       // 2 bust tip
      body(10, 0, [-6.25, 12.05, 0], 0.45, 2),     // 3 hand (kinematic, collides with the bust)
      body(8, 0, [-3.69, 13.77, 0], 0.4, 2),       // 4 elbow (kinematic)
    ],
    constraints: [joint(0, 1, [0.7, 14.2, 0.35]), joint(1, 2, [0.7, 14.2, 0.85])],
  };
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(bones[0].bone);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones.map(entry => entry.bone)));
  return { mesh, chest: bones[3].bone, hand: bones[10].bone, elbow: bones[8].bone };
}
