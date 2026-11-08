/**
 * R17 "能看到眼泪" (docs/claude/2026-11-06-r17-visible-tears.md): how the procedural tears look, in one place.
 *
 * Everything that decides whether a tear can be seen lives here: trail and bead size (in displayed eye distances),
 * the on-screen minimum width (in rendered pixels), colours and strengths. The GLSL that procedural-tears.ts installs
 * is generated from these numbers, and `tearWet` / `tearShade` below are the same arithmetic in JavaScript so tests can
 * check, without a GPU, that a peak tear still stands out from Gene's skin at the default pet size
 * (tests/tears-visibility.test.ts). Change a number here and both follow; change the formula in one, change the other.
 *
 * Not mood parameters: when she cries, for how long and how strongly stay in shared/mood.ts and crying-timeline.ts.
 */
type Rgb = readonly [number, number, number];
export interface TearLook {
  start: number; length: number; growPerSecond: number; width: number; taper: number; minBodyPx: number; maxWiden: number;
  beadWidth: number; beadHeight: number; beadMinPx: number; beadSpeed: number;
  rimColor: Rgb; rimStrength: number; bodyColor: Rgb; bodyStrength: number; glintColor: Rgb; glintStrength: number;
  /** Highlight weight on the trail body; 0.6 unless set (only the pre-R17 look sets it). */
  glintBodyScale?: number;
}

export const TEAR_LOOK: Readonly<TearLook> = Object.freeze<TearLook>({
  /** Trail starts this far below the eye centre and runs this long once grown (eye distances). */
  start: 0.13,
  length: 0.58,
  /** How fast the trail grows down the cheek (eye distances per second). */
  growPerSecond: 0.65,
  /** Half-width of the wet body at the top of the trail (eye distances); it narrows by `taper` towards the end. */
  width: 0.03,
  taper: 0.3,
  /**
   * The body never draws thinner than this many rendered pixels per side, so at the default pet size (Gene's eyes
   * ~29 px apart) the trail is ~3 px wide instead of ~1 px; close up the eye-distance width above wins. `maxWiden`
   * caps the widening (grazing angles, tiny windows).
   */
  minBodyPx: 1.5,
  maxWiden: 2.5,
  /** Bead (a drop sliding down the trail): half-size in eye distances, minimum half-width in pixels, loops per second. */
  beadWidth: 0.046,
  beadHeight: 0.07,
  beadMinPx: 2.2,
  beadSpeed: 0.48,
  /** Linear-light colours mixed over the lit skin: a darker wet rim, a lighter translucent body, a white glint. */
  rimColor: [0.16, 0.36, 0.58],
  rimStrength: 0.55,
  bodyColor: [0.56, 0.82, 0.96],
  bodyStrength: 0.45,
  glintColor: [0.85, 0.94, 1.0],
  glintStrength: 0.75,
});

/** The older look (until 2026-11-06), kept only so tests can show the visibility check catches it. */
export const TEAR_LOOK_BEFORE_R17: Readonly<TearLook> = Object.freeze<TearLook>({
  ...TEAR_LOOK, width: 0.022, taper: 0.35, minBodyPx: 0, maxWiden: 1, beadWidth: 0.036, beadHeight: 0.057, beadMinPx: 0, beadSpeed: 0.52,
  rimColor: [0.27, 0.55, 0.72], rimStrength: 0.32, bodyColor: [0.54, 0.84, 0.96], bodyStrength: 0.6,
  glintColor: [0.75, 0.88, 0.94], glintStrength: 0.65, glintBodyScale: 0.36,
});


const f = (n: number) => n.toFixed(4);
const v3 = (c: Rgb) => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;
/** Highlight weight on the trail body (the bead has its own glint). */
const glintOnTrail = (look: TearLook) => look.glintBodyScale ?? 0.6;

/**
 * GLSL for the fragment-shader mask. `vShTearsHead` and the uniforms come from procedural-tears.ts.
 * Returns (rim, body, glint) weights in 0..1 for one eye; `side` mirrors the curve, `phase` offsets the bead.
 */
export function tearMaskGlsl(look: TearLook = TEAR_LOOK): string {
  return `
vec3 shTearsMask(vec3 origin, float side, float phase) {
  vec3 offset = (vShTearsHead - origin) / shTearsScale;
  vec2 p = vec2(dot(offset, shTearsAxisX), -dot(offset, shTearsAxisY));
  // Eye distances per rendered pixel across the trail: keeps a minimum on-screen width at small pet sizes.
  float pixel = max(length(vec2(dFdx(p.x), dFdy(p.x))), 1e-6);
  float y = p.y - ${f(look.start)};
  float trailLength = min(${f(look.length)}, max(0.0, shTearsTime) * ${f(look.growPerSecond)});
  float curve = side * (0.018 * y + 0.018 * sin(y * 5.0));
  float x = p.x - curve;
  float natural = ${f(look.width)} * (1.0 - ${f(look.taper)} * clamp(y / ${f(look.length)}, 0.0, 1.0));
  float width = clamp(${f(look.minBodyPx)} * pixel, natural, natural * ${f(look.maxWiden)});
  float ends = smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(max(0.0, trailLength - 0.07), max(0.001, trailLength), y));
  float trail = (1.0 - smoothstep(width * 0.55, width * 1.45, abs(x))) * ends;
  float body = (1.0 - smoothstep(width * 0.4, width, abs(x))) * ends;
  float highlight = (1.0 - smoothstep(width * 0.08, width * 0.38, abs(x + width * 0.36))) * ends;
  float progress = fract(max(0.0, shTearsTime - 0.12) * ${f(look.beadSpeed)} + phase);
  float beadY = progress * ${f(look.length)};
  float beadX = side * (0.018 * beadY + 0.018 * sin(beadY * 5.0));
  float beadW = clamp(${f(look.beadMinPx)} * pixel, ${f(look.beadWidth)}, ${f(look.beadWidth)} * ${f(look.maxWiden)});
  vec2 beadP = vec2((p.x - beadX) / beadW, (y - beadY) / (${f(look.beadHeight)} * beadW / ${f(look.beadWidth)}));
  float beadGate = smoothstep(0.05, 0.14, progress) * (1.0 - smoothstep(0.84, 1.0, progress)) * step(beadY, trailLength);
  float bead = (1.0 - smoothstep(0.64, 1.0, length(beadP))) * beadGate;
  float beadGlint = exp(-10.0 * dot(beadP + vec2(0.27, 0.28), beadP + vec2(0.27, 0.28))) * beadGate;
  float depth = 1.0 - smoothstep(0.18, 0.42, abs(dot(offset, shTearsForward)));
  return vec3(max(trail, bead), max(body, bead * 0.85), max(highlight * ${f(glintOnTrail(look))}, beadGlint)) * depth;
}
`;
}

/** GLSL that shades the lit colour (`outgoingLight`, linear) with both eyes' masks; placed before opaque_fragment. */
export function tearColorGlsl(look: TearLook = TEAR_LOOK): string {
  return `
if (shTearsAmount > 0.0) {
  vec3 wet = max(shTearsMask(shTearsLeft, -1.0, 0.0), shTearsMask(shTearsRight, 1.0, 0.38));
  float facing = gl_FrontFacing ? smoothstep(0.12, 0.55, dot(normalize(vViewPosition), normal)) : 0.0;
  wet *= shTearsAmount * facing;
  outgoingLight = mix(outgoingLight, ${v3(look.rimColor)}, wet.x * ${f(look.rimStrength)});
  outgoingLight = mix(outgoingLight, ${v3(look.bodyColor)}, wet.y * ${f(look.bodyStrength)});
  outgoingLight += ${v3(look.glintColor)} * wet.z * ${f(look.glintStrength)};
}
`;
}

// ---------------------------------------------------------------------------------------------------------------
// The same arithmetic in JavaScript (tests only need it; nothing here runs per frame in the app).

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const smoothstep = (lo: number, hi: number, value: number) => { const t = clamp((value - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };
const fract = (n: number) => n - Math.floor(n);

export interface TearWet { rim: number; body: number; glint: number }

/**
 * `tearMaskGlsl` for one eye at a point (x right, y down, eye distances from the trail origin; depth assumed on the
 * cheek), `pixel` eye distances per rendered pixel, `timeS` seconds into the cry.
 */
export function tearWet(px: number, py: number, pixel: number, timeS: number, side: -1 | 1 = -1, phase = 0, look: TearLook = TEAR_LOOK): TearWet {
  const y = py - look.start;
  const trailLength = Math.min(look.length, Math.max(0, timeS) * look.growPerSecond);
  const x = px - side * (0.018 * y + 0.018 * Math.sin(y * 5));
  const natural = look.width * (1 - look.taper * clamp(y / look.length, 0, 1));
  const width = clamp(look.minBodyPx * pixel, natural, natural * look.maxWiden);
  const ends = smoothstep(0, 0.04, y) * (1 - smoothstep(Math.max(0, trailLength - 0.07), Math.max(0.001, trailLength), y));
  const trail = (1 - smoothstep(width * 0.55, width * 1.45, Math.abs(x))) * ends;
  const body = (1 - smoothstep(width * 0.4, width, Math.abs(x))) * ends;
  const highlight = (1 - smoothstep(width * 0.08, width * 0.38, Math.abs(x + width * 0.36))) * ends;
  const progress = fract(Math.max(0, timeS - 0.12) * look.beadSpeed + phase);
  const beadY = progress * look.length, beadX = side * (0.018 * beadY + 0.018 * Math.sin(beadY * 5));
  const beadW = clamp(look.beadMinPx * pixel, look.beadWidth, look.beadWidth * look.maxWiden);
  const bx = (px - beadX) / beadW, by = (y - beadY) / (look.beadHeight * beadW / look.beadWidth);
  const beadGate = smoothstep(0.05, 0.14, progress) * (1 - smoothstep(0.84, 1, progress)) * (beadY <= trailLength ? 1 : 0);
  const bead = (1 - smoothstep(0.64, 1, Math.hypot(bx, by))) * beadGate;
  const gx = bx + 0.27, gy = by + 0.28, beadGlint = Math.exp(-10 * (gx * gx + gy * gy)) * beadGate;
  return { rim: Math.max(trail, bead), body: Math.max(body, bead * 0.85), glint: Math.max(highlight * glintOnTrail(look), beadGlint) };
}

/** `tearColorGlsl` for one lit linear colour (facing the camera, depth on the cheek). */
export function tearShade(base: Rgb, wet: TearWet, amount: number, look: TearLook = TEAR_LOOK): [number, number, number] {
  const a = clamp(amount, 0, 1), out = [...base] as [number, number, number];
  for (let i = 0; i < 3; i++) {
    out[i] += (look.rimColor[i] - out[i]) * wet.rim * a * look.rimStrength;
    out[i] += (look.bodyColor[i] - out[i]) * wet.body * a * look.bodyStrength;
    out[i] += look.glintColor[i] * wet.glint * a * look.glintStrength;
  }
  return out;
}
