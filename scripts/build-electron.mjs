import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
await build({
  entryPoints: { main: "electron/desktop-entry.ts", preload: "electron/safety/preload.ts", "reply-preload": "electron/brain/reply-preload.ts", "single-emoji-preload": "electron/stage/single-emoji-preload.ts",
    // Local pose sensing (I-001): the utilityProcess entry and the hidden sensor window's preload.
    "pose-worker": "electron/senses/pose/worker.ts", "pose-sensor-preload": "electron/senses/pose/sensor-preload.ts",
    // Local speech recognition (voice input): the utilityProcess entry.
    "asr-worker": "electron/senses/asr/worker.ts",
    // Local recall by meaning (I-111): the embedding utilityProcess entry.
    "semantic-worker": "electron/memory/memory-semantic/worker.ts",
    // I-135 认出"不是你": the face-check utilityProcess entry.
    "face-worker": "electron/senses/face/worker.ts",
    // Unbound v1 step 3 只认你的声音: the voiceprint utilityProcess entry.
    "voiceprint-worker": "electron/senses/voiceprint/worker.ts",
    // Unbound U1: the Unbound window's preload (electron/unbound/window.ts UNBOUND_PRELOAD).
    "unbound-preload": "electron/unbound/preload.ts",
    // Unbound v1 step 2: the small input box's preload (electron/unbound/window-options.ts UNBOUND_INPUT_PRELOAD).
    "unbound-input-preload": "electron/unbound/input-preload.ts",
    // I-159 C: the card beside her (electron/unbound/window-options.ts UNBOUND_CARD_PRELOAD).
    "unbound-card-preload": "electron/unbound/card-preload.ts",
    // R01 物理调参台: the developer lab window's preload (electron/stage/physics-lab-window.ts PHYSICS_LAB_PRELOAD).
    "physics-lab-preload": "electron/stage/physics-lab-preload.ts" },
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
// Licence texts copied into every installed pose component (electron/senses/pose/component-store.ts).
mkdirSync("dist-electron/pose-licenses", { recursive: true });
for (const name of readdirSync("electron/senses/pose/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/senses/pose/licenses/${name}`, `dist-electron/pose-licenses/${name}`);
// The speech component carries the same runtime licences (not pose's README) plus its own model licence and README.
mkdirSync("dist-electron/asr-licenses", { recursive: true });
for (const name of readdirSync("electron/senses/pose/licenses")) if (name.endsWith(".txt") && name !== "README.txt") copyFileSync(`electron/senses/pose/licenses/${name}`, `dist-electron/asr-licenses/${name}`);
for (const name of readdirSync("electron/senses/asr/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/senses/asr/licenses/${name}`, `dist-electron/asr-licenses/${name}`);
// Recall by meaning carries the same runtime licences plus the model's licence and README.
mkdirSync("dist-electron/semantic-licenses", { recursive: true });
for (const name of readdirSync("electron/senses/pose/licenses")) if (name.endsWith(".txt") && name !== "README.txt") copyFileSync(`electron/senses/pose/licenses/${name}`, `dist-electron/semantic-licenses/${name}`);
for (const name of readdirSync("electron/memory/memory-semantic/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/memory/memory-semantic/licenses/${name}`, `dist-electron/semantic-licenses/${name}`);
// The face check carries the same runtime licences plus YuNet's and SFace's licences and its README (I-135).
mkdirSync("dist-electron/face-licenses", { recursive: true });
for (const name of readdirSync("electron/senses/pose/licenses")) if (name.endsWith(".txt") && name !== "README.txt") copyFileSync(`electron/senses/pose/licenses/${name}`, `dist-electron/face-licenses/${name}`);
for (const name of readdirSync("electron/senses/face/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/senses/face/licenses/${name}`, `dist-electron/face-licenses/${name}`);
// The voiceprint carries the same runtime licences plus CAM++'s licence and its README (Unbound v1 step 3).
mkdirSync("dist-electron/voiceprint-licenses", { recursive: true });
for (const name of readdirSync("electron/senses/pose/licenses")) if (name.endsWith(".txt") && name !== "README.txt") copyFileSync(`electron/senses/pose/licenses/${name}`, `dist-electron/voiceprint-licenses/${name}`);
for (const name of readdirSync("electron/senses/voiceprint/licenses")) if (name.endsWith(".txt")) copyFileSync(`electron/senses/voiceprint/licenses/${name}`, `dist-electron/voiceprint-licenses/${name}`);
// 体验记录 (E2): the commit this build came from, for the journal's "应用启动" line (electron/memory/journal/app-journal.ts readBuildCommit).
// SOFT_HEARTS_BUILD_COMMIT wins (a build from an exported tree has no .git); otherwise git; unknown stays null.
let buildCommit = (process.env.SOFT_HEARTS_BUILD_COMMIT ?? "").trim().toLowerCase();
if (!/^[0-9a-f]{7,40}$/.test(buildCommit)) {
  try { buildCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { buildCommit = ""; }
}
writeFileSync("dist-electron/build-info.json", JSON.stringify({ commit: /^[0-9a-f]{7,40}$/.test(buildCommit) ? buildCommit : null, builtAt: new Date().toISOString() }) + "\n");
