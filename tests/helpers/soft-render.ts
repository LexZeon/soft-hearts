// Development only (never in the suite): a small software renderer for her posed meshes, so a close moment's key frames can be looked at
// next to a storyboard without starting the app. It draws every triangle of her skinned meshes as the page's camera sees them (z-buffer,
// perspective-correct texture lookup, a soft light from the camera), reads the model's own PNG textures when it can (8-bit RGB / RGBA,
// not interlaced; downsampled on load), and writes a PNG. No toon shading, no outlines, no physics: it shows where things are, not how
// pretty they are. I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md "做了").
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { Color, Matrix4, Vector3, Vector4, type Camera, type Material, type SkinnedMesh, type Texture } from 'three';

export interface Picture { width: number; height: number; rgba: Uint8Array }

/** A PNG (8-bit gray, RGB, gray+alpha or RGBA; no interlace) → RGBA, keeping every `step`-th pixel. null when it is something else. */
export function decodePng(bytes: Buffer, maxSide = 1024): Picture | null {
  if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let at = 8, width = 0, height = 0, depth = 0, kind = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; kind = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = kind === 0 ? 1 : kind === 2 ? 3 : kind === 4 ? 2 : kind === 6 ? 4 : 0;
  if (depth !== 8 || !channels || interlace) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, step = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const outW = Math.ceil(width / step), outH = Math.ceil(height / step), out = new Uint8Array(outW * outH * 4);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let p = src[i];
      if (filter === 1) p += a; else if (filter === 2) p += b; else if (filter === 3) p += (a + b) >> 1;
      else if (filter === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = p & 255;
    }
    if (y % step === 0) for (let x = 0; x < width; x += step) {
      const o = ((y / step) * outW + x / step) * 4, s = x * channels;
      if (channels === 1 || channels === 2) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = channels === 2 ? line[s + 1] : 255; }
      else { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = channels === 4 ? line[s + 3] : 255; }
    }
    [prev, line] = [line, prev];
  }
  return { width: outW, height: outH, rgba: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** RGBA → PNG (RGB, the alpha dropped). */
export function encodePng(p: Picture): Buffer {
  const raw = Buffer.alloc((p.width * 3 + 1) * p.height);
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const o = y * (p.width * 3 + 1) + 1 + x * 3, s = (y * p.width + x) * 4;
    raw[o] = p.rgba[s]; raw[o + 1] = p.rgba[s + 1]; raw[o + 2] = p.rgba[s + 2];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(p.width, 0); header.writeUInt32BE(p.height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const textures = new Map<string, Picture | null>();
function textureOf(material: Material, modelDir: string | null): Picture | null {
  const map = (material as { map?: Texture | null }).map, file = (map?.userData as { path?: string } | undefined)?.path;
  if (!file || !modelDir) return null;
  const full = path.resolve(modelDir, file);
  if (!textures.has(full)) textures.set(full, existsSync(full) && /\.png$/i.test(full) ? decodePng(readFileSync(full)) : null);
  return textures.get(full)!;
}

export interface Mark { x: number; y: number; z: number; color: [number, number, number] }
/**
 * Her meshes as `camera` sees them, `width` × `height`. `modelDir`: where the model's textures are (null: plain material colours).
 * `marks`: world points drawn as small dots on top (eyes, mouth, ear), `grid`: faint lines at the fifths of the width.
 */
export function renderMeshes(meshes: readonly SkinnedMesh[], camera: Camera, width: number, height: number,
  options: { modelDir?: string | null; marks?: readonly Mark[]; grid?: boolean; background?: [number, number, number] } = {}): Picture {
  const rgba = new Uint8Array(width * height * 4), depth = new Float32Array(width * height).fill(Infinity), bg = options.background ?? [246, 236, 222];
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255; }
  camera.updateMatrixWorld(true);
  const viewProj = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camPos = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const v = new Vector3(), q = new Vector4(), color = new Color();
  for (const mesh of meshes) {
    if (!mesh.visible) continue;
    mesh.updateMatrixWorld(true);
    const g = mesh.geometry, pos = g.getAttribute('position'), uv = g.getAttribute('uv'), index = g.index, n = pos.count;
    const world = new Float32Array(n * 3), screen = new Float32Array(n * 3), w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, v); mesh.localToWorld(v);
      world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
      q.set(v.x, v.y, v.z, 1).applyMatrix4(viewProj);
      w[i] = q.w; screen[i * 3] = (q.x / q.w * 0.5 + 0.5) * width; screen[i * 3 + 1] = (0.5 - q.y / q.w * 0.5) * height; screen[i * 3 + 2] = q.z / q.w;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = g.groups.length ? g.groups : [{ start: 0, count: index ? index.count : n, materialIndex: 0 }];
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material || !material.visible || (material.transparent && material.opacity < 0.3)) continue;
      const tex = textureOf(material, options.modelDir ?? null), base = (material as { color?: Color }).color ?? color.setRGB(1, 1, 1);
      for (let k = group.start; k < group.start + group.count; k += 3) {
        const ia = index ? index.getX(k) : k, ib = index ? index.getX(k + 1) : k + 1, ic = index ? index.getX(k + 2) : k + 2;
        if (w[ia] <= 1e-6 || w[ib] <= 1e-6 || w[ic] <= 1e-6) continue;
        if (screen[ia * 3 + 2] < -1 || screen[ib * 3 + 2] < -1 || screen[ic * 3 + 2] < -1) continue; // nearer than the near plane: the page would cut it
        const ax = screen[ia * 3], ay = screen[ia * 3 + 1], bx = screen[ib * 3], by = screen[ib * 3 + 1], cx = screen[ic * 3], cy = screen[ic * 3 + 1];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        // A soft light from the camera: the triangle's normal against the way to it.
        const ux = world[ib * 3] - world[ia * 3], uy = world[ib * 3 + 1] - world[ia * 3 + 1], uz = world[ib * 3 + 2] - world[ia * 3 + 2];
        const vx = world[ic * 3] - world[ia * 3], vy = world[ic * 3 + 1] - world[ia * 3 + 1], vz = world[ic * 3 + 2] - world[ia * 3 + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        let lx = camPos.x - world[ia * 3], ly = camPos.y - world[ia * 3 + 1], lz = camPos.z - world[ia * 3 + 2]; const ll = Math.hypot(lx, ly, lz) || 1; lx /= ll; ly /= ll; lz /= ll;
        const light = 0.62 + 0.38 * Math.abs(nx * lx + ny * ly + nz * lz) + 0.08 * ny;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
        if (x0 > x1 || y0 > y1) continue;
        const iwA = 1 / w[ia], iwB = 1 / w[ib], iwC = 1 / w[ic];
        const uA = uv ? uv.getX(ia) : 0, vA = uv ? uv.getY(ia) : 0, uB = uv ? uv.getX(ib) : 0, vB = uv ? uv.getY(ib) : 0, uC = uv ? uv.getX(ic) : 0, vC = uv ? uv.getY(ic) : 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const l0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area, l1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area, l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const z = l0 * screen[ia * 3 + 2] + l1 * screen[ib * 3 + 2] + l2 * screen[ic * 3 + 2], o = y * width + x;
          if (z >= depth[o]) continue;
          let r = base.r, gg = base.g, b = base.b;
          if (tex) {
            const iw = l0 * iwA + l1 * iwB + l2 * iwC, tu = (l0 * uA * iwA + l1 * uB * iwB + l2 * uC * iwC) / iw, tv = (l0 * vA * iwA + l1 * vB * iwB + l2 * vC * iwC) / iw;
            const sx = Math.min(tex.width - 1, Math.max(0, Math.floor((tu - Math.floor(tu)) * tex.width))), sy = Math.min(tex.height - 1, Math.max(0, Math.floor((tv - Math.floor(tv)) * tex.height)));
            const s = (sy * tex.width + sx) * 4;
            if (tex.rgba[s + 3] < 100) continue;
            r *= tex.rgba[s] / 255; gg *= tex.rgba[s + 1] / 255; b *= tex.rgba[s + 2] / 255;
          }
          depth[o] = z;
          rgba[o * 4] = Math.min(255, 255 * r * light); rgba[o * 4 + 1] = Math.min(255, 255 * gg * light); rgba[o * 4 + 2] = Math.min(255, 255 * b * light);
        }
      }
    }
  }
  if (options.grid) for (let f = 1; f < 5; f++) { const x = Math.round(width * f / 5); for (let y = 0; y < height; y += 3) { const o = (y * width + x) * 4; rgba[o] = rgba[o] * 0.7; rgba[o + 1] = rgba[o + 1] * 0.7; rgba[o + 2] = rgba[o + 2] * 0.7 + 60; } }
  for (const mark of options.marks ?? []) {
    q.set(mark.x, mark.y, mark.z, 1).applyMatrix4(viewProj);
    if (q.w <= 0) continue;
    const mx = Math.round((q.x / q.w * 0.5 + 0.5) * width), my = Math.round((0.5 - q.y / q.w * 0.5) * height);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = mx + dx, y = my + dy;
      if (x < 0 || y < 0 || x >= width || y >= height || dx * dx + dy * dy > 5) continue;
      const o = (y * width + x) * 4; rgba[o] = mark.color[0]; rgba[o + 1] = mark.color[1]; rgba[o + 2] = mark.color[2];
    }
  }
  return { width, height, rgba };
}
