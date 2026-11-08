export interface TargetBone {
  name: string;
  position: number[];
  parentIndex: number;
  connectIndex?: number;
  offsetPosition?: number[];
  ik?: { effector: number };
}
export interface RetargetOptions {
  startFrame?: number;
  endFrame?: number;
  rootMode?: 'fixed' | 'vertical' | 'relative';
  sourceUpAxis?: 'y' | 'z';
  faceForward?: boolean;
  upperBodyOnly?: boolean;
  loopBlendSeconds?: number;
  scale?: number;
  modelName?: string;
  mapping?: Record<string, string>;
}
export interface BoneFrame {
  boneName: string;
  frameNum: number;
  position: number[];
  rotation: number[];
}
export function parseBvh(text: string): {
  nodes: { name: string; parent: number; children: number[]; offset: number[]; channels: string[]; channelOffset: number; endSite: boolean }[];
  values: Float64Array;
  channelCount: number;
  frameCount: number;
  frameTime: number;
};
export function retargetBvhToGene(text: string, targetBones: TargetBone[], options?: RetargetOptions): {
  bytes: Buffer;
  report: {
    sourceFrameCount: number;
    sourceFrameTime: number;
    startFrame: number;
    endFrame: number;
    outputFrameCount: number;
    outputFps: number;
    durationSeconds: number;
    scale: number;
    sourceUpAxis: 'y' | 'z';
    faceForward: boolean;
    rootMode: string;
    upperBodyOnly: boolean;
    loopBlendSeconds: number;
    mapping: Record<string, string>;
    missingTargets: string[];
    warnings: string[];
  };
};
export function encodeVmd(frames: BoneFrame[], modelName?: string): Buffer;
