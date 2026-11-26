/**
 * I-159 B: what her per-turn context says about the senses while she
 * is out in Unbound. Her fixed prompt (electron/brain/chat-settings.ts) still says the senses are switches on the companion; out here the
 * companion window is not in sight, so this line is what she goes by: they are all on, and the user needs to do nothing to turn them on.
 * One sentence of fact; nothing here opens or closes anything. Not out: an empty string, and her prompt is as before.
 */
export const UNBOUND_OUTSIDE_LINE = '【你现在在外面（Unbound）】你在外面时，摄像头、麦克风、屏幕、电脑的声音都是开着的（认脸要本机组件，没装的就没开）。'
  + '用户不需要、也不用去开这些开关，别教用户去点桌宠上的开关或进设置里开；这几样在外面时暂时不能单独关，用户想关就请他先回小窗。';

/** Only while she is really out ('unbound'; on her way out the bundle is not on yet). */
export function unboundOutsideLine(state: string | null | undefined): string {
  return state === 'unbound' ? UNBOUND_OUTSIDE_LINE : '';
}
