// Pose feasibility bench: minimal stand-alone Electron host for the browser-side routes
// (onnxruntime-web WebGPU / wasm / WebNN and MediaPipe tasks-vision). NOT product code, never started by the app.
// Run with the repository's electron binary and an isolated temporary profile:
//   electron.exe scripts/pose-bench/electron/main.cjs --task <name> --params '<json>' --tag <name>
// It serves the bench folder read-only on 127.0.0.1 (random port, COOP/COEP set so wasm threads work), opens one hidden
// window, lets the page report a result JSON to /api/report, writes it to <bench>/runs/<tag>.json and quits.
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const argv = process.argv.slice(2);
const arg = (n, d = "") => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const BENCH = process.env.POSE_BENCH_DIR || path.join(process.env.LOCALAPPDATA, "soft-hearts-next-bench");
const HERE = __dirname, LIB = path.join(HERE, "..", "lib");
const task = arg("task", "info"), tag = arg("tag", task), params = arg("params", "{}");
const profile = path.join(BENCH, "electron-profile", `${tag}-${Date.now()}`);
if (!profile.includes("soft-hearts-next-bench")) throw new Error("profile must live in the bench folder");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
// WebNN is behind a feature flag in Chromium; enabling it here affects only this throw-away process.
app.commandLine.appendSwitch("enable-features", "WebMachineLearningNeuralNetwork");
app.commandLine.appendSwitch("enable-unsafe-webgpu");

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".task": "application/octet-stream", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const ROOTS = { "/lib/": LIB, "/page/": HERE, "/bench/": BENCH };
let samplers = new Map();
let result = null;

function serve(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/api/report" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      result = Buffer.concat(chunks).toString("utf8");
      fs.mkdirSync(path.join(BENCH, "runs"), { recursive: true });
      fs.writeFileSync(path.join(BENCH, "runs", `${tag}.json`), result);
      res.end("ok");
      setTimeout(() => app.quit(), 300);
    });
    return;
  }
  if (url.pathname === "/api/log") { console.log("[page]", url.searchParams.get("m")); res.end("ok"); return; }
  if (url.pathname === "/api/params") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ task, tag, params: JSON.parse(params) })); return; }
  if (url.pathname === "/api/list") { // directory listing of the bench image folders only
    const dir = path.join(BENCH, "images", url.searchParams.get("dir") || "");
    if (!dir.startsWith(path.join(BENCH, "images"))) { res.statusCode = 403; res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => f.replace(/\\/g, "/"))));
    return;
  }
  if (url.pathname === "/api/sampler/start") {
    const label = url.searchParams.get("label"), seconds = Number(url.searchParams.get("seconds"));
    const pids = app.getAppMetrics().map((m) => String(m.pid));
    import(pathToFileURL(path.join(LIB, "sampling.mjs")).href).then(({ startSampler }) => {
      const out = path.join(BENCH, "runs", `${tag}-${label}.sample.json`);
      samplers.set(label, { promise: startSampler(pids, seconds, out), pids, startedAt: Date.now() });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ pids, types: app.getAppMetrics().map((m) => `${m.type}:${m.pid}`) }));
    });
    return;
  }
  if (url.pathname === "/api/sampler/finish") {
    const label = url.searchParams.get("label"), from = Number(url.searchParams.get("from")), to = Number(url.searchParams.get("to"));
    const s = samplers.get(label);
    import(pathToFileURL(path.join(LIB, "sampling.mjs")).href).then(async ({ reduce }) => {
      const raw = await s.promise;
      res.setHeader("Content-Type", "application/json");
      if (!raw) { res.end(JSON.stringify({ error: "sampler failed" })); return; }
      raw.samples = raw.samples.filter((x) => { const t = Date.parse(x.t); return t >= from + 500 && t <= to + 500; });
      raw.samples.unshift(raw.samples[0] ?? { t: "", sysCpu: 0, procs: {}, gpu: [] });
      res.end(JSON.stringify({ ...reduce(raw, s.pids), pids: s.pids }));
    });
    return;
  }
  for (const [prefix, root] of Object.entries(ROOTS)) {
    if (!url.pathname.startsWith(prefix)) continue;
    const rel = decodeURIComponent(url.pathname.slice(prefix.length));
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || (prefix === "/bench/" && !/^(models|images|npm|downloads)[\\/]/.test(rel))) { res.statusCode = 403; res.end("forbidden"); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; res.end("not found"); return; }
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Length", st.size);
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.statusCode = 404; res.end("not found");
}

app.whenReady().then(async () => {
  const server = http.createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on("console-message", (_e, level, message) => console.log(`[console ${level}]`, String(message).slice(0, 400)));
  win.webContents.on("render-process-gone", (_e, d) => { console.log("renderer gone", d); app.quit(); });
  await win.loadURL(`http://127.0.0.1:${port}/page/index.html`);
  const maxMs = Number(arg("timeout", String(25 * 60_000)));
  setTimeout(() => { console.log("timeout"); app.exit(2); }, maxMs).unref();
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => { if (!result) process.exitCode = 3; });
