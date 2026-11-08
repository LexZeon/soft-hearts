import { createServer } from "vite";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { prepareSourceProfile } from "./source-profile.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// pnpm dev never uses the user's real profile: the development profile, seeded once from stable (scripts/source-profile.mjs).
const profile = await prepareSourceProfile(root);
if (profile.message) console.log(profile.message);
await import("./build-electron.mjs");
const server = await createServer();
await server.listen();
const env = { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, profile.argument], {
  stdio: "inherit",
  env,
  windowsHide: true,
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
