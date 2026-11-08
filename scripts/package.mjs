import { spawn } from "node:child_process";
import { packagingArguments } from './setup-platform.mjs';
const builderArguments = packagingArguments(process.platform, process.arch, process.argv.slice(2));
await import("./verify-bundled-assets.mjs");
function run(script, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [script, ...args], {
      stdio: "inherit",
      windowsHide: true,
    });
    process.on("error", reject);
    process.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Packaging step failed (${code})`)),
    );
  });
}
await run("node_modules/typescript/bin/tsc", ["--noEmit"]);
await run("node_modules/vite/bin/vite.js", ["build"]);
await import("./build-electron.mjs");
await run(
  "node_modules/electron-builder/out/cli/cli.js",
  builderArguments,
);
