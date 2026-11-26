/**
 * I-152 step 2: where a pat lands on a model driven through the standard skeleton (a VRM): the companion's own head-contact probe
 * (src/stage/head-contact.ts), measured against the model's own head and eyes over each of its meshes (a VRM's scalp is in its
 * hair mesh, not the face's), keeping the one that reaches highest. Call after the body was presented once (her head posed).
 */
import { Vector3, type Bone } from 'three';
import { probeHeadContact } from '../../stage';
import type { StandardBody } from './standard-body';

type HeadContact = ReturnType<typeof probeHeadContact>;

export function standardHeadContact(body: StandardBody, heightUnits: number): { contact: HeadContact | null; head: Bone | null } {
  const head = body.head;
  if (!head) return { contact: null, head: null };
  // The probe measures in the head bone's own frame; a VRM's bones are in metres under a root scaled to stage units, so her height
  // is handed over in the head's units (without this the eyes look too close together and the probe falls back to an estimate).
  head.updateWorldMatrix(true, false);
  const scale = head.getWorldScale(new Vector3()).x / (body.mesh.getWorldScale(new Vector3()).x || 1);
  const height = heightUnits / (scale > 0 ? scale : 1);
  let best: HeadContact | null = null, top = -Infinity;
  for (const mesh of body.model.meshes) {
    const contact = probeHeadContact(mesh, head, body.eyes, height);
    const reach = contact.center.dot(contact.up) + contact.halfHeight; // in the head's own frame, along its up
    if (Number.isFinite(reach) && reach > top) { top = reach; best = contact; }
  }
  return { contact: best, head };
}
