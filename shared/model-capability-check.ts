import {
  CAPABILITY_NEEDS, MODEL_CAPABILITY_IDS, deriveModelCapabilities,
  type CapabilityChoice, type HaikuMatches, type ModelCapabilityId,
} from './model-capability';
import {
  MORPH_SLOTS, STANDARD_BONES, profileCandidateChecker, slotPolicy,
  type ModelProfile, type ModelProfileInput, type MorphSlot, type StandardBone,
} from './model-profile';

/**
 * I-024 模型体检, the host and page side (docs/claude/2026-11-04-i024-capability-host.md). One record per model, keyed by the
 * same content hash as the A1 profile cache: the user's on/off for each capability (MODEL_CAPABILITY_IDS, one table), the
 * slots haiku matched (each candidate passed the same vertex check as the profile's own name matches), what haiku was asked
 * and when the check ran. When the profile's names leave a capability missing, haiku reads ONLY this model's own morph and
 * bone names and the slots wanted (never chat, memory, a path or a file name), once per model; its answer must be strict
 * JSON naming names from the list. Nothing here changes PMX/VMD bytes.
 */

/** Bump to check every model again on its next load (the user's choices are kept; haiku's answer and matches are dropped). */
export const MODEL_CHECK_VERSION = 1;
export const MAX_CHECK_NAMES = 1024;
export const MAX_CHECK_NAME_LENGTH = 64;
export const MAX_CANDIDATES_PER_SLOT = 3;
export const MODEL_CHECK_TIMEOUT_MS = 30_000;

export interface ModelCheckNames { morphs: string[]; bones: string[] }
export interface ModelCheckWanted { morphs: MorphSlot[]; bones: StandardBone[] }
/** All haiku sees: this model's own part names and the slots wanted. */
export interface ModelCheckRequest { names: ModelCheckNames; wanted: ModelCheckWanted }
/** haiku's answer: up to MAX_CANDIDATES_PER_SLOT names from the list per wanted slot, most likely first. */
export interface HaikuCandidates { morphs: Partial<Record<MorphSlot, string[]>>; bones: Partial<Record<StandardBone, string[]>> }
/** matched: named something; none: answered, nothing fits; failed: timed out, errored or did not answer strict JSON. */
export type HaikuOutcome = 'matched' | 'none' | 'failed';
export interface ModelCheckAsked { at: number; outcome: HaikuOutcome; slots: number; candidates: HaikuCandidates }
export interface ModelCapabilityRecord {
  checkVersion: number;
  /** When this model's check finished (names, then haiku's candidates checked by vertices); null: not yet in this version. */
  checkedAt: number | null;
  /** The user's choices on the character page; a missing id follows what was detected. */
  choices: Partial<Record<ModelCapabilityId, 'on' | 'off'>>;
  haiku: HaikuMatches;
  /** Asked once per model, failures included; null: not asked. */
  asked: ModelCheckAsked | null;
  updatedAt: number;
}
/** The host's view for the current model; `profile` is its cached A1 profile, so a page can tell the record is its stage's model. */
export interface ModelCapabilityView { modelKey: string | null; modelUrl: string; profile: ModelProfile | null; record: ModelCapabilityRecord | null }
export interface ModelCapabilityUpdate { modelKey: string; record: ModelCapabilityRecord }
/** asked: haiku answered (or failed) now; stored: asked before, the same answer again; unavailable: Claude cannot be asked now (nothing recorded). */
export type ModelCheckAskStatus = 'asked' | 'stored' | 'failed' | 'unavailable';
export interface ModelCheckAskResult { status: ModelCheckAskStatus; candidates: HaikuCandidates | null }
/** 试一下 on the pet: shown; cannot (the stage said no); not-ready (no answer in time); pet-hidden. */
export type CapabilityPreviewResult = 'shown' | 'cannot' | 'not-ready' | 'pet-hidden';
export interface CapabilityPreviewRequest { requestId: string; id: ModelCapabilityId }

/** 中文名 of each capability: the character page's rows and the channel's list (list_model_capabilities) read this one table. */
export const CAPABILITY_LABELS: Readonly<Record<ModelCapabilityId, string>> = Object.freeze({
  closeEyes: '能闭眼', blush: '能脸红', mouth: '有口型', sleepPose: '能做睡姿', gesture: '能做手势', drowsyFace: '困的脸', tears: '能流泪',
});

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const isModelCapabilityId = (value: unknown): value is ModelCapabilityId => MODEL_CAPABILITY_IDS.includes(value as ModelCapabilityId);
export const isCheckName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CHECK_NAME_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
export const emptyCandidates = (): HaikuCandidates => ({ morphs: {}, bones: {} });
export const candidateCount = (candidates: HaikuCandidates | null | undefined) =>
  candidates ? Object.keys(candidates.morphs).length + Object.keys(candidates.bones).length : 0;
export const matchCount = (matches: HaikuMatches | null | undefined) =>
  Object.keys(matches?.morphs ?? {}).length + Object.keys(matches?.bones ?? {}).length;

export function emptyCapabilityRecord(now: number): ModelCapabilityRecord {
  return { checkVersion: MODEL_CHECK_VERSION, checkedAt: null, choices: {}, haiku: {}, asked: null, updatedAt: now };
}

/** The record is for this version's check (an older one is checked again, keeping the user's choices). */
export const recordChecked = (record: ModelCapabilityRecord | null | undefined): boolean =>
  !!record && record.checkVersion === MODEL_CHECK_VERSION && record.checkedAt !== null;

// ---------------------------------------------------------------- what to ask

/**
 * Universal skeleton step 2, the haiku entry point for the face actions' slots (嘟嘴, mouthPucker): EMPTY on purpose. Asking
 * haiku spends the user's quota and the user has not agreed to it (docs/claude/2026-11-06-universal-skeleton-plan.md, question
 * 3), so 嘟嘴 is found by its names and aliases only. To turn it on once the user says yes: put 'mouthPucker' here (its words
 * are already in MODEL_CHECK_SLOT_WORDS; haiku's candidate then passes the same lip check, profileCandidateChecker) and bump
 * MODEL_CHECK_VERSION so models checked before are asked once more.
 */
export const FACE_ACTION_HAIKU_SLOTS: readonly MorphSlot[] = Object.freeze([]);

/** Slots and bones the capabilities this profile cannot do yet still need (empty: nothing to ask). */
export function missingNeeds(profile: ModelProfile | null): ModelCheckWanted {
  const morphs = new Set<MorphSlot>(), bones = new Set<StandardBone>();
  if (!profile) return { morphs: [], bones: [] };
  const card = deriveModelCapabilities(profile);
  for (const id of MODEL_CAPABILITY_IDS) {
    if (card[id].detected) continue;
    for (const slot of CAPABILITY_NEEDS[id].morphs?.flat() ?? []) if ((profile.morphs[slot]?.index ?? -1) < 0) morphs.add(slot);
    for (const bone of CAPABILITY_NEEDS[id].bones ?? []) if (!profile.bones.map[bone]) bones.add(bone);
  }
  for (const slot of FACE_ACTION_HAIKU_SLOTS) if ((profile.morphs[slot]?.index ?? -1) < 0) morphs.add(slot);
  return { morphs: MORPH_SLOTS.filter(slot => morphs.has(slot)), bones: STANDARD_BONES.filter(bone => bones.has(bone)) };
}

/** This model's own part names, each once, bounded; overlong or control-character names are left out (never sent). */
export function modelCheckNames(input: Pick<ModelProfileInput, 'morphs' | 'bones'>): ModelCheckNames {
  const unique = (names: readonly string[]) => [...new Set(names.filter(isCheckName))].slice(0, MAX_CHECK_NAMES);
  return { morphs: unique(input.morphs.map(morph => morph.name)), bones: unique(input.bones.map(bone => bone.name)) };
}

/** Plain words for each slot haiku may be asked about ("left" is the model's own left). */
export const MODEL_CHECK_SLOT_WORDS: Readonly<Partial<Record<MorphSlot | StandardBone, string>>> = Object.freeze({
  blink: '两只眼睛一起闭上（眨眼、闭眼）',
  blinkLeft: '只闭上模型自己的左眼（单眼眨眼）',
  blinkRight: '只闭上模型自己的右眼（单眼眨眼）',
  shy: '脸红：两颊泛红的红晕',
  a: '嘴张大，发"啊"的口型',
  o: '嘴张圆，发"哦"的口型',
  jitome: '眼皮半垂（半闭眼、じと目）',
  sad: '眉毛皱起、发愁（困った眉）',
  // Not asked yet (FACE_ACTION_HAIKU_SLOTS is empty): ready for when the user agrees.
  mouthPucker: '嘟嘴：嘴唇往前撅、往中间收（口すぼめ）',
  neck: '脖子',
  head: '头',
  eyeLeft: '模型自己的左眼球',
  eyeRight: '模型自己的右眼球',
  armLeft: '模型自己的左上臂（肩膀到手肘）',
  armRight: '模型自己的右上臂（肩膀到手肘）',
  elbowLeft: '模型自己的左手肘（前臂）',
  elbowRight: '模型自己的右手肘（前臂）',
  wristLeft: '模型自己的左手腕（手）',
  wristRight: '模型自己的右手腕（手）',
});

export const MODEL_CHECK_SYSTEM_PROMPT = [
  '你是桌宠应用里的「模型部位对照器」，只做一件事：给你一个 MMD 模型自己的表情名清单和骨骼名清单，以及几个要找的部位，你从清单里挑出最可能是这个部位的名字。',
  '只输出一个 JSON 对象，不要任何别的文字，也不要代码块：{"morphs":{"槽位":["名字"]},"bones":{"槽位":["名字"]}}。',
  `名字必须原样取自清单；每个槽位最多 ${MAX_CANDIDATES_PER_SLOT} 个候选，按可能性从高到低。拿不准或清单里没有，就不写这个槽位，不要硬猜。左右指模型自己的左右。`,
].join('\n');

/** The whole prompt: fixed words, the wanted slots and this model's own names. Nothing else can get in. */
export function modelCheckPrompt(request: ModelCheckRequest): string {
  const wanted = (slots: readonly (MorphSlot | StandardBone)[]) => slots.map(slot => `${slot}：${MODEL_CHECK_SLOT_WORDS[slot] ?? slot}`).join('\n');
  return [
    ...(request.wanted.morphs.length ? ['要找的表情（填在 morphs 里）：', wanted(request.wanted.morphs), ''] : []),
    ...(request.wanted.bones.length ? ['要找的骨骼（填在 bones 里）：', wanted(request.wanted.bones), ''] : []),
    `表情名清单：${JSON.stringify(request.names.morphs)}`,
    `骨骼名清单：${JSON.stringify(request.names.bones)}`,
  ].join('\n');
}

/** Host-side check of what a page sends: bounded name lists and known slots only. */
export function validateModelCheckRequest(value: unknown): ModelCheckRequest {
  if (!isObject(value) || !isObject(value.names) || !isObject(value.wanted)) throw new Error('模型体检请求不正确。');
  const names = (list: unknown) => {
    if (!Array.isArray(list) || list.length > MAX_CHECK_NAMES || !list.every(isCheckName)) throw new Error('模型部位名字清单不正确。');
    return [...new Set(list)];
  };
  const slots = <T extends string>(list: unknown, known: readonly T[]) => {
    if (!Array.isArray(list) || !list.every(slot => known.includes(slot as T))) throw new Error('要找的部位不正确。');
    return known.filter(slot => list.includes(slot));
  };
  const request = { names: { morphs: names(value.names.morphs), bones: names(value.names.bones) },
    wanted: { morphs: slots(value.wanted.morphs, MORPH_SLOTS), bones: slots(value.wanted.bones, STANDARD_BONES) } };
  if (!request.wanted.morphs.length && !request.wanted.bones.length) throw new Error('没有要找的部位。');
  return request;
}

/** haiku's answer as candidates, or null when it is not strict JSON of that shape. Names not in the list are dropped. */
export function parseHaikuCandidates(text: string, request: ModelCheckRequest): HaikuCandidates | null {
  let body = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(body);
  if (fenced) body = fenced[1];
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  if (!isObject(data) || Object.keys(data).some(key => key !== 'morphs' && key !== 'bones')) return null;
  const result = emptyCandidates();
  const section = <T extends string>(value: unknown, wanted: readonly T[], names: readonly string[], into: Partial<Record<T, string[]>>): boolean => {
    if (value === undefined || value === null) return true;
    if (!isObject(value)) return false;
    for (const [slot, raw] of Object.entries(value)) {
      const list = typeof raw === 'string' ? [raw] : raw === null ? [] : Array.isArray(raw) ? raw : null;
      if (!list || !list.every(name => typeof name === 'string')) return false;
      if (!wanted.includes(slot as T)) continue;
      const picked = [...new Set(list as string[])].filter(name => names.includes(name)).slice(0, MAX_CANDIDATES_PER_SLOT);
      if (picked.length) into[slot as T] = picked;
    }
    return true;
  };
  if (!section(data.morphs, request.wanted.morphs, request.names.morphs, result.morphs)
    || !section(data.bones, request.wanted.bones, request.names.bones, result.bones)) return null;
  return result;
}

// ---------------------------------------------------------------- checking haiku's names on the model

/**
 * Each candidate goes through the same vertex check as the profile's name matches (profileCandidateChecker); the first that
 * passes takes the slot. A slot the profile already found keeps the name match, and a morph or bone the profile already uses
 * for another part is not taken again. Only what passed is returned.
 */
export function verifyHaikuCandidates(input: ModelProfileInput, profile: ModelProfile, candidates: HaikuCandidates): HaikuMatches {
  const check = profileCandidateChecker(input, profile);
  const morphs: Partial<Record<MorphSlot, number>> = {}, bones: Partial<Record<StandardBone, number>> = {};
  const usedMorphs = new Set(MORPH_SLOTS.map(slot => profile.morphs[slot]?.index ?? -1).filter(index => index >= 0));
  const indicesOf = (names: readonly string[], name: string) => names.flatMap((value, index) => value === name ? [index] : []);
  const morphNames = input.morphs.map(morph => morph.name), boneNames = input.bones.map(bone => bone.name);
  for (const slot of MORPH_SLOTS) {
    if ((profile.morphs[slot]?.index ?? -1) >= 0) continue;
    found: for (const name of candidates.morphs[slot] ?? [])
      for (const index of indicesOf(morphNames, name)) {
        if (usedMorphs.has(index) || check.morph(slot, index)) continue;
        morphs[slot] = index; usedMorphs.add(index); break found;
      }
  }
  const known: Partial<Record<StandardBone, number>> = {};
  for (const bone of STANDARD_BONES) { const entry = profile.bones.map[bone]; if (entry) known[bone] = entry.index; }
  const usedBones = new Set(Object.values(known));
  for (const bone of STANDARD_BONES) {
    if (known[bone] !== undefined) continue;
    found: for (const name of candidates.bones[bone] ?? [])
      for (const index of indicesOf(boneNames, name)) {
        if (usedBones.has(index) || check.bone(bone, index, known)) continue;
        bones[bone] = known[bone] = index; usedBones.add(index); break found;
      }
  }
  return { ...(Object.keys(morphs).length ? { morphs } : {}), ...(Object.keys(bones).length ? { bones } : {}) };
}

/**
 * The stage's profile with haiku's checked matches filled into the slots its names left empty (a slot the names found is
 * never replaced), so the stage uses them like a name match: the blink morph for the eyelids, the shy morph for the blush,
 * the neck for the sleep pose. Morph amounts stay uncalibrated (scale 1). Each index must still carry the name the model has
 * at that index. Returns the new profile and what was filled.
 */
export function mergeHaikuMatches(profile: ModelProfile, matches: HaikuMatches | null | undefined,
  names: { morphs: readonly string[]; bones: readonly string[] }): { profile: ModelProfile; merged: HaikuMatches } {
  const next = JSON.parse(JSON.stringify(profile)) as ModelProfile;
  const morphs: Partial<Record<MorphSlot, number>> = {}, bones: Partial<Record<StandardBone, number>> = {};
  for (const slot of MORPH_SLOTS) {
    const at = matches?.morphs?.[slot], entry = next.morphs[slot];
    if (!entry || entry.index >= 0 || !index(at) || typeof names.morphs[at] !== 'string') continue;
    next.morphs[slot] = { index: at, name: names.morphs[at], policy: slotPolicy(slot), amplitude: 0, scale: 1, rejected: entry.rejected };
    morphs[slot] = at;
  }
  for (const bone of STANDARD_BONES) {
    const at = matches?.bones?.[bone];
    if (next.bones.map[bone] || !index(at) || typeof names.bones[at] !== 'string') continue;
    next.bones.map[bone] = { index: at, name: names.bones[at] };
    next.bones.missing = next.bones.missing.filter(missing => missing !== bone);
    // T-213: a shared name is there but no motion track can bind it (shared/model-profile.ts profileBoneState).
    if (names.bones.filter(name => name === names.bones[at]).length > 1) next.bones.duplicates = [...next.bones.duplicates ?? [], bone];
    bones[bone] = at;
  }
  return { profile: next, merged: { ...(Object.keys(morphs).length ? { morphs } : {}), ...(Object.keys(bones).length ? { bones } : {}) } };
}

/** Whether a record's matches include any the stage's profile has not taken in yet (they apply from the next model load). */
export function matchesWaiting(record: Pick<ModelCapabilityRecord, 'haiku'> | null | undefined, merged: HaikuMatches | null | undefined): boolean {
  const waiting = <T extends string>(wanted: Partial<Record<T, number>> | undefined, have: Partial<Record<T, number>> | undefined) =>
    Object.entries(wanted ?? {}).some(([slot, at]) => (have as Record<string, number> | undefined)?.[slot] !== at);
  return waiting(record?.haiku?.morphs, merged?.morphs) || waiting(record?.haiku?.bones, merged?.bones);
}

// ---------------------------------------------------------------- stored data

const index = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 65_536;

/** Host-side check of verified matches a page reports; throws on anything else. */
export function validateHaikuMatches(value: unknown): HaikuMatches {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'morphs' && key !== 'bones')) throw new Error('模型体检结果不正确。');
  const section = <T extends string>(raw: unknown, known: readonly T[]): Partial<Record<T, number>> | undefined => {
    if (raw === undefined) return undefined;
    if (!isObject(raw) || !Object.entries(raw).every(([slot, at]) => known.includes(slot as T) && index(at))) throw new Error('模型体检结果不正确。');
    return Object.keys(raw).length ? { ...raw } as Partial<Record<T, number>> : undefined;
  };
  const morphs = section(value.morphs, MORPH_SLOTS), bones = section(value.bones, STANDARD_BONES);
  return { ...(morphs ? { morphs } : {}), ...(bones ? { bones } : {}) };
}

function acceptCandidates(value: unknown): HaikuCandidates | null {
  if (!isObject(value) || !isObject(value.morphs) || !isObject(value.bones)) return null;
  const section = <T extends string>(raw: Record<string, unknown>, known: readonly T[]) => Object.entries(raw).every(([slot, names]) =>
    known.includes(slot as T) && Array.isArray(names) && names.length >= 1 && names.length <= MAX_CANDIDATES_PER_SLOT && names.every(isCheckName));
  if (!section(value.morphs, MORPH_SLOTS) || !section(value.bones, STANDARD_BONES)) return null;
  return { morphs: structuredClone(value.morphs) as HaikuCandidates['morphs'], bones: structuredClone(value.bones) as HaikuCandidates['bones'] };
}

/** A stored record, or null when it is not one this version can read (that model is simply checked again). */
export function acceptCapabilityRecord(value: unknown): ModelCapabilityRecord | null {
  try {
    if (!isObject(value) || !Number.isInteger(value.checkVersion) || !finiteTime(value.updatedAt)
      || !(value.checkedAt === null || finiteTime(value.checkedAt)) || !isObject(value.choices)) return null;
    if (!Object.entries(value.choices).every(([id, choice]) => isModelCapabilityId(id) && (choice === 'on' || choice === 'off'))) return null;
    const haiku = validateHaikuMatches(value.haiku);
    let asked: ModelCheckAsked | null = null;
    if (value.asked !== null) {
      const raw = value.asked;
      if (!isObject(raw) || !finiteTime(raw.at) || !['matched', 'none', 'failed'].includes(raw.outcome as string)
        || !Number.isInteger(raw.slots) || (raw.slots as number) < 0 || (raw.slots as number) > MORPH_SLOTS.length + STANDARD_BONES.length) return null;
      const candidates = acceptCandidates(raw.candidates);
      if (!candidates) return null;
      asked = { at: raw.at, outcome: raw.outcome as HaikuOutcome, slots: raw.slots as number, candidates };
    }
    return { checkVersion: value.checkVersion as number, checkedAt: value.checkedAt as number | null,
      choices: { ...value.choices } as ModelCapabilityRecord['choices'], haiku, asked, updatedAt: value.updatedAt };
  } catch { return null; }
}

/** A choice from the character page (null: follow what was detected again). */
export function validateCapabilityChoice(id: unknown, choice: unknown): { id: ModelCapabilityId; choice: CapabilityChoice } {
  if (!isModelCapabilityId(id) || !(choice === 'on' || choice === 'off' || choice === null)) throw new Error('能力开关不正确。');
  return { id, choice };
}
