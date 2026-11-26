// I-154 batch 2: a mood view, a capability card and a synthetic face rig for the window face's tests (tests/unbound-window-face*.test.ts).
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../../shared/foundation/mood';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../../shared/mood/fatigue';
import type { MoodView } from '../../shared/mood/mood-runtime';
import type { ModelCapabilities, ModelCapabilityId } from '../../shared/stage/model-capability';
import type { WindowFaceRig } from '../../src/unbound/window-mode/window-face-rig';

export function faceView(over: { primary?: string; companion?: string | null; token?: string; characterId?: string; expressions?: boolean;
  phase?: FatiguePhase; F?: number; blushEnabled?: boolean; intensity?: number; blushCue?: { id: string; amount: number };
  values?: { D: number; O: number; E: number; N: number; C: number } } = {}): MoodView {
  const snapshot = getMoodSnapshot(createMoodState(0));
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  if (over.blushEnabled !== undefined) parameters.blush.enabled = over.blushEnabled;
  const view: MoodView = { characterId: over.characterId ?? 'face-test', token: over.token ?? 'face-token', revision: 1, developerMode: false,
    expressions: over.expressions ?? true, parameters, gesture: null,
    // A happy label with happy numbers (the idle smile follows the numbers, I-073), as the host sends them together.
    snapshot: { ...snapshot, primary: over.primary ?? 'happy', companion: over.companion === undefined ? 'comfortable' : over.companion, cue: null, phase: 'idle',
      values: over.values ?? ((over.primary ?? 'happy') === 'happy' ? { D: 75, O: 62, E: 58, N: 70, C: 45 } : snapshot.values),
      intensity: { ...snapshot.intensity, expression: over.intensity ?? 50, posture: 50, gaze: 50 } },
  } as MoodView;
  if (over.phase) view.fatigue = { ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A: 0.9, F: over.F ?? 0.8, phase: over.phase })), sleepEntryReady: true } as MoodView['fatigue'];
  if (over.blushCue) view.snapshot.blush = { id: over.blushCue.id, at: 0, until: 4_000, strength: over.blushCue.amount, reason: 'closeness', ageMs: 0,
    amount: 0, profile: { ...parameters.blush } };
  return view;
}

/** A card with these capabilities enabled (others detected but off), and an optional user choice. */
export function card(enabled: ModelCapabilityId[], choices: Partial<Record<ModelCapabilityId, 'on' | 'off'>> = {}): ModelCapabilities {
  const ids: ModelCapabilityId[] = ['closeEyes', 'blush', 'mouth', 'sleepPose', 'gesture', 'drowsyFace', 'tears'];
  return Object.fromEntries(ids.map(id => [id, { id, detected: true, source: 'name', choice: choices[id] ?? null,
    enabled: choices[id] === 'off' ? false : enabled.includes(id), missing: [] }])) as unknown as ModelCapabilities;
}

/** A model with every face slot (indices 1..), not the reviewed Gene unless asked; a vowel and a mouth smile as its mouth shapes. */
export function syntheticRig(over: Partial<WindowFaceRig> = {}): WindowFaceRig {
  const slots = { a: 1, smileEyes: 2, mouthSmile: 3, sad: 4, jitome: 5, browUp: 6, surprise: 7, blink: 8, shy: 9, mouthPucker: 10, o: 11, u: 12 };
  return { slots, smile: 'smileEyes', scales: new Map(), reviewed: false, drowsy: { brow: true, eye: true }, mouthShapes: [1, 3, 10, 11, 12],
    shy: 9, blushChannel: 13, profile: null, ...over };
}
