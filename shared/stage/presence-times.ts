/**
 * How long she takes to fade out and in when the model on stage changes (C2 换成她). One pair of numbers for both engines that draw the
 * companion window (the old stage, src/stage/presence-fade.ts, and the Unbound window, src/unbound/window-mode/window-stage.ts), so
 * they cannot drift apart (I-176 audit row 5: they had, 450/300 against 420/320).
 */
export const PRESENCE_FADE_OUT_MS = 320;
export const PRESENCE_FADE_IN_MS = 420;
