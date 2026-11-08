import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLISION_PROXY_VERSION, PROXY_PARAMS, PROXY_SEGMENTS, acceptCollisionProxy, classifyProxyBones, fitCollisionProxy,
  type CollisionProxy, type CollisionProxyInput, type ProxyCapsule, type ProxySegment,
} from '../shared/collision-proxy';
import {
  MODEL_PROFILE_VERSION, acceptCachedProfile, buildModelProfile, standardBoneOfName, summarizeModelProfile, validateStoredModelProfile,
  type ModelProfile, type StandardBone, type Vec3,
} from '../shared/model-profile';
import {
  LINEAR_INTERPOLATION, buildRetargetRig, compactRig, planRetarget, qarc, qconj, qrotate, rigFromCompact, vlength, vnormalize, vsub,
  type CompactRig, type Quat, type RetargetRig, type TrackKey, type Tracks,
} from '../shared/motion-retarget';
import { adaptMotion, armClearance, checkTracks, fitMotion, usesFittedBody } from '../shared/motion-fit';
import geneSource from '../shared/retarget-gene-source.json';
import { StageModelProfile } from '../src/stage/model-profile';
import { bodyModel, shuffledVertices, type BodyOptions } from './helpers/body-fixtures';
import { profileInput, toThreeMesh, type ModelData } from './helpers/model-fixtures';
import { catalogMotions, loadBundledMotion, readGene } from './helpers/bundled-motions';

const profileOf = (data: ModelData) => buildModelProfile(profileInput(data));
const proxyOf = (data: ModelData) => profileOf(data).collision!;
const rigOf = (data: ModelData, key = 'body') => buildRetargetRig({ key, profile: profileOf(data), bones: data.bones, morphNames: [] });
const body = (options: BodyOptions = {}) => bodyModel(options);
const capsule = (proxy: CollisionProxy, segment: ProxySegment) => proxy.capsules.find(entry => entry.segment === segment)!;
const length = (entry: ProxyCapsule) => vlength(vsub(entry.b, entry.a));
const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.abs(vnormalize(a).reduce((sum, value, k) => sum + value * vnormalize(b)[k], 0)))) * 180 / Math.PI;
const TORSO_AND_HEAD: ProxySegment[] = ['pelvis', 'abdomen', 'chest', 'neck', 'head'];
/** The same capsule within `tolerance` (radius relative, endpoints in model units). */
function sameCapsule(actual: ProxyCapsule, expected: ProxyCapsule, tolerance: number, label: string) {
  assert.equal(actual.bone, expected.bone, label);
  assert.ok(Math.abs(actual.radius / expected.radius - 1) <= tolerance, `${label} radius ${actual.radius} vs ${expected.radius}`);
  for (const end of ['a', 'b'] as const) assert.ok(vlength(vsub(actual[end], expected[end])) <= tolerance * 2, `${label} ${end} ${actual[end]} vs ${expected[end]}`);
}
const still = (q: Quat): TrackKey[] => [0, 60].map(frame => ({ frame, p: [0, 0, 0], q, interp: LINEAR_INTERPOLATION }));

/** Left upper arm swung forward until the elbow is `front` ahead of the body line, forearm straight across the belly (toward -x). */
function forearmAcrossBelly(rig: RetargetRig, front: number): Tracks {
  const at = (slot: StandardBone) => rig.bones[rig.slots[slot]!].position;
  const upper = vlength(vsub(at('elbowLeft'), at('armLeft'))), sin = front / upper;
  const arm = qarc(vsub(at('elbowLeft'), at('armLeft')), [0, -Math.sqrt(1 - sin * sin), sin]);
  const elbow = qarc(vnormalize(vsub(at('wristLeft'), at('elbowLeft'))), qrotate(qconj(arm), [-1, 0, 0]));
  return new Map([[rig.slots.armLeft!, still(arm)], [rig.slots.elbowLeft!, still(elbow)]]);
}
/** Front of the torso mesh at a height (vertices near the midline). */
function frontAt(data: ModelData, y: number): number {
  let front = -Infinity;
  for (let vertex = 0; vertex < data.positions.length / 3; vertex++) {
    const [px, py, pz] = [data.positions[vertex * 3], data.positions[vertex * 3 + 1], data.positions[vertex * 3 + 2]];
    if (Math.abs(px) < 0.3 && Math.abs(py - y) < 0.2) front = Math.max(front, pz);
  }
  return front;
}

test('one capsule per body segment, sized like the mesh and lying along its bones (A and T pose)', () => {
  for (const pose of ['A', 'T'] as const) {
    const data = body({ pose }), proxy = proxyOf(data);
    assert.equal(proxy.version, COLLISION_PROXY_VERSION);
    assert.deepEqual(proxy.capsules.map(entry => entry.segment), [...PROXY_SEGMENTS], pose);
    assert.deepEqual(proxy.missing, []);
    const expected: Partial<Record<ProxySegment, [number, number]>> = {
      // Built radii: belly ~0.62..0.95 across, chest ~0.7..1.1, neck 0.4, head ~1.0, upper arm 0.38→0.32, forearm 0.31→0.25, thigh 0.68→0.45, shin 0.44→0.3.
      abdomen: [0.75, 0.95], chest: [0.75, 1.0], neck: [0.37, 0.43], head: [0.9, 1.1], upperArmLeft: [0.32, 0.38], forearmLeft: [0.25, 0.31],
      thighLeft: [0.48, 0.68], shinLeft: [0.32, 0.44], pelvis: [0.9, 1.2],
    };
    for (const [segment, [low, high]] of Object.entries(expected) as [ProxySegment, [number, number]][])
      assert.ok(capsule(proxy, segment).radius >= low && capsule(proxy, segment).radius <= high, `${pose} ${segment} ${capsule(proxy, segment).radius}`);
    const bone = (slot: StandardBone) => data.bones[profileOf(data).bones.map[slot]!.index].position;
    for (const [segment, from, to] of [['upperArmLeft', 'armLeft', 'elbowLeft'], ['forearmRight', 'elbowRight', 'wristRight'], ['thighLeft', 'legLeft', 'kneeLeft']] as const)
      assert.ok(angleDeg(vsub(capsule(proxy, segment).b, capsule(proxy, segment).a), vsub(bone(to), bone(from))) < 2, `${pose} ${segment} along its bone`);
    // Left and right mirror each other (to the quantile's sample step).
    const left = capsule(proxy, 'forearmLeft'), right = capsule(proxy, 'forearmRight');
    assert.ok(Math.abs(left.radius - right.radius) < 1e-6 && Math.abs(left.a[0] + right.a[0]) < 5e-3 && Math.abs(left.a[1] - right.a[1]) < 5e-3, `${left.a} ${right.a}`);
  }
});

test('a fat belly: the old round capsule misses a forearm buried in it, the fitted proxy catches it (and the slim body stays clean)', () => {
  const fat = body({ build: 'fat' }), slim = body();
  const fatRig = rigOf(fat, 'fat'), slimRig = rigOf(slim, 'slim');
  assert.ok(usesFittedBody(fatRig) && usesFittedBody(slimRig));
  const roughFat: RetargetRig = { ...fatRig, collision: null };
  assert.equal(usesFittedBody(roughFat), false);
  const front = 0.95, tracks = forearmAcrossBelly(fatRig, front);
  // Geometry first: the forearm (radius ~0.28) lies fully inside the fat belly, and just in front of the slim one.
  const height = 15.36 - Math.sqrt(vlength(vsub(fatRig.bones[fatRig.slots.elbowLeft!].position, fatRig.bones[fatRig.slots.armLeft!].position)) ** 2 - front ** 2);
  assert.ok(frontAt(fat, height) > front + 0.28 + 0.2, `fat belly front ${frontAt(fat, height)}`);
  assert.ok(frontAt(slim, height) <= front - 0.28 + 0.02, `slim belly front ${frontAt(slim, height)}`);
  // The old approximation (one hip-to-neck capsule, 0.27 shoulder widths) is the same for both bodies and misses it.
  assert.ok(armClearance(roughFat, tracks, 30).Left!.torso > 1);
  assert.deepEqual(checkTracks(roughFat, tracks, 60).issues, []);
  // The fitted proxy sees the belly.
  const fitted = armClearance(fatRig, tracks, 30).Left!;
  assert.ok(fitted.torso < 1 && fitted.fitted && fitted.segment === 'abdomen', JSON.stringify(fitted));
  const issues = checkTracks(fatRig, tracks, 60).issues;
  assert.equal(issues[0]?.check, 'penetration');
  assert.match(issues[0].where, /left arm into torso \(abdomen\)/);
  const fit = fitMotion(fatRig, new Map(tracks), 60, []);
  assert.notEqual(fit.status, 'ok');
  assert.deepEqual(fit.before.map(issue => [issue.check, issue.where]), [['penetration', 'left arm into torso (abdomen)']]);
  // Known limit (docs/claude/2026-11-02-collision-proxy.md): the 30° ease-out moves the forearm down to the pelvis/belly junction,
  // where stacked capsules under-cover a fat belly, so the re-check calls it adjusted although the mesh is still crossed.
  // On the slim body the same pose only touches.
  assert.ok(armClearance(slimRig, forearmAcrossBelly(slimRig, front), 30).Left!.torso > 1);
  assert.deepEqual(checkTracks(slimRig, forearmAcrossBelly(slimRig, front), 60).issues, []);
});

test('the whole library on skinned synthetic bodies with fitted proxies (slim/fat/bust, A/T, no twist + D bones): nothing hidden', () => {
  const source = rigFromCompact(geneSource as unknown as CompactRig);
  assert.ok(usesFittedBody(source), 'the shipped Gene source rig carries its proxy, so baselines compare like with like');
  for (const options of [{}, { pose: 'T' }, { build: 'fat' }, { bust: 0.7, skirt: 'bones', hair: 'bones' }, { pose: 'T', twist: false, dBones: true }] as BodyOptions[]) {
    const target = rigOf(body(options), JSON.stringify(options));
    assert.ok(usesFittedBody(target));
    const plan = planRetarget(source, target);
    const statuses = catalogMotions.map(motion => adaptMotion(loadBundledMotion(motion.id), plan).fit.status);
    assert.equal(statuses.filter(status => status === 'hidden').length, 0, JSON.stringify(options));
    assert.ok(statuses.filter(status => status === 'ok').length >= 50, JSON.stringify(options));
  }
});

test('a long skirt and long hair on their own chains (physics, names or both) do not widen the body', () => {
  const plain = proxyOf(body());
  for (const variant of ['bones', 'physics-only', 'named-only'] as const) {
    const proxy = proxyOf(body({ skirt: variant, hair: variant }));
    assert.equal(proxy.excluded.bones, 8 * 2 + 3 * 3, variant);
    assert.ok(proxy.excluded.vertices > 1000, variant);
    for (const segment of TORSO_AND_HEAD) sameCapsule(capsule(proxy, segment), capsule(plain, segment), 0.01, `${variant} ${segment}`);
  }
  // Control: the same skirt on bones nothing marks (neutral names, no physics) is indistinguishable from body and does widen the hips.
  const unmarked = proxyOf(body({ skirt: 'unmarked' }));
  assert.ok(capsule(unmarked, 'pelvis').radius > capsule(plain, 'pelvis').radius * 1.1, String(capsule(unmarked, 'pelvis').radius));
});

test('stray accessory vertices skinned straight to the chest neither move nor inflate it; a bust does widen it forward', () => {
  const plain = proxyOf(body()), stray = proxyOf(body({ outliers: 40 }));
  assert.ok(40 / capsule(stray, 'chest').vertices > 0.05, 'more than the centre quantile alone would ignore');
  sameCapsule(capsule(stray, 'chest'), capsule(plain, 'chest'), 0.01, 'chest with strays');
  const bust = proxyOf(body({ bust: 0.7 }));
  assert.ok(capsule(bust, 'chest').radius > capsule(plain, 'chest').radius * 1.08);
  const z = (entry: ProxyCapsule) => (entry.a[2] + entry.b[2]) / 2;
  assert.ok(z(capsule(bust, 'chest')) > z(capsule(plain, 'chest')) + 0.15, 'the chest axis moves toward the bust');
  sameCapsule(capsule(bust, 'abdomen'), capsule(plain, 'abdomen'), 0.02, 'abdomen under a bust');
});

test('skin weights: BDEF1/BDEF2/BDEF4 and SDEF-as-two-weights count by share; thresholds are tunable', () => {
  const bones = [
    { name: 'root', parent: -1, position: [0, 0, 0] as Vec3 }, { name: '左腕', parent: 0, position: [0, 10, 0] as Vec3 },
    { name: '左ひじ', parent: 1, position: [0, 7, 0] as Vec3 }, { name: '左手首', parent: 2, position: [0, 4, 0] as Vec3 },
    { name: '左髪', parent: 0, position: [0, 6, -1] as Vec3 },
  ];
  const positions: number[] = [], indices: number[] = [], weights: number[] = [];
  const ring = (y: number, r: number, count: number, skin: [number, number][]) => {
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * 2 * Math.PI; positions.push(r * Math.cos(angle), y, r * Math.sin(angle));
      for (let s = 0; s < 4; s++) { indices.push(skin[s]?.[0] ?? 0); weights.push(skin[s]?.[1] ?? 0); }
    }
  };
  for (const y of [9, 8.5, 8]) ring(y, 0.4, 8, [[1, 1]]); // BDEF1 upper arm
  for (const y of [6, 5.5, 5]) ring(y, 0.3, 8, [[2, 1]]); // BDEF1 forearm
  ring(7.2, 0.38, 10, [[1, 0.6], [2, 0.4]]); // BDEF2 mostly upper arm
  ring(6.8, 0.33, 10, [[1, 0.4], [2, 0.6]]); // BDEF2 mostly forearm
  ring(7.0, 0.35, 10, [[1, 0.3], [2, 0.3], [3, 0.2], [0, 0.2]]); // BDEF4 with no majority: nobody's
  ring(7.1, 0.36, 10, [[1, 0.5], [2, 0.5]]); // SDEF (as MMDLoader skins it: two weights), a tie: the first segment in order
  ring(5.8, 0.3, 10, [[2, 0.85], [4, 0.15]]); // a hair strand's root over the forearm
  const input: CollisionProxyInput = { positions, skin: { indices, weights, width: 4 }, bones, slots: { armLeft: 1, elbowLeft: 2, wristLeft: 3 } };
  const count = (proxy: CollisionProxy, segment: ProxySegment) => proxy.capsules.find(entry => entry.segment === segment)?.vertices ?? 0;
  const base = fitCollisionProxy(input);
  assert.deepEqual(base.capsules.map(entry => entry.segment), ['upperArmLeft', 'forearmLeft']);
  assert.equal(count(base, 'upperArmLeft'), 24 + 10 + 10);
  assert.equal(count(base, 'forearmLeft'), 24 + 10);
  assert.deepEqual(base.excluded, { bones: 1, vertices: 10 });
  const strict = fitCollisionProxy(input, { minWeight: 0.65 });
  assert.equal(count(strict, 'upperArmLeft'), 24); assert.equal(count(strict, 'forearmLeft'), 24);
  assert.equal(count(fitCollisionProxy(input, { maxExcluded: 0.2 }), 'forearmLeft'), 24 + 10 + 10, 'a looser hair limit keeps the strand roots');
  assert.equal(PROXY_PARAMS.minWeight, 0.5);
});

test('deterministic: the same mesh always gives the same proxy, whatever the vertex order', () => {
  const data = body({ bust: 0.4, skirt: 'bones', hair: 'bones', outliers: 12 });
  const first = proxyOf(data), second = proxyOf(data);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(proxyOf(shuffledVertices(data)), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'plain JSON');
  // Rounded to 1e-6, so a cache round trip is exact.
  for (const entry of first.capsules) for (const value of [...entry.a, ...entry.b, entry.radius]) assert.equal(Math.round(value * 1e6) / 1e6, value);
});

test('T pose without twist bones and with "D" leg bones: the same body, the same torso and legs', () => {
  const plain = proxyOf(body({ pose: 'T' })), variant = proxyOf(body({ pose: 'T', twist: false, dBones: true }));
  for (const segment of ['pelvis', 'abdomen', 'chest', 'thighLeft', 'shinRight', 'upperArmLeft', 'handRight'] as const)
    sameCapsule(capsule(variant, segment), capsule(plain, segment), 0.02, segment);
  const data = body({ dBones: true }), profile = profileOf(data);
  const slots: Partial<Record<StandardBone, number>> = Object.fromEntries(Object.entries(profile.bones.map).map(([slot, entry]) => [slot, entry!.index]));
  const classes = classifyProxyBones({ bones: data.bones, slots, slotOfName: standardBoneOfName });
  const named = (name: string) => PROXY_SEGMENTS[classes[data.bones.findIndex(bone => bone.name === name)]];
  assert.equal(named('左足D'), 'thighLeft'); assert.equal(named('右ひざD'), 'shinRight');
});

test('Gene: a full proxy that leaves hair, earrings, cloak and hem out and follows twist links', () => {
  const gene = readGene(), profile = profileOf(gene), proxy = profile.collision!;
  assert.deepEqual(proxy.capsules.map(entry => entry.segment), [...PROXY_SEGMENTS]);
  const slots: Partial<Record<StandardBone, number>> = Object.fromEntries(Object.entries(profile.bones.map).map(([slot, entry]) => [slot, entry!.index]));
  const physics = new Set(gene.rigidBodies.filter(entry => entry.type !== 0).map(entry => entry.boneIndex));
  const classes = classifyProxyBones({ bones: gene.bones.map((bone, index) => ({ ...bone, physics: physics.has(index) })), slots, slotOfName: standardBoneOfName });
  const classOf = (name: string) => classes[gene.bones.findIndex(bone => bone.name === name)];
  gene.bones.forEach((bone, index) => { if (/髪|アホ毛|イヤリング|クローク|すそ/.test(bone.name)) assert.equal(classes[index], -2, bone.name); });
  assert.equal(proxy.excluded.bones, gene.bones.filter(bone => /髪|アホ毛|イヤリング|クローク|すそ/.test(bone.name)).length);
  assert.equal(PROXY_SEGMENTS[classOf('左腕捩連')], 'upperArmLeft'); assert.equal(PROXY_SEGMENTS[classOf('右手捩連')], 'forearmRight');
  assert.equal(PROXY_SEGMENTS[classOf('上半身補')], 'abdomen');
  assert.equal(classOf('右肩連'), -1, 'a shoulder link (付与 from 右肩) is a shoulder, not chest');
  const p = profile.proportions, sw = p.shoulderWidth!;
  for (const segment of ['pelvis', 'abdomen', 'chest'] as const) {
    const ratio = capsule(proxy, segment).radius / sw;
    assert.ok(ratio > 0.25 && ratio < 0.5, `${segment} ${ratio}`);
  }
  const head = capsule(proxy, 'head');
  assert.ok(head.radius / p.headSize > 0.3 && head.radius / p.headSize < 0.42, String(head.radius / p.headSize));
  // Crown to chin; the joined lower end may reach into the neck, not below it.
  const neckY = gene.bones[profile.bones.map.neck!.index].position[1];
  assert.ok(Math.max(head.a[1], head.b[1]) + head.radius <= p.crownY + 0.05, 'not above the crown (the hair cap counts, the hair chains do not)');
  assert.ok(Math.min(head.a[1], head.b[1]) - head.radius >= neckY, 'not below the neck joint');
  // Plain, bounded profile data, accepted by the host store.
  assert.ok(JSON.stringify(profile).length < 64_000);
  assert.deepEqual(validateStoredModelProfile(JSON.parse(JSON.stringify(profile))).collision, proxy);
  // The shipped source rig carries it unchanged (capsules ride slots, not indices).
  const rig = buildRetargetRig({ key: 'gene', profile, bones: gene.bones, morphNames: [] });
  assert.deepEqual(rigFromCompact(JSON.parse(JSON.stringify(compactRig(rig)))).collision, proxy);
});

test('the profile carries the proxy through the cache; a tampered or stale proxy means a recompute', () => {
  const data = body({ hair: 'bones' }), profile = profileOf(data);
  const model = { vertices: data.positions.length / 3, bones: data.bones.map(bone => bone.name), morphs: [] as string[] };
  assert.equal(profile.version, MODEL_PROFILE_VERSION);
  const stored = validateStoredModelProfile(JSON.parse(JSON.stringify(profile)));
  assert.deepEqual(acceptCachedProfile(stored, model), profile);
  const tamper = (change: (proxy: Record<string, unknown> & { capsules: Record<string, unknown>[] }) => void) => {
    const copy = JSON.parse(JSON.stringify(stored)) as ModelProfile & { collision: never }; change(copy.collision); return acceptCachedProfile(copy, model);
  };
  assert.equal(tamper(proxy => { proxy.version = COLLISION_PROXY_VERSION + 1; }), null);
  assert.equal(tamper(proxy => { proxy.capsules[0].radius = -1; }), null);
  assert.equal(tamper(proxy => { proxy.capsules[0].bone = 'tail'; }), null);
  assert.equal(tamper(proxy => { proxy.capsules[1].segment = proxy.capsules[0].segment; }), null);
  assert.equal(tamper(proxy => { proxy.capsules.pop(); }), null);
  assert.equal(acceptCachedProfile({ ...stored, collision: undefined }, model), null);
  assert.deepEqual(acceptCachedProfile({ ...stored, collision: null }, model)?.collision, null, 'a model without skin data has none');
  // A capsule riding a bone this model does not map is refused.
  assert.equal(acceptCollisionProxy(profile.collision, bone => bone !== 'head'), null);
  // Developer summary (canvas data-model-profile): plain numbers per segment.
  const summary = summarizeModelProfile(profile, 'computed', false).collision!;
  assert.equal(summary.capsules, 15); assert.deepEqual(summary.missing, []);
  assert.equal(summary.radius.chest, Math.round(capsule(profile.collision!, 'chest').radius * 1000) / 1000);
  assert.ok(summary.excludedBones > 0);
  assert.equal(summarizeModelProfile(null, 'unavailable', false).collision, null);
});

test('the stage adapter fits the same proxy from an MMDLoader-shaped mesh (full weights, rigid bodies, grants)', () => {
  const gene = readGene(), expected = proxyOf(gene), mesh = toThreeMesh(gene, { fullSkin: true });
  try {
    const stage = new StageModelProfile(mesh, { reviewed: true });
    const proxy = stage.profile!.collision!;
    assert.deepEqual(proxy.capsules.map(entry => [entry.segment, entry.bone, entry.vertices]), expected.capsules.map(entry => [entry.segment, entry.bone, entry.vertices]));
    proxy.capsules.forEach((entry, k) => sameCapsule(entry, expected.capsules[k], 1e-5, entry.segment));
    assert.deepEqual(proxy.excluded, expected.excluded);
    assert.equal(stage.summary.collision?.capsules, 15);
  } finally { mesh.geometry.dispose(); }
});
