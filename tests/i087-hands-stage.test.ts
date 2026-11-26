/**
 * I-087 牵手、拉钩、击掌, stage side, on the real Stage frame loop with the bundled public Gene (tests/helpers/gene-stage-harness.ts), at 60
 * and 30 fps (a 60 Hz screen). The cursor arrives as the host reads it (every 100 ms, src/main.ts pointerTimer), in both the event run
 * and the undisturbed control run (so her gaze follows the same cursor in both). Every run: the display guard has nothing to catch, the
 * arm's and the body's unexpected step ("意外步长", R29c) stays small, she ends where the undisturbed run is.
 */
import test from 'node:test';
import type { HandReachCue } from '../src/initiative/hand-reach';
import { NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import { TRACKED_BONES } from './helpers/frame-stats';

const ARM = ['右腕', '右ひじ'].map(name => TRACKED_BONES.indexOf(name as typeof TRACKED_BONES[number]));
const BODY = ['上半身', '右肩'].map(name => TRACKED_BONES.indexOf(name as typeof TRACKED_BONES[number]));

export interface HandsRun { caught: string[]; arm: number; body: number; source: number; step: number; end: number; phases: string[]; maxRatio: number; far: boolean[]; reach: number }

const round = (n: number) => Math.round(n * 100) / 100;
export const HANDS_NUMBERS: Record<string, unknown> = {};
const cue = (use: HandReachCue['use'], style: Partial<HandReachCue['style']> = {}): HandReachCue => ({ use, style: { ...NEUTRAL_HAND_STYLE, ...style } });
/** A cursor that rests near her right hand, then wanders slowly in a loop (the user moving the mouse while holding). */
const wander = (t: number) => t < 5 ? { x: -0.35, y: -0.2 } : { x: -0.35 + 0.25 * Math.sin((t - 5) * 1.1), y: -0.2 + 0.18 * Math.sin((t - 5) * 0.7) };
const record = (name: string, r: HandsRun) => { HANDS_NUMBERS[name] = { arm: round(r.arm), body: round(r.body), source: round(r.source), step: round(r.step), end: round(r.end) }; };

test.after(() => { if (process.env.HANDS_NUMBERS) console.log(JSON.stringify(HANDS_NUMBERS)); });
