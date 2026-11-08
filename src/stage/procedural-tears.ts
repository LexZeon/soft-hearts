import { Bone, Matrix4, ShaderMaterial, SkinnedMesh, Vector3, type Material } from 'three';
import type { BlushAnchors } from './procedural-blush';
import { TEAR_LOOK, tearColorGlsl, tearMaskGlsl } from './tear-look';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finitePoint = (p: readonly number[]) => p.length === 3 && p.every(Number.isFinite);

/** Technical presentation constants, measured in displayed eye distances; not mood parameters. The full look is TEAR_LOOK. */
export const TEAR_STYLE = Object.freeze({ start: TEAR_LOOK.start, length: TEAR_LOOK.length, width: TEAR_LOOK.width, beadWidth: TEAR_LOOK.beadWidth, beadHeight: TEAR_LOOK.beadHeight });

export interface TearsState {
  supported: boolean;
  reason: string;
  attached: boolean;
  compiled: number;
  amount: number;
  elapsedMs: number;
  materialIndices: number[];
}

function supportedMaterial(material: Material | undefined): material is ShaderMaterial {
  return material instanceof ShaderMaterial && material.opacity > 0.2 &&
    material.vertexShader.includes('#include <common>') && material.vertexShader.includes('#include <displacementmap_vertex>') &&
    material.vertexShader.includes('#include <skinning_vertex>') && material.fragmentShader.includes('#include <common>') &&
    material.fragmentShader.includes('#include <opaque_fragment>') && material.fragmentShader.includes('outgoingLight') &&
    material.fragmentShader.includes('vViewPosition') && material.fragmentShader.includes('#include <normal_fragment_maps>');
}

/**
 * `cardAllowed` (I-024): another model whose capability card has 流泪 on. It passes the same landmark, surface and axis
 * gates as the reviewed Gene (found eye display positions on a named face material); without them tears stay off.
 * Only the reviewed Gene gets its audited cheek-cover material too.
 */
export function tearsSupport(anchors: BlushAnchors | null, verifiedGene: boolean, cardAllowed = false): { supported: boolean; reason: string } {
  if (verifiedGene !== true && cardAllowed !== true) return { supported: false, reason: '泪水暂限主进程核验内容的预装 Gene，或模型体检卡开了"能流泪"的模型；当前保留原表情' };
  // I-038: the face surface is a named face material, or one unnamed material that owns both cheeks (local-face, one index).
  if (!anchors || anchors.eyeReference !== 'main-eye-geometry'
    || !(anchors.surfaceSource === 'named-face' || (anchors.surfaceSource === 'local-face' && new Set(anchors.materialIndices).size === 1)))
    return { supported: false, reason: '泪水需要已确认的双眼展示位置与脸部材质；当前未放置泪痕' };
  if (![anchors.leftEye, anchors.rightEye, anchors.leftCheek, anchors.rightCheek, anchors.right, anchors.up, anchors.forward].every(finitePoint) ||
    !Number.isFinite(anchors.eyeDistance) || anchors.eyeDistance < 1e-5 || !anchors.materialIndices.length ||
    !anchors.materialIndices.every(index => Number.isSafeInteger(index) && index >= 0))
    return { supported: false, reason: '泪水锚点不可用，当前未放置泪痕' };
  const axes = [anchors.right, anchors.up, anchors.forward].map(p => new Vector3(...p));
  if (axes.some(axis => Math.abs(axis.length() - 1) > 0.02) || Math.abs(axes[0].dot(axes[1])) > 0.02 ||
    Math.abs(axes[0].dot(axes[2])) > 0.02 || Math.abs(axes[1].dot(axes[2])) > 0.02)
    return { supported: false, reason: '泪水脸部参考轴不可靠，当前未放置泪痕' };
  return { supported: true, reason: verifiedGene === true ? 'Gene 程序泪痕与滑落泪珠；实际贴合与可见性待本包画面验收' : '程序泪痕与滑落泪珠（模型体检卡，已找到双眼与脸部材质）；实际贴合与可见性待画面验收' };
}

const VERTEX_DECLARATIONS = `
uniform mat4 shTearsMeshToHead;
varying vec3 vShTearsHead;
`;
const FRAGMENT_DECLARATIONS = `
uniform float shTearsAmount;
uniform float shTearsTime;
uniform float shTearsScale;
uniform vec3 shTearsLeft;
uniform vec3 shTearsRight;
uniform vec3 shTearsAxisX;
uniform vec3 shTearsAxisY;
uniform vec3 shTearsForward;
varying vec3 vShTearsHead;
// x: wet rim, y: translucent blue body, z: white glint (tear-look.ts).
${tearMaskGlsl()}`;
// R17: colours, strengths and sizes come from TEAR_LOOK (tear-look.ts), the one place to tune how tears look.
const FRAGMENT_COLOR = tearColorGlsl();

/**
 * A bounded surface effect: no particles, textures, fluid solver, model edits or scene geometry.
 * Attach AFTER ProceduralBlush and dispose BEFORE it, including calibration rebuilds.
 * Head-local coordinates are sampled from the final skinned pose on the renderer's callback.
 */
export class ProceduralTears {
  private disposed = false;
  private capability: boolean;
  private explanation: string;
  private amount = 0;
  private elapsedMs = 0;
  private readonly originalMaterials: Material | Material[];
  private installedMaterials: Material | Material[];
  private attachments: { index: number; source: ShaderMaterial; clone: ShaderMaterial }[] = [];
  private readonly compiled = new Set<ShaderMaterial>();
  private readonly previousRender: SkinnedMesh['onBeforeRender'];
  private readonly renderHook: SkinnedMesh['onBeforeRender'];
  private readonly uniforms = {
    shTearsMeshToHead: { value: new Matrix4() }, shTearsAmount: { value: 0 }, shTearsTime: { value: 0 },
    shTearsScale: { value: 1 }, shTearsLeft: { value: new Vector3() }, shTearsRight: { value: new Vector3() },
    shTearsAxisX: { value: new Vector3() }, shTearsAxisY: { value: new Vector3() }, shTearsForward: { value: new Vector3() },
  };

  constructor(private readonly head: Bone, anchors: BlushAnchors, private readonly mesh: SkinnedMesh, verifiedGene: boolean, cardAllowed = false) {
    const support = tearsSupport(anchors, verifiedGene, cardAllowed);
    this.capability = support.supported; this.explanation = support.reason;
    this.originalMaterials = this.installedMaterials = mesh.material;
    this.previousRender = mesh.onBeforeRender;
    const owner = this;
    this.renderHook = function (...args) {
      owner.previousRender.apply(this, args);
      if (owner.disposed || !owner.capability || owner.amount === 0) return;
      const determinant = owner.head.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) { owner.uniforms.shTearsAmount.value = 0; return; }
      owner.uniforms.shTearsMeshToHead.value.copy(owner.head.matrixWorld).invert().multiply(owner.mesh.matrixWorld);
      owner.uniforms.shTearsAmount.value = owner.amount;
    };
    if (!this.capability) return;
    const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const indices = [...new Set(anchors.materialIndices)].sort((a, b) => a - b);
    // This branch is behind the existing host content-hash gate, not a name or
    // filename classifier. Stage supplies its separate default Gene anchors.
    // The audited Gene PMX has an opaque cheek cover in front of face material 3;
    // face-only shading is hidden there. Preserve that cover and shade it too.
    if (verifiedGene && indices.length === 1 && indices[0] === 3) {
      if (source[3]?.name !== '顔' || source[8]?.name !== '頬薄赤' || !supportedMaterial(source[8])) {
        this.capability = false; this.explanation = '已核验 Gene 的脸颊覆盖材质不可用，泪水未安装'; return;
      }
      indices.push(8);
    }
    if (!indices.every(index => supportedMaterial(source[index]))) {
      this.capability = false; this.explanation = '脸部着色器缺少泪水接点，当前保留原材质'; return;
    }
    const forward = new Vector3(...anchors.forward);
    this.uniforms.shTearsScale.value = anchors.eyeDistance;
    this.uniforms.shTearsAxisX.value.set(...anchors.right); this.uniforms.shTearsAxisY.value.set(...anchors.up);
    this.uniforms.shTearsForward.value.copy(forward);
    // Eye centers define x/y only; the real cheek surface supplies depth.
    for (const [point, eye, cheek] of [
      [this.uniforms.shTearsLeft.value, anchors.leftEye, anchors.leftCheek],
      [this.uniforms.shTearsRight.value, anchors.rightEye, anchors.rightCheek],
    ] as const) point.set(...eye).addScaledVector(forward, new Vector3(...cheek).sub(new Vector3(...eye)).dot(forward));
    const next = [...source];
    try {
      for (const index of indices) {
        const original = source[index] as ShaderMaterial, clone = original.clone();
        if (clone === original) throw new Error('Tear material clone must have independent ownership.');
        // Track ownership immediately so a later clone/uniform setup failure can
        // release every newly created material without publishing a partial array.
        this.attachments.push({ index, source: original, clone });
        for (const [name, uniform] of Object.entries(original.uniforms)) {
          if (uniform.value?.isTexture) clone.uniforms[name].value = uniform.value;
          else if (Array.isArray(uniform.value) && uniform.value.some(value => value?.isTexture))
            clone.uniforms[name].value = uniform.value.map(value => value?.isTexture ? value : value?.clone ? value.clone() : value);
        }
        const priorCompile = original.onBeforeCompile, priorKey = original.customProgramCacheKey;
        clone.onBeforeCompile = (shader, renderer) => {
          priorCompile.call(clone, shader, renderer);
          if (!shader.vertexShader.includes('#include <common>') || !shader.vertexShader.includes('#include <displacementmap_vertex>') ||
            !shader.vertexShader.includes('#include <skinning_vertex>') || !shader.fragmentShader.includes('#include <common>') ||
            !shader.fragmentShader.includes('#include <normal_fragment_maps>') || !shader.fragmentShader.includes('outgoingLight') ||
            !shader.fragmentShader.includes('vViewPosition') || !shader.fragmentShader.includes('#include <opaque_fragment>') ||
            shader.vertexShader.includes('vShTearsHead')) {
            this.capability = false; this.explanation = '脸部着色扩展冲突，泪水已停用'; this.uniforms.shTearsAmount.value = 0; return;
          }
          Object.assign(shader.uniforms, this.uniforms);
          shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_DECLARATIONS}`)
            .replace('#include <displacementmap_vertex>', '#include <displacementmap_vertex>\nvShTearsHead = (shTearsMeshToHead * vec4(transformed, 1.0)).xyz;');
          // Later than blush/lighting, earlier than alpha output, tone mapping and color-space conversion.
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARATIONS}`)
            .replace('#include <opaque_fragment>', `${FRAGMENT_COLOR}\n#include <opaque_fragment>`);
          this.compiled.add(clone);
        };
        clone.customProgramCacheKey = () => `${priorKey.call(original)}:soft-hearts-surface-tears-v1`;
        next[index] = clone;
      }
      this.installedMaterials = Array.isArray(mesh.material) ? next : next[0];
      mesh.material = this.installedMaterials; mesh.onBeforeRender = this.renderHook;
    } catch {
      this.capability = false; this.explanation = '泪水材质初始化失败，原脸部与脸颊材质已保留';
      this.uniforms.shTearsAmount.value = 0;
      for (const { clone } of this.attachments) { try { clone.dispose(); } catch { /* Continue releasing other owned clones. */ } }
      this.attachments = []; this.compiled.clear();
    }
  }

  update(amount: number, elapsedMs: number): void {
    if (this.disposed) return;
    this.amount = Number.isFinite(amount) ? clamp(amount, 0, 1) : 0;
    this.elapsedMs = Number.isFinite(elapsedMs) ? clamp(elapsedMs, 0, 120_000) : 0;
    this.uniforms.shTearsAmount.value = this.capability ? this.amount : 0;
    this.uniforms.shTearsTime.value = this.elapsedMs / 1000;
  }

  getState(): TearsState {
    const current = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    return { supported: this.capability && !this.disposed, reason: this.explanation, attached: !this.disposed && this.mesh.onBeforeRender === this.renderHook && this.attachments.length > 0 && this.attachments.every(value => current[value.index] === value.clone),
      compiled: this.compiled.size, amount: this.uniforms.shTearsAmount.value, elapsedMs: this.elapsedMs, materialIndices: this.attachments.map(value => value.index) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.amount = this.uniforms.shTearsAmount.value = 0;
    if (this.mesh.material === this.installedMaterials) this.mesh.material = this.originalMaterials;
    else {
      const replacements = new Map<Material, Material>(this.attachments.map(value => [value.clone, value.source]));
      if (Array.isArray(this.mesh.material)) this.mesh.material = this.mesh.material.map(material => replacements.get(material) ?? material);
      else this.mesh.material = replacements.get(this.mesh.material) ?? this.mesh.material;
    }
    if (this.mesh.onBeforeRender === this.renderHook) this.mesh.onBeforeRender = this.previousRender;
    for (const { clone } of this.attachments) clone.dispose();
    this.attachments = []; this.compiled.clear();
  }
}
