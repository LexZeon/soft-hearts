/**
 * 显卡有没有用上: how the full-screen page
 * asks for its WebGL context, and what it reads back about it for the developer readout.
 *
 * The page used to ask for the low-power chip, which on a laptop with a built-in and a separate chip means the built-in one. A transparent
 * full-screen window drawing a 3D character is exactly what the separate chip is for, so it asks for the high-performance one (together with
 * the host's `force_high_performance_gpu` switch, electron/foundation/gpu-choice/). With one chip the answer is the same either way.
 */
import type { WebGLRendererParameters } from 'three';
import { classifyRenderer, type GpuKind, type GpuVendor } from '../../shared/foundation/gpu-kind';

export const unboundGlOptions = (antialias: boolean): WebGLRendererParameters => ({ alpha: true, antialias, powerPreference: 'high-performance' });

/** What the context says it is drawn by, as closed words (hardware or software, the vendor family). Never throws; unknown when it cannot be read. */
export function gpuOfContext(gl: WebGLRenderingContext | WebGL2RenderingContext | null): { kind: GpuKind; vendor: GpuVendor } {
  try {
    if (!gl) return { kind: 'unknown', vendor: 'other' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return classifyRenderer(String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
  } catch { return { kind: 'unknown', vendor: 'other' }; }
}
