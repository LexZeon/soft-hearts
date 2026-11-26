// window.__unboundProbe: the numbers the developer view and the preview / smoke scripts read (split out of main.ts 2026-11-18, no
// behaviour change). Everything that changes while the page runs comes in through functions.
import { Vector3, type PerspectiveCamera, type WebGLRenderer } from 'three';
import { summarize } from '../../shared/unbound/scene';
import type { InteractiveToggle, Capsule2D } from '../../shared/unbound/hit-test';
import type { HeadSpot } from '../../shared/unbound/typing';
import { MMD_UNIT_M } from '../../shared/unbound/world';
import type { SensesLight } from './bubbles';
import type { BodyMeter } from './body-meter';
import type { ActPlayer, ActEnd, BodyAct } from './director/acts';
import { BODY_ACTS } from './director/acts';
import type { Director } from './director/director';
import type { SpeechBeat, SpeechBubbleGate } from './director/speech-beat';
import type { UnboundFigure } from './figure';
import type { UnboundIdleLayer } from './motion/unbound-idle';
import type { UnboundMouth } from './mouth';
import type { PeekMetrics } from './peek-metrics';
import type { PerfManager } from './perf';

export interface ProbeContext {
  readonly figure: () => UnboundFigure | null;
  readonly mouth: () => UnboundMouth | null;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly lights: SensesLight;
  readonly pointer: { readonly x: number; readonly y: number };
  readonly headOnWindow: () => { x: number; y: number; visible: boolean };
  readonly headSpot: () => HeadSpot | null;
  readonly toggle: InteractiveToggle;
  readonly toggles: () => number;
  readonly clicks: () => number;
  readonly fps: () => number | null;
  readonly presence: () => number;
  readonly capsules2D: () => readonly Capsule2D[];
  readonly roundTrips: number[];
  readonly hitTimes: number[];
  readonly frameLog: number[];
  readonly measuredFrames: { ms: number; quiet: boolean; hx: number; hy: number }[];
  readonly measuring: boolean;
  readonly meter: BodyMeter;
  readonly perf: PerfManager;
  readonly idleLayer: UnboundIdleLayer;
  readonly director: Director;
  readonly peekMetrics: PeekMetrics;
  readonly peekForcing: () => boolean;
  readonly nearM: () => number;
  readonly softPx: () => number;
  readonly speech: SpeechBeat;
  readonly speechGate: SpeechBubbleGate;
  readonly acts: ActPlayer;
  readonly lastActEnd: () => ActEnd | null;
  /** Round 13: the probes that change her exist only when the page was loaded with ?probe=preview. */
  readonly previewProbes: boolean;
  readonly setTimeScale: (value: number) => void;
  /** I-209 step 3: the shared stage (src/unbound/company/stage-page.ts): how many are on stage, where the others stand, frames her goal was held short. */
  readonly stage?: { readonly present: number; readonly others: readonly { id: string; xM: number; depthM: number }[]; readonly held: number; readonly lastPace: { idle: boolean; lowered: boolean }; readonly isFocused: boolean };
}

export function createProbe(c: ProbeContext) {
  const rt = () => summarize(c.roundTrips);
  return Object.freeze({
    head: () => (c.figure() ? c.headOnWindow() : null),
    /** Step 2 (the smoke script reads these): her head's middle and radius, her mouth, the senses light's rectangle, whether the window takes the mouse. */
    headSpot: () => c.headSpot(),
    mouth: () => { const mouth = c.mouth(); return { has: !!mouth, open: mouth?.open ?? 0, speaking: mouth?.isSpeaking ?? false }; },
    light: () => ({ lit: c.lights.lit, distance: c.lights.distance(c.pointer.x, c.pointer.y), at: c.lights.where() }),
    /** A point on her body (her chest), window pixels. */
    body: () => {
      const figure = c.figure();
      if (!figure) return null;
      const p = new Vector3(); figure.mesh.getWorldPosition(p); p.y += figure.heightUnits * 0.6;
      p.project(c.camera); return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight };
    },
    stats: () => { const figure = c.figure(); return { toggles: c.toggles(), roundTripMs: rt(), hitTestMs: summarize(c.hitTimes), fps: c.fps(), clicks: c.clicks(), interactive: c.toggle.interactive, capsules: c.capsules2D().length, presence: c.presence(),
      placement: figure?.placement ?? null, heightM: figure?.heightM ?? null, moving: figure?.moving ?? false, unitM: MMD_UNIT_M,
      walking: figure?.walking ?? false, heading: figure?.heading ?? null, stance: figure?.report?.stance ?? null, steps: figure?.report?.steps ?? 0,
      comMargin: figure?.report?.comMargin ?? null, reachDrop: figure?.report?.reachDrop ?? null, meter: c.meter.value }; },
    /** Step 1B: the tier, the quiet rate, the last frame intervals; with ?perf=... also the raw frame log (drained). */
    perf: () => ({ tier: c.perf.tier.id, quiet: c.perf.quiet, testing: c.perf.testing, drops: c.perf.drops, note: c.perf.note, fps: c.perf.fps, frameMs: summarize(c.frameLog), pixelRatio: c.renderer.getPixelRatio(), canvas: [c.renderer.domElement.width, c.renderer.domElement.height], devicePixelRatio: window.devicePixelRatio }),
    stage: () => (c.stage ? { present: c.stage.present, others: c.stage.others.map(o => ({ id: o.id, xM: o.xM, depthM: o.depthM })), held: c.stage.held, pace: c.stage.lastPace, focused: c.stage.isFocused } : null),
    perfDrain: () => { const out = c.measuredFrames.splice(0, c.measuredFrames.length); return c.measuring ? out : []; },
    /** Her idle: which source plays ('model+events', 'procedural', null while loading) and how much of it is laid on. */
    idle: () => ({ source: c.idleLayer.source, learned: c.idleLayer.learned, weight: c.idleLayer.weight }),
    /** Starts the body meter over (the preview measures one scenario at a time). */
    resetMeter: () => c.meter.reset(),
    /** U2: the director's beat, the near plane, the lens softness, her eye against the lens, and the peek metrics. */
    peek: () => ({ active: c.director.active, phase: c.director.phase, cancelled: c.director.cancelled, nearM: c.nearM(), softPx: c.softPx(),
      eyeDistanceM: c.peekMetrics.eyeDistanceM, eyeOffM: c.peekMetrics.eyeOffM, firstMotionMs: c.peekMetrics.firstMotionMs, holds: [...c.peekMetrics.holds],
      phases: [...c.peekMetrics.phases], closeFrameMs: summarize(c.peekMetrics.closeFrameMs), forcing: c.peekForcing() }),
    /** Preview measurement: eye-in-head angles (degrees), her heading and walking, and the director's beat. */
    eyes: () => { const figure = c.figure(); return figure ? { eyes: figure.eyeInHead(), heading: figure.heading * 180 / Math.PI, walking: figure.walking, moving: figure.moving, phase: c.director.phase, active: c.director.active, placement: figure.placement } : null; },
    resetPeekFrames: () => { c.peekMetrics.closeFrameMs.length = 0; },
    /** E3: the opening beat (switch, phase, when the bubble came out, why it was cut short or skipped). */
    speech: () => ({ enabled: c.speech.enabled, active: c.speech.active, phase: c.speech.phase, phases: [...c.speech.phases], bubbleAt: c.speech.bubbleTime, interrupted: c.speech.interrupted, skipped: c.speech.lastSkip, holding: c.speechGate.holding }),
    // Round 13 (review): the probes that change her (turn her, start an act, slow her clock) exist only in a preview, which loads the
    // page with ?probe=preview (scripts/unbound/e2-acts-preview-main.ts, e3-speech-preview-main.ts); the app never does.
    ...(c.previewProbes ? {
      /** E3 preview only: who she turns to while idle (a point on her floor, m), so the turn toward you has something to turn from; the next scene puts it back. */
      faceToward: (x: number, z: number) => { const figure = c.figure(); if (figure && Number.isFinite(x) && Number.isFinite(z)) figure.faceToward({ x, z }); },
      /** E2 (preview only): start one of her own acts; its state; slow her clock (0.05..1) to catch key frames. */
      act: (kind: unknown, amplitude = 1, liveliness = 0.6) => !!c.figure() && !c.director.active && typeof kind === 'string' && (BODY_ACTS as readonly string[]).includes(kind)
        && c.acts.start({ act: kind as BodyAct, amplitude: Number(amplitude), liveliness: Number(liveliness), seed: Math.random() }),
      cancelAct: () => c.acts.cancel(),
      actState: () => { const figure = c.figure(); return { active: c.acts.active, act: c.acts.act, beat: c.acts.beat, t: c.acts.time, lastEnd: c.lastActEnd(), hopLift: figure?.hopLift ?? 0, armsRaised: figure?.armsRaised ?? 0, comMargin: figure?.report?.comMargin ?? null }; },
      timeScale: (value: unknown) => { const v = Number(value); const scale = Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 1; c.setTimeScale(scale); return scale; },
    } : {}),
  });
}
