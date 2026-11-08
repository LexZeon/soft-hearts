import assert from "node:assert/strict";
import test from "node:test";
import catalogData from "../shared/motion-catalog.json";
import type { CatalogMotion, MotionCatalog } from "../shared/motion-library";
import { filterMotions, listTags } from "../src/ui/motion-filters";

const catalog = catalogData as MotionCatalog;
const motions = catalog.packs.flatMap(pack => pack.motions);

test("real library category filters separate idle and expression motions and support Chinese labels", () => {
  const idles = filterMotions(motions, { category: "idle" });
  assert.equal(idles.length, 5);
  assert.ok(idles.every(motion => motion.relativePath.startsWith("motions/idle/")));
  assert.equal(filterMotions(motions, { category: "expression" }).length, 27);
  assert.deepEqual(filterMotions(motions, { query: "待机" }), idles);
  assert.equal(filterMotions(motions, { category: "dance", query: "表情" }).length, 0);
});

test("multiword search combines fields and selected tags are an exact case-insensitive AND", () => {
  const selected = filterMotions(motions, {
    query: " CONVERSATION   upper-body ",
    selectedTags: ["MPI-EMBM", "upper-body"],
  });
  assert.equal(selected.length, 5);
  assert.ok(selected.every(motion => motion.id.startsWith("conversation-")));
  assert.deepEqual(filterMotions(motions, { selectedTags: ["body"] }), [],
    "body must not match full-body, body-motion or upper-body by substring");
  assert.deepEqual(filterMotions(motions, { selectedTags: ["gesture", "dance"] }), [],
    "selecting mutually exclusive tags returns an empty result instead of changing to OR");
  assert.equal(filterMotions(motions, { query: "arms folded", category: "idle" })[0]?.id, "arms-folded-idle");
});

test("tag counts follow query and category while remaining independent of selected tags", () => {
  const options = { category: "idle" as const, query: "idle", selectedTags: ["neutral"] };
  assert.equal(filterMotions(motions, options).length, 1);
  const counts = new Map(listTags(motions, options).map(({ tag, count }) => [tag, count]));
  assert.equal(counts.get("idle"), 5);
  assert.equal(counts.get("neutral"), 1);
  assert.equal(counts.get("proud"), 1, "non-selected options stay available to extend or clear the filter");
  assert.equal(counts.has("dance"), false);
  assert.deepEqual(listTags(motions, { query: "no-such-motion" }), []);
});

test("duplicate and blank tags do not inflate counts or alter the catalog", () => {
  const source: CatalogMotion = { ...motions[0], tags: ["Idle", " idle ", "", "FULL-BODY"] };
  const before = structuredClone(source);
  assert.deepEqual(listTags([source]), [{ tag: "full-body", count: 1 }, { tag: "idle", count: 1 }]);
  assert.deepEqual(filterMotions([source], { selectedTags: [" IDLE ", "idle", ""] }), [source]);
  assert.deepEqual(source, before);
});
