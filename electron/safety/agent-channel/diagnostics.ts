// I-061 「复制诊断信息」: puts together the inputs of shared/safety/diagnostics.ts from what the host knows. No Electron import, so it is
// tested directly; electron-wiring.ts passes the app version, the OS facts and the closures main.ts gave it.
import { formatDiagnostics, type DiagnosticsInput } from '../../../shared/safety/diagnostics';
import type { AgentChannelHost } from './host';

/** What main.ts knows and the channel host does not. */
export interface DiagnosticFacts {
  /** The commit this build was made from, or null. */
  commit: string | null;
  /** installedDesktopChannel?.channel: 'stable' | 'development' | undefined for a source run. */
  channel: string | null | undefined;
  journalEnabled: boolean;
  /** The experience journal's recent lines (only closed fields are ever read from them). */
  entries(): readonly unknown[];
  /** Overhaul step 7: the units switched off alone (`<part>/<unit>`). */
  partsOff?(): readonly string[];
}

export interface DiagnosticsEnvironment { version: string; platform: string; release: string; arch: string }

/** Installed channel names to the ones the block prints ('development' is `dev`; no installed channel is a source run). */
export function diagnosticChannel(channel: string | null | undefined): 'stable' | 'dev' | 'source' {
  return channel === 'stable' ? 'stable' : channel === 'development' ? 'dev' : 'source';
}

export function buildDiagnostics(host: Pick<AgentChannelHost, 'diagnosticFacts'>, facts: DiagnosticFacts, env: DiagnosticsEnvironment): string {
  const channel = host.diagnosticFacts();
  let entries: readonly unknown[] = [];
  try { entries = facts.journalEnabled ? facts.entries() : []; } catch { entries = []; }
  const input: DiagnosticsInput = {
    app: { version: env.version, commit: facts.commit, channel: diagnosticChannel(facts.channel) },
    os: { platform: env.platform, release: env.release, arch: env.arch },
    claudeCodeVersion: channel.claudeVersion,
    interconnect: channel.interconnect, channelOpen: channel.channelOpen,
    link: channel.link ? { state: channel.link.state, failure: channel.link.failure, checkedAt: channel.link.at } : null,
    journalEnabled: facts.journalEnabled, entries,
    ...(facts.partsOff ? { partsOff: (() => { try { return facts.partsOff!(); } catch { return []; } })() } : {}),
  };
  return formatDiagnostics(input);
}
