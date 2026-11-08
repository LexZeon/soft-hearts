// Pose feasibility bench: launch the stand-alone Electron test window for one task (isolated temp profile in the bench folder).
// Usage: node run-electron.mjs <task> <tag> '<params json>'
//   e.g. node run-electron.mjs ortweb web-gpu-A '{"ep":"webgpu","det":"yolox_nano","pose":"rtmpose_m","paced":[5,10]}'
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const electron = path.join(repo, "node_modules", "electron", "dist", "electron.exe");
if (!existsSync(electron)) throw new Error("electron not found at " + electron);
const [task, tag = task, params = "{}"] = process.argv.slice(2);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [path.join(here, "electron", "main.cjs"), "--task", task, "--tag", tag, "--params", params], { stdio: "inherit", env });
console.log("electron exit", r.status);
