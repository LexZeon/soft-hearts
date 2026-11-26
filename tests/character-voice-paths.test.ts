// I-162 step 1: every speech path asks the one resolver (shared/voice/character-voice-resolver.ts characterTtsConfig) which voice she has.
// effectiveTtsConfig is only the style layer of a character + model binding now: calling it directly for speech would skip her own voice and
// the never-wrong-gender rule (the way Akiko got Drama 3's built-in voice). This lists who may still call it, so a new speech path cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// Each one reads only the saved style for an editor, never to speak.
const STYLE_READERS = new Map([
  ['shared/voice/tts.ts', 'defines it'],
  ['shared/voice/character-voice-resolver.ts', 'the resolver builds on the style layer'],
  ['src/wiring/voice-wiring.ts', 'the voice panel shows her saved instruction and acting style (panelTtsConfig), not a fallback'],
  ['electron/safety/agent-channel/tools/voice.ts', 'set_voice_style reads and writes the saved style of the binding'],
]);

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap(name => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : rel.endsWith('.ts') ? [rel] : [];
  });
}

test('no speech path calls effectiveTtsConfig directly: they all go through characterTtsConfig', () => {
  const callers = ['electron', 'src', 'shared'].flatMap(files).filter(rel => /\beffectiveTtsConfig\(/u.test(readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(callers.filter(rel => !STYLE_READERS.has(rel)), [], 'a new direct caller: use characterTtsConfig (or add it here if it only reads the style)');
  for (const rel of ['electron/wiring/voice-wiring.ts', 'electron/wiring/brain-chat-wiring.ts', 'electron/wiring/memory-wiring.ts',
    'electron/wiring/senses-listen-wiring.ts', 'electron/wiring/senses-voice-input-wiring.ts'])
    assert.match(readFileSync(path.join(ROOT, rel), 'utf8'), /characterTtsConfig\(/u, `${rel} reads her voice through the resolver`);
});
