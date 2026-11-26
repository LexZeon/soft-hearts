// 保存她念出来的声音（用来比对）'s wiring (dev-only internal test tool; docs/claude/2026-11-24-voice-keep.md). It makes the tool's host the first time
// something needs it (the profile folder is only known then), tells it whether this build may have it at all (development channel or a
// source run: electron/voice/voice-keep/availability.ts), gives the speech runtime its tee and the control window its one handler, and hands
// the internal channel the dev-only tool. On a stable or packaged build every one of those is inert: the tee is null, the handler answers
// "not here", and no tool is registered, whatever a settings file left on disk says.
// No module-level side effects: the only module state is the one host, made on first use.
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { VoiceKeepHost, voiceKeepAvailable, voiceKeepChannelTool, HER_READING, type KeepInfo, type SentenceTee } from '../voice';
import { currentChannel } from './channel-gates-wiring';
import type { PartIpc } from './ipc-wiring';

export interface VoiceKeepNeeds {
  /** The profile folder, or null while the settings store is not made yet. */
  directory(): string | null;
  character(): { id: string; name: string } | null;
  controls(): BrowserWindow | null;
}

let current: VoiceKeepHost | null = null;

export function voiceKeepHere(): boolean { return voiceKeepAvailable(currentChannel(), app.isPackaged); }

export function wireVoiceKeep(needs: VoiceKeepNeeds): {
  /** SpeechRuntime's tee (null where the tool does not exist or is off). */
  tee(info: KeepInfo): SentenceTee | null;
  /** The control window's handler; registered only where the tool exists. */
  register(ipc: PartIpc): void;
} {
  const keeper = (): VoiceKeepHost | null => {
    if (current) return current;
    const directory = needs.directory();
    if (!directory || !voiceKeepHere()) return null;
    current = new VoiceKeepHost({ profileDirectory: directory, available: voiceKeepHere, now: () => Date.now(), character: needs.character,
      confirmClear: async ({ sentences, bytes }) => {
        const parent = needs.controls();
        const options = { type: 'warning' as const, title: 'soft hearts · 开发版', message: '清空保存下来的她的声音？',
          detail: `现在存着 ${sentences} 句，约 ${Math.round(bytes / (1024 * 1024))} MB。清空后收不回来。`, buttons: ['取消', '清空'], defaultId: 0, cancelId: 0, noLink: true };
        const answer = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return answer.response === 1;
      },
      openFolder: folder => shell.openPath(folder) });
    return current;
  };
  return {
    tee: info => (voiceKeepHere() ? keeper()?.recorder.begin(HER_READING, info) ?? null : null),
    register(ipc) {
      if (!voiceKeepHere()) return;
      void keeper()?.start();
      ipc.host('voiceKeep', request => keeper()?.handle(request) ?? null);
    },
  };
}

/** The internal channel's dev-only tool and its descriptor; empty on a stable or packaged build. */
export function voiceKeepChannelTools(): { tools: ReturnType<typeof voiceKeepChannelTool>['tool'][]; descriptors: ReturnType<typeof voiceKeepChannelTool>['descriptor'][] } {
  if (!voiceKeepHere()) return { tools: [], descriptors: [] };
  const made = voiceKeepChannelTool(() => current);
  return { tools: [made.tool], descriptors: [made.descriptor] };
}
