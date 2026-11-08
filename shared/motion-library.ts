import type { MotionTagLibraryQueryView } from './r32/motion-tag-contracts';
export type MotionPackId = "gene" | "100style-idles" | "mpi-embm-gestures" | "genea-2022-gestures" | "fnoji-dances" | "soft-hearts-actions";
export type MotionCategory = "pose" | "expression" | "reaction" | "idle" | "gesture" | "dance";

export interface MotionDownloadFile {
  relativePath: string;
  originalPath: string;
  downloadUrl: string;
  sha256: string;
  bytes: number;
}

export interface CatalogMotion extends MotionDownloadFile {
  id: string;
  name: string;
  category: MotionCategory;
  tags: string[];
  durationFrames: number;
  boneFrames: number;
  morphFrames: number;
}

export interface MotionPack {
  id: MotionPackId;
  name: string;
  source: string;
  sourceUrl: string;
  revision: string;
  license: { id: string; url: string; attribution: string };
  motions: CatalogMotion[];
  documents: MotionDownloadFile[];
  /** Reviewed adaptations ship locally; their upstream BVH URLs are provenance, not VMD downloads. */
  bundledOnly?: boolean;
  modifications?: string;
  compatibilityNote?: string;
}

export interface MotionCatalog {
  schemaVersion: 1;
  packs: MotionPack[];
}

export interface MotionPackStatus {
  id: MotionPackId;
  installedMotionIds: string[];
  complete: boolean;
  bundled?: boolean;
}

export interface MotionLibraryStatus {
  directory: string;
  packs: MotionPackStatus[];
  /** Present only for an explicit readonly four-soft query; legacy callers keep their old shape. */
  tagQuery?: MotionTagLibraryQueryView;
}

export interface MotionDownloadProgress {
  packId: MotionPackId;
  completed: number;
  total: number;
  fileName: string;
}
