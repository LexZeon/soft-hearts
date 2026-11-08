// Pose feasibility bench: run the onnxruntime-node measurement matrix one configuration at a time (so runs never overlap).
// Usage: node run-matrix.mjs [group ...]   groups: cpu dml det   (default: all)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bench = path.join(here, "bench-node.mjs");
const P = "--paced 5,10 --seconds 15 --frames 60";
const runs = {
  cpu: [
    `--route cpu --threads 4 --det yolox_nano --pose rtmpose_m ${P} --tag cpu4-A`,
    `--route cpu --threads 4 --det yolox_nano --pose rtmw_l_256 ${P} --tag cpu4-B`,
    `--route cpu --threads 4 --det yolox_nano --pose rtmw_l_384 ${P} --tag cpu4-C`,
    `--route cpu --threads 4 --det yolox_nano --pose rtmw_m_256 ${P} --tag cpu4-Bm`,
    `--route cpu --threads 2 --det yolox_nano --pose rtmpose_m ${P} --tag cpu2-A`,
    `--route cpu --threads 2 --det yolox_nano --pose rtmw_l_256 ${P} --tag cpu2-B`,
    `--route cpu --threads 4 --spin 0 --det yolox_nano --pose rtmpose_m ${P} --tag cpu4ns-A`,
    `--route cpu --threads 4 --spin 0 --det yolox_nano --pose rtmw_l_256 ${P} --tag cpu4ns-B`,
    `--route cpu --threads 0 --det yolox_nano --pose rtmw_l_256 ${P} --tag cpu20-B`,
  ],
  dml: [
    `--route dml0 --det yolox_nano --pose rtmpose_m ${P} --tag dml0-A`,
    `--route dml0 --det yolox_nano --pose rtmw_l_256 ${P} --tag dml0-B`,
    `--route dml0 --det yolox_nano --pose rtmw_l_384 ${P} --tag dml0-C`,
    `--route dml0 --det yolox_nano --pose rtmw_m_256 ${P} --tag dml0-Bm`,
  ],
  // second pass: the recommended CPU setting (2 threads, no spinning), single-core reference, RTMDet-nano as the detector,
  // and re-runs of rows that were measured while other sessions had the whole machine at ~100% CPU.
  extra: [
    `--route cpu --threads 2 --spin 0 --det yolox_nano --pose rtmpose_m ${P} --tag cpu2ns-A`,
    `--route cpu --threads 2 --spin 0 --det rtmdet_nano --pose rtmpose_m ${P} --tag cpu2ns-Ar`,
    `--route cpu --threads 2 --spin 0 --det yolox_nano --pose rtmw_m_256 ${P} --tag cpu2ns-Bm`,
    `--route cpu --threads 2 --spin 0 --det yolox_nano --pose rtmw_l_256 ${P} --tag cpu2ns-B`,
    `--route cpu --threads 1 --spin 0 --det yolox_nano --pose rtmpose_m ${P} --tag cpu1ns-A`,
    `--route cpu --threads 1 --spin 0 --det rtmdet_nano --pose rtmpose_m ${P} --tag cpu1ns-Ar`,
    `--route cpu --threads 1 --spin 0 --det yolox_nano --pose rtmw_m_256 ${P} --tag cpu1ns-Bm`,
    `--route dml0 --det yolox_nano --pose rtmpose_m ${P} --tag dml0-A2`,
    `--route dml0 --det rtmdet_nano --pose rtmpose_m ${P} --tag dml0-Ar`,
  ],
  det: [
    `--route cpu --threads 4 --det rtmdet_nano --pose rtmpose_m --frames 60 --tag det-cpu4-rtmdet`,
    `--route cpu --threads 4 --det yolox_tiny --pose rtmpose_m --frames 60 --tag det-cpu4-yoloxtiny`,
    `--route dml0 --det rtmdet_nano --pose rtmpose_m --frames 60 --tag det-dml0-rtmdet`,
    `--route dml0 --det yolox_tiny --pose rtmpose_m --frames 60 --tag det-dml0-yoloxtiny`,
  ],
};
const groups = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(runs);
for (const g of groups) {
  for (const a of runs[g]) {
    console.log(`\n##### ${g}: ${a}`);
    const r = spawnSync(process.execPath, [bench, ...a.split(" ")], { stdio: "inherit" });
    if (r.status !== 0) console.log(`!!!!! exit ${r.status}`);
  }
}
