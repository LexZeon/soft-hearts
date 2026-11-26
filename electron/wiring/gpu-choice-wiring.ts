// 显卡有没有用上 (docs/claude/2026-11-24-stage-smooth.md): the graphics chip request and the one start row, wired from electron/wiring/health-wiring.ts
// wireHealth (module top level of electron/main.ts, before the app is ready, which the Chromium switch needs). No module-level side effects:
// nothing here runs until wireGpuChoice is called.
import { BrowserWindow, app } from 'electron';
import type { JournalInput } from '../../shared/memory';
import { installGpuChoice } from '../foundation/gpu-choice/host';

export interface GpuChoiceNeeds {
  readonly appJournal: { record(input: JournalInput): unknown };
  journalCharacterId(): string | null;
}

/**
 * One small read-only script run once in a page the app already has: a throw-away WebGL context asked for the high-performance chip, as the
 * full-screen page asks, and the renderer string it got. It draws nothing and sends nothing anywhere; the string only becomes a closed word.
 */
const PROBE_SCRIPT = `(() => { try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2', { powerPreference: 'high-performance' }) || c.getContext('webgl', { powerPreference: 'high-performance' });
  if (!gl) return null; const ext = gl.getExtension('WEBGL_debug_renderer_info'); const out = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 200);
  const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); return out; } catch { return null; } })()`;

async function probeRenderer(): Promise<{ renderer: string | null } | null> {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !w.webContents.isDestroyed() && !w.webContents.isLoading());
  if (!win) return null;
  const value: unknown = await win.webContents.executeJavaScript(PROBE_SCRIPT, false);
  return { renderer: typeof value === 'string' ? value : null };
}

/** Once, before ready: asks for the high-performance chip, and writes the start row a few seconds after the app is up. */
export function wireGpuChoice(needs: GpuChoiceNeeds): void {
  installGpuChoice(app, {
    probe: probeRenderer,
    record: row => { needs.appJournal.record({ type: 'gpu-start', characterId: needs.journalCharacterId(), ...row }); },
    log: line => console.warn(line),
  });
}
