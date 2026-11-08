import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
await build({
  entryPoints: { main: "electron/desktop-entry.ts", preload: "electron/preload.ts", "reply-preload": "electron/reply-preload.ts", "single-emoji-preload": "electron/single-emoji-preload.ts",
    // Local pose sensing (I-001): the utilityProcess entry and the hidden sensor window's preload.
    "pose-worker": "electron/pose/worker.ts", "pose-sensor-preload": "electron/pose/sensor-preload.ts",
    // Local speech recognition (voice input): the utilityProcess entry.
    "asr-worker": "electron/asr/worker.ts" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "original-fs", "@openai/codex-sdk"],
  sourcemap: true,
});
// The sensor window's page: empty, no script (the preload does the capture), nothing may load.
writeFileSync("dist-electron/pose-sensor.html", '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>pose sensor</title>\n');
// Licence texts copied into every installed pose component (electron/pose/component-store.ts).
mkdirSync("dist-electron/pose-licenses", { recursive: true });
for (const name of readdirSync("electron/pose/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/pose/licenses/${name}`, `dist-electron/pose-licenses/${name}`);
// The speech component carries the same runtime licences (not pose's README) plus its own model licence and README.
mkdirSync("dist-electron/asr-licenses", { recursive: true });
for (const name of readdirSync("electron/pose/licenses")) if (name.endsWith(".txt") && name !== "README.txt") copyFileSync(`electron/pose/licenses/${name}`, `dist-electron/asr-licenses/${name}`);
for (const name of readdirSync("electron/asr/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/asr/licenses/${name}`, `dist-electron/asr-licenses/${name}`);
// 体验记录 (E2): the commit this build came from, for the journal's "应用启动" line (electron/journal/app-journal.ts readBuildCommit).
// SOFT_HEARTS_BUILD_COMMIT wins (a build from an exported tree has no .git); otherwise git; unknown stays null.
let buildCommit = (process.env.SOFT_HEARTS_BUILD_COMMIT ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{7,40}$/.test(buildCommit)) {
  try { buildCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { buildCommit = ""; }
}
writeFileSync("dist-electron/build-info.json", JSON.stringify({ commit: /^[0-9a-f]{7,40}$/.test(buildCommit) ? buildCommit : null, builtAt: new Date().toISOString() }) + "\n");
