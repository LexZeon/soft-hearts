/** Offline, explicit BVH retargeting. Input BVH is never executed or loaded by the app. */
import { Matrix4, Quaternion, Vector3 } from 'three';

const RAD = Math.PI / 180;
const UNIT = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) };
const MAX_FRAMES = 250_000;
const normal = value => value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^mixamorig/, '');
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}: ${value}`);
  return number;
};

/** Strict parser for single-root BVH with arbitrary listed Euler channel order. */
export function parseBvh(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024 * 1024) throw new Error('BVH input exceeds the offline conversion limit.');
  const tokens = text.replace(/^\uFEFF/, '').match(/[^\s{}]+|[{}]/g) || [];
  let cursor = 0;
  let channelCount = 0;
  const nodes = [];
  const take = () => {
    if (cursor >= tokens.length) throw new Error('Unexpected end of BVH.');
    return tokens[cursor++];
  };
  const expect = value => { if (take().toUpperCase() !== value.toUpperCase()) throw new Error(`Expected BVH ${value}.`); };
  function node(parent, endSite = false) {
    if (nodes.length >= 512) throw new Error('Too many BVH joints.');
    const index = nodes.length;
    const entry = { name: endSite ? `end-${index}` : take(), parent, children: [], offset: [], channels: [], channelOffset: channelCount, endSite };
    nodes.push(entry);
    expect('{'); expect('OFFSET');
    entry.offset = [finite(take(), 'offset'), finite(take(), 'offset'), finite(take(), 'offset')];
    if (!endSite) {
      expect('CHANNELS');
      const count = finite(take(), 'channel count');
      if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error('Invalid BVH channel count.');
      for (let i = 0; i < count; i++) {
        const channel = take();
        if (!/^[XYZ](position|rotation)$/.test(channel) || entry.channels.includes(channel)) throw new Error('Unsupported or duplicate BVH channel.');
        entry.channels.push(channel);
      }
      channelCount += count;
    }
    while (true) {
      const type = take().toUpperCase();
      if (type === '}') break;
      if (type === 'JOINT') entry.children.push(node(index));
      else if (type === 'END') { expect('SITE'); entry.children.push(node(index, true)); }
      else throw new Error(`Unexpected BVH hierarchy token: ${type}`);
    }
    return index;
  }
  expect('HIERARCHY'); expect('ROOT'); node(-1);
  expect('MOTION'); expect('Frames:');
  const frameCount = finite(take(), 'frame count');
  expect('Frame'); expect('Time:');
  const frameTime = finite(take(), 'frame time');
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > MAX_FRAMES || frameTime <= 0 || frameTime > 1) throw new Error('Invalid BVH timing.');
  if (tokens.length - cursor !== frameCount * channelCount) throw new Error('BVH frame/channel data does not match its header.');
  const values = new Float64Array(frameCount * channelCount);
  for (let i = 0; i < values.length; i++) values[i] = finite(take(), 'motion channel');
  const restPositions = nodes.map((entry, i) => {
    const value = new Vector3(...entry.offset);
    if (entry.parent >= 0) value.add(nodes[entry.parent].restPosition);
    entry.restPosition = value;
    return value;
  });
  return { nodes, values, channelCount, frameCount, frameTime, restPositions };
}

function sample(bvh, frame) {
  const low = Math.max(0, Math.min(bvh.frameCount - 1, Math.floor(frame)));
  const high = Math.min(bvh.frameCount - 1, low + 1);
  const fraction = frame - low;
  const positions = [];
  const rotations = [];
  function local(entry, index) {
    const rotation = new Quaternion();
    const position = new Vector3(...entry.offset);
    for (let channel = 0; channel < entry.channels.length; channel++) {
      const name = entry.channels[channel];
      const value = bvh.values[index * bvh.channelCount + entry.channelOffset + channel];
      if (name.endsWith('position')) position[name[0].toLowerCase()] += value;
      else rotation.multiply(new Quaternion().setFromAxisAngle(UNIT[name[0]], value * RAD));
    }
    return { position, rotation };
  }
  for (const entry of bvh.nodes) {
    const first = local(entry, low);
    const second = fraction > 0 ? local(entry, high) : first;
    const position = first.position.lerp(second.position, fraction);
    const rotation = first.rotation.slerp(second.rotation, fraction).normalize();
    if (entry.parent >= 0) {
      position.applyQuaternion(rotations[entry.parent]).add(positions[entry.parent]);
      rotation.premultiply(rotations[entry.parent]);
    }
    positions.push(position);
    rotations.push(rotation);
  }
  return { positions, rotations };
}

function frameFromDirection(direction) {
  const y = direction.clone().normalize();
  if (y.lengthSq() < 0.99) return new Quaternion();
  let z = new Vector3(0, 0, 1).addScaledVector(y, -y.z);
  if (z.lengthSq() < 1e-8) z = new Vector3(0, 1, 0).addScaledVector(y, -y.y);
  z.normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

function aliases(bvh) {
  const index = new Map(bvh.nodes.filter(node => !node.endSite).map(node => [normal(node.name), bvh.nodes.indexOf(node)]));
  const find = (...names) => names.map(normal).map(name => index.get(name)).find(value => value !== undefined);
  const collarRig = find('LeftCollar', 'RightCollar') !== undefined;
  const map = new Map();
  const add = (target, ...names) => { const source = find(...names); if (source !== undefined) map.set(target, source); };
  add('下半身', 'Hips', 'Hip', 'Pelvis', 'b_root', 'Root');
  add('上半身', 'Chest', 'Spine', 'Spine1', 'LowerBack', 'SpineLower', 'Spine_01', 'b_spine0');
  add('上半身2', 'Chest4', 'Spine3', 'Spine2', 'UpperChest', 'Chest2', 'Spine_03', 'Spine_02', 'b_spine3', 'Chest');
  add('首', 'Neck', 'Neck1', 'b_neck0');
  add('頭', 'Head', 'b_head');
  for (const [side, japanese, short] of [['Left', '左', 'L'], ['Right', '右', 'R']]) {
    add(`${japanese}肩`, `${side}Collar`, `${side}Clavicle`, `${short}Clavicle`, `b_${short}_shoulder`, ...(collarRig ? [] : [`${side}Shoulder`]));
    add(`${japanese}腕`, ...(collarRig ? [`${side}Shoulder`] : []), `${side}Arm`, `${side}UpperArm`, `${short}UpperArm`, `${short}Arm`, `b_${short}_arm`);
    add(`${japanese}ひじ`, `${side}Elbow`, `${side}ForeArm`, `${side}LowerArm`, `${short}ForeArm`, `${short}LowerArm`, `b_${short}_forearm`);
    add(`${japanese}手首`, `${side}Wrist`, `${side}Hand`, `${short}Hand`, `b_${short}_wrist`);
    add(`${japanese}足`, `${side}Hip`, `${side}UpLeg`, `${side}UpperLeg`, `${side}Thigh`, `${short}UpLeg`, `${short}Thigh`, `b_${short}_upleg`);
    add(`${japanese}ひざ`, `${side}Knee`, `${side}Leg`, `${side}LowerLeg`, `${short}Leg`, `${short}Shin`, `b_${short}_leg`);
    add(`${japanese}足首`, `${side}Ankle`, `${side}Foot`, `${short}Foot`, `b_${short}_foot`);
  }
  // One source joint cannot independently drive both MMD spine joints.
  if (map.get('上半身') === map.get('上半身2')) map.delete('上半身2');
  return map;
}

const NEXT = { '上半身': '上半身2', '上半身2': '首', '首': '頭', '左肩': '左腕', '右肩': '右腕', '左腕': '左ひじ', '右腕': '右ひじ', '左ひじ': '左手首', '右ひじ': '右手首', '左足': '左ひざ', '右足': '右ひざ', '左ひざ': '左足首', '右ひざ': '右足首' };
const LOWER = /^(下半身|[左右](足|ひざ|足首))$/;
function targetDirection(bone, bones, index) {
  const next = NEXT[bone.name] && index.get(NEXT[bone.name]);
  if (next !== undefined) return new Vector3(...bones[next].position).sub(new Vector3(...bone.position));
  if (bone.connectIndex >= 0 && bones[bone.connectIndex]) return new Vector3(...bones[bone.connectIndex].position).sub(new Vector3(...bone.position));
  if (Array.isArray(bone.offsetPosition)) return new Vector3(...bone.offsetPosition);
  const child = bones.find(entry => entry.parentIndex === index.get(bone.name));
  if (child) return new Vector3(...child.position).sub(new Vector3(...bone.position));
  return new Vector3(0, 1, 0);
}

function populateIkTargets(pose, bones, index) {
  const positions = [];
  const rotations = [];
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    const motion = pose.get(bone.name);
    const rotation = motion?.rotation.clone() ?? new Quaternion();
    const position = new Vector3(...bone.position);
    if (bone.parentIndex >= 0) {
      position.sub(new Vector3(...bones[bone.parentIndex].position));
      position.add(motion?.position ?? new Vector3()).applyQuaternion(rotations[bone.parentIndex]).add(positions[bone.parentIndex]);
      rotation.premultiply(rotations[bone.parentIndex]);
    } else position.add(motion?.position ?? new Vector3());
    positions.push(position); rotations.push(rotation);
  }
  for (const side of ['左', '右']) {
    const footIndex = index.get(`${side}足ＩＫ`);
    const toeIndex = index.get(`${side}つま先ＩＫ`);
    const ankleIndex = index.get(`${side}足首`);
    if (footIndex === undefined || ankleIndex === undefined) continue;
    const foot = bones[footIndex];
    const ankle = positions[ankleIndex];
    const parentPosition = foot.parentIndex < 0 ? new Vector3() : positions[foot.parentIndex];
    const parentRotation = foot.parentIndex < 0 ? new Quaternion() : rotations[foot.parentIndex];
    const restOffset = new Vector3(...foot.position).sub(foot.parentIndex < 0 ? new Vector3() : new Vector3(...bones[foot.parentIndex].position));
    const position = ankle.clone().sub(parentPosition).applyQuaternion(parentRotation.clone().invert()).sub(restOffset);
    const rotation = parentRotation.clone().invert().multiply(rotations[ankleIndex]);
    pose.set(foot.name, { position, rotation });
    if (toeIndex !== undefined) {
      const toe = bones[toeIndex];
      const effector = toe.ik?.effector;
      if (effector !== undefined && positions[effector]) {
        const toeOffset = new Vector3(...toe.position).sub(new Vector3(...foot.position));
        const offset = positions[effector].clone().sub(ankle).applyQuaternion(rotations[ankleIndex].clone().invert()).sub(toeOffset);
        pose.set(toe.name, { position: offset, rotation: new Quaternion() });
      }
    }
  }
}

/**
 * Retarget into PMX bones parsed with parsePmx(..., true), i.e. Three's right-handed space.
 * Bone directions correct T/A pose differences; rotations are solved through the actual
 * target hierarchy, including unmapped helper bones. Output bytes use VMD's left-handed space.
 */
export function retargetBvhToGene(text, targetBones, options = {}) {
  const bvh = parseBvh(text);
  if (!Array.isArray(targetBones) || targetBones.length < 2 || targetBones.some(bone => !Array.isArray(bone.position) || bone.position.length !== 3 || !bone.position.every(Number.isFinite))) throw new Error('Expected right-handed PMX bone data.');
  const targetIndex = new Map(targetBones.map((bone, index) => [bone.name, index]));
  const center = targetIndex.get('センター');
  if (center === undefined) throw new Error('Target is missing the MMD center bone.');
  for (let i = 0; i < targetBones.length; i++) if (!Number.isInteger(targetBones[i].parentIndex) || targetBones[i].parentIndex >= i || targetBones[i].parentIndex < -1) throw new Error('Target bones must be in parent-first PMX order.');
  const mapping = aliases(bvh);
  if (options.mapping) for (const [target, sourceName] of Object.entries(options.mapping)) {
    const source = bvh.nodes.findIndex(node => node.name === sourceName);
    if (source < 0 || !targetIndex.has(target)) throw new Error(`Unknown explicit bone mapping: ${target} / ${sourceName}`);
    mapping.set(target, source);
  }
  if (!mapping.has('下半身') || !mapping.has('頭') || !mapping.has('左腕') || !mapping.has('右腕')) throw new Error('BVH skeleton needs explicit mappings for pelvis, head and both upper arms.');
  const start = options.startFrame ?? 0;
  const end = options.endFrame ?? bvh.frameCount - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= bvh.frameCount || end <= start) throw new Error('Invalid BVH crop frames.');
  const seconds = (end - start) * bvh.frameTime;
  // Common exporters round 1/30 and 1/120 to six decimal places. Rounding here
  // preserves the selected endpoint instead of silently dropping a VMD frame.
  const count = Math.round(seconds * 30) + 1;
  if (count > 18_001) throw new Error('Convert at most ten minutes per clip.');
  const up = options.sourceUpAxis ?? 'y';
  if (!['y', 'z'].includes(up)) throw new Error('sourceUpAxis must be y or z.');
  const rootMode = options.rootMode ?? 'fixed';
  if (!['fixed', 'vertical', 'relative'].includes(rootMode)) throw new Error('Unknown root motion mode.');
  const sourceToWorld = up === 'z' ? new Quaternion().setFromAxisAngle(UNIT.X, -Math.PI / 2) : new Quaternion();
  const initial = sample(bvh, start);
  const sourcePelvis = mapping.get('下半身');
  if (options.faceForward !== false) {
    const forward = new Vector3(0, 0, 1).applyQuaternion(initial.rotations[sourcePelvis]).applyQuaternion(sourceToWorld);
    const yaw = Math.atan2(forward.x, forward.z);
    sourceToWorld.premultiply(new Quaternion().setFromAxisAngle(UNIT.Y, -yaw));
  }
  const targetHip = targetBones[targetIndex.get('下半身') ?? center].position[1];
  const sourceHip = Math.abs(initial.positions[sourcePelvis].clone().applyQuaternion(sourceToWorld).y);
  const sourceRestHeight = Math.max(...bvh.restPositions.map(position => position.y)) - Math.min(...bvh.restPositions.map(position => position.y));
  const targetHeight = Math.max(...targetBones.map(bone => bone.position[1])) - Math.min(...targetBones.map(bone => bone.position[1]));
  const scale = options.scale ?? (sourceHip > 1 ? targetHip / sourceHip : targetHeight / sourceRestHeight);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) throw new Error('Invalid skeleton scale.');
  const corrections = new Map();
  for (const [name, source] of mapping) {
    if (!targetIndex.has(name)) continue;
    const target = targetBones[targetIndex.get(name)];
    if (name === '下半身') { corrections.set(name, new Quaternion()); continue; }
    const next = NEXT[name] && mapping.get(NEXT[name]);
    const child = next ?? bvh.nodes[source].children[0];
    if (child === undefined) { corrections.set(name, new Quaternion()); continue; }
    const sourceDirection = bvh.restPositions[child].clone().sub(bvh.restPositions[source]);
    corrections.set(name, frameFromDirection(sourceDirection).multiply(frameFromDirection(targetDirection(target, targetBones, targetIndex)).invert()));
  }
  const poses = [];
  const initialPosition = initial.positions[sourcePelvis].clone();
  const outputNames = new Set(['センター']);
  for (const name of corrections.keys()) if (!(options.upperBodyOnly && LOWER.test(name))) outputNames.add(name);
  // Reset twist helpers: mapped forearms/wrists already contain the source twist.
  for (const name of ['左腕捩', '右腕捩', '左手捩', '右手捩']) if (targetIndex.has(name)) outputNames.add(name);
  for (let frame = 0; frame < count; frame++) {
    const sourceFrame = start + Math.min(seconds, frame / 30) / bvh.frameTime;
    const source = sample(bvh, sourceFrame);
    const desired = new Map();
    for (const [name, correction] of corrections) {
      if (options.upperBodyOnly && LOWER.test(name)) continue;
      desired.set(targetIndex.get(name), source.rotations[mapping.get(name)].clone().premultiply(sourceToWorld).multiply(correction).normalize());
    }
    const centerOffset = source.positions[sourcePelvis].clone().sub(initialPosition).applyQuaternion(sourceToWorld).multiplyScalar(scale);
    if (rootMode === 'fixed' || options.upperBodyOnly) centerOffset.set(0, 0, 0);
    else if (rootMode === 'vertical') centerOffset.set(0, centerOffset.y, 0);
    const rotations = [];
    const worldRotations = [];
    const positions = [];
    for (let i = 0; i < targetBones.length; i++) {
      const bone = targetBones[i];
      const parentRotation = bone.parentIndex < 0 ? new Quaternion() : worldRotations[bone.parentIndex];
      const rotation = desired.has(i) ? parentRotation.clone().invert().multiply(desired.get(i)).normalize() : new Quaternion();
      const position = new Vector3(...bone.position);
      if (bone.parentIndex >= 0) position.sub(new Vector3(...targetBones[bone.parentIndex].position)).applyQuaternion(parentRotation).add(positions[bone.parentIndex]);
      if (i === center) position.add(centerOffset);
      rotations.push(rotation);
      worldRotations.push(parentRotation.clone().multiply(rotation));
      positions.push(position);
    }
    const pose = new Map([...outputNames].map(name => [name, { position: name === 'センター' ? centerOffset.clone() : new Vector3(), rotation: rotations[targetIndex.get(name)].clone() }]));
    poses.push(pose);
  }
  const blendSeconds = options.loopBlendSeconds ?? 0;
  if (!Number.isFinite(blendSeconds) || blendSeconds < 0 || blendSeconds > seconds / 2) throw new Error('Loop blend must fit inside half of the clip.');
  const blendFrames = Math.min(count - 1, Math.round(blendSeconds * 30));
  if (blendFrames > 0) {
    for (let i = count - blendFrames; i < count; i++) {
      const value = (i - (count - blendFrames) + 1) / blendFrames;
      const alpha = value * value * (3 - 2 * value);
      for (const [name, motion] of poses[i]) {
        const first = poses[0].get(name);
        if (!first) continue;
        motion.position.lerp(first.position, alpha);
        motion.rotation.slerp(first.rotation, alpha).normalize();
      }
    }
  }
  const frames = [];
  const previous = new Map();
  for (let i = 0; i < poses.length; i++) {
    // Recompute after loop blending too, so IK still agrees with the blended FK pose.
    // The runtime leaves IK enabled and does not consume VMD IK-enable records.
    populateIkTargets(poses[i], targetBones, targetIndex);
    for (const [boneName, motion] of poses[i]) {
    const q = motion.rotation;
    if (previous.has(boneName) && previous.get(boneName).dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    previous.set(boneName, q.clone());
    frames.push({ boneName, frameNum: i, position: motion.position.toArray(), rotation: q.toArray() });
    }
  }
  return {
    bytes: encodeVmd(frames, options.modelName ?? 'Gene retarget'),
    report: { sourceFrameCount: bvh.frameCount, sourceFrameTime: bvh.frameTime, startFrame: start, endFrame: end, outputFrameCount: count, outputFps: 30, durationSeconds: (count - 1) / 30, scale, sourceUpAxis: up, faceForward: options.faceForward !== false, rootMode, upperBodyOnly: Boolean(options.upperBodyOnly), loopBlendSeconds: blendSeconds, mapping: Object.fromEntries([...mapping].map(([name, i]) => [name, bvh.nodes[i].name])), missingTargets: ['上半身', '上半身2', '首', '左肩', '右肩', '左ひじ', '右ひじ', '左手首', '右手首', '左足', '右足'].filter(name => !mapping.has(name)), warnings: ['Body bones only; no face, finger articulation or physics.', 'Source non-root translations are not copied; the target keeps its own limb lengths.', 'Retargeted clips require visual playback review before inclusion.'] },
  };
}

let shiftJis;
function encodeShiftJis(value, limit) {
  if (!shiftJis) {
    shiftJis = new Map();
    const decoder = new TextDecoder('shift-jis', { fatal: true });
    for (let a = 0; a < 256; a++) {
      try { const char = decoder.decode(Uint8Array.of(a)); if (char.length === 1) shiftJis.set(char, Buffer.from([a])); } catch {}
      if (!((a >= 0x81 && a <= 0x9f) || (a >= 0xe0 && a <= 0xfc))) continue;
      for (let b = 0x40; b <= 0xfc; b++) {
        if (b === 0x7f) continue;
        try { const char = decoder.decode(Uint8Array.of(a, b)); if (char.length === 1 && !shiftJis.has(char)) shiftJis.set(char, Buffer.from([a, b])); } catch {}
      }
    }
  }
  const bytes = [];
  for (const character of value) {
    const encoded = shiftJis.get(character);
    if (!encoded) throw new Error(`VMD name is not representable in Shift-JIS: ${value}`);
    bytes.push(encoded);
  }
  const result = Buffer.concat(bytes);
  if (result.length > limit) throw new Error(`VMD name is too long: ${value}`);
  return result;
}

/** Encode right-handed Three-space bone frames as standard left-handed VMD 0002. */
export function encodeVmd(frames, modelName = 'Gene retarget') {
  if (!Array.isArray(frames) || frames.length > 2_000_000) throw new Error('VMD bone-frame limit exceeded.');
  const data = Buffer.alloc(54 + frames.length * 111 + 5 * 4);
  data.write('Vocaloid Motion Data 0002', 0, 'ascii');
  encodeShiftJis(modelName, 20).copy(data, 30);
  data.writeUInt32LE(frames.length, 50);
  let offset = 54;
  const names = new Map();
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameNum) || frame.frameNum < 0 || frame.frameNum > 0xffffffff || !Array.isArray(frame.position) || frame.position.length !== 3 || !Array.isArray(frame.rotation) || frame.rotation.length !== 4 || ![...frame.position, ...frame.rotation].every(Number.isFinite)) throw new Error('Invalid VMD bone frame.');
    if (!names.has(frame.boneName)) names.set(frame.boneName, encodeShiftJis(frame.boneName, 15));
    names.get(frame.boneName).copy(data, offset); offset += 15;
    data.writeUInt32LE(frame.frameNum, offset); offset += 4;
    // Reflection through Z: position z changes sign, quaternion x/y change sign.
    for (const value of [frame.position[0], frame.position[1], -frame.position[2], -frame.rotation[0], -frame.rotation[1], frame.rotation[2], frame.rotation[3]]) { data.writeFloatLE(value, offset); offset += 4; }
    const control = [20, 20, 20, 20, 20, 20, 20, 20, 107, 107, 107, 107, 107, 107, 107, 107];
    for (let block = 0; block < 4; block++) { Buffer.from(control).copy(data, offset); offset += 16; }
  }
  return data;
}
