// I-048 step 2: from the screen sampler's frame (a data URL) to the two things watching together needs: the small grayscale thumbnail for
// the change gate and a smaller JPEG for the model to look at (also what the 30-minute screenshot cache keeps). Electron's nativeImage
// does the resizing; the gray conversion is shared/behaviors/watch-timeline/thumbnail.ts. The frame is never written anywhere here.

import { nativeImage } from 'electron';
import { THUMB_HEIGHT, THUMB_WIDTH, grayFromBgra } from '../../shared/behaviors/watch-timeline/thumbnail';
import { WATCH_TIMELINE_KNOBS, type WatchTimelineKnobs } from '../../shared/behaviors/watch-timeline/knobs';

export function prepareWatchFrame(dataUrl: string, knobs: WatchTimelineKnobs['session'] = WATCH_TIMELINE_KNOBS.session): { thumb: Uint8Array; picture: string } | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return null;
  const small = image.resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, quality: 'good' });
  const thumb = grayFromBgra(small.toBitmap());
  if (!thumb) return null;
  const size = image.getSize();
  const scaled = size.width > knobs.pictureWidth ? image.resize({ width: Math.max(64, Math.round(knobs.pictureWidth)), quality: 'good' }) : image;
  const picture = `data:image/jpeg;base64,${scaled.toJPEG(Math.min(100, Math.max(1, Math.round(knobs.pictureQuality)))).toString('base64')}`;
  return { thumb, picture };
}
