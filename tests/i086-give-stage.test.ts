/**
 * I-086 她也照顾你, stage side, on the real Stage frame loop with the bundled public Gene (tests/helpers/gene-stage-harness.ts), at 60
 * and 30 fps (a 60 Hz screen): she reaches toward you with a snack and you take it; she holds it out and takes it back; she pushes
 * the cushion over; an offer interrupted mid-reach. Every run: the display guard has nothing to catch, the arm's unexpected step
 * ("意外步长", R29c) stays small, she ends where the undisturbed run is, and the prop never pops (its visibility moves gradually).
 */
import test from 'node:test';
import type { GiveStageCue, GiveStageOutcome } from '../src/initiative/give-performance';
import { TRACKED_BONES } from './helpers/frame-stats';

const ARM = ['右腕', '右ひじ'].map(name => TRACKED_BONES.indexOf(name as typeof TRACKED_BONES[number]));
const cue = (extra: Partial<GiveStageCue> = {}): GiveStageCue => ({ id: 'give-t1', stage: 'hand', prop: 'snack', playful: false, picture: null, waitMs: 1500, ...extra });

interface Run { caught: string[]; maxSurprise: number; sourceSurprise: number; maxStep: number; propJump: number; outcomes: GiveStageOutcome[]; endGap: number; phases: string[] }

const round = (n: number) => Math.round(n * 100) / 100;
const numbers: Record<string, unknown> = {};

test.after(() => { if (process.env.GIVE_NUMBERS) console.log(JSON.stringify(numbers)); });
