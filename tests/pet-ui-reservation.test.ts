import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { isPetControlPoint } from "../src/ui/MoodCompanion";
import { PetInteraction, type PetInteractionEvent, type PetInteractionState } from "../src/ui/PetInteraction";

function layout(selector: string, left: number, top: number, width: number, height: number) {
  return {
    selector, visibility: "visible", displayed: true,
    getBoundingClientRect() { return { left, top, width: this.displayed ? width : 0, height: this.displayed ? height : 0 }; },
  };
}

function harness(t: TestContext) {
  let clock = 0, interacting = false;
  const toolbar = layout("#pet-toolbar", 20, 23, 300, 60);
  const chat = layout(".pet-chat", 22, 330, 276, 65);
  const size = layout(".pet-window-help", 220, 90, 90, 80); size.displayed = false;
  const developer = layout("[data-mood-ui]", 305, 190, 45, 90); developer.displayed = false;
  const widgets = [toolbar, chat, size, developer];
  const view = new EventTarget() as EventTarget & { performance: { now(): number } };
  view.performance = { now: () => clock };
  const owner = Object.assign(new EventTarget(), {
    defaultView: view, hidden: false,
    querySelectorAll(selector: string) { return widgets.filter(widget => selector.split(",").map(value => value.trim()).includes(widget.selector)); },
  });
  const document = owner as unknown as Document;
  const surface = Object.assign(new EventTarget(), {
    ownerDocument: document,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 340, height: 400 }),
    contains: () => false,
  });
  const states: PetInteractionState[] = [], events: PetInteractionEvent[] = [], errors: string[] = [];
  const input = new PetInteraction(surface as unknown as HTMLElement, {
    // This close-up head overlaps toolbar, chat input and window adjustment help.
    getHeadRegion: () => ({ x: 160, y: 180, radius: 180, mouthX: 160, mouthY: 140 }),
    blocksPoint: (x, y) => isPetControlPoint(document, x, y),
    onState(state) {
      states.push(state); interacting = state.phase !== "idle" && state.phase !== "rua-hover";
      toolbar.visibility = chat.visibility = interacting ? "hidden" : "visible";
    },
    onFeedback() {}, onEvent: event => { events.push(event); }, onError: error => errors.push(error),
  });
  t.after(() => input.dispose());
  function dispatch(type: string, x: number, y: number, at: number) {
    clock = at;
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, buttons: 0, pointerType: "mouse", isPrimary: true });
    if (type.startsWith("drag") || type === "drop") Object.assign(event, {
      dataTransfer: { types: ["Files"], dropEffect: "copy", files: [{ name: "snack.png", type: "image/png", size: 128 }] },
    });
    surface.dispatchEvent(event);
    return event;
  }
  return { input, states, events, errors, toolbar, chat, size, developer, document, surface, dispatch,
    ready(x = 170, y = 170) { dispatch('pointermove', x, y, 0); },
    interacting: () => interacting };
}

test("an overlapping toolbar ends head contact even while hidden and the event still targets the stage", t => {
  const h = harness(t);
  h.ready();
  assert.equal(h.input.state.phase, "rua");
  assert.equal(h.toolbar.visibility, "hidden");
  assert.equal(isPetControlPoint(h.document, 170, 43), true, "visibility:hidden retains the UI reservation");
  const event = h.dispatch("pointermove", 170, 43, 100);
  assert.equal(event.target, h.surface, "the hidden button cannot be identified from event.target");
  assert.equal(h.input.state.phase, "idle");
  assert.equal(h.interacting(), false);
  assert.equal(h.toolbar.visibility, "visible");
  assert.equal(h.chat.visibility, "visible");
  assert.deepEqual(h.events, [], "a stationary head hover and UI exit earn no activity");
  h.dispatch("pointermove", 170, 170, 200);
  assert.equal(h.input.state.phase, "rua", "leaving UI starts immediate fresh contact without reusing the old movement");
  assert.equal(h.toolbar.visibility, 'hidden', 'this reservation fixture deliberately hides paint during contact; toolbar timing is tested separately');
});

test("chat input and visible window adjustment help reserve only their actual layout", t => {
  const h = harness(t);
  for (const point of [[170, 350], [260, 110]]) {
    h.size.displayed = true;
    h.ready();
    assert.equal(h.input.state.phase, "rua");
    h.dispatch("pointermove", point[0], point[1], 100);
    assert.equal(h.input.state.phase, "idle");
  }
  h.size.displayed = false;
  assert.equal(isPetControlPoint(h.document, 260, 110), false, "a collapsed display:none panel does not block the model");
  h.dispatch("pointermove", 260, 110, 200);
  assert.equal(h.input.state.phase, "rua");
  assert.equal(isPetControlPoint(h.document, 170, 170), false, "the full model rectangle is not reserved");
  h.developer.displayed = true;
  assert.equal(isPetControlPoint(h.document, 320, 220), true);
  assert.equal(isPetControlPoint(h.document, NaN, 220), false);
});

test("dragging food into reserved UI cancels preparation and requires a fresh mouth pause", t => {
  const h = harness(t);
  h.dispatch("dragover", 170, 160, 0);
  h.dispatch("dragover", 170, 160, 700);
  assert.equal(h.input.state.phase, "feeding-ready");
  const blocked = h.dispatch("dragover", 170, 43, 710);
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(h.input.state.phase, "idle");
  assert.equal(h.interacting(), false);
  h.dispatch("drop", 170, 43, 720);
  assert.equal(h.events.length, 0, "a UI drop must never accept food");
  assert.deepEqual(h.errors, [], "ordinary UI use is not a failed feeding attempt");
  h.dispatch("dragover", 170, 160, 800);
  assert.equal(h.input.state.phase, "feeding-wait", "the old ready state was discarded");
  h.dispatch("dragover", 170, 160, 1500);
  h.dispatch("drop", 170, 160, 1510);
  assert.equal(h.input.state.phase, "feeding-accepted");
  assert.equal(h.events.filter(event => event.type === "food").length, 1);
});

test("a direct drop or pointer move onto UI also cancels feeding before it can be accepted", t => {
  const h = harness(t);
  for (const type of ["drop", "pointermove"]) {
    h.dispatch("dragover", 170, 160, 0);
    h.dispatch("dragover", 170, 160, 700);
    assert.equal(h.input.state.phase, "feeding-ready");
    h.dispatch(type, 170, 43, 710);
    assert.equal(h.input.state.phase, "idle", type);
    assert.equal(h.toolbar.visibility, "visible", type);
  }
  assert.equal(h.events.filter(event => event.type === "food").length, 0);
});
