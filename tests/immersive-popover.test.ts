// The companion toolbar's panels replace one another without changing what they control. 2026-11-22 (I-190): rewritten from slicing the
// companion UI's source text and evaluating pieces of it to driving the real class on the fake companion window (the toolbar moved to
// src/stage/companion-toolbar.ts, and a text slice would have kept testing code that no longer runs).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { installPetWindow } from './helpers/pet-window-dom'; // no-pet-ok: the existing helper's names
import { PetUI, renderPet } from '../src/stage/PetUI'; // no-pet-ok: the existing file and class names

test('actual toolbar handlers switch panels without changing audio intent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // no-pet-ok: the existing helper's and host calls' names
  const dom = installPetWindow(t, { openControls: async () => {}, updatePetReply: async () => undefined, setPetWindowOperation: async () => undefined });
  renderPet(dom.app as unknown as HTMLElement); // no-pet-ok: the existing function name
  const { byId } = dom;
  let audioOpen = false, closeCalls = 0, switches = 0;
  const audioButton = byId('pet-system-audio-sharing'); // no-pet-ok: an existing element id
  const ui = new PetUI({ // no-pet-ok: the existing class name
    edit() {}, stop() { switches++; }, feature() { switches++; }, send() {}, error: message => { throw Error(message); },
    systemAudio() { audioOpen = !audioOpen; audioButton.setAttribute('aria-expanded', String(audioOpen)); },
    closeSystemAudioPanel() { closeCalls++; audioOpen = false; audioButton.setAttribute('aria-expanded', 'false'); },
    popups: { 'screen-sharing-options': { isOpen: () => false, close() {} }, 'mood-companion': { isOpen: () => false, close() {} } },
  });
  dom.beforeClose(() => ui.dispose());
  const reader = byId('pet-reply-reader'), notice = byId('notice-detail-panel'); // no-pet-ok: an existing element id
  reader.showModal(); notice.hidden = false;
  audioButton.click();
  assert.equal(audioOpen, true, 'the listening panel opened');
  assert.equal(notice.hidden, true, 'the notice details closed');
  assert.equal(reader.open, false, 'the reply reader closed');
  ui.setSystemAudioExpanded(true);
  assert.equal(audioButton.getAttribute('aria-expanded'), 'true');
  byId('notice-details').click();
  assert.equal(audioOpen, false, 'opening the notice details closes the listening panel');
  assert.equal(closeCalls, 1);
  assert.equal(switches, 0, 'no panel change touched a switch or stopped a reply');
});
