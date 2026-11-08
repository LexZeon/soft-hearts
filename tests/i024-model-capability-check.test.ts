// I-024 模型体检: what haiku may see (names only), its strict answer, and the vertex check its names must pass (synthetic models).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelProfile, type ModelProfile } from '../shared/model-profile';
import { deriveModelCapabilities } from '../shared/model-capability';
import {
  MODEL_CHECK_SYSTEM_PROMPT, missingNeeds, modelCheckNames, modelCheckPrompt, parseHaikuCandidates, validateModelCheckRequest,
  verifyHaikuCandidates, type ModelCheckRequest,
} from '../shared/model-capability-check';
import { StageModelProfile, onStageModelProfile, requestModelProfileCache } from '../src/stage/model-profile';
import { JAPANESE_MORPHS, profileInput, toThreeMesh, toyModel, type ModelData, type ToyMorph } from './helpers/model-fixtures';

/** A model whose blink, blush and neck use names the alias lists do not know; a decoy "めとじ2" moves the mouth instead. */
function oddModel(): ModelData {
  const morphs: ToyMorph[] = [...JAPANESE_MORPHS.filter(morph => !['まばたき', 'ウィンク', 'ウィンク右', '照れ'].includes(morph.name)),
    { name: 'めとじ2', region: 'mouth', amount: 0.3 }, { name: 'めとじ', region: 'eyes', amount: 0.31 }, { name: 'ほっぺ', region: 'cheeks', amount: 0.09 }];
  const data = toyModel({ morphs });
  data.bones.find(bone => bone.name === '首')!.name = 'くび';
  return data;
}
const indexOf = (data: ModelData, name: string) => data.morphs.findIndex(morph => morph.name === name);
const boneIndex = (data: ModelData, name: string) => data.bones.findIndex(bone => bone.name === name);

test('the names miss blink, blush and the neck: those slots are what would be asked, nothing else', () => {
  const data = oddModel(), profile = buildModelProfile(profileInput(data));
  const card = deriveModelCapabilities(profile);
  assert.deepEqual([card.closeEyes.detected, card.blush.detected, card.sleepPose.detected, card.mouth.detected, card.gesture.detected], [false, false, false, true, true]);
  assert.deepEqual(missingNeeds(profile), { morphs: ['blink', 'blinkLeft', 'blinkRight', 'shy'], bones: ['neck'] });
  assert.deepEqual(missingNeeds(buildModelProfile(profileInput(toyModel()))), { morphs: [], bones: [] }, 'a fully named model asks nothing');
});

test("haiku's names count only after the same vertex check: a decoy that moves the mouth is not a blink", () => {
  const data = oddModel(), input = profileInput(data), profile = buildModelProfile(input);
  const matches = verifyHaikuCandidates(input, profile, { morphs: { blink: ['めとじ2', 'めとじ'], shy: ['ほっぺ'] }, bones: { neck: ['くび'] } });
  assert.deepEqual(matches, { morphs: { blink: indexOf(data, 'めとじ'), shy: indexOf(data, 'ほっぺ') }, bones: { neck: boneIndex(data, 'くび') } });
  const card = deriveModelCapabilities(profile, {}, matches);
  assert.deepEqual([card.closeEyes.source, card.blush.source, card.sleepPose.source], ['haiku', 'haiku', 'haiku']);
  // Only the decoy, a mouth morph for the blush, the hair or an arm for the neck: nothing passes, the card does not change.
  const none = verifyHaikuCandidates(input, profile, { morphs: { blink: ['めとじ2'], shy: ['あ'] }, bones: { neck: ['前髪', '左腕', '頭'] } });
  assert.deepEqual(none, {});
  assert.equal(deriveModelCapabilities(profile, {}, none).closeEyes.detected, false);
});

test('a slot the names already found keeps its match; a morph the profile already uses is not taken again', () => {
  const data = toyModel(), input = profileInput(data), profile = buildModelProfile(input);
  assert.deepEqual(verifyHaikuCandidates(input, profile, { morphs: { blink: ['じと目'], jitome: ['まばたき'] }, bones: { head: ['前髪'] } }), {});
});

test('what haiku sees is fixed words, the wanted slots and the model\'s own names; nothing else a page sends gets in', () => {
  const data = oddModel(), names = modelCheckNames(profileInput(data));
  assert.ok(names.morphs.includes('めとじ') && names.bones.includes('くび'));
  const page = { names: { ...names, memory: ['她昨天说想你'] }, wanted: { morphs: ['blink', 'shy'], bones: ['neck'] }, chat: '今天好累，抱抱我' };
  const request = validateModelCheckRequest(page);
  assert.deepEqual(Object.keys(request), ['names', 'wanted']);
  assert.deepEqual(Object.keys(request.names), ['morphs', 'bones']);
  const prompt = modelCheckPrompt(request);
  for (const secret of ['抱抱', '昨天', 'C:\\', '.pmx']) assert.equal(prompt.includes(secret), false, secret);
  // Take away the fixed lines and the two name lists: nothing is left.
  const lists = [`表情名清单：${JSON.stringify(names.morphs)}`, `骨骼名清单：${JSON.stringify(names.bones)}`];
  const rest = prompt.split('\n').filter(line => !lists.includes(line) && line !== '' && !/^要找的(表情|骨骼)/u.test(line) && !/^(blink|shy|neck)：/u.test(line));
  assert.deepEqual(rest, []);
  assert.doesNotMatch(MODEL_CHECK_SYSTEM_PROMPT, /聊天|记忆/u);
  assert.throws(() => validateModelCheckRequest({ names, wanted: { morphs: [], bones: [] } }), /没有要找/u);
  assert.throws(() => validateModelCheckRequest({ names: { morphs: ['a\nb'], bones: [] }, wanted: { morphs: ['blink'], bones: [] } }));
  assert.throws(() => validateModelCheckRequest({ names, wanted: { morphs: ['tail'], bones: [] } }));
  assert.equal(modelCheckNames({ morphs: [{ name: 'x'.repeat(65), offsets: () => null }, { name: 'ok', offsets: () => null }], bones: [] }).morphs.join(), 'ok',
    'an overlong name is never sent');
});

test('the answer must be strict JSON naming names from the list; anything else is a failure', () => {
  const request: ModelCheckRequest = { names: { morphs: ['めとじ', 'あ'], bones: ['くび'] }, wanted: { morphs: ['blink'], bones: ['neck'] } };
  assert.deepEqual(parseHaikuCandidates('{"morphs":{"blink":["めとじ","目とじ"]},"bones":{"neck":"くび"}}', request),
    { morphs: { blink: ['めとじ'] }, bones: { neck: ['くび'] } }, 'a made-up name is dropped');
  assert.deepEqual(parseHaikuCandidates('```json\n{"morphs":{"shy":["あ"]}}\n```', request), { morphs: {}, bones: {} }, 'a slot not asked is ignored');
  for (const bad of ['好的，眨眼是 めとじ', '{"morphs":{"blink":["めとじ"]}} 以上', '{"morphs":[1]}', '{"morphs":{"blink":[1]}}', '{"note":"x"}', ''])
    assert.equal(parseHaikuCandidates(bad, request), null, bad);
});

test('the real Three adapter: the stage profile tells listeners, gives its own names and checks on its own mesh', () => {
  const data = oddModel(), mesh = toThreeMesh(data), built: StageModelProfile[] = [];
  const stop = onStageModelProfile(profile => built.push(profile));
  try {
    const stage = new StageModelProfile(mesh, { reviewed: false });
    assert.deepEqual(built, [stage]);
    assert.deepEqual(stage.identity(), { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: data.morphs.map(morph => morph.name) });
    assert.ok(stage.checkNames()!.morphs.includes('めとじ'));
    const matches = stage.verifyHaikuCandidates({ morphs: { blink: ['めとじ2', 'めとじ'] }, bones: { neck: ['くび'] } });
    assert.deepEqual(matches, { morphs: { blink: indexOf(data, 'めとじ') }, bones: { neck: boneIndex(data, 'くび') } });
    stage.releaseCheckInput();
    assert.equal(stage.checkNames(), null);
    assert.deepEqual(stage.verifyHaikuCandidates({ morphs: { blink: ['めとじ'] }, bones: {} }), {}, 'released: nothing more is checked');
    stop();
    new StageModelProfile(mesh, { reviewed: false });
    assert.equal(built.length, 1, 'unsubscribed');
  } finally { stop(); mesh.geometry.dispose(); }
});

test('eye bones under unknown names: haiku\'s pair counts only on the right sides and under the head (能流泪 needs them)', () => {
  const data = toyModel();
  data.bones.find(bone => bone.name === '左目')!.name = 'め.L'; data.bones.find(bone => bone.name === '右目')!.name = 'め.R';
  const left = boneIndex(data, 'め.L'), right = boneIndex(data, 'め.R'), skin = Int32Array.from(data.skinBone);
  // The eyeballs: head vertices around each eye follow its eye bone (as a real model's do), so the bones really move something.
  for (let vertex = 0; vertex < skin.length; vertex++) {
    const x = data.positions[vertex * 3], y = data.positions[vertex * 3 + 1];
    if (y >= 17.85 && y <= 18.05 && Math.abs(x) >= 0.3 && Math.abs(x) <= 0.6) skin[vertex] = x > 0 ? left : right;
  }
  data.skinBone = skin;
  const input = profileInput(data), profile = buildModelProfile(input);
  assert.equal(deriveModelCapabilities(profile).tears.detected, false);
  assert.deepEqual(missingNeeds(profile).bones, ['eyeLeft', 'eyeRight']);
  assert.deepEqual(verifyHaikuCandidates(input, profile, { morphs: {}, bones: { eyeLeft: ['め.R'], eyeRight: ['め.L'] } }), {}, 'swapped sides');
  const matches = verifyHaikuCandidates(input, profile, { morphs: {}, bones: { eyeLeft: ['め.L'], eyeRight: ['め.R'] } });
  assert.deepEqual(matches, { bones: { eyeLeft: left, eyeRight: right } });
  assert.deepEqual(verifyHaikuCandidates(input, profile, { morphs: {}, bones: { eyeLeft: ['前髪'], eyeRight: ['左腕'] } }), {}, 'the hair and an arm are not eyes');
  assert.equal(deriveModelCapabilities(profile, {}, matches).tears.source, 'haiku');
});

test('next load: the host sends the checked matches with the cached profile and the stage uses them like a name match', async () => {
  const data = oddModel(), mesh = toThreeMesh(data);
  try {
    const first = new StageModelProfile(mesh, { reviewed: false });
    assert.equal(first.indices.blink, -1, 'the names found no blink');
    const matches = first.verifyHaikuCandidates({ morphs: { blink: ['めとじ'], shy: ['ほっぺ'] }, bones: { neck: ['くび'] } });
    const stored = JSON.parse(JSON.stringify(first.profile));
    const desktop = { getModelProfile: async () => ({ modelKey: 'a'.repeat(64), modelUrl: 'local://odd', profile: JSON.parse(JSON.stringify(stored)), haiku: matches }) };
    const cache = await requestModelProfileCache(desktop, 'local://odd');
    const second = new StageModelProfile(mesh, { reviewed: false, cached: cache!.profile });
    assert.equal(second.source, 'cache');
    assert.equal(second.indices.blink, indexOf(data, 'めとじ'), 'the eyelids now close with the morph haiku found');
    assert.equal(second.profile!.morphs.shy.index, indexOf(data, 'ほっぺ'));
    assert.equal(second.bone('neck')?.name, 'くび', 'the sleep pose has its neck');
    assert.deepEqual(second.fromHaiku, matches);
    assert.equal(second.namedProfile!.morphs.blink.index, -1, 'the names\' own profile is kept for the card');
    assert.deepEqual(deriveModelCapabilities(second.namedProfile, {}, matches).closeEyes.source, 'haiku');
    // The reviewed Gene never takes anything in; a stale or foreign index is ignored; without matches nothing changes.
    const reviewed = new StageModelProfile(mesh, { reviewed: true, cached: (await requestModelProfileCache(desktop, 'local://odd'))!.profile });
    assert.equal(reviewed.indices.blink, -1); assert.deepEqual(reviewed.fromHaiku, {});
    const plain = new StageModelProfile(mesh, { reviewed: false, cached: JSON.parse(JSON.stringify(stored)) });
    assert.equal(plain.indices.blink, -1);
    const bogus = { getModelProfile: async () => ({ modelKey: 'a'.repeat(64), modelUrl: 'local://odd', profile: JSON.parse(JSON.stringify(stored)),
      haiku: { morphs: { blink: 99_999 } } }) };
    const odd = new StageModelProfile(mesh, { reviewed: false, cached: (await requestModelProfileCache(bogus, 'local://odd'))!.profile });
    assert.equal(odd.indices.blink, -1, 'an index the model does not have is ignored');
    assert.equal(await requestModelProfileCache(desktop, 'local://another'), null, 'another model: nothing');
  } finally { mesh.geometry.dispose(); }
});

export type { ModelProfile };
