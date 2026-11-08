// Values the packaged smoke (scripts/smoke.mjs) expects from the app. Plain JS so the smoke can import it;
// tests/smoke-expectations.test.ts keeps each one equal to its source of truth in the app code.
/** shared/defaults.ts CLAUDE_MODEL_ALIASES: the model list for the Claude connection, offered without network discovery. */
export const SMOKE_CLAUDE_MODEL_ALIASES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

/**
 * I-001 local pose sensing in the packaged app, with the smoke's own empty LOCALAPPDATA (so: nothing installed).
 * 2026-11-03: in the stable build the pet's camera button seemed to do nothing; the smoke now checks, without a
 * download and without any camera, that the host is up, its bundled files load, and a refused click says why.
 */
export const SMOKE_POSE = Object.freeze({
  /** Windows phase with no component installed (other platforms report 'unsupported'). */
  phase: 'not-installed',
  /** electron/pose/manifest.ts POSE_COMPONENT_VERSION. */
  componentVersion: 1,
  /** electron/pose/manifest.ts downloadBytes(POSE_MANIFEST, platform): the first download the question names. */
  downloadBytes: Object.freeze({ 'win32-arm64': 85_171_644, 'win32-x64': 84_059_204 }),
  /** electron/pose/bundle-files.ts POSE_BUNDLE: next to main.cjs inside app.asar. */
  bundle: Object.freeze({ worker: 'pose-worker.cjs', sensorPreload: 'pose-sensor-preload.cjs', sensorPage: 'pose-sensor.html', licenses: 'pose-licenses' }),
  /** src/notice-policy.ts NOTICE_ACTIONS['camera-needs-component']: what the pet says when its 「姿势识别」 switch is refused (I-036). */
  refusedLine: '姿势识别要先下载本地识别组件（只在这台电脑上运行），在控制窗口的「隐私」页点「下载」就好。「发图片」不用下载。',
});
