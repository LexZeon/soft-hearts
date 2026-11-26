// I-177 batch 1: 「通话用的声音设备」 in the control window's voice section. The user's two priority lists (which microphone a call uses, where her
// voice plays), the 「戴耳机」 reminder switch, and 「重新看看建议」 (the same card the call bar shows). Names are the user's own devices on their own
// screen; the lists live in this profile's local storage (src/voice/voice-call/call-mic.ts), which both windows share and read fresh (batch 2).
// An empty list = the system default, as always. Batch 2: the output list takes effect where the window can route its audio (`routed`).
import { registerUiMessages } from '../../shared/foundation/ui-language';
import { uiText } from '../foundation/ui-language';

/** What the panel needs of the call's device advisor (src/voice/voice-call/call-mic.ts CallMicAdvisor fits); the settings part does not import the voice part. */
export interface CallDevicesAdvisor {
  readonly prefs: { inputOrder: string[]; outputOrder: string[]; hintOff: boolean };
  setHintOff(off: boolean): void;
  setOrders(inputOrder: string[], outputOrder: string[]): void;
  deviceNames(): Promise<{ inputs: string[]; outputs: string[] }>;
  suggestionNow(): Promise<{ text: string } | null>;
  answer(suggestion: any, value: 'yes' | 'no' | 'later'): void;
}

registerUiMessages({
  en: {
    '通话用的声音设备': 'Call audio devices',
    '用到麦克风时（打电话、按 T 说话、一起听）用排在最前、并且插着的那个；列表空着，就用系统默认的。她的声音从哪里出来：目前只记下顺序，还没有生效（系统声音也不能指定设备）。': 'Whenever the microphone is used (calls, push-to-talk, listening together) the first plugged-in entry of the list is used; an empty list uses the system default. Where her voice plays: only the order is kept for now, it does not take effect yet (the system voice cannot be routed).',
    '用到麦克风时（打电话、按 T 说话、一起听）用排在最前、并且插着的那个；列表空着，就用系统默认的。她的声音（Drama 3、百炼）也从排在最前、插着的那个出来；系统声音跟着系统，不能指定。': 'Whenever the microphone is used (calls, push-to-talk, listening together) the first plugged-in entry of the list is used; an empty list uses the system default. Her voice (Drama 3, Bailian) also plays on the first plugged-in entry of its list; the system voice follows the system and cannot be routed.',
    '她的声音从哪里出来': 'Where her voice plays',
    '麦克风用哪个': 'Which microphone', '她的声音从哪里出来（暂未生效）': 'Where her voice plays (not in effect yet)', '按系统默认': 'System default',
    '一天最多提醒一次戴耳机': 'Remind me about headphones at most once a day', '重新看看建议': 'Look for a suggestion again', '加入': 'Add', '上移': 'Up', '删除': 'Remove',
    '现在没有可以换的建议。': 'No suggestion right now.', '（未接入）': ' (not plugged in)', '换': 'Switch', '不换': 'Keep', '以后再说': 'Later', '已换。': 'Switched.',
  },
  'zh-CN': {},
});

/** `routed` (I-177 batch 2): this window can play her voice on a chosen output (AudioContext.setSinkId); false keeps the list labelled 暂未生效. */
export function mountCallDevicesPanel(host: HTMLElement | null, advisor: CallDevicesAdvisor | null, say: (text: string) => void, routed = false): void {
  if (!host || !advisor) return;
  const doc = host.ownerDocument;
  const root = doc.createElement('div'); root.className = 'call-devices-panel';
  const h = doc.createElement('h4'); h.textContent = uiText('通话用的声音设备');
  const note = doc.createElement('p'); note.className = 'hint';
  note.textContent = uiText(routed ? '用到麦克风时（打电话、按 T 说话、一起听）用排在最前、并且插着的那个；列表空着，就用系统默认的。她的声音（Drama 3、百炼）也从排在最前、插着的那个出来；系统声音跟着系统，不能指定。'
    : '用到麦克风时（打电话、按 T 说话、一起听）用排在最前、并且插着的那个；列表空着，就用系统默认的。她的声音从哪里出来：目前只记下顺序，还没有生效（系统声音也不能指定设备）。');
  const label = doc.createElement('label'); label.className = 'toggle-row';
  const box = doc.createElement('input'); box.type = 'checkbox'; box.checked = !advisor.prefs.hintOff;
  box.onchange = () => advisor.setHintOff(!box.checked);
  const boxText = doc.createElement('span'); boxText.textContent = uiText('一天最多提醒一次戴耳机');
  label.append(boxText, box);
  const inputs = doc.createElement('div'), outputs = doc.createElement('div'), card = doc.createElement('p');
  const again = doc.createElement('button'); again.type = 'button'; again.textContent = uiText('重新看看建议');

  const draw = async (): Promise<void> => {
    const present = await advisor.deviceNames();
    const names = (kind: 'audioinput' | 'audiooutput') => kind === 'audioinput' ? present.inputs : present.outputs;
    const list = (box: HTMLElement, title: string, order: string[], available: string[], save: (next: string[]) => void) => {
      const heading = doc.createElement('strong'); heading.textContent = uiText(title);
      const rows = doc.createElement('ol');
      if (!order.length) { const li = doc.createElement('li'); li.textContent = uiText('按系统默认'); rows.append(li); }
      order.forEach((name, i) => {
        const li = doc.createElement('li'); li.textContent = name + (available.includes(name) ? '' : '（未接入）') + ' ';
        const up = doc.createElement('button'); up.type = 'button'; up.textContent = uiText('上移'); up.disabled = i === 0;
        up.onclick = () => { const next = order.slice(); [next[i - 1], next[i]] = [next[i], next[i - 1]]; save(next); };
        const del = doc.createElement('button'); del.type = 'button'; del.textContent = uiText('删除');
        del.onclick = () => save(order.filter((_, j) => j !== i));
        li.append(up, ' ', del); rows.append(li);
      });
      const select = doc.createElement('select');
      for (const name of available.filter(n => !order.includes(n))) { const o = doc.createElement('option'); o.value = name; o.textContent = name; select.append(o); }
      const add = doc.createElement('button'); add.type = 'button'; add.textContent = uiText('加入'); add.disabled = !select.options.length;
      add.onclick = () => { if (select.value) save([...order, select.value]); };
      box.replaceChildren(heading, rows, select, ' ', add);
    };
    list(inputs, '麦克风用哪个', advisor.prefs.inputOrder, names('audioinput'), next => { advisor.setOrders(next, advisor.prefs.outputOrder); void draw(); });
    list(outputs, routed ? '她的声音从哪里出来' : '她的声音从哪里出来（暂未生效）', advisor.prefs.outputOrder, names('audiooutput'), next => { advisor.setOrders(advisor.prefs.inputOrder, next); void draw(); });
  };
  again.onclick = async () => {
    card.replaceChildren();
    const suggestion = await advisor.suggestionNow();
    if (!suggestion) { card.textContent = uiText('现在没有可以换的建议。'); return; }
    card.textContent = uiText(suggestion.text) + ' ';
    for (const [value, text] of [['yes', '换'], ['no', '不换'], ['later', '以后再说']] as const) {
      const b = doc.createElement('button'); b.type = 'button'; b.textContent = uiText(text);
      b.onclick = () => { advisor.answer(suggestion, value); card.replaceChildren(); if (value === 'yes') say('已换。'); void draw(); };
      card.append(b, ' ');
    }
  };
  root.append(h, note, label, inputs, outputs, again, card);
  host.append(root);
  void draw();
}
