import { vmdDurationMs } from './vmd-duration';
import {
  BEHAVIOR_SEMANTICS, type BehaviorFaceBindingId, type BehaviorSemantic,
} from './behavior-motion';

/** A use is reviewed separately from the asset. No paths, permissions or settings. */
export type BehaviorRecipeId = BehaviorFaceBindingId | 'chat.explain' | 'chat.consider' | 'chat.upbeat'
  | 'body.confirm' | 'idle.neutral' | 'idle.arms-behind' | 'idle.arms-folded' | 'idle.proud' | 'idle.depressed';
export type RecipeChannel = 'expression' | 'gesture' | 'pose';
export interface BehaviorRecipe {
  readonly id: BehaviorRecipeId;
  readonly packId: 'gene' | 'genea-2022-gestures' | 'mpi-embm-gestures' | '100style-idles';
  readonly motionId: string;
  readonly sha256: string;
  readonly durationMs: number;
  readonly channel: RecipeChannel;
  readonly mask: 'gene-eyebrow-eye-v1' | 'm004-upper-body-v1' | 'candidate-head-v1' | 'candidate-pose-v1';
  readonly review: 'existing-use-verified' | 'review-required';
  readonly timing: 'original-once';
  readonly target: 'verified-gene';
  readonly evidence: string;
}
const face = (id: BehaviorFaceBindingId, sha256: string): BehaviorRecipe => Object.freeze({
  id, packId: 'gene', motionId: id.slice(5), sha256, durationMs: 10_000, channel: 'expression',
  mask: 'gene-eyebrow-eye-v1', review: 'existing-use-verified', timing: 'original-once', target: 'verified-gene',
  evidence: 'docs/mood/behavior-motion-implementation.md#a073: restricted eyebrows/eyes only',
});
const chat = (id: 'chat.explain' | 'chat.consider' | 'chat.upbeat'): BehaviorRecipe => Object.freeze({
  id, packId: id === 'chat.upbeat' ? 'mpi-embm-gestures' : 'genea-2022-gestures',
  motionId: id === 'chat.upbeat' ? 'conversation-joy' : 'speaking-gesture-2',
  sha256: id === 'chat.upbeat' ? '027860a2db2891277a36e723dc69300b16828a701e33169ec29edd3397db710b'
    : '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d',
  durationMs: id === 'chat.upbeat' ? vmdDurationMs(88) : 6_000, channel: 'gesture',
  mask: 'm004-upper-body-v1', review: 'existing-use-verified', timing: 'original-once', target: 'verified-gene',
  evidence: 'docs/motion-annotations/chat-gesture-m004.md: approved ten rotation tracks; single existing player',
});
const idle = (id: BehaviorRecipeId, motionId: string, sha256: string, frames = 300): BehaviorRecipe => Object.freeze({
  id, packId: '100style-idles', motionId, sha256, durationMs: vmdDurationMs(frames), channel: 'pose',
  mask: 'candidate-pose-v1', review: 'review-required', timing: 'original-once', target: 'verified-gene',
  evidence: 'MA1 sampled only; continuous one-shot use, legs, exit and combinations still require review',
});

/** Independently pinned source identities. Catalog labels/tags do not approve a use. */
export const BEHAVIOR_RECIPES: Readonly<Record<BehaviorRecipeId, BehaviorRecipe>> = Object.freeze({
  'face.smile': face('face.smile', '87cfd8818c6474a968ed83f8c6040d3a9657d8947a2eab7f47675a3fa50fb2b3'),
  'face.embarrassed-smile': face('face.embarrassed-smile', '1fe9d30181511c135b8fd9c8afb9795a29b197aa7da05a4a104c2c1e113296d3'),
  'face.happy': face('face.happy', '8da8b93dfc2dba19535246126558f82238c915ff8a90b2d05dfba17a333f903e'),
  'face.laugh': face('face.laugh', '714c04a833285aacc7b75039d872fc852c6df75025296bae0a707e5bbb3e159e'),
  'face.compassion': face('face.compassion', 'd90a4b147a5c87cb514aee1f6a44ae3c43beb13473039223897028f4847654f7'),
  'face.in-trouble': face('face.in-trouble', '62754cb6c6912a75c1506b8bcc375a03dfdffe5a9c6fe7573c1f9152e44a2497'),
  'face.disappointed': face('face.disappointed', 'ae12bcab9288fed1b951c565871f4414debd81a45b81ef1b29472f373f751790'),
  'face.disgust': face('face.disgust', '96944c44a88ac91ea7b87edfeccc677c8c83abf3cebeb76923ce3a95baf0f21f'),
  'face.sentimental': face('face.sentimental', 'f9f746e6c2fc660e21b5264a4282b8a155dbf8efdd3ce5d288ac834b5e71d8da'),
  'face.sad': face('face.sad', 'f7039798db01383d05febe7dcae03cb164ad6acee2015906459e9f6c425ba507'),
  'face.convinced': face('face.convinced', '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82'),
  'chat.explain': chat('chat.explain'), 'chat.consider': chat('chat.consider'), 'chat.upbeat': chat('chat.upbeat'),
  'body.confirm': Object.freeze({ id: 'body.confirm', packId: 'gene', motionId: 'convinced',
    sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82', durationMs: 10_000,
    channel: 'gesture', mask: 'candidate-head-v1', review: 'review-required', timing: 'original-once', target: 'verified-gene',
    evidence: 'Existing approval excludes all bones; head nod requires a separate continuous-use review' }),
  'idle.neutral': idle('idle.neutral', 'neutral-idle', '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb'),
  'idle.arms-behind': idle('idle.arms-behind', 'arms-behind-back-idle', 'c8ca993f621b9171d7aba41fdbdfd63d0819cadcbc13377d4fa431ae48419858'),
  'idle.arms-folded': idle('idle.arms-folded', 'arms-folded-idle', '8d3340498d8ce4e103ea2f1295893a25b3393a792a77fb1f11830ca648b5f9fd'),
  'idle.proud': idle('idle.proud', 'proud-idle', '811ae39e09565bf824baf4803f8467b2881f1b42088448a49e9cb2fde7403a05', 161),
  'idle.depressed': idle('idle.depressed', 'depressed-idle', 'e3084f4253a4a39edffffb47a620e110dcc42005419e3e540eb3a65faa425907'),
});

export type CoverageDisposition = 'authored-subset' | 'continuous' | 'modifier' | 'protected' | 'external' | 'gap' | 'reserved';
export interface BehaviorCoverage {
  readonly semantic: BehaviorSemantic;
  readonly disposition: CoverageDisposition;
  readonly activeRecipes: readonly BehaviorRecipeId[];
  readonly pendingRecipes: readonly BehaviorRecipeId[];
  readonly gaps: readonly string[];
  readonly fallback: string;
}
function coverage(semantic: BehaviorSemantic): BehaviorCoverage {
  const entry = BEHAVIOR_SEMANTICS[semantic];
  const activeRecipes: BehaviorRecipeId[] = [...entry.bindingIds];
  const pendingRecipes: BehaviorRecipeId[] = [], gaps: string[] = [];
  let disposition: CoverageDisposition = entry.route === 'face' ? 'authored-subset'
    : entry.kind === 'continuous' ? 'continuous' : entry.kind === 'modifier' ? 'modifier'
      : entry.kind === 'manual' || entry.kind === 'gate' ? 'protected'
        : entry.kind === 'reserved' ? 'reserved' : entry.route === 'voice' ? 'external' : 'gap';
  if (semantic.startsWith('chat.') && semantic !== 'chat.none') {
    activeRecipes.push(semantic as 'chat.explain' | 'chat.consider' | 'chat.upbeat'); disposition = 'authored-subset';
  }
  if (semantic === 'chat.none') disposition = 'protected';
  if (semantic.startsWith('voice.')) disposition = 'external';
  if (semantic.startsWith('mood.') || ['cue.reunion', 'cue.satisfied', 'cue.motion'].includes(semantic))
    gaps.push('No dedicated authored body reaction is approved for this semantic.');
  if (semantic === 'mood.calm' || semantic === 'phase.idle') {
    // MA1 observed these two as low-amplitude arms-down variants. Other idle
    // candidates remain in the registry but have no neutral-state assignment.
    pendingRecipes.push('idle.neutral', 'idle.proud');
    gaps.push('No continuous-use-verified automatic idle pool yet.');
  }
  if (semantic === 'cue.satisfied' || semantic === 'cue.motion') pendingRecipes.push('body.confirm');
  if (semantic === 'event.food' || semantic === 'phase.food-eating') gaps.push('No receiving, chewing or swallowing use is approved.');
  if (semantic === 'flag.crying-candidate' || semantic === 'cue.reunion') gaps.push('Visible tears are owned by R17; no crying resource is approved here.');
  return Object.freeze({ semantic, disposition, activeRecipes: Object.freeze(activeRecipes),
    pendingRecipes: Object.freeze(pendingRecipes), gaps: Object.freeze(gaps), fallback: entry.fallback });
}

/** Complete denominator, including intentional continuous/protected routes and explicit gaps. */
export const BEHAVIOR_COVERAGE: Readonly<Record<BehaviorSemantic, BehaviorCoverage>> = Object.freeze(
  Object.fromEntries((Object.keys(BEHAVIOR_SEMANTICS) as BehaviorSemantic[]).map(key => [key, coverage(key)])),
) as Readonly<Record<BehaviorSemantic, BehaviorCoverage>>;

export interface RecipeGates {
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly targetVerified: boolean;
  readonly manualPose: boolean;
  readonly manualGesture: boolean;
  readonly manualExpression: boolean;
  readonly manualHead: boolean;
  readonly dynamicPose: boolean;
  readonly phase: string; // Future cheek phase can suppress without changing legacy mood/card shapes.
  readonly cameraOrWindow: boolean;
  readonly inputFocused: boolean;
  readonly preview: boolean;
  readonly speaking: boolean;
  readonly music: boolean;
  readonly waitingForReply: boolean;
}
export type RecipeAdmission = { readonly allowed: true; readonly recipe: BehaviorRecipe }
  | { readonly allowed: false; readonly reason: 'unknown' | 'unreviewed-use' | 'unsupported-target' | 'gate' | 'manual' | 'continuous-owner' };

/** Called by the host before resolve and again after await. Caller cannot upgrade a pending use. */
export function admitBehaviorRecipe(id: unknown, gates: RecipeGates): RecipeAdmission {
  if (typeof id !== 'string' || !Object.hasOwn(BEHAVIOR_RECIPES, id)) return { allowed: false, reason: 'unknown' };
  const recipe = BEHAVIOR_RECIPES[id as BehaviorRecipeId];
  if (recipe.review !== 'existing-use-verified') return { allowed: false, reason: 'unreviewed-use' };
  const booleanKeys = ['enabled', 'visible', 'targetVerified', 'manualPose', 'manualGesture', 'manualExpression',
    'manualHead', 'dynamicPose', 'cameraOrWindow', 'inputFocused', 'preview', 'speaking', 'music', 'waitingForReply'] as const;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)
    || booleanKeys.some(key => typeof gates[key] !== 'boolean') || typeof gates.phase !== 'string')
    return { allowed: false, reason: 'gate' };
  if (!gates.targetVerified) return { allowed: false, reason: 'unsupported-target' };
  if (!gates.enabled || !gates.visible || gates.phase !== 'idle' || gates.cameraOrWindow || gates.inputFocused || gates.preview || gates.waitingForReply)
    return { allowed: false, reason: 'gate' };
  const manual = recipe.channel === 'expression' ? gates.manualExpression
    : gates.manualPose || gates.manualGesture || gates.dynamicPose;
  if (manual) return { allowed: false, reason: 'manual' };
  // Upper-body rotation has no mouth property: ordinary TTS can accompany it.
  if (recipe.channel !== 'expression' && gates.music) return { allowed: false, reason: 'continuous-owner' };
  return { allowed: true, recipe };
}
