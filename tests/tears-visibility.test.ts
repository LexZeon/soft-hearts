/**
 * R17 "能看到眼泪" (docs/claude/2026-11-06-r17-visible-tears.md). The tears have to be seen, not just exist.
 *
 * Without a GPU, the visibility checks run the shader's own arithmetic (tear-look.ts: tearWet/tearShade, generated
 * from the same TEAR_LOOK numbers as the installed GLSL) across one row of rendered pixels, with each pixel averaged
 * over 8 sub-samples, over Gene's lit skin as measured in the default pet window (sRGB 255/232/216). The pixel size
 * comes from Gene's real eye distance and the default pet framing (400×560 window, full-body camera 47.3 at fov 32,
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
import { ProceduralTears } from '../src/stage/procedural-tears';
import { TEAR_LOOK, TEAR_LOOK_BEFORE_R17, tearColorGlsl, tearMaskGlsl, tearShade, tearWet, type TearLook } from '../src/stage/tear-look';
import { applyMoodEvent, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodSnapshot } from '../shared/mood';
import { geneStage } from './helpers/gene-stage-harness';

const REPORT = !!process.env.R29_REPORT;
const GENE_SHA256 = '0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37';
/** Lit skin beside the tear in the default pet screenshot (2026-11-06, before and after: the skin itself is unchanged). */
const SKIN_SRGB = [255, 232, 216] as const;
/** The default pet: full-body framing of Gene in the 400×560 window (measured in the test build), and the stage's pixel ratio cap. */
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
  const manifest = JSON.parse(await readFile(resolve('shared/bundled-assets.json'), 'utf8'));
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
/** Eye distances per rendered pixel at the default pet size. */
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

/** One accepted reunion after a long absence on the real frame loop (shared/mood.ts decides it; not changed here). */
async function reunion(fps: number, tears: boolean) {
  const h = await geneStage({ fps });
  try {
    h.run(1);
    const surface = new SurfaceSpy();
    if (tears) Object.assign(h.stage, { proceduralTears: surface, tearsVerifiedGene: true, tearsReason: 'R17 harness surface' });
    const now = Date.now(), parameters = structuredClone(DEFAULT_MOOD_PARAMETERS), initial = createMoodState(now, parameters);
    initial.lastInteractionAt = now - parameters.longing.graceMs - 86 / parameters.longing.perHour * 3_600_000;
    const state = applyMoodEvent(initial, { type: 'chat', id: 'r17-reunion', context: 'neutral' }, now, parameters);
    const snapshot = getMoodSnapshot(state, now, parameters);
    assert.equal(snapshot.cryingCandidate, true);
    h.stage.setMood({ characterId: 'gene', token: 'gene_token', revision: 2, developerMode: false, expressions: true, parameters, snapshot });
    const start = h.shown.length - 1, amounts: number[] = [], trail: number[] = [];
    h.run(parameters.longing.cryDurationMs / 1000 + 1, () => { amounts.push(surface.amount); trail.push(surface.elapsedMs); });
    amounts.push(surface.amount);
    const frames = h.shown.slice(start);
    const catches = frames.filter((frame, index) => index && frame.guardJumps !== frames[index - 1].guardJumps).map(frame => frame.guardLast);
    return { amounts, trail, catches };
  } finally { h.close(); }
}

for (const fps of [60, 30]) {
  test(`R29: on the real frame loop at ${fps} fps a cry fades the tears in and out without a flash, and the tears add no display-guard catch`, async () => {
    const { amounts, trail, catches } = await reunion(fps, true), control = await reunion(fps, false);
    {
      const shown = amounts.slice(1);
      const steps = shown.slice(1).map((value, index) => Math.abs(value - shown[index]));
      const firstVisible = shown.find(value => value > 0) ?? 0, lastVisible = [...shown].reverse().find(value => value > 0) ?? 0;
      // The visible change per frame: the strongest colour layer times the change in amount.
      const strongest = Math.max(TEAR_LOOK.rimStrength, TEAR_LOOK.bodyStrength), before = Math.max(TEAR_LOOK_BEFORE_R17.rimStrength, TEAR_LOOK_BEFORE_R17.bodyStrength);
      const maxStep = Math.max(...steps);
      if (REPORT) console.log(`R17 R29 ${fps} fps: frames shown ${shown.filter(v => v > 0).length}, peak ${Math.max(...shown).toFixed(3)}, ` +
        `max amount step ${maxStep.toFixed(4)}, max opacity step now ${(maxStep * strongest).toFixed(4)} (pre-R17 ${(maxStep * before).toFixed(4)}), ` +
        `first ${firstVisible.toFixed(4)}, last ${lastVisible.toFixed(4)}, end ${shown.at(-1)}, guard catches with tears ${JSON.stringify(catches)}, ` +
        `same reunion without a tear surface ${JSON.stringify(control.catches)}`);
      assert.ok(Math.max(...shown) > 0.95, 'the cry reaches its peak');
      assert.equal(shown.at(-1), 0, 'ends at exactly 0');
      assert.ok(firstVisible < 0.05 && lastVisible < 0.05, `no pop in or out (first ${firstVisible}, last ${lastVisible})`);
      // Smoothstep rise over 650 ms is the steepest part: 1.5 / (0.65 s × fps) per frame, plus the frame's own jitter.
      assert.ok(maxStep <= 1.5 / (0.65 * fps) + 0.01, `amount step ${maxStep}`);
      assert.ok(maxStep * strongest <= 0.06, 'the tear colour never changes by more than 6% in one frame');
      // Never flickers: rises, holds, falls (no frame goes back the other way by more than float noise).
      const peakAt = shown.indexOf(Math.max(...shown));
      assert.ok(shown.slice(0, peakAt).every((v, i) => i === 0 || v >= shown[i - 1] - 1e-9) && shown.slice(peakAt).every((v, i, a) => i === 0 || v <= a[i - 1] + 1e-9));
      // The trail grows with the cry's own clock, frame by frame, never jumping ahead.
      const trailSteps = trail.slice(1).map((v, i) => v - trail[i]).filter(v => v > 0);
      assert.ok(Math.max(...trailSteps) <= 1000 / fps + 2, 'the trail clock advances one frame at a time');
      // Tears own no bone or morph, so the guard sees exactly what the same reunion shows without them. And the reunion
      // itself needs no catch: its troubled brow (困る) eases in (docs/claude/2026-11-06-reunion-brow-jump.md).
      assert.deepEqual(catches, control.catches, 'the tears add no display-guard catch');
      assert.deepEqual(control.catches, [], 'the reunion frame needs no display-guard catch, with or without tears');
      assert.ok(catches.every(property => !/tear/i.test(property ?? '')));
      assert.equal(control.amounts.every(value => value === 0), true, 'without a surface nothing is shown');
    }
  });
}
