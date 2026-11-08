// Pose feasibility bench: run sampler.ps1 and reduce its raw output. NOT product code.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sampler.ps1");
export const LOGICAL_CPUS = 20;

/** Start the sampler; resolves with the raw JSON object when it finishes. */
export function startSampler(pids, seconds, outFile) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SAMPLER, "-TargetPids", pids.join(","), "-Seconds", String(seconds), "-Out", outFile], { stdio: "ignore", windowsHide: true });
  return new Promise((resolve) => {
    child.on("exit", () => resolve(existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8").replace(/^﻿/, "")) : null));
  });
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Reduce raw samples. The first sample is dropped (counters need two reads for rates).
 * procCores = process CPU in cores (100% of one core = 1). procPctOfMachine = share of all 20 logical CPUs.
 * GPU: per (luid, engine) sum of the target processes' utilisation, grouped by engine type; reported as the busiest engine.
 */
export function reduce(raw, pids) {
  const s = raw.samples.slice(1);
  const out = { seconds: s.length, sysCpuPct: mean(s.map((x) => x.sysCpu)) };
  const procCpu = s.map((x) => pids.reduce((a, p) => a + (x.procs?.[p]?.["% processor time"] ?? 0), 0));
  const ws = s.map((x) => pids.reduce((a, p) => a + (x.procs?.[p]?.["working set"] ?? 0), 0));
  const priv = s.map((x) => pids.reduce((a, p) => a + (x.procs?.[p]?.["private bytes"] ?? 0), 0));
  out.procCores = mean(procCpu) / 100;
  out.procPctOfMachine = (mean(procCpu) / (100 * LOGICAL_CPUS)) * 100;
  out.workingSetMB = mean(ws) / 1048576; out.workingSetMaxMB = Math.max(0, ...ws) / 1048576;
  out.privateMB = mean(priv) / 1048576; out.privateMaxMB = Math.max(0, ...priv) / 1048576;
  // GPU engines
  const byType = {}; // engtype -> per-sample busiest engine for target pids
  const luids = new Set();
  s.forEach((x, i) => {
    const per = {}; // key luid|eng|type -> sum
    for (const [inst, val] of x.gpu ?? []) {
      const m = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.+)$/i.exec(inst);
      if (!m || !pids.includes(m[1])) continue;
      luids.add(m[2]);
      const key = `${m[2]}|${m[3]}_${m[4]}|${m[5]}`;
      per[key] = (per[key] ?? 0) + val;
    }
    const best = {};
    for (const [key, v] of Object.entries(per)) { const type = key.split("|")[2]; best[type] = Math.max(best[type] ?? 0, v); }
    for (const t of new Set([...Object.keys(best), ...Object.keys(byType)])) (byType[t] ??= new Array(s.length).fill(0))[i] = best[t] ?? 0;
  });
  out.gpuByEngineType = Object.fromEntries(Object.entries(byType).map(([t, a]) => [t, +mean(a).toFixed(2)]));
  out.gpuLuids = [...luids];
  // whole-machine GPU, busiest 3D / compute engine (context for background load)
  const sys = {};
  s.forEach((x) => {
    const per = {};
    for (const [inst, val] of x.gpu ?? []) {
      const m = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.+)$/i.exec(inst);
      if (!m) continue;
      const key = `${m[1]}|${m[2]}_${m[3]}|${m[4]}`;
      per[key] = (per[key] ?? 0) + val;
    }
    const best = {};
    for (const [key, v] of Object.entries(per)) { const type = key.split("|")[2]; best[type] = Math.max(best[type] ?? 0, v); }
    for (const [t, v] of Object.entries(best)) (sys[t] ??= []).push(v);
  });
  out.gpuSystemBusiestEngine = Object.fromEntries(Object.entries(sys).map(([t, a]) => [t, +(a.reduce((x, y) => x + y, 0) / s.length).toFixed(2)]));
  return out;
}
