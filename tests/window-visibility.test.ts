import test from "node:test";
import assert from "node:assert/strict";
import { WindowVisibility } from "../electron/window-visibility";

test("native and requested visibility advance one scoped revision without inventing a show", () => {
  const pet = new WindowVisibility(20, false, false);
  assert.deepEqual(pet.observe(false, true), { windowId: 20, revision: 1, visible: false, petVisible: true });
  assert.equal(pet.observe(true, true).revision, 2);
  assert.equal(pet.observe(true, true).revision, 2);
  assert.deepEqual(pet.observe(false, true), { windowId: 20, revision: 3, visible: false, petVisible: true });
  assert.equal(pet.observe(false, false).revision, 4);
});

test("control visibility stays independent from pet intent and snapshots cannot mutate ownership", () => {
  const controls = new WindowVisibility(10, true, false), pet = new WindowVisibility(20, false, false);
  const view = controls.observe(true, true);
  assert.deepEqual(view, { windowId: 10, revision: 1, visible: true, petVisible: true });
  view.visible = false; view.revision = 900;
  assert.equal(controls.observe(true, true).revision, 1);
  assert.equal(controls.observe(true, true).visible, true);
  assert.equal(pet.observe(false, false).revision, 0);
});
