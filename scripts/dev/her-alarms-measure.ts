// I-195: how many characters her alarms add to every chat turn's prompt (switch on), for the real-chat acceptance's comparison (first-character median,
// switch off vs on). No model call, no profile. Run: node node_modules/tsx/dist/cli.mjs scripts/dev/her-alarms-measure.ts
// For the acceptance: its throw-away profile turns the switch on with SOFT_HEARTS_HER_ALARMS=1 in the app's environment (or by writing
// `{"version":1,"on":true}` into <profile>/her-alarms.json); the real profile is never touched.
import { alarmListLine, alarmSentence } from '../../shared/behaviors/alarms/prompt';
import { SPEECH_BEAT_WORDS } from '../../shared/behaviors/speech-beats/interface';
import { speechBeatSentence } from '../../shared/behaviors/speech-beats/choose';

const count = (text: string) => Array.from(text).length;
const now = Date.now();
const view = (note: string, at: number | null, on: 'back' | null, talk: string | null) => ({ id: 'x', at, on, talk, note, createdAt: now });
const worst = alarmListLine(Array.from({ length: 5 }, () => view('字'.repeat(60), now + 3_600_000, null, null)), now);
const typical = alarmListLine([view('看看汤', now + 20 * 60_000, null, null)], now);
console.log(JSON.stringify({
  switchOff: 0,
  switchOnNothingWaiting: count(alarmSentence()),
  switchOnOneWaiting: count(alarmSentence()) + count(typical) + 1,
  switchOnFiveWaitingWorst: count(alarmSentence()) + count(worst) + 1,
  forScale: { speechBeatSentence: count(speechBeatSentence()), speechBeatWords: SPEECH_BEAT_WORDS.length },
}, null, 2));
