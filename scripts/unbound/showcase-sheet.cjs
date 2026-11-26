// Unbound showcase: a labelled contact sheet from chosen stills (development and the morning package). Runs in Electron (it has a
// canvas): electron scripts/unbound/showcase-sheet.cjs <list.json> <out.png>
// list.json: [{ "file": "<png path>", "label": "<text>", "sy": <crop top, fraction, optional> }, ...]; tiles 4 across.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const [listFile, outFile] = process.argv.slice(-2);
app.whenReady().then(async () => {
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  const tiles = list.map(item => ({ label: String(item.label), sy: Number(item.sy ?? 0.04), src: `data:image/png;base64,${fs.readFileSync(item.file).toString('base64')}` }));
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const tiles = ${JSON.stringify(tiles)};
    const cols = 4, w = 640, h = 400, pad = 8, c = document.getElementById('c'), g = c.getContext('2d');
    c.width = cols * w + (cols + 1) * pad; c.height = Math.ceil(tiles.length / cols) * (h + 34) + pad + 10;
    g.fillStyle = '#1b1310'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < tiles.length; i++) {
      const img = new Image(); img.src = tiles[i].src; await img.decode();
      const x = pad + (i % cols) * (w + pad), y = pad + Math.floor(i / cols) * (h + 34);
      // The middle of the frame: her face and hands.
      const sw = img.width * 0.62, sh = sw * h / w, sx = (img.width - sw) / 2, sy = img.height * tiles[i].sy;
      g.drawImage(img, sx, sy, sw, sh, x, y, w, h);
      g.fillStyle = '#f3e9e2'; g.font = '18px "Microsoft YaHei UI", sans-serif'; g.fillText(tiles[i].label, x + 4, y + h + 24);
    }
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(outFile, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  app.exit(0);
}).catch(error => { console.error(String(error)); app.exit(1); }); // never hang on a missing file
