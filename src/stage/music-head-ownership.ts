import type { AnimationClip, KeyframeTrack } from 'three';
import { motionTrackChannel, type MotionLayerClips } from './motion-layers';

interface HeadRestPosition { readonly x: number; readonly y: number; readonly z: number; }
const ZERO_POSITION: HeadRestPosition = { x: 0, y: 0, z: 0 };

function ownsHeadTrack(track: KeyframeTrack, headName: string, restPosition: HeadRestPosition): boolean {
  const prefix = `.bones[${headName}].`;
  if (!track.name.startsWith(prefix)) return false;
  const property = track.name.slice(prefix.length);
  if (property !== 'quaternion' && property !== 'position' && property !== 'scale') return false;
  const width = track.getValueSize();
  if (!track.values.length || width < 1) return false;
  for (let index = width; index < track.values.length; index++)
    if (Math.abs(track.values[index] - track.values[index % width]) > 0.0001) return true;
  // A non-default static head pose also keeps presentation ownership.
  if (property === 'quaternion' && width === 4)
    return Math.hypot(track.values[0], track.values[1], track.values[2]) > 0.0001
      || Math.abs(Math.abs(track.values[3]) - 1) > 0.0001;
  // MMDLoader writes bindPosition + VMD displacement into Float32 tracks.
  // A default zero displacement is therefore the loaded rest position, not 0.
  const rest = property === 'position'
    ? [Math.fround(restPosition.x), Math.fround(restPosition.y), Math.fround(restPosition.z)]
    : [1, 1, 1];
  return Array.from(track.values).some((value, index) => Math.abs(value - rest[index % width]) > 0.0001);
}

/** Only the exact resolved head track matters; an unrelated upper-body track does not own the head. */
export function hasOwnedHeadTrack(clip: AnimationClip | null, headName: string | undefined, restPosition: HeadRestPosition = ZERO_POSITION): boolean {
  if (!clip || !headName) return false;
  return clip.tracks.some(track => ownsHeadTrack(track, headName, restPosition));
}

/** Match LayeredMmdAnimation's actual disjoint property bindings, not raw VMD content. */
export function hasOwnedLayeredHeadTrack(
  clips: MotionLayerClips,
  headName: string | undefined,
  restPosition: HeadRestPosition = ZERO_POSITION,
  options: { legacy?: boolean; reviewedDefault?: boolean } = {},
): boolean {
  if (!headName) return false;
  if (options.legacy) return !options.reviewedDefault && hasOwnedHeadTrack(clips.pose, headName, restPosition);
  const gestureTracks = new Set(clips.gesture?.tracks
    .filter(track => motionTrackChannel(track.name) === 'gesture').map(track => track.name));
  const owns = (track: KeyframeTrack) => ownsHeadTrack(track, headName, restPosition);
  return (!options.reviewedDefault && !!clips.pose?.tracks.some(track => {
    const kind = motionTrackChannel(track.name);
    return kind !== null && kind !== 'expression' && !gestureTracks.has(track.name) && owns(track);
  })) || !!clips.gesture?.tracks.some(track => motionTrackChannel(track.name) === 'gesture' && owns(track))
    || !!clips.expression?.tracks.some(track => motionTrackChannel(track.name) === 'expression' && owns(track));
}
