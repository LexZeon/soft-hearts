// The packaged smoke (scripts/smoke.mjs) and the navigation smoke check the control window's top-level pages against
// scripts/lib/control-navigation.mjs. When a page was added (C2 角色), only the packaged smoke noticed, minutes into
// the desktop update. This keeps the script list equal to the real navigation tree in the ordinary unit tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_NAVIGATION } from '../src/ui/control-navigation-state';
import { CONTROL_ROOTS } from '../scripts/lib/control-navigation.mjs';

test('the smoke scripts list the same top-level control pages, in the same order, as the sidebar', () => {
  assert.deepEqual([...CONTROL_ROOTS], CONTROL_NAVIGATION.map(group => group.id));
});
