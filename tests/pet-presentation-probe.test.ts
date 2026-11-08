import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPetPresentation, probePetPresentation, type ProbeDocument } from '../src/pet-presentation-probe';
import { readPetPresentationSample } from '../electron/pet-restore';

function page(options: { lost?: boolean | 'none'; visibility?: string; canvas?: boolean } = {}) {
  const canvas = options.canvas === false ? null : {
    width: 600, height: 840, clientWidth: 400, clientHeight: 560,
    getContext: (kind: string) => kind === 'webgl2' && options.lost !== 'none' ? { isContextLost: () => options.lost === true } : null,
  };
  const doc: ProbeDocument = {
    visibilityState: options.visibility ?? 'visible',
    querySelector: selector => selector === '#stage canvas' ? canvas : null,
    defaultView: { devicePixelRatio: 1.5 },
  };
  return doc;
}
const frameRuns = (callback: () => void) => { queueMicrotask(callback); };
const frameStalls = () => {};

test('a drawing pet reports a live canvas and running frames', async () => {
  const sample = await probePetPresentation(page(), true, 'startup', frameRuns, 50);
  assert.deepEqual(sample, { reason: 'startup', visibility: 'visible', hostVisible: true, canvasWidth: 600, canvasHeight: 840,
    clientWidth: 400, clientHeight: 560, devicePixelRatio: 1.5, contextLost: false, frameAdvanced: true });
  assert.deepEqual(readPetPresentationSample(sample), sample, 'the host accepts exactly what the pet sends');
});

test('a hidden page whose frames never run is reported as such, without a reload', async () => {
  const reports: unknown[] = []; let reloads = 0;
  const sample = await checkPetPresentation({ document: page({ visibility: 'hidden' }), hostVisible: () => false, reason: 'restore',
    report: async value => { reports.push(value); }, reload: () => { reloads++; }, frame: frameStalls, wait: async () => {} });
  assert.equal(sample?.frameAdvanced, false);
  assert.equal(sample?.visibility, 'hidden');
  assert.equal(reports.length, 1);
  assert.equal(reloads, 0);
});

test('after an explicit recovery, a lost WebGL context reloads the pet page once', async () => {
  let reloads = 0;
  await checkPetPresentation({ document: page({ lost: true }), hostVisible: () => true, reason: 'restore',
    report: async () => { throw new Error('host log unavailable'); }, reload: () => { reloads++; }, frame: frameRuns });
  assert.equal(reloads, 1, 'a failing diagnostic report must not block the reload');
});

test('the startup probe only reports; it never reloads', async () => {
  const reports: { contextLost: boolean | null }[] = [];
  await checkPetPresentation({ document: page({ lost: true }), hostVisible: () => true, reason: 'startup',
    report: async value => { reports.push(value); }, frame: frameRuns, delayMs: 5, wait: async () => {} });
  assert.equal(reports[0].contextLost, true);
});

test('a missing canvas or context is unknown, not lost', async () => {
  assert.equal((await probePetPresentation(page({ canvas: false }), true, 'restore', frameRuns, 50)).contextLost, null);
  assert.equal((await probePetPresentation(page({ lost: 'none' }), true, 'restore', frameRuns, 50)).contextLost, null);
});
