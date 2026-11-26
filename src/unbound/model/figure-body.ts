/**
 * I-152 step 2: the one way Unbound's pages load her body. An MMD file as before (the page's own loader); a VRM, as it is, through
 * the stage's public page (loaded lazily: the glTF loader and MToon come only for a VRM) onto the standard body. The caller hands
 * `mesh` to UnboundFigure either way and keeps `standard` to call present() after each frame and dispose() with the figure.
 */
import type { SkinnedMesh } from 'three';
import { modelFormatOf } from '../../../shared/foundation/model-format';
import { StandardBody } from './standard-body';

export interface FigureBody { mesh: SkinnedMesh; textures: Promise<void>; standard: StandardBody | null }

export async function loadFigureBody(url: string, loadMmd: (url: string) => Promise<{ mesh: SkinnedMesh; textures: Promise<void> }>): Promise<FigureBody> {
  if (modelFormatOf(url) !== 'vrm') return { ...await loadMmd(url), standard: null };
  const { loadVrmForEngine } = await import('../../stage');
  const standard = StandardBody.of(await loadVrmForEngine(url));
  return { mesh: standard.mesh, textures: Promise.resolve(), standard };
}

/** Drops a body that arrived too late (a newer load won). */
export function dropFigureBody(body: FigureBody): void { if (body.standard) body.standard.dispose(); else body.mesh.geometry.dispose(); }
