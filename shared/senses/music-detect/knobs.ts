/**
 * 功能：她听歌时不再唱到一半停下，歌越带劲越想动（I-053，docs/claude/2026-11-08-i053-music.md；I-072 大修，docs/claude/2026-11-10-i072-music-overhaul.md）
 *
 * 旋钮文件：能调的值都在这里。每个旋钮上面一行"用户可能怎么说"，下面可选一行"怎么调"；
 * handbook/knobs.md 那张"想改什么 → 改哪里"的表由 `node scripts/list-knobs.mjs` 从这些行生成，别手改那张表。
 *
 * 读法：
 *  - 一首歌被认出是音乐、放了 songMemory.minMusicSeconds 秒之后，她"记得这首歌还在放"：歌里两三秒的人声段、间奏、安静的过渡段
 *    不再让她判成"不是音乐"。要么安静 silenceSeconds 秒，要么连续 speechSeconds 秒都像对白，才算这首歌结束。
 *    兜底：既不安静也不像对白、拍子也没回来（比如一直有底噪），fadeSeconds 秒后也结束，免得一直"在放歌"。
 *  - 拍子除了看最近 8 秒，也看最近 4 秒取高的；刚才那首歌的快慢（周期）记下来，同样快慢的鼓点回来（误差 periodTolerance 以内）
 *    就在 1～2 秒内认回来，记着的时间是 reacquire.rememberSeconds。
 *  - 歌的劲儿（拍子越强、越快）最多给她"想动"的分数加 songEnergyMaxBonus，心情、睡意、你叫她跳的影响照旧。
 *  - I-072"唱歌不算对白"：看中间那段频率（人声所在）的响度，在最近 3 秒里有多少时间是"平稳"的（前后约 0.1 秒内起伏不到
 *    speechVsSinging.steadyDb）。说话一个字一个字地起落（每秒 3～7 个音节），几乎没有平稳的时候；唱歌的长音、颤音起伏浅，
 *    大部分时间平稳。平稳得多的（≥ heldShare），原来"像说话"的分数不算数；平稳得少的（≤ syllabicShare）、而且字不在拍子上
 *    （offBeatLock），才算对白——包括垫着轻鼓点的对白。
 *  - I-072"轻的段落不算安静"：已经记住这首歌时，响度在 quiet.rememberedRms 以上就算有声音（没在放歌时，门槛照旧）。
 *  - I-072 第二轮（Codex 反例）"拍上的起伏是音乐"：中频起伏的节奏（EDM 的抽吸、说唱字字落在拍上）和鼓点的周期重合、拍子又清楚时（onBeatFrom），
 *    不再算"像说话"。字乱着起、对白垫着鼓，起伏不跟拍子走，照旧算对白。
 * 不变的：认定"是音乐 / 不是音乐"的分数线和等待时间（src/stage/music-likeness.ts 里的四个数）是用户定的，不在这里动。
 * 这些都只是试用值，没在用户真机放的歌上验证过。
 */
export interface MusicDetectKnobs {
  readonly songMemory: { readonly minMusicSeconds: number; readonly silenceSeconds: number; readonly speechSeconds: number; readonly fadeSeconds: number };
  readonly reacquire: { readonly periodTolerance: number; readonly rememberSeconds: number; readonly minBeat: number; readonly windowSeconds: number };
  readonly songEnergyMaxBonus: number;
  readonly speechVsSinging: { readonly steadyDb: number; readonly heldShare: number; readonly syllabicShare: number; readonly offBeatLock: number; readonly onBeatFrom: number };
  readonly quiet: { readonly rememberedRms: number };
}

export const MUSIC_DETECT_KNOBS: MusicDetectKnobs = Object.freeze<MusicDetectKnobs>({
  // 用户可能怎么说：歌放到一半她突然不点头了／歌放完接着对白，她过了好久才停
  // 怎么调：minMusicSeconds＝认出是音乐多久之后才算"记得这首歌"；silenceSeconds＝安静多久算歌结束；speechSeconds＝连续像对白多久算歌结束（越大，歌后接对白时她停得越晚；I-072 起唱歌不再算对白，从 7 改成 5）；fadeSeconds＝兜底，什么都不像时多久后结束
  songMemory: { minMusicSeconds: 5, silenceSeconds: 3, speechSeconds: 5, fadeSeconds: 12 },

  // 用户可能怎么说：间奏或人声段过后，鼓点回来了她还是慢半拍才跟上／别的节奏也被当成刚才那首歌
  // 怎么调：periodTolerance＝快慢差多少以内算同一首（0.06＝6%）；rememberSeconds＝歌结束后多久内还认得它的快慢；minBeat＝鼓点要多清楚（0～1）才算回来了；windowSeconds＝只看最近几秒的鼓点（越小认回得越快，也越容易被碰巧的节奏骗到）
  reacquire: { periodTolerance: 0.06, rememberSeconds: 30, minBeat: 0.5, windowSeconds: 2 },

  // 用户可能怎么说：放快歌她只是点头不跳／放慢歌她也跳得太起劲
  // 怎么调：歌最带劲时给"想动"最多加多少（0.10＝加 0.10；0＝歌的快慢不影响她跳不跳）
  songEnergyMaxBonus: 0.1,

  // 用户可能怎么说：歌唱到人声那段她就停了，好像把歌词当成对白／看剧时人说话她也跟着点头／EDM 或说唱放着她不点头
  // 怎么调：steadyDb＝前后约 0.1 秒内起伏小于多少分贝算"平稳"；heldShare＝平稳的时间占到多少就算在唱（调小：更多人声算唱歌）；syllabicShare＝平稳的时间少于多少才算一个字一个字地说话（调大：更多人声算对白）；offBeatLock＝字和拍子对得多齐以下算"不在拍子上"（0～1）；onBeatFrom＝中频的起伏每拍同一个位置重复到多整齐（0～1），从这里开始算"是鼓点结构"（调小：更多拍上的起伏算音乐，说唱、抽吸更容易认，但垫着鼓的对白也更容易被当成歌；调大：反之）
  speechVsSinging: { steadyDb: 5, heldShare: 0.4, syllabicShare: 0.3, offBeatLock: 0.85, onBeatFrom: 0.4 },

  // 用户可能怎么说：歌里轻的那段她就不动了，好像以为歌停了
  // 怎么调：已经记住这首歌时，响度（0～1）在这以上就不算安静；0.001 约是 -60 dBFS（没在放歌时的门槛照旧是 0.004，约 -48 dBFS）
  quiet: { rememberedRms: 0.001 },
});
