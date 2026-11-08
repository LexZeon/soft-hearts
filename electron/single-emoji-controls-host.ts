import { randomUUID } from 'node:crypto';
import { getEmoji } from '../shared/single-emoji';
import type { EmojiSettingsStore } from './single-emoji-settings';
import type { SingleEmojiCues } from './single-emoji-cues';

/** register is the existing controls-main-frame-only host registrar, not a new
 * renderer dispatcher. There is no caller-selected context/event/window/path. */
export function registerSingleEmojiControls(
  register: (method: string, operation: (...args: unknown[]) => unknown) => void,
  ports: { store: EmojiSettingsStore; cues(): SingleEmojiCues | null; context(): string;
    publish(value: import('../shared/single-emoji').EmojiSettings): void },
): void {
  register('getSingleEmojiSettings', (...args) => {
    if (args.length) throw Error('表情设置读取参数不正确。');
    return ports.store.current;
  });
  register('setSingleEmojiSettings', async (...args) => {
    if (args.length !== 1) throw Error('表情设置保存参数不正确。');
    const saved = await ports.store.save(args[0]);
    ports.cues()?.invalidate();
    ports.publish(saved);
    return saved;
  });
  register('previewSingleEmoji', (...args) => {
    if (args.length !== 1 || !getEmoji(args[0])) throw Error('只能预览当前系统表情目录中的一个表情。');
    return ports.cues()?.offer('preview-' + randomUUID(), getEmoji(args[0])!.id, ports.context()) ?? false;
  });
}
