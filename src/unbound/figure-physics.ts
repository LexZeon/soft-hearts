/**
 * Her hair and chest physics and the jelly follow-through on the full-screen page (moved out of src/unbound/main.ts unchanged on 2026-11-21,
 * docs/claude/2026-11-21-unbound-full-ACH.md, so the page file only shrinks): the companion's physics setting held to the quality tier's cap,
 * whether the model has anything to move, and the Ammo runtime loaded only when it does.
 */
import { normalizeModelPhysicsSettings } from '../../shared/stage/model-physics'; // direct, not via ../../shared/stage: through the page rollup moves the stage's shared modules into the chunk the Unbound window loads too (docs/claude/2026-11-16-overhaul-parts-4.md)
import { LocalModelPhysics, probeModelPhysicsSupport } from '../stage/model-physics';
import { capQuality, type PerfTier } from '../../shared/unbound/perf-tiers';
import type { UnboundScene } from '../../shared/unbound/scene';
import type { UnboundFigure } from './figure';
import { StandardBody } from './model/standard-body';

/** The companion's physics setting, held to the tier's cap. */
export function physicsSettingsFor(s: UnboundScene, tier: PerfTier) {
  const settings = normalizeModelPhysicsSettings(s.physics ?? undefined);
  return { ...settings, quality: capQuality(settings.quality, tier.physicsCap) };
}
/** A tier (or the setting) changed: her physics budget in place, and a VRM's own springs (I-152 step 3, run by StandardBody.present). */
export function configureFigurePhysics(target: UnboundFigure, settings: ReturnType<typeof physicsSettingsFor>): void {
  target.configurePhysics(settings);
  StandardBody.ofMesh(target.mesh)?.configurePhysics(settings);
}
function physicsWanted(s: UnboundScene, mesh: UnboundFigure['mesh']): boolean {
  const settings = normalizeModelPhysicsSettings(s.physics ?? undefined);
  const support = probeModelPhysicsSupport(mesh);
  return (settings.hair.enabled && settings.hair.strength > 0 && support.hair.supported) || (settings.chest.enabled && settings.chest.strength > 0 && support.chest.supported);
}
/**
 * Her physics for this scene; `current()`: she is still the figure shown once the runtime has loaded. `jelly: false` (I-209: the others on
 * stage, never touched in step 1): no follow-through layer, so nothing is compiled for a touch that cannot come.
 */
export async function syncFigurePhysics(target: UnboundFigure, s: UnboundScene, tier: () => PerfTier, current: () => boolean, options: { jelly?: boolean } = {}): Promise<void> {
  if (options.jelly !== false) target.configureJelly(physicsSettingsFor(s, tier())); // I-147 (src/stage/jelly/): off unless the model's lab tuning turns a layer on
  StandardBody.ofMesh(target.mesh)?.configurePhysics(physicsSettingsFor(s, tier())); // a VRM: its own springs take the same switches
  if (!physicsWanted(s, target.mesh)) { target.attachPhysics(null); return; }
  try {
    const { loadAmmo } = await import('../stage/ammo-runtime');
    const ammo = await loadAmmo();
    if (!current()) return;
    target.attachPhysics(new LocalModelPhysics(target.mesh, ammo, physicsSettingsFor(s, tier())));
  } catch { target.attachPhysics(null); /* she stands without hair physics, as the companion does when it cannot start */ }
}
