import { AmbientLight, DirectionalLight, LoadingManager, type Scene } from "three";
import { CappedTextureLoader } from "./textures";

/**
 * The loading manager every MMD model load uses (the companion's stage and Unbound, src/unbound/figure.ts): textures go through the
 * capped loader (textures.ts), and PMX texture paths may use Windows separators and relative Japanese/Chinese names.
 * The caller sets onLoad / onError.
 */
export function createModelLoadingManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.addHandler(
    /\.(?:png|jpe?g|bmp|gif|webp|sph|spa)(?:[?#].*)?$/i,
    new CappedTextureLoader(manager),
  );
  manager.setURLModifier((resource) => resource.replace(/\\/g, "/"));
  return manager;
}

/** The stage's lights (one soft ambient, a warm key, a cool fill), shared so she looks the same in every window. */
export function addStageLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 1.1));
  const key = new DirectionalLight(0xfff2e6, 1.6);
  key.position.set(7, 25, 20);
  scene.add(key);
  const fill = new DirectionalLight(0xcddcff, 0.35);
  fill.position.set(-15, 10, -8);
  scene.add(fill);
}
