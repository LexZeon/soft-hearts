// The packaged smoke runs only at the end of a desktop update, minutes in. Its fixed expectations drifted twice
// (the 角色 page, the fable alias) and failed the install after every other check passed. These keep them in step.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CLAUDE_MODEL_ALIASES } from '../shared/defaults';
import { SMOKE_CLAUDE_MODEL_ALIASES, SMOKE_POSE } from '../scripts/lib/smoke-expectations.mjs';
import { POSE_BUNDLE } from '../electron/pose/bundle-files';
import { POSE_COMPONENT_VERSION, POSE_MANIFEST, POSE_PLATFORMS, downloadBytes } from '../electron/pose/manifest';
import { NOTICE_ACTIONS } from '../src/notice-policy';

test('the smoke expects the same Claude model aliases the app offers', () => {
  assert.deepEqual([...SMOKE_CLAUDE_MODEL_ALIASES], [...CLAUDE_MODEL_ALIASES]);
});

test('the smoke expects the pose host, files and refusal line the app has', () => {
  assert.equal(SMOKE_POSE.componentVersion, POSE_COMPONENT_VERSION);
  assert.deepEqual(Object.keys(SMOKE_POSE.downloadBytes).sort(), [...POSE_PLATFORMS].sort());
  for (const platform of POSE_PLATFORMS) assert.equal(SMOKE_POSE.downloadBytes[platform], downloadBytes(POSE_MANIFEST, platform), platform);
  assert.deepEqual({ ...SMOKE_POSE.bundle }, { ...POSE_BUNDLE });
  assert.equal(SMOKE_POSE.refusedLine, NOTICE_ACTIONS['camera-needs-component']);
  // The build really writes those names (scripts/build-electron.mjs entries and the static page / licence folder).
  const build = readFileSync(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  for (const name of [POSE_BUNDLE.worker, POSE_BUNDLE.sensorPreload]) assert.match(build, new RegExp(`"${name.replace('.cjs', '')}":`), name);
  assert.ok(build.includes(`dist-electron/${POSE_BUNDLE.sensorPage}`) && build.includes(`dist-electron/${POSE_BUNDLE.licenses}`));
});
