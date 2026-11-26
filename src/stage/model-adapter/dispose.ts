// Releasing a model's GPU and CPU resources (moved from src/stage/mmd/model.ts disposeMesh, unchanged, I-152 step 0).
import { Texture, type Material, type Mesh, type Object3D, type SkinnedMesh } from 'three';

/** Every mesh under `root` (skinned or not, I-152 step 1: a VRM is a tree of them): geometry, materials, textures, skeletons, once each. */
export function disposeObjectTree(root: Object3D): void {
  const geometries = new Set<{ dispose(): void }>(), materials = new Set<Material>(), skeletons = new Set<{ dispose(): void }>();
  root.traverse(object => {
    const mesh = object as Partial<Mesh> & { isMesh?: boolean; isSkinnedMesh?: boolean; skeleton?: { dispose(): void } };
    if (!mesh.isMesh || !mesh.geometry) return;
    geometries.add(mesh.geometry);
    for (const material of mesh.material ? materialsOf(mesh.material as Material | Material[]) : []) materials.add(material);
    if (mesh.isSkinnedMesh && mesh.skeleton) skeletons.add(mesh.skeleton);
  });
  const textures = new Set<Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
    if (uniforms) for (const uniform of Object.values(uniforms)) if (uniform?.value instanceof Texture) textures.add(uniform.value);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) {
    texture.dispose();
    const image = texture.image;
    if (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) image.width = image.height = 1;
    texture.image = null;
  }
  for (const skeleton of skeletons) skeleton.dispose();
}

const materialsOf = (material: Material | Material[]): Material[] => Array.isArray(material) ? material : [material];

/** Geometry, every material and every texture it or its uniforms hold (canvas images shrunk first), and the skeleton. */
export function disposeSkinnedMesh(mesh: SkinnedMesh): void {
  mesh.geometry.dispose();
  const textures = new Set<Texture>();
  for (const material of materialsOf(mesh.material)) {
    for (const value of Object.values(material))
      if (value instanceof Texture) textures.add(value);
    const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
    if (uniforms)
      for (const uniform of Object.values(uniforms))
        if (uniform.value instanceof Texture) textures.add(uniform.value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    const image = texture.image;
    if (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) image.width = image.height = 1;
    texture.image = null;
  }
  mesh.skeleton.dispose();
}
