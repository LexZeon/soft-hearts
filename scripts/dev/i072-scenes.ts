/**
 * I-072: prints the eight synthetic scenes' numbers (tests/helpers/music-fixtures.ts) at 60 and 30 Hz display rates.
 *   node node_modules/tsx/dist/cli.mjs scripts/dev/i072-scenes.ts
 */
import { describe, judge, scenes } from '../../tests/helpers/music-fixtures';

for (const refreshHz of [60, 30]) {
  console.log(`--- ${refreshHz} Hz`);
  for (const scene of scenes()) console.log(describe(judge(scene, { refreshHz })));
}
