import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    target: "chrome130", chunkSizeWarningLimit: 800,
    // The pet and control windows (index.html) and the Unbound window (src/unbound/index.html, electron/unbound/window.ts).
    rollupOptions: { input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), unbound: fileURLToPath(new URL("./src/unbound/index.html", import.meta.url)),
      // Unbound v1 step 2: the small input box beside her head (electron/unbound/input-window.ts).
      unboundInput: fileURLToPath(new URL("./src/unbound/input.html", import.meta.url)),
      // I-159 C: the card beside her (electron/unbound/card-window.ts).
      unboundCard: fileURLToPath(new URL("./src/unbound/card.html", import.meta.url)),
      // R01 物理调参台 (electron/stage/physics-lab-window.ts): developer only.
      physicsLab: fileURLToPath(new URL("./src/stage/physics-lab/index.html", import.meta.url)) } },
  },
});
