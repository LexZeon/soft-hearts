/** I-072 round 2: the music share of the last 8 s for Codex's counter-examples and controls at 60 / 30 Hz.  node node_modules/tsx/dist/cli.mjs scripts/dev/i072-round2.ts */
import { round2Cases, tailShare } from '../../tests/helpers/music-fixtures';

for (const refreshHz of [60, 30]) {
  console.log(`--- ${refreshHz} Hz`);
  for (const c of round2Cases()) { const r = tailShare(c.pcm, { refreshHz }); console.log(`${c.name}: 后 8 秒是音乐 ${(r.share * 100).toFixed(0)}% · beat ${r.beat.toFixed(2)} speech ${r.speech.toFixed(2)} score ${r.score.toFixed(2)}`); }
}
