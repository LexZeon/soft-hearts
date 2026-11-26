// Renderer wiring, I-190 (docs/claude/2026-11-22-i190-source-pickers.md): the sense source menus in this window. Both app windows keep the
// device lists current (the names plugged in now, for the Unbound input box) and follow a choice made anywhere: an open microphone moves to
// the chosen one, 「发图片」's camera stream reopens from the chosen camera. The companion toolbar gets the menus. Never a switch.
// Called from wireRuntimeState (senses-wiring.ts); nothing here runs on import (tests/renderer-golden.test.mjs).
import { setCameraChooser } from '../senses';
import { createSourceChoices, type SourceChoices } from '../../shared/senses';
import { ambientAudioController, mediaInput } from './voice-chat-wiring';
import { petUI as companionUI } from './pet-window-wiring'; // no-pet-ok: the existing wiring file and binding names

export let sourceChoices: SourceChoices | null = null;

export function wireSources(): void {
  if (sourceChoices || typeof window.desktop?.screenSourceMenu !== 'function') return;
  const choices = sourceChoices = createSourceChoices(window.desktop);
  setCameraChooser(() => choices.devices.cameraDeviceId());
  let camera: Promise<string | null> = choices.devices.cameraDeviceId();
  choices.devices.onChange(() => {
    void ambientAudioController?.reselectMicrophone().catch(() => false); // only an open microphone moves
    const before = camera;
    camera = choices.devices.cameraDeviceId();
    void Promise.all([before, camera]).then(([was, now]) => { if (was !== now) mediaInput?.switchCamera(); }, () => {}); // only an open stream reopens
  });
  companionUI?.setSources(choices);
  void choices.devices.read(); // the names plugged in now, written down for the windows that cannot read them
}
