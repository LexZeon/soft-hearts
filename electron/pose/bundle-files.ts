/**
 * What scripts/build-electron.mjs puts next to main.cjs for local pose sensing (inside app.asar when packaged).
 * The packaged smoke (scripts/smoke.mjs) checks the same names; tests/smoke-expectations.test.ts keeps them equal.
 */
export const POSE_BUNDLE = Object.freeze({
  worker: 'pose-worker.cjs',
  sensorPreload: 'pose-sensor-preload.cjs',
  sensorPage: 'pose-sensor.html',
  licenses: 'pose-licenses',
});
