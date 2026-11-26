/**
 * I-135 認出是不是你（Beta）, 2026-11-25: the REAL YuNet and SFace models on programmatically drawn faces (no camera, no person).
 * Skipped when the models or the runtime are not on this computer (they live under .local/ of the main checkout, never in the repo).
 *
 * What it shows: the pipeline (colour order, five-point alignment to 112x112, scale) gives the same drawn face the same numbers and two
 * different drawn faces different ones, and the detector's landmark order and coordinates match where the faces were drawn. These are
 * cartoons: the numbers say nothing about real faces. The threshold for real people still needs the user and another person
 * (docs/claude/2026-11-25-face-check-restart.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { alignFace } from '../electron/senses/face/align';
import { classifyCheck } from '../electron/senses/face/decision';
import { FACE_KNOBS } from '../electron/senses/face/knobs';
import { cosine, l2normalize } from '../electron/senses/face/score';
import { decodeYunet, detectorInput, largestFace } from '../electron/senses/face/yunet';
import { drawFace, drawnLandmarks, FACE_A, FACE_B } from './helpers/face-drawing';

function findLocal(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, '.local', 'face-models-download', 'face_recognition_sface_2021dec_int8.onnx'))
      && existsSync(path.join(dir, '.local', 'ml', 'models', 'ort-1.31.1', 'runtime', 'node_modules', 'onnxruntime-node'))) return path.join(dir, '.local');
    dir = path.dirname(dir);
  }
  return null;
}
const local = findLocal();
const skip = local ? false : 'the models and the runtime are not on this computer';

async function open() {
  const ort = createRequire(import.meta.url)(path.join(local!, 'ml', 'models', 'ort-1.31.1', 'runtime', 'node_modules', 'onnxruntime-node'));
  const options = { executionProviders: ['cpu'], logSeverityLevel: 3 };
  const detector = await ort.InferenceSession.create(readFileSync(path.join(local!, 'face-models-download', 'face_detection_yunet_2023mar.onnx')), options);
  const recognizer = await ort.InferenceSession.create(readFileSync(path.join(local!, 'face-models-download', 'face_recognition_sface_2021dec_int8.onnx')), options);
  return { ort, detector, recognizer };
}

test('real SFace: the same drawn face scores high, two different drawn faces score low, and the old 0.20 line would have let them through', { skip }, async () => {
  const { ort, recognizer } = await open();
  const embed = async (face: typeof FACE_A, noise: number, seed: number) => {
    const aligned = alignFace(drawFace(face, 320, 240, noise, seed), 320, 240, drawnLandmarks(face));
    const out = await recognizer.run({ [recognizer.inputNames[0]]: new ort.Tensor('float32', aligned.rgb, [1, 3, 112, 112]) });
    return l2normalize(Array.from(out[recognizer.outputNames[0]].data as Float32Array));
  };
  const a1 = await embed(FACE_A, 0, 1), a2 = await embed(FACE_A, 8, 2), b1 = await embed(FACE_B, 0, 3), b2 = await embed(FACE_B, 8, 4);
  const same = [cosine(a1, a2), cosine(b1, b2)], other = [cosine(a1, b1), cosine(a2, b2), cosine(a1, b2), cosine(a2, b1)];
  assert.ok(Math.min(...same) > 0.7, `same face ${same.join()}`);
  assert.ok(Math.max(...other) < FACE_KNOBS.match.sameCosine, `different faces stay under the official line: ${other.join()}`);
  assert.ok(Math.min(...same) - Math.max(...other) > 0.3, 'the scores are far apart');
  // What the check makes of them against an enrolled A: never "the user", never merely "unsure".
  const look = (similarity: number) => ({ found: true, detScore: 0.97, faceWidth: 90, frontal: 0.95, sharpness: 120, brightness: 130, similarity });
  for (const score of other) assert.ok(['clear-not', 'weak-not'].includes(classifyCheck(look(score))), String(score));
  for (const score of same) assert.equal(classifyCheck(look(score)), 'match');
  assert.ok(other.some(score => score >= 0.2), 'fixture: at least one stranger score sat in the band the old 0.20 line called "unsure, taken as you"');
});

test('real YuNet: finds a drawn face, its landmarks come back in the order and place they were drawn (right eye, left eye, nose, right mouth, left mouth)', { skip }, async () => {
  const { ort, detector } = await open();
  const rgba = drawFace(FACE_B, 320, 240, 0, 3);
  const input = detectorInput(rgba, 320, 240, 640);
  const outputs = await detector.run({ [detector.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, 640, 640]) });
  const face = largestFace(decodeYunet(outputs, input, { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 20 }));
  assert.ok(face, 'a drawn face with strong features is found');
  const truth = drawnLandmarks(FACE_B);
  assert.ok(face!.landmarks[0].x < face!.landmarks[1].x, 'the first point is the eye on the image left (the person\'s right eye)');
  assert.ok(face!.landmarks[3].x < face!.landmarks[4].x, 'the fourth point is the mouth corner on the image left');
  // The eyes and the nose are close to where they were drawn (a cartoon, so a generous distance), which pins the scale and the padding.
  for (const index of [0, 1, 2]) assert.ok(Math.hypot(face!.landmarks[index].x - truth[index].x, face!.landmarks[index].y - truth[index].y) < 25, `landmark ${index}`);
  assert.ok(face!.x >= 0 && face!.y >= 0 && face!.x + face!.width <= 330 && face!.y + face!.height <= 250, 'the box is in source pixels');
});
