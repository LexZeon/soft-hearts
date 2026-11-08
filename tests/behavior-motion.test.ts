import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEHAVIOR_FACE_BINDING_IDS, BEHAVIOR_SEMANTICS, MAX_BEHAVIOR_FACE_STRENGTH,
  isBehaviorFaceBindingId, isBehaviorSemantic, selectBehaviorReaction, selectBehaviorState,
  type BehaviorFaceBindingId, type BehaviorSemantic,
  type BehaviorStateSelection,
} from '../shared/behavior-motion';
import { createMoodState, getMoodSnapshot, MOOD_CHANNELS, type MoodLabel, type MoodSnapshot } from '../shared/mood';
import { IDLE_GESTURE_KNOBS, IDLE_FACE_IDS } from '../shared/behaviors/idle-gesture/knobs';
import { idleGestureNow } from '../shared/behaviors/idle-gesture/choose';

const snapshot = (): MoodSnapshot => getMoodSnapshot(createMoodState(1_000), 1_000);
const withCue = (kind: NonNullable<MoodSnapshot['cue']>['kind'] = 'satisfied'): MoodSnapshot => {
  const value = snapshot(); value.cue = { id: 'accepted-event', kind, at: 1_000, until: 5_000 }; return value;
};
const labels: MoodLabel[] = ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'];
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

test('semantic coverage distinguishes current channel levels, continuous trends and discrete fast directions', () => {
  const groups = {
    mood: labels,
    modifier: ['playful', 'close', 'comfortable', 'cautious', 'wistful'],
    context: ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'],
    phase: ['idle', 'rua-hover', 'rua', 'food-wait', 'food-ready', 'food-eating'],
    event: ['rua', 'food', 'chat', 'appraisal', 'phase', 'attention'],
    cue: ['satisfied', 'reunion', 'look', 'motion', 'speech'],
    blush: ['semantic', 'closeness'],
    chat: ['none', 'explain', 'upbeat', 'consider'],
  };
  for (const [prefix, values] of Object.entries(groups)) for (const value of values)
    assert.ok(isBehaviorSemantic(`${prefix}.${value}`), `${prefix}.${value}`);
  for (const channel of MOOD_CHANNELS) {
    assert.ok(isBehaviorSemantic(`channel.${channel}`));
    assert.ok(isBehaviorSemantic(`trend.${channel}`));
    for (const direction of ['up', 'down', 'steady']) {
      assert.ok(isBehaviorSemantic(`fast.${channel}.${direction}`));
      assert.equal(isBehaviorSemantic(`trend.${channel}.${direction}`), false);
    }
  }
  assert.ok(isBehaviorSemantic('flag.crying-candidate'));
  for (const [semantic, item] of Object.entries(BEHAVIOR_SEMANTICS)) {
    assert.ok(item.fallback.trim(), semantic);
    assert.ok(Object.isFrozen(item) && Object.isFrozen(item.bindingIds), semantic);
    assert.ok(item.bindingIds.every(isBehaviorFaceBindingId), semantic);
  }
});

test('continuous channels, voice, manual layers and local gates retain explicit delegates or fallback', () => {
  const continuous = ['breath-idle', 'mouse-gaze', 'blink', 'speech-mouth', 'rua-follow', 'food-mouth', 'mood-micro', 'event-impact', 'blush', 'system-audio-dance', 'motion-transition'];
  for (const name of continuous) assert.equal(BEHAVIOR_SEMANTICS[`continuous.${name}` as BehaviorSemantic].route, 'procedural');
  for (const name of ['calm', 'happy', 'comfort', 'sad', 'firm', 'focused'])
    assert.equal(BEHAVIOR_SEMANTICS[`voice.${name}` as BehaviorSemantic].route, 'voice');
  for (const name of ['pose', 'gesture', 'expression'])
    assert.equal(BEHAVIOR_SEMANTICS[`manual.${name}` as BehaviorSemantic].route, 'manual');
  for (const name of ['manual-gesture', 'dynamic-pose', 'manual-expression', 'manual-head', 'direct-contact', 'speaking', 'music', 'expression-off-or-zero', 'context-or-reply-invalid', 'hidden-or-disposed', 'preview-local', 'window-camera-input'])
    assert.equal(BEHAVIOR_SEMANTICS[`gate.${name}` as BehaviorSemantic].kind, 'gate');
});

test('reserved interactions and crying remain unsupported while M004 keeps its single existing route', () => {
  for (const name of ['reserved.pinch.*', 'reserved.physics.*', 'reserved.vision-attention-chat'] as const) {
    assert.equal(BEHAVIOR_SEMANTICS[name].kind, 'reserved');
    assert.equal(BEHAVIOR_SEMANTICS[name].route, 'none');
    assert.deepEqual(BEHAVIOR_SEMANTICS[name].bindingIds, []);
  }
  assert.equal(BEHAVIOR_SEMANTICS['flag.crying-candidate'].route, 'none');
  assert.equal(BEHAVIOR_SEMANTICS['chat.none'].route, 'none');
  for (const name of ['chat.explain', 'chat.consider', 'chat.upbeat'] as const) {
    assert.equal(BEHAVIOR_SEMANTICS[name].route, 'chat-gesture');
    assert.deepEqual(BEHAVIOR_SEMANTICS[name].bindingIds, []);
  }
});

test('only the eleven exact face identities and known semantic keys are recognized', () => {
  assert.equal(BEHAVIOR_FACE_BINDING_IDS.length, 11);
  assert.ok(Object.isFrozen(BEHAVIOR_FACE_BINDING_IDS));
  assert.equal(new Set(BEHAVIOR_FACE_BINDING_IDS).size, 11);
  for (const value of BEHAVIOR_FACE_BINDING_IDS) assert.ok(isBehaviorFaceBindingId(value));
  for (const value of ['face.angry', '../smile.vmd', 'face.smile/../../other', 'https://example.test/smile.vmd', 'constructor', null, {}])
    assert.equal(isBehaviorFaceBindingId(value), false);
  for (const value of ['mood.angry', 'phase.pinch', 'constructor', '__proto__', '../mood.happy', null, {}])
    assert.equal(isBehaviorSemantic(value), false);
});

test('all twelve main feelings have a deliberate face selection or calm procedural fallback', () => {
  const expected: Record<MoodLabel, BehaviorFaceBindingId | null> = {
    calm: null, close: 'face.embarrassed-smile', content: 'face.smile', happy: 'face.happy', excited: 'face.laugh',
    concerned: 'face.compassion', disappointed: 'face.disappointed', upset: 'face.in-trouble', longing: 'face.sentimental',
    sad: 'face.sad', relieved: 'face.smile', 'tense-expectation': 'face.in-trouble',
  };
  for (const primary of labels) {
    const mood = snapshot(); mood.primary = primary;
    const value = selectBehaviorState(mood);
    assert.equal(value.semantic, `mood.${primary}`);
    assert.equal(value.bindingId, expected[primary]);
    assert.ok(value.reason.length);
    assert.ok(value.bindingId ? value.strength > 0 : value.strength === 0);
    assert.equal('loop' in value || 'hold' in value || 'url' in value || 'path' in value, false);
  }
});

test('registry admission is exactly closed over all primary/context/companion state and reaction selections', () => {
  const contexts: MoodSnapshot['context'][] = ['neutral', 'positive', 'support', 'concern', 'disappointment', 'offense'];
  const companions: MoodSnapshot['companion'][] = [null, 'playful', 'close', 'comfortable', 'cautious', 'wistful'];
  const reactions = ['satisfied', 'reunion', 'motion'] as const;
  const outputs = new Map<BehaviorSemantic, Set<BehaviorFaceBindingId>>();
  const admit = (selected: BehaviorStateSelection | null, kind: 'state' | 'reaction') => {
    if (!selected?.bindingId) return;
    const metadata = BEHAVIOR_SEMANTICS[selected.semantic];
    assert.equal(metadata.route, 'face', selected.semantic);
    assert.equal(metadata.kind, kind, selected.semantic);
    assert.ok(metadata.bindingIds.includes(selected.bindingId), `${selected.semantic} must admit ${selected.bindingId}`);
    let ids = outputs.get(selected.semantic);
    if (!ids) { ids = new Set(); outputs.set(selected.semantic, ids); }
    ids.add(selected.bindingId);
  };
  for (const primary of labels) for (const context of contexts) for (const companion of companions) {
    const mood = snapshot(); Object.assign(mood, { primary, context, companion });
    admit(selectBehaviorState(mood), 'state');
    for (const kind of reactions) {
      mood.cue = { id: 'accepted-event', kind, at: 1_000, until: 5_000 };
      admit(selectBehaviorReaction(mood), 'reaction');
    }
    // #11: every face the idle gesture may pick for a look or motion in this state (shared/behaviors/idle-gesture/).
    for (const kind of ['look', 'motion'] as const) {
      mood.cue = { id: 'accepted-event', kind, at: 1_000, until: 5_000 };
      const now = idleGestureNow({ kind, source: 'rule', snapshot: mood, personality: null, contacts: [], fatiguePhase: null, now: 1_000 });
      for (const face of IDLE_FACE_IDS) {
        const knob = IDLE_GESTURE_KNOBS.faces[face];
        if (!(knob.base[kind] * knob.serious[now.serious ? 0 : 1] > 0)) continue;
        admit(selectBehaviorReaction(mood, { cueId: 'accepted-event', bindingId: knob.bindingId === 'mood' ? now.moodFace : knob.bindingId }), 'reaction');
      }
    }
  }
  const selectedSemantics: BehaviorSemantic[] = [
    ...labels.map(primary => `mood.${primary}` as const),
    ...reactions.map(kind => `cue.${kind}` as const), 'cue.look',
  ];
  for (const semantic of selectedSemantics) {
    const admitted = BEHAVIOR_SEMANTICS[semantic].bindingIds;
    assert.equal(new Set(admitted).size, admitted.length, `${semantic} has no duplicate admission`);
    assert.deepEqual([...admitted].sort(), [...outputs.get(semantic) ?? []].sort(),
      `${semantic} must admit all and only its selector outputs`);
  }
});

test('serious context restrains lingering positive states and upset needs offense to choose disgust', () => {
  for (const primary of ['close', 'happy', 'excited', 'relieved'] as const) {
    const mood = snapshot(); mood.primary = primary;
    mood.context = 'concern'; assert.equal(selectBehaviorState(mood).bindingId, 'face.compassion');
    mood.context = 'disappointment'; assert.equal(selectBehaviorState(mood).bindingId, 'face.disappointed');
    mood.context = 'offense'; assert.equal(selectBehaviorState(mood).bindingId, 'face.in-trouble');
  }
  const upset = snapshot(); upset.primary = 'upset';
  assert.equal(selectBehaviorState(upset).bindingId, 'face.in-trouble');
  upset.values.C = 100; upset.values.N = 100;
  assert.equal(selectBehaviorState(upset).bindingId, 'face.in-trouble', 'high channels alone do not add offense');
  upset.context = 'offense'; assert.equal(selectBehaviorState(upset).bindingId, 'face.disgust');
});

test('wistful reunion and serious main feelings never become unconditional happy performance', () => {
  const mood = withCue('reunion'); mood.primary = 'relieved'; mood.companion = 'wistful'; mood.cryingCandidate = true;
  assert.equal(selectBehaviorState(mood).bindingId, 'face.sentimental');
  assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.sentimental');
  for (const primary of ['concerned', 'disappointed', 'upset', 'longing', 'sad', 'tense-expectation'] as const) {
    mood.primary = primary;
    assert.equal(selectBehaviorReaction(mood)?.bindingId, selectBehaviorState(mood).bindingId);
    assert.ok(!['face.smile', 'face.happy', 'face.laugh'].includes(selectBehaviorReaction(mood)!.bindingId));
  }
  mood.primary = 'relieved'; mood.context = 'concern';
  assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.compassion');
});

test('expression intensity has a finite bound and zero does not request optional face playback', () => {
  for (const intensity of [0, -1, NaN, Infinity, -Infinity]) {
    const mood = withCue(); mood.primary = 'happy'; mood.intensity.expression = intensity;
    assert.equal(selectBehaviorState(mood).bindingId, null);
    assert.equal(selectBehaviorState(mood).strength, 0);
    assert.equal(selectBehaviorReaction(mood), null);
  }
  for (const intensity of [1, 10, 50, 100, 1_000]) {
    const mood = withCue(); mood.primary = 'happy'; mood.intensity.expression = intensity;
    for (const value of [selectBehaviorState(mood), selectBehaviorReaction(mood)!])
      assert.ok(Number.isFinite(value.strength) && value.strength > 0 && value.strength <= MAX_BEHAVIOR_FACE_STRENGTH);
  }
  const mood = withCue(); mood.primary = 'happy';
  const before = selectBehaviorState(mood).strength;
  mood.companion = 'cautious'; assert.ok(selectBehaviorState(mood).strength < before);
});

test('qualitative state identity does not restart with numeric drift, event ages or snapshot timestamps', () => {
  const mood = withCue(); mood.primary = 'happy';
  const first = selectBehaviorState(mood);
  mood.values.D = 90; mood.boredom = 40; mood.longing = 20; mood.trend.D = 7; mood.fast.D = 'up';
  mood.lastInteractionAt = 2_000; mood.intensity.expression = 80; mood.cue!.until += 100;
  assert.equal(selectBehaviorState(mood).key, first.key);
  assert.notEqual(selectBehaviorState(mood).strength, first.strength);
  mood.primary = 'sad'; assert.notEqual(selectBehaviorState(mood).key, first.key);
});

test('raw events and attention candidates do not manufacture a reaction without an accepted cue', () => {
  const mood = snapshot(); mood.primary = 'happy'; mood.attentionCandidate = 'motion';
  mood.event = { id: 'accepted-chat', at: 1_000, ageMs: 0, context: 'positive', delta: { D: 5, O: 2, E: 4, N: 0, C: 0 } };
  assert.equal(selectBehaviorReaction(mood), null);
  for (const kind of ['look', 'speech'] as const) {
    mood.cue = { id: 'accepted-cue', kind, at: 1_000, until: 4_000 };
    assert.equal(selectBehaviorReaction(mood), null, `${kind} keeps its existing continuous/bubble delegate`);
  }
});

test('a satisfied cue preserves neutral/negative meaning rather than always smiling', () => {
  const mood = withCue();
  assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.convinced');
  mood.context = 'concern'; assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.compassion');
  mood.context = 'disappointment'; assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.disappointed');
  mood.context = 'offense'; assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.in-trouble');
  mood.primary = 'sad'; mood.context = 'neutral'; assert.equal(selectBehaviorReaction(mood)?.bindingId, 'face.sad');
});

test('direct interaction suppresses reactions so measured rua batches cannot restart clips', () => {
  for (const kind of ['satisfied', 'reunion', 'motion'] as const) for (const phase of ['rua', 'food-wait', 'food-ready', 'food-eating'] as const) {
    const mood = withCue(kind); mood.primary = 'happy'; mood.phase = phase;
    assert.equal(selectBehaviorReaction(mood), null, `${kind}/${phase}`);
  }
});

test('reaction selection copies accepted identity/times and keeps one key across later mood snapshots', () => {
  const mood = withCue(); mood.primary = 'happy';
  const selected = selectBehaviorReaction(mood)!;
  assert.equal(selected.sourceEventId, mood.cue!.id);
  assert.equal(selected.at, mood.cue!.at);
  assert.equal(selected.expiresAt, mood.cue!.until);
  assert.equal(selected.semantic, 'cue.satisfied');
  assert.equal('id' in selected || 'url' in selected || 'path' in selected, false);
  mood.primary = 'sad'; mood.trend.C = 10;
  assert.equal(selectBehaviorReaction(mood)?.key, selected.key);
});

test('malformed or unsupported cues cannot acquire a face performance', () => {
  for (const patch of [
    { id: '../cue' }, { id: 'https://example.test/cue' }, { id: '' }, { at: NaN }, { at: -1 }, { until: Infinity },
    { until: 1_000 }, { until: 999 }, { kind: 'dance' },
  ]) {
    const mood = withCue(); mood.cue = { ...mood.cue!, ...patch } as NonNullable<MoodSnapshot['cue']>;
    assert.equal(selectBehaviorReaction(mood), null);
  }
});

test('selection is repeatable on frozen input and never changes reward, state or cue identity', () => {
  const mood = withCue('reunion'); mood.primary = 'relieved'; mood.companion = 'wistful';
  const before = structuredClone(mood); deepFreeze(mood);
  assert.deepEqual(selectBehaviorState(mood), selectBehaviorState(mood));
  assert.deepEqual(selectBehaviorReaction(mood), selectBehaviorReaction(mood));
  assert.deepEqual(mood, before);
});
