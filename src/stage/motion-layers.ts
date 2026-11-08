import {
  AnimationClip,
  type AnimationAction,
  type AnimationMixer,
  type SkinnedMesh,
} from "three";
import { MMDAnimationHelper } from "three/examples/jsm/animation/MMDAnimationHelper.js";
import type { BehaviorBodyDependencies } from "./behavior-body";

export type MotionLayerChannel = "pose" | "gesture" | "expression";

export interface MotionLayerClips {
  pose: AnimationClip | null;
  gesture: AnimationClip | null;
  expression: AnimationClip | null;
}

export type MotionLayerTimes = Record<MotionLayerChannel, number | null>;

interface PlayingLayer {
  clip: AnimationClip;
  action: AnimationAction;
}

const CHANNELS: readonly MotionLayerChannel[] = ["pose", "gesture", "expression"];
const EMPTY_CLIPS: MotionLayerClips = { pose: null, gesture: null, expression: null };

/** Classify only the bone and morph properties produced by MMDLoader. */
export function motionTrackChannel(trackName: string): MotionLayerChannel | null {
  if (/^\.morphTargetInfluences\[\d+\]$/.test(trackName)) return "expression";
  const match = /^\.bones\[([^\]]+)\]\.(?:position|quaternion|scale)$/.exec(trackName);
  if (!match) return null;
  const name = match[1].normalize("NFKC").toLowerCase().split(/[:|]/).at(-1)!
    .replace(/[\s_.-]/g, "").replace(/^bip\d+/, "");
  if (/^(?:左|右|両)?(?:上|下)?(?:目|眼|顎|あご|口|唇|眉|頬|鼻|舌|歯|瞼|まぶた)(?:\d|先|上|下|中|内|外|角|補助|ik|fk)*$/.test(name) ||
      /^(?:left|right|[lr])?(?:upper|lower)?(?:eye(?:brow|lid|ball)?s?|lid|jaw|mouth|lip|brow|face|cheek|nose|tongue|teeth)(?:left|right|[lr]|upper|lower|inner|outer|base|bone|joint|end|tip|ctrl|control|ik|fk|\d)*$/.test(name))
    return "expression";
  // Roots and legs remain controlled by the pose even if a source contains a full dance.
  if (/全ての親|センター|グルーブ|下半身|腰|足|脚|ひざ|膝|つま先|root|center|groove|waist|pelvis|hips?|leg|thigh|knee|ankle|foot|toe/.test(name))
    return "pose";
  if (/^(?:左|右|両)?(?:上半身|肩|腕|ひじ|肘|手首|親指|人指|人差指|中指|薬指|小指|首|頭)(?:\d|捩|捻|補助|先|ik|fk)*$/.test(name) ||
      /^(?:left|right|[lr])?(?:shoulder|upperarm|lowerarm|forearm|arm|elbow|wrist|hand|finger|thumb|index|middle|ring|pinky|little|neck|head|spine|chest|thorax)(?:left|right|[lr]|finger|thumb|index|middle|ring|pinky|little|bone|joint|twist|roll|aux|end|tip|ik|fk|\d)*$/.test(name))
    return "gesture";
  return "pose";
}

/** One MMD mixer with disjoint property tracks, so layers never average each other. */
export class LayeredMmdAnimation {
  readonly helper: MMDAnimationHelper;
  private readonly mixer: AnimationMixer;
  private source: MotionLayerClips = { ...EMPTY_CLIPS };
  private readonly playing: Partial<Record<MotionLayerChannel, PlayingLayer>> = {};
  private legacy = false;
  private disposed = false;

  constructor(private readonly mesh: SkinnedMesh) {
    this.helper = new MMDAnimationHelper({ sync: false, resetPhysicsOnLoop: false });
    // An empty array still asks the helper to create its mixer and IK/grant solvers.
    this.helper.add(mesh, { animation: [], physics: false });
    this.mixer = this.helper.objects.get(mesh)!.mixer!;
  }

  /** Return only properties whose source or playback phase actually changed. */
  setClips(clips: MotionLayerClips, options: { legacy?: boolean } = {}): string[] {
    if (this.disposed) return [];
    const legacy = options.legacy ?? false;
    const next: MotionLayerClips = legacy
      ? { pose: clips.pose, gesture: null, expression: null }
      : { ...clips };
    const changed = CHANNELS.filter(channel => next[channel] !== this.source[channel]);
    if (!changed.length && legacy === this.legacy) return [];
    const previousProperties = this.controlledProperties();

    const rebuild = new Set(changed);
    if (legacy !== this.legacy || changed.includes("gesture")) rebuild.add("pose");
    const poseTime = next.pose === this.source.pose ? this.playing.pose?.action.time ?? 0 : 0;
    // Splitting an existing VMD should continue its face at the same frame too.
    const expressionTime = this.legacy && !legacy && next.expression === this.source.pose
      ? this.playing.pose?.action.time ?? 0 : 0;

    // The helper caches the pre-IK skeleton. Restore it before changing bindings,
    // then refresh it after stop() restores properties that are no longer animated.
    this.restoreBoneSnapshot();
    for (const channel of rebuild) this.removeLayer(channel);
    const gestureTracks = new Set(next.gesture?.tracks
      .filter(track => motionTrackChannel(track.name) === "gesture")
      .map(track => track.name));
    for (const channel of rebuild) {
      const source = next[channel];
      if (!source) continue;
      const tracks = source.tracks.filter(track => {
        if (legacy) return true;
        const kind = motionTrackChannel(track.name);
        if (channel === "pose") return kind !== null && kind !== "expression" && !gestureTracks.has(track.name);
        return kind === channel;
      });
      // Keep the authored timeline even when a layer has no matching tracks.
      const clip = new AnimationClip(`${source.name}:${channel}`, Math.max(source.duration, 1 / 30), tracks, source.blendMode);
      const action = this.mixer.clipAction(clip).play();
      if (channel === "pose") action.time = poseTime;
      else if (channel === "expression") action.time = expressionTime;
      this.playing[channel] = { clip, action };
    }
    this.saveBoneSnapshot();
    this.source = next;
    this.legacy = legacy;
    const nextProperties = this.controlledProperties();
    return [...new Set([...previousProperties.keys(), ...nextProperties.keys()])].filter(name => {
      const before = previousProperties.get(name), after = nextProperties.get(name);
      return !before || !after || before.source !== after.source || Math.abs(before.time - after.time) > 1e-9;
    });
  }

  getLayerTimes(): MotionLayerTimes {
    return {
      pose: this.playing.pose?.action.time ?? null,
      gesture: this.playing.gesture?.action.time ?? null,
      expression: this.playing.expression?.action.time ?? null,
    };
  }

  /** An actual selected layer owns only the property tracks it contains. */
  hasLayerProperty(channel:MotionLayerChannel,property:string):boolean {
    return this.playing[channel]?.clip.tracks.some(track=>track.name===property)===true;
  }

  /** Internal presentation bridge only; no renderer IPC or second mixer. */
  getBehaviorBodyBindings(options: { allowBaseProjection?: boolean } = {}): BehaviorBodyDependencies {
    if (this.disposed) throw new Error("The MMD animation has been disposed.");
    return {
      mixer: this.mixer,
      baseActions: () => CHANNELS.flatMap(channel => this.playing[channel] ? [this.playing[channel]!.action] : []),
      allowBaseProjection: options.allowBaseProjection === true,
      withBoneBindings: <T>(mutation: () => T): T => {
        if (this.disposed) throw new Error("The MMD animation has been disposed.");
        this.restoreBoneSnapshot();
        try { return mutation(); }
        finally { this.saveBoneSnapshot(); }
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreBoneSnapshot();
    for (const channel of CHANNELS) this.removeLayer(channel);
    this.mixer.uncacheRoot(this.mesh);
    this.helper.remove(this.mesh);
    this.source = { ...EMPTY_CLIPS };
  }

  private removeLayer(channel: MotionLayerChannel): void {
    const layer = this.playing[channel];
    if (!layer) return;
    layer.action.stop();
    this.mixer.uncacheAction(layer.clip, this.mesh);
    delete this.playing[channel];
  }

  private controlledProperties(): Map<string, { source: AnimationClip; time: number }> {
    const properties = new Map<string, { source: AnimationClip; time: number }>();
    for (const channel of CHANNELS) {
      const layer = this.playing[channel], source = this.source[channel];
      if (!layer || !source) continue;
      for (const track of layer.clip.tracks) properties.set(track.name, { source, time: layer.action.time });
    }
    return properties;
  }

  private boneSnapshot(): Float32Array | undefined {
    // Three r170 exposes helper objects but omits its bone cache in the typings.
    return (this.helper.objects.get(this.mesh) as { backupBones?: Float32Array } | undefined)?.backupBones;
  }

  private restoreBoneSnapshot(): void {
    const snapshot = this.boneSnapshot();
    if (!snapshot) return;
    this.mesh.skeleton.bones.forEach((bone, index) => {
      bone.position.fromArray(snapshot, index * 7);
      bone.quaternion.fromArray(snapshot, index * 7 + 3);
    });
  }

  private saveBoneSnapshot(): void {
    const snapshot = this.boneSnapshot();
    if (!snapshot) return;
    this.mesh.skeleton.bones.forEach((bone, index) => {
      bone.position.toArray(snapshot, index * 7);
      bone.quaternion.toArray(snapshot, index * 7 + 3);
    });
  }
}
