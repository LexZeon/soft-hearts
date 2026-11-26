// A test world for a typed line (2026-11-23, docs/claude/2026-11-23-typed-send-deep-fix.md): her full-screen box, the host, the hidden control
// window and her small window on one fake clock. The real pieces run: UnboundTyping and UnboundSayAcks (host), sayLine, the control-awake owner,
// the handed-line gate and validateChatRequest (host), receiveUnboundSay / sendUnboundLine, the SendGuard and the real sendChat source (the
// windows, in a sandbox). The world gives them what the machine gave them on 2026-11-23 morning:
// - the control window, shown once and then hidden, is throttled: its timers run `timerLateMs` late and messages reach it `deliverLateMs` late
//   (measured with this Electron: a 2 s timer after 4.3–21.7 s, deliveries up to 0.5 s; lifted, at once) — unless the host lifts it;
// - voice input is capturing: a chunk every 85 ms goes to the host (each takes the main process a moment), and the host's settings save waits
//   behind the capture's writes until the capture stops (I-191);
// - the main process is busy: every call waits `mainMs` before its handler runs.
// Nothing here calls a model; her reply is a timer on the host.
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { scanBreathRequest } from '../../shared/actions/breath-request';
import { scanFramingRequest } from '../../shared/stage/framing-request';
import { scanStopReadoutRequest } from '../../shared/voice/stop-readout-request';
import { outgoingChatMessages } from '../../src/brain/reply-history';
import { lookHint, turnAttachments } from '../../src/senses/look-send';
import { pauseCutForSend, receiveUnboundSay, type SendTimer } from '../../src/brain/pause-talk-send';
import { SendGuard } from '../../src/brain/send-guard';
import { validateChatRequest } from '../../electron/settings/validation';
import { admitHandedLine, setHandedLineGate } from '../../electron/brain/handed-line-gate';
import { UnboundSayAcks } from '../../electron/unbound/say-ack';
import { createControlAwake, lineAwake } from '../../electron/unbound/control-awake';
import { sayLine } from '../../electron/unbound/say-line';
import { UnboundTyping, type BoxRefill } from '../../electron/unbound/typing';
import type { SendDropWhy, SendOutcome } from '../../shared/brain';
import { rendererSource } from './renderer-source';

const source = rendererSource();
const ast = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const SEND = (() => { const found = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendChat')!; return transformSync(found.getText(ast), { loader: 'ts', target: 'es2022' }).code; })();

/** One clock for everything; events run in time order, and every promise they start settles before the next event. */
export class WorldClock {
  now = 0;
  private seq = 0;
  private readonly events = new Map<number, { at: number; run: () => void }>();
  at(at: number, run: () => void): number { const id = ++this.seq; this.events.set(id, { at: Math.max(at, this.now), run }); return id; }
  after(ms: number, run: () => void): number { return this.at(this.now + ms, run); }
  cancel(id: unknown): void { this.events.delete(id as number); }
  moveTo(id: number, at: number): void { const e = this.events.get(id); if (e) e.at = Math.max(at, this.now); }
  async runUntil(end: number): Promise<void> {
    await settle();
    for (;;) {
      let first: [number, { at: number; run: () => void }] | null = null;
      for (const entry of this.events) if (!first || entry[1].at < first[1].at || (entry[1].at === first[1].at && entry[0] < first[0])) first = entry;
      if (!first || first[1].at > end) break;
      this.events.delete(first[0]); this.now = first[1].at; first[1].run(); await settle();
    }
    this.now = Math.max(this.now, end);
  }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

export interface WorldOptions {
  /** Today's fixes on (the host lifts the control window's throttling, numbers its lines, skips a save that changes nothing). */
  fixed: boolean;
  /** How late the throttled control window runs its timers (ms). */
  timerLateMs?: number;
  /** How late a message reaches the throttled control window (ms). */
  deliverLateMs?: number;
  /** How long the busy main process takes before it runs a call (ms). */
  mainMs?: number;
  /** Voice input capturing (chunks every 85 ms; the host's save waits behind it). */
  capturing?: boolean;
  /** A control window that cannot be woken until then: no message reaches it before this time, throttled or not (ms on the clock). */
  stallUntil?: number;
  /** Her reply: first character and end, after the turn is accepted (ms). */
  firstCharMs?: number; replyMs?: number;
}

export interface LineRecord { text: string; from: 'unbound' | 'small'; enter: number; accepted: number[]; answers: number; refilled: number; said: number; hints: string[] }

export function typedSendWorld(options: WorldOptions) {
  const clock = new WorldClock();
  const o = { timerLateMs: 20_000, deliverLateMs: 500, mainMs: 300, capturing: true, firstCharMs: 1_500, replyMs: 4_000, ...options };
  const lines: LineRecord[] = [];
  const journal: { why: SendDropWhy; waitMs: number }[] = [];
  let throttled = true; // the control window: shown once, then hidden
  const throttleCalls: boolean[] = [];

  // ---- the control window's timers: late while throttled; lifting brings a waiting one back to its time at once (as measured)
  const pending = new Map<number, number>();
  const controlsTimer: SendTimer = {
    set: (run, ms) => { const due = clock.now + ms; const id = clock.at(throttled ? due + o.timerLateMs : due, () => { pending.delete(id); run(); }); pending.set(id, due); return id; },
    clear: handle => { clock.cancel(handle); pending.delete(handle as number); },
  };
  const smallTimer: SendTimer = { set: (run, ms) => clock.after(ms, run), clear: handle => clock.cancel(handle) };
  const controlsWindow = { isDestroyed: () => false, webContents: { setBackgroundThrottling(allowed: boolean) {
    throttleCalls.push(allowed); throttled = allowed;
    if (!allowed) for (const [id, due] of pending) clock.moveTo(id, due);
  } } };
  const toControls = (run: () => void) => clock.at(Math.max(o.stallUntil ?? 0, clock.now + (throttled ? o.deliverLateMs : 1)), run);

  // ---- the host: a busy main process, the capture's writes, the chat handler, her reply
  const toMain = (run: () => void) => clock.after(o.mainMs, run);
  let captureOn = o.capturing, chunks = 0;
  const chunk = () => { if (!captureOn) return; chunks++; toMain(() => {}); clock.after(85, chunk); };
  if (captureOn) clock.after(85, chunk);
  const saveWaiters: (() => void)[] = [];
  const hostSave = (): Promise<boolean> => new Promise(resolve => toMain(() => { if (captureOn) saveWaiters.push(() => resolve(true)); else resolve(true); }));
  const acks = new UnboundSayAcks({ now: () => clock.now, setTimer: (run, ms) => clock.after(ms, run), clearTimer: handle => clock.cancel(handle),
    journal: fact => { journal.push(fact); }, ...(o.fixed ? { awake: lineAwake(createControlAwake(() => controlsWindow)) } : {}) });
  setHandedLineGate(o.fixed ? acks : null);
  let running: string | null = null;
  /** Which typed line a request carries: a full-screen line by its Enter time (the request's sentAt), a small-window line by its text. */
  const recordFor = (from: LineRecord['from'], text: string, sentAt?: number) => { const same = lines.filter(l => l.from === from && l.text === text); return (from === 'unbound' ? same.find(l => l.enter === sentAt) : undefined) ?? same.find(l => !l.accepted.length) ?? same.at(-1); };
  const hostChat = (value: unknown, from: LineRecord['from']): void => {
    const request = validateChatRequest(o.fixed ? value : { ...(value as object), line: undefined });
    const handed = admitHandedLine(request.line);
    if (running) throw new Error('上一项任务仍在进行，请等待或停止。');
    running = request.id; handed?.();
    const line = recordFor(from, request.messages.at(-1)!.content, request.sentAt);
    if (line) line.accepted.push(clock.now);
    clock.after(o.firstCharMs, () => { if (running === request.id && line) line.answers++; });
    clock.after(o.replyMs, () => { if (running !== request.id) return; running = null; for (const w of windows) if (w.active() === request.id) w.setActive(null); });
  };
  /** A call from a window: to the busy main, its handler, the answer back (late into the throttled control window). */
  const invoke = <T>(from: 'controls' | 'small', handler: () => T): Promise<T> => new Promise((resolve, reject) => toMain(() => {
    let result: T, failed = false, error: unknown;
    try { result = handler(); } catch (e) { failed = true; error = e; }
    const back = () => { if (failed) reject(error); else resolve(result!); };
    if (from === 'controls') toControls(back); else clock.after(1, back);
  }));

  // ---- a window: the real sendChat with its guard, on this world's ports
  const windows: { active(): string | null; setActive(v: string | null): void }[] = [];
  function chatWindow(kind: 'controls' | 'small') {
    const input = { value: '' }, state = { ids: 0 };
    const timer = kind === 'controls' ? controlsTimer : smallTimer;
    const guard = new SendGuard({ now: () => clock.now, wall: () => clock.now, timer, from: () => kind === 'controls' ? 'controls' : 'companion', notify: () => {}, journal: () => {} });
    const unchanged = true; // nobody edits settings in these scenes
    const ports = {
      note: () => invoke(kind, () => undefined),
      shared: () => invoke(kind, () => [] as unknown[]),
      chat: (value: unknown) => invoke(kind, () => hostChat(value, kind === 'controls' ? 'unbound' : 'small')),
      save: () => (o.fixed && unchanged ? Promise.resolve(true) : invoke(kind, () => null).then(() => hostSave())),
    };
    const wrapper = `let activeChat=null,attachments=[],history=[],reply='',activeUser=null,assistantNode=null;`
      + `const claudeTasksOffered=()=>false,asksTestCommand=()=>false,immersiveDeveloperMode=false,testNotes=null;`
      // no-pet-ok: the next line defines the existing flag name the wiring source reads
      + `const isPet=false,settings={provider:{kind:'claude'},voice:{}},characterState=null,userProfilePanel=null;const replyPresentation={interrupt(){return null}};`
      + `const crypto={randomUUID:()=>kind+'-'+(++state.ids)};const $=()=>input;const speech={stop(){},prewarm(){}};const syncBodyInputGate=()=>{},setChatBusy=()=>{},renderAttachments=()=>{};`
      + `const window={desktop:{noteUserInput:()=>ports.note(),sharedAttachments:()=>ports.shared(),chat:v=>ports.chat(v)}};`
      + `const saveBeforeSend=()=>ports.save();const onStream=e=>{if(e.type==='error'&&activeChat===e.id)activeChat=null;};const uiText=t=>t;const sendGuard=guard;`
      + `${SEND};return {send:(...a)=>sendChat(...a),setActive:v=>{activeChat=v},active:()=>activeChat};`;
    const api = new Function('input', 'ports', 'state', 'guard', 'kind', 'outgoingChatMessages', 'scanStopReadoutRequest', 'scanFramingRequest', 'scanBreathRequest', 'lookHint',
      'turnAttachments', 'pauseCutForSend', wrapper)(input, ports, state, guard, kind, outgoingChatMessages, scanStopReadoutRequest, scanFramingRequest, scanBreathRequest, lookHint,
      turnAttachments, pauseCutForSend) as { send(bypass?: boolean, look?: boolean, unboundAt?: number): Promise<SendOutcome>; setActive(v: string | null): void; active(): string | null };
    windows.push(api);
    return { ...api, input, timer };
  }
  const controls = chatWindow('controls'), small = chatWindow('small');

  // ---- her full-screen box (host) and the control window's side of it
  let boxOpen = false;
  const opened: (BoxRefill | undefined)[] = [];
  const byText = (text: string) => [...lines].reverse().find(l => l.text === text && l.from === 'unbound');
  const typing = new UnboundTyping({
    touch: () => true, shortcut: { register: () => true, unregister: () => {} }, acks, ackWaitMs: 3_000,
    say: (text, tag) => sayLine({ chatAvailable: () => true, controlsAlive: () => true, interruptReply: () => null,
      send: said => { toControls(() => {
        void receiveUnboundSay(said, { box: () => controls.input, answering: () => controls.active() !== null, timer: controlsTimer,
          stop: async () => { const id = controls.active(); controls.setActive(null); if (id) await invoke('controls', () => { if (running === id) running = null; }); },
          send: at => controls.send(true, false, at), ack: a => { void invoke('controls', () => acks.ack(JSON.parse(JSON.stringify(a)))).catch(() => {}); } });
      }); } }, text, tag),
    input: { open: (_rect, _panel, refill) => { boxOpen = true; opened.push(refill); if (refill) { const l = byText(refill.text); if (l) l.refilled++; } }, close: () => { boxOpen = false; }, destroy: () => {}, isOpen: () => boxOpen },
    state: () => 'unbound', window: () => ({ x: 0, y: 0, width: 1000, height: 600 }), askHead: async () => null,
    said: text => { const l = byText(text); if (l) l.said++; }, clock: () => clock.now,
  });

  return {
    clock, lines, journal, throttleCalls, acks, opened, chunks: () => chunks,
    /** The user types a line in her full-screen box and presses Enter (now). */
    typeInBox(text: string): LineRecord {
      const line: LineRecord = { text, from: 'unbound', enter: clock.now, accepted: [], answers: 0, refilled: 0, said: 0, hints: [] };
      lines.push(line); boxOpen = true;
      void typing.submit(text).then(result => { if (result.hint) line.hints.push(result.hint); });
      return line;
    },
    /** The user types a line in her small window's box and presses Enter (now). */
    typeInSmall(text: string): LineRecord {
      const line: LineRecord = { text, from: 'small', enter: clock.now, accepted: [], answers: 0, refilled: 0, said: 0, hints: [] };
      lines.push(line); small.input.value = text;
      void small.send();
      return line;
    },
    stopCapture(): void { captureOn = false; for (const run of saveWaiters.splice(0)) run(); },
    done(): void { setHandedLineGate(null); },
  };
}
