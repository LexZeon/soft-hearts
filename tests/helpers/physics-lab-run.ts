/**
 * Offline physics measurement (R01, docs/claude/2026-11-17-physics-lab.md): the stage's own LocalModelPhysics on CPU Ammo, driven by
 * the lab's fixed test motions in the stage's writer order (restore → final pose → physics frame), measured by the lab's meter.
 * Any PMX the caller can read; the private model is only ever passed in by a local probe, never by a committed test.
 */
import { readFile } from 'node:fs/promises';
import { MeshBasicMaterial, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings } from '../../shared/stage/model-physics';
import { LocalModelPhysics, type LocalPhysicsFactory } from '../../src/stage/model-physics';
import { buildPhysicsRigPlan } from '../../src/stage/physics-rig';
import { physicsGroups, type PhysicsGroupInfo } from '../../src/stage/physics-lab/groups';
import { PhysicsMeter, meterColliders, type GroupNumbers } from '../../src/stage/physics-lab/meter';
import { TEST_MOTION_PERIOD, applyTestMotion, motionRig, stillFor, type TestMotion } from '../../src/stage/physics-lab/test-motions';
import type { AmmoModule } from '../../src/stage/ammo-runtime';

export const GENE_PMX = new URL('../../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model/gene.pmx', import.meta.url);

/** The pinned loader's geometry and skeleton, without materials or textures (CPU only). */
export async function loadPmxMesh(file: string | URL): Promise<SkinnedMesh> {
  const bytes = await readFile(file);
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const data: unknown = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as unknown as { meshBuilder: { materialBuilder: { build: (...args: unknown[]) => unknown }; build(data: unknown, resourcePath: string): SkinnedMesh } };
  loader.meshBuilder.materialBuilder.build = () => new MeshBasicMaterial();
  return loader.meshBuilder.build(data, '');
}

export interface ScenarioResult {
  groups: PhysicsGroupInfo[];
  numbers: Record<string, GroupNumbers>;
  avgStepMs: number;
  status: string;
}

/** One motion for `loops` loops at `fps`; numbers are from the last loop (the first loops warm up). */
export function runScenario(mesh: SkinnedMesh, ammo: AmmoModule, settings: Partial<ModelPhysicsSettings> | ModelPhysicsSettings, motion: TestMotion,
  options: { fps?: number; loops?: number; speed?: number; factory?: LocalPhysicsFactory } = {}): ScenarioResult {
  const fps = options.fps ?? 60, loops = options.loops ?? 2, speed = options.speed ?? 1;
  const physics = new LocalModelPhysics(mesh, ammo, normalizeModelPhysicsSettings(settings), options.factory);
  const plan = buildPhysicsRigPlan(mesh);
  const groups = physicsGroups(mesh, plan);
  const bodies = [...new Set([...plan.hair.sourceBodyIndices, ...plan.chest.sourceBodyIndices])];
  const meter = new PhysicsMeter(mesh, groups, meterColliders(mesh, bodies));
  const rig = motionRig(mesh);
  const rest = mesh.skeleton.bones.map(bone => ({ p: bone.position.clone(), q: bone.quaternion.clone() }));
  const period = TEST_MOTION_PERIOD[motion] / speed;
  const frames = Math.round(period * fps * loops), dt = 1 / fps;
  try {
    for (let frame = 0; frame < frames; frame++) {
      if (frame === Math.round(period * fps * (loops - 1))) meter.reset();
      physics.restore();
      mesh.skeleton.bones.forEach((bone, i) => { bone.position.copy(rest[i].p); bone.quaternion.copy(rest[i].q); });
      const t = frame * dt * speed;
      applyTestMotion(rig, motion, t);
      mesh.updateMatrixWorld(true);
      meter.sampleBase();
      const started = performance.now();
      physics.frame(dt);
      const elapsed = performance.now() - started;
      meter.sampleAfter(dt, stillFor(motion, t), elapsed);
    }
    return { groups, numbers: meter.numbers(), avgStepMs: meter.avgStepMs, status: physics.getState().status };
  } finally {
    physics.dispose();
    mesh.skeleton.bones.forEach((bone, i) => { bone.position.copy(rest[i].p); bone.quaternion.copy(rest[i].q); });
    mesh.updateMatrixWorld(true);
  }
}
