/**
 * R17 "能看到眼泪" (docs/claude/2026-11-06-r17-visible-tears.md). The tears have to be seen, not just exist.
 *
 * Without a GPU, the visibility checks run the shader's own arithmetic (tear-look.ts: tearWet/tearShade, generated
 * from the same TEAR_LOOK numbers as the installed GLSL) across one row of rendered pixels, with each pixel averaged
 * over 8 sub-samples, over Gene's lit skin as measured in the default companion window (sRGB 255/232/216). The pixel size
 * comes from Gene's real eye distance and the default companion framing (400×560 window, full-body camera 47.3 at fov 32,
 * rendered at the stage's capped pixel ratio 1.5, or 1 on a plain monitor). The pre-R17 look (TEAR_LOOK_BEFORE_R17)
 * runs through the same checks and must fail them: that is the "看不见" regression these tests exist to catch.
 * The screenshots and their measured contrast are in the record; this file only guards the numbers.
 *
 * R29: the cry on the real Stage frame loop (gene-stage-harness) at 60 and 30 fps: the tear fades in and out in
 * small steps (no flash, no pop), starts and ends at exactly 0, and the display guard catches nothing, with or without
 * the tears.
 * R29_REPORT=1 prints the per-frame numbers for the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ShaderMaterial, SkinnedMesh, Texture } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { probeBlushAnchors } from '../src/stage/procedural-blush';
import { ProceduralTears } from '../src/mood/procedural-tears';
import { TEAR_LOOK, TEAR_LOOK_BEFORE_R17, tearColorGlsl, tearMaskGlsl, tearShade, tearWet, type TearLook } from '../src/mood/tear-look';

const REPORT = !!process.env.R29_REPORT;
const GENE_SHA256 = '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
/** Lit skin beside the tear in the default companion screenshot (2026-11-06, before and after: the skin itself is unchanged). */
const SKIN_SRGB = [255, 232, 216] as const;
/** The default companion: full-body framing of Gene in the 400×560 window (measured in the test build), and the stage's pixel ratio cap. */
const PET = { cssHeight: 560, distance: 47.3, fov: 32 } as const;

const toLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));
const luminance = (rgb: readonly number[]) => 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
function lab(rgb: readonly number[]) {
  const [r, g, b] = rgb.map(toLinear), f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: readonly number[], b: readonly number[]) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const SKIN_LINEAR = SKIN_SRGB.map(toLinear) as [number, number, number];

/** One rendered pixel at (column, row) around a point in eye distances, averaged over 8×8 sub-samples, as 8-bit sRGB. */
function pixelAt(look: TearLook, pixel: number, cx: number, cy: number, timeS: number, amount = 1) {
  const sum = [0, 0, 0];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const shaded = tearShade(SKIN_LINEAR, tearWet(cx + ((i + 0.5) / 8 - 0.5) * pixel, cy + ((j + 0.5) / 8 - 0.5) * pixel, pixel, timeS, -1, 0, look), amount, look);
    for (let k = 0; k < 3; k++) sum[k] += shaded[k] / 64;
  }
  return sum.map(toSrgb);
}
/** A row of pixels across the left trail at `depth` eye distances below the eye: per pixel, colour distance and luminance contrast to the skin. */
function across(look: TearLook, pixel: number, depth: number, timeS: number, amount = 1) {
  const y = depth - look.start, centre = -(0.018 * y + 0.018 * Math.sin(y * 5));
  const row = [];
  for (let k = -12; k <= 12; k++) {
    const rgb = pixelAt(look, pixel, centre + k * pixel, depth, timeS, amount);
    row.push({ deltaE: deltaE(rgb, SKIN_SRGB), contrast: (luminance(rgb) - luminance(SKIN_SRGB)) / luminance(SKIN_SRGB) });
  }
  return row;
}
const visibility = (row: ReturnType<typeof across>) => ({
  strong: row.filter(p => p.deltaE >= 15).length,
  darkest: Math.min(...row.map(p => p.contrast)),
  maxDeltaE: Math.max(...row.map(p => p.deltaE)),
});

async function gene() {
  const manifest = JSON.parse(await readFile(resolve('shared/actions/bundled-assets.json'), 'utf8'));
  const bytes = await readFile(resolve('assets/bundled', manifest.root, manifest.model.relativePath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), GENE_SHA256);
  const parserModule = 'three/examples/jsm/libs/mmdparser.module.js';
  const { MMDParser } = await import(parserModule);
  const parsed = new MMDParser.Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
  const loader = new MMDLoader() as any;
  loader.meshBuilder.materialBuilder._loadTexture = () => { const texture = new Texture() as Texture & { readyCallbacks: unknown[] }; texture.readyCallbacks = []; return texture; };
  const mesh = loader.meshBuilder.build(parsed, '') as SkinnedMesh;
  const head = mesh.skeleton.bones.find(bone => bone.name === '頭')!;
  const eyes = ['左目', '右目'].map(name => mesh.skeleton.bones.find(bone => bone.name === name)!);
  const probe = probeBlushAnchors(mesh, head, eyes);
  assert.ok(probe.anchors, probe.reason);
  return { mesh, head, anchors: probe.anchors, close() { mesh.geometry.dispose(); mesh.skeleton.dispose(); for (const m of mesh.material as ShaderMaterial[]) m.dispose(); } };
}
let eyeDistance: number | null = null;
async function geneEyeDistance() {
  if (eyeDistance === null) { const g = await gene(); eyeDistance = g.anchors.eyeDistance; g.close(); }
  return eyeDistance;
}
/** Eye distances per rendered pixel at the default companion size. */
async function defaultPixel(pixelRatio: number) {
  const unitsPerCssPixel = 2 * PET.distance * Math.tan(PET.fov / 2 * Math.PI / 180) / PET.cssHeight;
  return unitsPerCssPixel / pixelRatio / await geneEyeDistance();
}

test('at the peak of a cry the tear trail stands out from her skin at the default pet size, by colour and by brightness', async () => {
  for (const ratio of [1.5, 1]) {
    const pixel = await defaultPixel(ratio);
    // Gene's eyes are ~29 rendered pixels apart here (~20 on a plain monitor): the reason a 1-pixel tear was lost.
    assert.ok(1 / pixel > 15 && 1 / pixel < 40, `eye distance ${1 / pixel} px`);
    for (const depth of [0.25, 0.45]) {
      const now = visibility(across(TEAR_LOOK, pixel, depth, 3));
      assert.ok(now.strong >= 2, `ratio ${ratio}, ${depth}: at least 2 px clearly coloured (ΔE ≥ 15), got ${now.strong}`);
      assert.ok(now.darkest <= -0.12, `ratio ${ratio}, ${depth}: the wet rim is at least 12% darker than the skin, got ${now.darkest.toFixed(3)}`);
      const before = visibility(across(TEAR_LOOK_BEFORE_R17, pixel, depth, 3));
      assert.ok(before.strong < 2 && before.darkest > -0.12, `the pre-R17 look must fail this check (${JSON.stringify(before)})`);
      if (REPORT) console.log(`R17 trail ratio ${ratio} depth ${depth}: before ${JSON.stringify(before)} now ${JSON.stringify(now)}`);
    }
  }
});

test('a drop sliding down the trail is a visible blob at the default pet size', async () => {
  const pixel = await defaultPixel(1.5);
  /** Clearly coloured pixels (ΔE ≥ 15) per row of a 13×13 window: the drop is what sticks out beyond the trail itself. */
  const count = (look: TearLook) => {
    // Halfway down the trail: the left bead's progress is 0.5.
    const timeS = 0.12 + 0.5 / look.beadSpeed, depth = look.start + 0.5 * look.length;
    const rows: number[] = [];
    for (let row = -6; row <= 6; row++) {
      const y = depth - look.start + row * pixel, centre = -(0.018 * y + 0.018 * Math.sin(y * 5));
      let strong = 0;
      for (let col = -6; col <= 6; col++) if (deltaE(pixelAt(look, pixel, centre + col * pixel, depth + row * pixel, timeS), SKIN_SRGB) >= 15) strong++;
      rows.push(strong);
    }
    const trail = Math.min(...rows), beyond = rows.reduce((sum, value) => sum + value - trail, 0);
    return { trail, widest: Math.max(...rows), beyond };
  };
  const now = count(TEAR_LOOK), before = count(TEAR_LOOK_BEFORE_R17);
  if (REPORT) console.log(`R17 bead (13×13 px window): before ${JSON.stringify(before)} now ${JSON.stringify(now)}`);
  assert.ok(now.widest > now.trail, `the drop is wider than its trail (${JSON.stringify(now)})`);
  assert.ok(now.beyond >= 8, `the drop adds at least 8 clearly coloured px beyond the trail, got ${now.beyond}`);
  assert.ok(before.beyond < 8, `the pre-R17 drop must fail this check (${JSON.stringify(before)})`);
});

test('close up it stays a translucent streak, not a painted sticker', async () => {
  // Face filling most of the window: ~140 rendered px between the eyes. The minimum-pixel widening is off here.
  const pixel = 1 / 140, row = across(TEAR_LOOK, pixel, 0.3, 3);
  const coloured = row.filter(p => p.deltaE >= 8).length;
  assert.ok(coloured <= 14, `a narrow streak (≤ 0.1 eye distance), got ${coloured} px`);
  // Skin shows through everywhere: no pixel darker than 60% of the skin, and the two colour layers together never cover it.
  assert.ok(Math.min(...row.map(p => p.contrast)) >= -0.4, 'no opaque dark band');
  assert.ok(1 - (1 - TEAR_LOOK.rimStrength) * (1 - TEAR_LOOK.bodyStrength) <= 0.8, 'at most 80% coverage at the very centre');
  // At the default size the widening is bounded too.
  assert.ok(TEAR_LOOK.maxWiden <= 3 && TEAR_LOOK.minBodyPx <= 2 && TEAR_LOOK.beadMinPx <= 3);
  // And a cry at half strength (fading) is still a tear, only fainter: never stronger than the peak.
  const half = visibility(across(TEAR_LOOK, await defaultPixel(1.5), 0.3, 3, 0.5)), full = visibility(across(TEAR_LOOK, await defaultPixel(1.5), 0.3, 3, 1));
  assert.ok(half.maxDeltaE < full.maxDeltaE && half.darkest > full.darkest);
});

test("Gene's installed face and cheek-cover shaders are the code generated from TEAR_LOOK", async () => {
  const g = await gene();
  try {
    const tears = new ProceduralTears(g.head, g.anchors, g.mesh, true);
    assert.equal(tears.getState().supported, true); assert.deepEqual(tears.getState().materialIndices, [3, 8]);
    for (const index of [3, 8]) {
      const material = (g.mesh.material as ShaderMaterial[])[index];
      const shader = { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader, uniforms: material.uniforms };
      material.onBeforeCompile(shader as any, {} as any);
      assert.ok(shader.fragmentShader.includes(tearMaskGlsl()), `material ${index} mask`);
      assert.ok(shader.fragmentShader.includes(tearColorGlsl()), `material ${index} colour`);
      assert.ok(!shader.fragmentShader.includes(tearMaskGlsl(TEAR_LOOK_BEFORE_R17)));
    }
    tears.dispose();
  } finally { g.close(); }
});

class SurfaceSpy {
  amount = 0; elapsedMs = 0;
  update(amount: number, elapsedMs: number) { this.amount = amount; this.elapsedMs = elapsedMs; }
  dispose() { this.amount = 0; }
  getState() { return { supported: true, reason: 'R17 harness surface', amount: this.amount, elapsedMs: this.elapsedMs }; }
}
