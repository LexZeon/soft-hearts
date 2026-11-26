import { quickLineWithClaude, type InnerLoopStream } from '../initiative';
import { SCREEN_LOOK_PROMPT, SCREEN_LOOK_SYSTEM_PROMPT } from '../../shared/behaviors/user-activity/screen-look';

/**
 * I-066 你现在方便吗 · 看一眼, brain interface (docs/claude/brain-interface.md): one tool-less haiku call (quickLineWithClaude) with one
 * downscaled screen picture (the 320×200 thumbnail of 屏幕只读大概, base64 JPEG over stdin, nothing on disk) and a short system prompt;
 * the answer is one word of a closed list (shared/behaviors/user-activity/screen-look.ts parses it, model-independent). Only while the
 * user's screen sharing is on, only when she wants to start talking and the keyboard and mouse alone cannot tell; at most
 * knobs.presence.look.perHour an hour.
 */
export async function screenLookWithClaude(picture: string, signal: AbortSignal, stream?: InnerLoopStream): Promise<string> {
  return (await quickLineWithClaude(SCREEN_LOOK_PROMPT, SCREEN_LOOK_SYSTEM_PROMPT, signal, stream, [picture])).text;
}
