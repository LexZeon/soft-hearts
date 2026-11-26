/**
 * 功能：她跟着音乐跳舞、点头时，别的事占着她（她在说话、你碰她、挪窗口……）她留下多少（window-music.ts；小窗和全屏都走这里）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：每一项是一个让开的原因，dance＝舞留下多少，nod＝点头留下多少。
 *  - 现在全是 0：有这件事时舞和点头按 R29b 慢慢收住，事情过去再慢慢回来（就是 2026-11-26 之前的行为，一点没改）。
 *  - 现在只认 0（让开）和 1（这件事不让她停）；0 和 1 之间的数先按 0 算：要留一部分，得让 music-dance.ts / music-nod.ts 的
 *    presence 能停在一个份额上，而不是只有"收住 / 回来"两头（I-227）。
 *  - 几件事同时有：取最小的那个（最让的那个说了算）。
 *  - 窗口没画出来（hidden）不在这里：那时什么都不在屏幕上，舞和点头直接清零。
 * 0.2.1（I-227，跟着音乐的自然摇摆，说话时和别的一些时候理论上不该被打断）要改这些数，比如说话时留住身体的晃、头和嘴给说话；
 * 鼠标停在她身上时全留着。
 */

export interface MusicKeep { readonly dance: number; readonly nod: number }

export const MUSIC_YIELD_KNOBS = Object.freeze({
  // 用户可能怎么说：她一说话就不跟着音乐晃了
  // 怎么调：dance、nod 改成 1＝说话时照样跳 / 点头（现在只认 0 和 1）
  speech: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：我调镜头时她就停了
  camera: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：我挪窗口、改大小、打开回复阅读时她就停了
  windowOrInput: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：鼠标停在她身上 / 摸她、喂她、捏脸、拉她时她就不跳了
  directInteraction: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：她走路的时候不跟着音乐晃（全屏）
  walking: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：我选了一个动头的姿势或动作，她就不跟着音乐动了
  manualHead: Object.freeze({ dance: 0, nod: 0 }),
  // 用户可能怎么说：她睡着了还在跟着音乐晃／睡着了就不晃了
  asleep: Object.freeze({ dance: 0, nod: 0 }),
} satisfies Record<string, MusicKeep>);

/** The yield reasons (window-music.ts musicYieldReason's words, as the canvas readout shows them) and the knob each reads. */
export const MUSIC_YIELD_KNOB_OF = Object.freeze({ speech: 'speech', camera: 'camera', 'window-or-input': 'windowOrInput', 'direct-interaction': 'directInteraction',
  walking: 'walking', 'manual-head': 'manualHead', asleep: 'asleep' } as const satisfies Record<string, keyof typeof MUSIC_YIELD_KNOBS>);
export type MusicYieldReason = keyof typeof MUSIC_YIELD_KNOB_OF;
