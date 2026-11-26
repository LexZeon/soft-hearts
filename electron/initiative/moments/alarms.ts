// I-195 her own alarms ("留心"): the host side.
//  - The switch (the user profile page, off by default): off = no marker sentence in her prompt, no marker read into the store, nothing fires (what is
//    stored stays, dormant). The marker is stripped from her text either way (speech-beats filter), so it never leaks with the switch off.
//  - Her marker (set / done) is read once her reply completed: shared/behaviors/alarms/parse.ts; malformed ones are dropped silently.
//  - Each chat turn (switch on): the marker sentence, her waiting alarms as one short list (only when she has any), a woken "he talks about X" / "he
//    says he is going to sleep" (handed to her inside this very turn, fired once), and the user's own words taking hers away ("取消她的闹钟").
//  - Events: the moments host tells `event(word)` what it recognised; the alarms waiting for it are armed and then wake through the moments path
//    (MomentHost.recognise → kind 'her-alarm': the same gates, the same one proactive-speech door; she decides what to say, I-188's rule).
//  - Her note is her own words: only into her own prompt and the user's profile page; the journal keeps closed words only.
import { ALARM_GREY_LINE, type AlarmEvent, type AlarmView, type AlarmWhy } from '../../../shared/behaviors/alarms/interface';
import { ALARM_KNOBS, type AlarmKnobs } from '../../../shared/behaviors/alarms/knobs';
import { parseAlarmMarker } from '../../../shared/behaviors/alarms/parse';
import { alarmListLine, alarmSentence, alarmWokeLine, parseAlarmCancel } from '../../../shared/behaviors/alarms/prompt';
import type { MomentJournalRow } from './host';
import type { AlarmStore } from './alarm-store';

export interface HerAlarmsPorts {
  store: AlarmStore;
  characterId(): string | null;
  /** The switch on the user profile page (default off). */
  on(): boolean;
  clock?(): number;
  journal?(row: MomentJournalRow): void;
  knobs?: AlarmKnobs;
}

/** What wakes through the moments path. */
export interface WokenAlarm { readonly id: string; readonly note: string; readonly why: AlarmWhy; readonly dueAt: number; readonly time: boolean }

export class HerAlarms {
  private readonly knobs: AlarmKnobs;
  private streakFrom: number | null = null;
  private lastActive = -Infinity;
  private sittingSent = false;

  constructor(private readonly ports: HerAlarmsPorts) { this.knobs = ports.knobs ?? ALARM_KNOBS; }

  get on(): boolean { try { return this.ports.on() === true; } catch { return false; } }
  get store(): AlarmStore { return this.ports.store; }

  /** The text of the chat turn's private lines (the marker sentence, her list, a woken one, a cancel); '' with the switch off. */
  chatTurn(userText: unknown): string {
    if (!this.on) return '';
    const characterId = this.character(), now = this.now();
    if (!characterId) return '';
    const lines: string[] = [];
    try {
      const cancel = parseAlarmCancel(userText);
      if (cancel) {
        const result = this.ports.store.dropHer(characterId, cancel.which, now);
        if (result.dropped.length) { for (const _ of result.dropped) this.journal({ characterId, kind: 'her-alarm', outcome: 'cancelled', why: 'user' }); lines.push(`（应用提示：用户说想取消你给自己留的心，应用已经取消了 ${result.dropped.length} 个。）`); }
        else if (result.ambiguous) lines.push(`（应用提示：用户说想取消你给自己留的心，可是你留着 ${result.count} 个，没说是哪一个；应用没有取消，你可以问问用户，或等 TA 说第几个、全部。）`);
        else lines.push('（应用提示：用户说想取消你给自己留的心，不过现在没有留着的。）');
      }
      for (const hit of this.ports.store.textHits(characterId, userText, now)) {
        this.journal({ characterId, kind: 'her-alarm', outcome: 'spoke' });
        lines.push(alarmWokeLine(hit.item.what, hit.why));
      }
      const list = alarmListLine(this.ports.store.views(characterId, now), now);
      lines.push(...(list ? [list] : []), alarmSentence());
    } catch { /* her chat never waits on this */ }
    return lines.join('\n');
  }

  /** Her completed reply's marker bodies: new alarms are kept, `done` markers take listed ones away. Returns whether any alarm was set (the grey line). */
  takeMarkers(bodies: readonly string[] | undefined): boolean {
    if (!this.on || !bodies?.length) return false;
    const characterId = this.character(), now = this.now();
    if (!characterId) return false;
    let sets = 0;
    try {
      for (const body of bodies.slice(0, this.knobs.markersPerReply + 2)) {
        const marker = parseAlarmMarker(body, now, this.knobs);
        if (!marker) continue; // malformed: dropped silently
        if (marker.kind === 'drop') {
          const result = this.ports.store.dropHer(characterId, marker.which, now);
          for (const _ of result.dropped) this.journal({ characterId, kind: 'her-alarm', outcome: 'cancelled' });
        } else if (sets < this.knobs.markersPerReply && this.ports.store.addHer(characterId, marker.spec, now)) { sets++; this.journal({ characterId, kind: 'her-alarm', outcome: 'set' }); }
      }
    } catch { /* nothing stored */ }
    return sets > 0;
  }

  /** The moments host saw an event: the alarms waiting for it are armed. */
  event(word: AlarmEvent): void {
    if (!this.on) return;
    const characterId = this.character();
    try { if (characterId) this.ports.store.event(characterId, word, this.now()); } catch { /* nothing armed */ }
  }

  /** Once a second with whether the user is at the computer: a long stretch is the event 'sitting' (once per stretch). */
  tick(active: boolean, now: number): void {
    if (!this.on) { this.streakFrom = null; return; }
    if (active) {
      if (this.streakFrom === null || now - this.lastActive > 5 * 60_000) { this.streakFrom = now; this.sittingSent = false; }
      this.lastActive = now;
      if (!this.sittingSent && now - this.streakFrom >= this.knobs.sittingMinutes * 60_000) { this.sittingSent = true; this.event('sitting'); }
    } else if (this.streakFrom !== null && now - this.lastActive > 5 * 60_000) this.streakFrom = null;
  }

  /** The alarm that should speak now through the moments path, or null (switch off: never). */
  due(characterId: string, now: number): WokenAlarm | null {
    if (!this.on) return null;
    try {
      const { item, gaveUp } = this.ports.store.dueHer(characterId, now);
      for (let i = 0; i < gaveUp; i++) this.journal({ characterId, kind: 'her-alarm', outcome: 'expired', why: 'late' });
      if (!item) return null;
      return { id: item.id, note: item.what, why: this.ports.store.whyOf(item), dueAt: item.dueAt, time: !item.on && !item.talk };
    } catch { return null; }
  }

  /** The state of the alarm a pending moment carries, after sweeping the given-up ones ('due' = still waiting); null: gone or the switch is off. */
  keep(characterId: string, id: string, now: number): string | null {
    if (!this.on) return null;
    try { this.ports.store.dueHer(characterId, now); return this.ports.store.stateOf(id); } catch { return null; }
  }

  /** The user profile page: her waiting alarms of the current character (the user's own page; notes are her words), and taking them away. */
  list(): { on: boolean; items: AlarmView[] } {
    const characterId = this.character();
    let items: AlarmView[] = [];
    try { if (characterId) items = this.ports.store.views(characterId, this.now()); } catch { items = []; }
    return { on: this.on, items };
  }
  cancel(id: string | 'all'): { on: boolean; items: AlarmView[] } {
    const characterId = this.character(), now = this.now();
    try {
      if (characterId) {
        const views = this.ports.store.views(characterId, now);
        const which = id === 'all' ? 'all' : views.findIndex(item => item.id === id) + 1;
        if (which === 'all' || which >= 1) {
          const result = this.ports.store.dropHer(characterId, which, now);
          for (const _ of result.dropped) this.journal({ characterId, kind: 'her-alarm', outcome: 'cancelled', why: 'user' });
        }
      }
    } catch { /* the list is shown again as it is */ }
    return this.list();
  }

  /** The grey line when she set one. */
  get greyLine(): string { return ALARM_GREY_LINE; }

  private character(): string | null { try { return this.ports.characterId() || null; } catch { return null; } }
  private now(): number { try { const value = (this.ports.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } }
  private journal(row: MomentJournalRow): void { try { this.ports.journal?.(row); } catch { /* the journal never changes what she does */ } }
}
