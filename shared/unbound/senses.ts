/**
 * Unbound v1 step 2: the small light near her while a sense is in use (docs/claude/2026-11-15-unbound-v1-step2-typing.md). The
 * companion window shows its own light for the face check; out in Unbound the user must still always see when the camera, the
 * microphone, the screen or the computer's sound is being used. This only decides what is lit and what the hover says.
 */
export interface UnboundSenses { camera: boolean; microphone: boolean; screen: boolean; audio: boolean }
export const NO_SENSES: Readonly<UnboundSenses> = Object.freeze({ camera: false, microphone: false, screen: false, audio: false });

export interface RuntimeFacts {
  voiceInput?: boolean; screenSharing?: boolean; cameraSharing?: boolean; cameraLocal?: boolean; cameraImages?: boolean; cameraHeld?: boolean;
}

/**
 * What is really in use. The camera counts when something reads it: the local pose sensing, or the picture sending unless the user
 * said "别看" (then no frame is taken). Everything else is its own switch, as the host reports it.
 */
export function sensesFrom(runtime: RuntimeFacts, systemAudioActive: boolean): UnboundSenses {
  const camera = runtime.cameraSharing === true && (runtime.cameraLocal === true || runtime.cameraImages !== true || runtime.cameraHeld !== true);
  return { camera, microphone: runtime.voiceInput === true, screen: runtime.screenSharing === true, audio: systemAudioActive === true };
}

export function sameSenses(a: UnboundSenses | null | undefined, b: UnboundSenses | null | undefined): boolean {
  const x = a ?? NO_SENSES, y = b ?? NO_SENSES;
  return x.camera === y.camera && x.microphone === y.microphone && x.screen === y.screen && x.audio === y.audio;
}

export const anySense = (senses: UnboundSenses | null | undefined): boolean => !!senses && (senses.camera || senses.microphone || senses.screen || senses.audio);

export const SENSE_LABELS: Readonly<Record<keyof UnboundSenses, string>> = Object.freeze({ camera: '摄像头', microphone: '麦克风', screen: '屏幕', audio: '电脑的声音' });

/** The hover text: one line per sense that is on, and how to turn it off. Empty when nothing is on. */
export function senseLines(senses: UnboundSenses | null | undefined): string[] {
  if (!senses || !anySense(senses)) return [];
  const on = (Object.keys(SENSE_LABELS) as (keyof UnboundSenses)[]).filter(key => senses[key]).map(key => `${SENSE_LABELS[key]}开着`);
  // I-159: out here there is no switch to point at, and they stay on; to turn one off, go back first.
  return [...on, '她在外面时它们一直开着；想关，先回小窗。'];
}

/** Which senses the light shows, in a fixed order (for the dots). */
export function litSenses(senses: UnboundSenses | null | undefined): (keyof UnboundSenses)[] {
  return senses ? (Object.keys(SENSE_LABELS) as (keyof UnboundSenses)[]).filter(key => senses[key]) : [];
}

export function parseSenses(value: unknown): UnboundSenses | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = ['camera', 'microphone', 'screen', 'audio'] as const;
  if (!keys.every(key => typeof raw[key] === 'boolean')) return null;
  return { camera: raw.camera as boolean, microphone: raw.microphone as boolean, screen: raw.screen as boolean, audio: raw.audio as boolean };
}
