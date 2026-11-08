// Pose feasibility bench: read-only reference copy of rtmlib (Tau-J/rtmlib, Apache-2.0) pre/post-processing sources,
// pinned to one commit, so the JS port in this folder can be checked against them. NOT product code, NOT executed.
// Usage: node download-reference.mjs <bench-dir>
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const bench = process.argv[2];
if (!bench || !bench.includes("soft-hearts-next-bench")) throw new Error("bench dir required");
const COMMIT = "03a1693e59e4f7cd84582c0fb30459b3bf18ad42";
const FILES = [
  "LICENSE",
  "rtmlib/tools/base.py",
  "rtmlib/tools/object_detection/yolox.py",
  "rtmlib/tools/object_detection/rtmdet.py",
  "rtmlib/tools/object_detection/post_processings.py",
  "rtmlib/tools/pose_estimation/rtmpose.py",
  "rtmlib/tools/pose_estimation/pre_processings.py",
  "rtmlib/tools/pose_estimation/post_processings.py",
  "rtmlib/tools/solution/wholebody.py",
  "rtmlib/tools/solution/body.py",
];
const out = [];
for (const f of FILES) {
  const url = `https://raw.githubusercontent.com/Tau-J/rtmlib/${COMMIT}/${f}`;
  const res = await fetch(url);
  if (!res.ok) { console.error("FAILED", url, res.status); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const target = path.join(bench, "reference", "rtmlib", f);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buf);
  out.push({ file: f, url, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
}
writeFileSync(path.join(bench, "reference", "rtmlib", "reference-manifest.json"), JSON.stringify({ commit: COMMIT, license: "Apache-2.0", files: out }, null, 1));
console.log(out.map(o => `${o.file}\t${o.size}\t${o.sha256}`).join("\n"));
