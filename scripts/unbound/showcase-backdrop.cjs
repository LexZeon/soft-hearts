// Unbound showcase, round 14 (development): the live window's own captures (transparent PNGs, never the desktop) composited over a
// light and a dark solid backdrop, side by side, so the alpha edges and her colours can be judged. Also prints the picture size,
// her bounding box (alpha > 8) and the share of pixels that are partly transparent inside her (a veil would show there).
// Runs in Electron (it has a canvas): electron scripts/unbound/showcase-backdrop.cjs <out.png> <capture.png>...
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const args = process.argv.slice(process.argv.findIndex(a => a.endsWith('showcase-backdrop.cjs')) + 1);
const [outFile, ...inputs] = args;
app.whenReady().then(async () => {
  const srcs = inputs.map(f => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const srcs = ${JSON.stringify(srcs)}, stats = [];
    const images = [];
    for (const src of srcs) { const img = new Image(); img.src = src; await img.decode(); images.push(img); }
    // Her box over all captures (alpha > 8), with a margin.
    let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
    for (const img of images) {
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let partial = 0, inside = 0, bx0 = 1e9, by0 = 1e9, bx1 = 0, by1 = 0;
      for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
        const a = d[(y * img.width + x) * 4 + 3];
        if (a > 8) { inside++; if (a < 245) partial++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      }
      stats.push({ w: img.width, h: img.height, box: [bx0, by0, bx1, by1], partialShare: inside ? +(partial / inside).toFixed(3) : null });
      x0 = Math.min(x0, bx0); y0 = Math.min(y0, by0); x1 = Math.max(x1, bx1); y1 = Math.max(y1, by1);
    }
    const m = 40; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(images[0].width, x1 + m); y1 = Math.min(images[0].height, y1 + m);
    const crop = ${JSON.stringify(process.env.BACKDROP_CROP ? process.env.BACKDROP_CROP.split(",").map(Number) : null)}; // x, y, w, h: a close look at one spot
    if (crop) { x0 = crop[0]; y0 = crop[1]; x1 = crop[0] + crop[2]; y1 = crop[1] + crop[3]; }
    const bw = x1 - x0, bh = y1 - y0, scale = crop ? 700 / bh : Math.min(1, 700 / bh), tw = Math.round(bw * scale), th = Math.round(bh * scale);
    const backs = ['#f3f1ec', '#1d1f24'], pad = 10, label = 26;
    const c = document.getElementById('c'); c.width = images.length * 2 * (tw + pad) + pad; c.height = th + 2 * pad + label;
    const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, c.width, c.height);
    images.forEach((img, i) => backs.forEach((back, j) => {
      const x = pad + (i * 2 + j) * (tw + pad);
      g.fillStyle = back; g.fillRect(x, pad, tw, th);
      g.drawImage(img, x0, y0, bw, bh, x, pad, tw, th);
      g.fillStyle = '#111'; g.font = '16px "Microsoft YaHei UI", sans-serif'; g.fillText((j ? '深色' : '浅色') + '背景 #' + (i + 1), x + 4, th + pad + 20);
    }));
    return { png: c.toDataURL('image/png'), stats };
  })()`);
  fs.writeFileSync(outFile, Buffer.from(result.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
  console.log(JSON.stringify(result.stats));
  app.exit(0);
}).catch(error => { console.error(String(error)); app.exit(1); });
