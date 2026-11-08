// Pose feasibility bench: turn runs/*.json (node and Electron results) into markdown tables. NOT product code.
// Usage: node summarize-runs.mjs [bench-dir] [filter-regex]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const bench = process.argv[2] || path.join(process.env.LOCALAPPDATA, "soft-hearts-next-bench");
const filter = new RegExp(process.argv[3] || ".");
const dir = path.join(bench, "runs");
const f1 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "-" : Number(x).toFixed(1));
const f0 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "-" : Math.round(x));
const gpu = (p) => {
  const g = p?.gpuByEngineType ?? {};
  const keys = Object.keys(g).filter((k) => g[k] > 0.05);
  return keys.length ? keys.map((k) => `${k.replace(/_\d+$/, "")}:${g[k].toFixed(1)}`).join(" ") : "0";
};

const rows = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.endsWith(".sample.json") && filter.test(x)).sort()) {
  const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  if (!r.unpaced) continue;
  const first = typeof r.firstFrameMs === "object" ? r.firstFrameMs.total : r.firstFrameMs;
  const load = r.loadMs ? (typeof r.loadMs === "object" ? `${r.loadMs.det ?? "-"}/${r.loadMs.pose ?? "-"}` : r.loadMs) : "-";
  const u = r.unpaced;
  rows.push({ f, r, first, load, u });
}
console.log("| run | det+pose | load ms (det/pose) | first frame ms | det p50/p90 | pose p50/p90 | total p50/p90 | max fps (full / pose only) | idle sys CPU % |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const { f, r, first, load, u } of rows) {
  console.log(`| ${f.replace(".json", "")} | ${r.det ?? ""}+${r.pose ?? ""} ${r.ep ?? r.route ?? ""}${r.threads ? " t" + r.threads : ""} | ${load} | ${f0(first)} | ${f1(u.det?.p50)}/${f1(u.det?.p90)} | ${f1(u.pose?.p50)}/${f1(u.pose?.p90)} | ${f1(u.total?.p50)}/${f1(u.total?.p90)} | ${u.maxFps} / ${u.maxFpsPoseOnly} | ${f1(r.idleBaseline?.sysCpuPct)} |`);
}
console.log("\n| run | fps | achieved | process CPU (cores) | % of 20-CPU machine | system CPU % | GPU engine % (process) | working set / private MB |");
console.log("|---|---|---|---|---|---|---|---|");
for (const { f, r } of rows) {
  for (const [fps, p] of Object.entries(r.paced ?? {})) {
    console.log(`| ${f.replace(".json", "")} | ${fps} | ${p.achievedFps} (late ${p.lateFrames}) | ${p.procCores?.toFixed(2)} | ${f1(p.procPctOfMachine)} | ${f1(p.sysCpuPct)} | ${gpu(p)} | ${f0(p.workingSetMB)} / ${f0(p.privateMB)} |`);
  }
}
