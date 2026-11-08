import type { SystemAudioState } from "../shared/contracts";

/** Runtime-only consent for one trusted pet window; never a microphone grant. */
export class SystemAudioRuntime {
  private owner: number | null = null;
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  get state(): SystemAudioState { return { active: this.owner !== null }; }

  setSharing(value: unknown, owner: number): SystemAudioState {
    if (typeof value !== "boolean") throw new Error("系统音频共享开关不正确。");
    if (value && this.platform !== "win32") throw new Error("系统音频共享目前仅支持 Windows。");
    if (value && this.owner !== null && this.owner !== owner) throw new Error("系统音频已由另一个窗口使用。");
    if (!value && this.owner !== null && this.owner !== owner) throw new Error("此窗口未开启系统音频共享。");
    this.owner = value ? owner : null;
    return this.state;
  }

  displayStreams(owner: number, mainFrame: boolean, audioRequested: boolean): { audio: "loopback" } | null {
    return this.platform === "win32" && this.owner === owner && mainFrame && audioRequested
      ? { audio: "loopback" } : null;
  }

  reset(): SystemAudioState { this.owner = null; return this.state; }

  dropOwner(owner: number): SystemAudioState {
    if (this.owner === owner) this.owner = null;
    return this.state;
  }
}
