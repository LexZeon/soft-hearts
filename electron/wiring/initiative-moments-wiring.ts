// 主动's wiring, I-188 她认出的时刻 (electron/initiative/moments/): what the moments read from the rest of the app and where they report.
// wireInitiative calls wireInitiativeMoments once, after the inner loop exists (the moments use its sleep reading and rest-reminder
// night). The 1-second clock ticks `innerLoopHost.moments` (electron/wiring/clock-wiring.ts); the cue chain's opening step asks `moments.claims`; the chat
// turn hands the user's message to `momentsChatTurn` (reminders, and with the switch on her own alarms, I-195) and her finished reply's alarm markers to
// `momentsReplyDone`. No module-level side effects: nothing here runs on import.
import path from 'node:path';
import { innerLoopNightKey } from '../../shared/initiative';
import { describeTrigger, parseAlarmCancel } from '../../shared/behaviors/alarms/prompt';
import { ALARM_GREY_LINE, type HerAlarmsRequest, type HerAlarmsView } from '../../shared/behaviors/alarms/interface';
import { isCardMilestoneRequest, isObjectNoteRequest, type CardMilestoneRequest, type ObjectNoteRequest } from '../../shared/cards';
import { cardMilestoneCall } from './card-milestone-call-wiring';
import { cardObjectNoteCall } from './card-objects-call-wiring';
import { AlarmStore, AlarmSwitch, HerAlarms, MomentHost, MomentStateStore } from '../initiative';
import { userActivity, userInputUntil, watchContinuity, watchTogether } from './senses-wiring';
import { closeCutNotice, unbound } from './unbound-wiring';
import { voiceCallOn } from './voice-cleanup-wiring';
import type { InitiativeNeeds } from './initiative-wiring';
import type { PartIpc } from './ipc-wiring';
import { innerLoopHost } from './initiative-inner-loop-wiring';
import { poseUses, poseUsesChatTurn } from './senses-pose-uses-wiring';

/** The moments host (null until wireInitiativeMoments ran). Read by the clock, the cue chain and the chat turn. */
export let moments: MomentHost | null = null;
/** I-195: her own alarms (null until wireInitiativeMoments ran) and the switch on the user profile page (default off). */
export let herAlarms: HerAlarms | null = null;
let alarmSwitch: AlarmSwitch | null = null;

const localMinute = (wallMs: number): number => { const d = new Date(wallMs); return d.getHours() * 60 + d.getMinutes(); };

/** wireInitiative calls this once, after wireInitiativeInnerLoop. */
export function wireInitiativeMoments(needs: InitiativeNeeds): void {
  const dir = () => needs.store ? needs.store.directory : null;
  const reminders = new AlarmStore(() => { const d = dir(); return d ? path.join(d, 'reminders.json') : null; }); // the user's reminders and her own alarms: one file, kept apart inside
  // The test hook (the real-chat acceptance's throw-away profile): SOFT_HEARTS_HER_ALARMS=1 turns the switch on for that run; it never turns it off and writes nothing.
  alarmSwitch = new AlarmSwitch(() => { const d = dir(); return d ? path.join(d, 'her-alarms.json') : null; }, undefined, () => process.env.SOFT_HEARTS_HER_ALARMS === '1');
  herAlarms = new HerAlarms({ store: reminders, characterId: () => needs.companion?.mood.get().characterId ?? null, on: () => alarmSwitch?.on === true,
    journal: row => { needs.appJournal.record({ type: 'moment', ...row }); } });
  moments = new MomentHost({
    characterId: () => needs.companion?.mood.get().characterId ?? null,
    localMinute,
    enabled: () => !!needs.store && needs.store.current.innerLoop !== false && !!needs.companion && needs.companion.mood.get().expressions,
    typing: () => Date.now() < userInputUntil || [...needs.pending.values()].some(task => task.kind === 'chat'),
    call: () => voiceCallOn(),
    asleep: () => innerLoopHost.loop.asleep(),
    visible: () => needs.herOnScreen(),
    presence: () => userActivity?.presence() ?? null,
    idleSeconds: () => userActivity?.idleSeconds() ?? null,
    lastInteractionAt: () => needs.companion?.mood.get().snapshot.lastInteractionAt ?? null,
    nightKey: now => innerLoopNightKey(now, localMinute(now)),
    restUsed: night => innerLoopHost.reminders?.used(night) ?? false,
    state: new MomentStateStore(() => { const d = dir(); return d ? path.join(d, 'moments-state.json') : null; }),
    reminders,
    alarms: herAlarms,
    closeMoments: () => needs.companion?.mood.moments.recent ?? [], // her kisses and hugs (I-195: an alarm may wait for one)
    // A reminder she promised: only the hard state (promiseAttention); every other moment: the welcome rules (interval, hourly cap).
    askSpeech: mode => !!needs.companion && (mode === 'promise' ? needs.companion.mood.promiseAttention() : needs.companion.mood.welcomeAttention()),
    watching: () => watchTogether?.session.watchingNow() === true,
    screen: id => watchTogether?.session.screenEvent(id) ?? null,
    unbound: () => { const view = unbound?.view(); return view ? { unbound: view.state === 'unbound', fullscreen: view.fullscreen === true } : null; },
    drowsy: () => { const phase = needs.companion?.mood.get().fatigue?.phase; return phase === 'drowsy' || phase === 'falling-asleep'; },
    pose: now => poseUses?.moment(now) ?? null, // I-189: slumped / close, staring, sitting long (local pose only), information through the same gate
    closeCut: closeCutNotice(), // I-203: a kiss / hug of her reply was interrupted: one immediate turn with the facts (no cooldown: not autonomous)
    journal: row => { needs.appJournal.record({ type: 'moment', ...row }); },
  });
  innerLoopHost.moments = moments; // the 1-second clock ticks it through the inner loop's host (electron/wiring/clock-wiring.ts reads only what it is handed)
}

/**
 * The chat turn's private lines (electron/wiring/brain-chat-wiring.ts): the reminder line ("提醒我…" noted, "不用提醒了" cancelled), then with the
 * switch on her alarms' lines (the marker sentence, her list, a woken one, a cancel), then the local pose lines (I-189: a nod answer's note,
 * "画面里好像还有一个人", sitting numbers when asked, a reading that ended unheard). '' when there is nothing. A message that takes her alarms away
 * is not also read as taking the user's reminder away.
 */
export function momentsChatTurn(text: unknown): string {
  let reminder = '', alarm = '';
  try { reminder = parseAlarmCancel(text) !== null ? '' : moments?.chatTurn(text) ?? ''; } catch { reminder = ''; }
  try { alarm = herAlarms?.chatTurn(text) ?? ''; } catch { alarm = ''; }
  let watch = ''; try { watch = watchContinuity?.takeNotes() ?? ''; } catch { watch = ''; } // 2026-11-24 (续): 一起看 paused / resumed / a lost share nobody could be told at once: facts, once
  return [reminder, alarm, poseUsesChatTurn(text), watch].filter(Boolean).join('\n\n');
}

/**
 * Her completed reply's alarm markers (the speech-beats filter already took them out of her text): read, kept, and the chat's grey line when she set one
 * (the line only, never what she wrote). Null when nothing was set (including the switch off: the markers are simply dropped).
 */
export function momentsReplyDone(markers: readonly string[] | undefined): string | null {
  try { return herAlarms?.takeMarkers(markers) ? ALARM_GREY_LINE : null; } catch { return null; }
}

/** The user profile page's call (the control window only): the switch and her waiting alarms; the switch is the user's own click. */
export function registerHerAlarms(ipc: PartIpc): void {
  const view = (): HerAlarmsView => {
    const now = Date.now(), list = herAlarms?.list() ?? { on: false, items: [] };
    return { on: list.on, items: list.items.map(item => ({ id: item.id, when: describeTrigger(item, now), note: item.note })) };
  };
  ipc.host('herAlarms', async (request: HerAlarmsRequest | CardMilestoneRequest | ObjectNoteRequest) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid request.');
    if (isObjectNoteRequest(request)) return { ...view(), objectNote: await cardObjectNoteCall(request) }; // I-208: the archive page edits or deletes one of her margin notes (same channel: the preload may not grow)
    if (isCardMilestoneRequest(request)) return { ...view(), milestone: await cardMilestoneCall(request) }; // I-207: the same page, the same channel (the preload may not grow)
    if (request.action === 'switch') { if (typeof request.on !== 'boolean') throw new Error('Invalid request.'); await alarmSwitch?.set(request.on); }
    else if (request.action === 'cancel') { if (typeof request.id !== 'string' || !request.id) throw new Error('Invalid request.'); herAlarms?.cancel(request.id); }
    else if (request.action !== 'view') throw new Error('Invalid request.');
    return view();
  });
}
