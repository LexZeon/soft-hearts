import type { AppSettings } from "./contracts";
/** Claude Code model aliases offered in the model field; an empty field follows Claude Code's default. */
export const CLAUDE_MODEL_ALIASES: readonly string[] = Object.freeze(["haiku", "sonnet", "opus", "fable"]);
export const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  model: null,
  motion: null,
  camera: { yaw: 0, pitch: 0, distance: 30, targetY: 10, targetX: 0, targetZ: 0, fov: 32 },
  // baseUrl is unused by Claude Code but is part of the chat-memory scope hash: never change it.
  provider: { kind: "claude", baseUrl: "http://127.0.0.1:11434/v1", model: "" },
  persona:
    "你是住在用户桌面的 AI 伙伴，温暖、自然、简洁地用中文交谈。尊重用户隐私；只根据用户主动提供的信息回答，不假装看到了屏幕或摄像头。",
  pet: {
    visible: true,
    alwaysOnTop: true,
    // Click-through on by default (穿透模式默认开启): only the transparent space around her lets clicks through;
    // her body and the visible controls stay clickable (src/ui/pointer-passthrough.ts).
    clickThrough: true,
    followMouse: true,
    // R29f (motion like keyframe animation): 60 by default; 24 / 30 stay as power-saving choices.
    fps: 60,
    breath: 0.5,
    scale: 1,
  },
  // Read-aloud with the free system voice is on by default; paid Bailian TTS stays opt-in.
  voice: { enabled: true, voiceURI: "", rate: 1, volume: 0.8, moodInfluence: 50, firstChunk: 'sentence' },
  // 识别方式 'local' by default: the app's own recognizer, downloaded on request. The address
  // is only used by the 'compatible' engine; it also decides the migration of older settings (electron/validation.ts).
  voiceInput: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', language: 'zh', apiKey: '', engine: 'local' },
  agent: { workingDirectory: "", model: "", writable: false },
  // Inner loop on by default.
  innerLoop: true,
  // 她主动找你说话: 适中 = today's rhythm.
  proactiveTalk: 'normal',
  // 体验记录 (E2): off until the user turns it on.
  experienceJournal: false,
};
