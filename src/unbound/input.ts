/**
 * Unbound v1 step 2: the small input box's page (electron/unbound/input-window.ts). One line, Enter sends, Esc closes. It talks to
 * the host only through window.unboundInput (electron/unbound/input-preload-api.ts); text only through .value / textContent.
 */
import type { UnboundInputApi } from '../../electron/unbound/input-preload-api';
import { enterSends } from '../../shared/unbound/typing';
import { isUiLanguage } from '../../shared/foundation/ui-languages';
import { setUiLanguage, uiText } from '../foundation/ui-language';
import { PANEL_TEXT, SensesPanel } from './input-senses';

const api = (window as unknown as { unboundInput?: UnboundInputApi }).unboundInput;
const field = document.getElementById('line') as HTMLInputElement;
const hint = document.getElementById('hint') as HTMLDivElement;
const callButton = document.getElementById('call') as HTMLButtonElement;
const sensesButton = document.getElementById('senses') as HTMLButtonElement;
// I-190: the senses panel (src/unbound/input-senses.ts): the button beside the line or a right click on her opens it.
const panelRoot = document.getElementById('panel') as HTMLElement | null;
const panel = api && typeof api.senses === 'function' && sensesButton && panelRoot ? new SensesPanel(document, panelRoot, sensesButton, api) : null;
if (!panel && sensesButton) sensesButton.hidden = true;
let sending = false;
let calling = false;
let callOn = false;

/** The box's own words follow the interface language (the host says which one with every open; nothing else is sent in). */
function applyCopy(language?: string, to?: string): void {
  if (isUiLanguage(language)) setUiLanguage(language);
  document.title = uiText('soft hearts · 对她说');
  field.placeholder = to ? uiText('对{0}说点什么…', to) : uiText('对她说点什么…'); // I-209 step 3: with several on stage, whose box it is
  hint.dataset.default = uiText('Enter 发送 · Esc 关闭');
  showCall(callOn);
  if (panel) { sensesButton.title = uiText(PANEL_TEXT.button); sensesButton.setAttribute('aria-label', sensesButton.title); }
  document.documentElement.lang = isUiLanguage(language) ? language : document.documentElement.lang;
}
/** 「打电话」 / 「挂断」: the label follows whether a call is on (the host says, with every open and every change). */
function showCall(on: boolean): void {
  callOn = on;
  callButton.textContent = uiText(on ? '挂断' : '打电话');
  callButton.classList.toggle('on', on);
}
applyCopy();
function opened(language?: string, refill?: { text: string; hint: string }, to?: string): void { applyCopy(language, to); field.value = refill?.text ?? ''; hint.textContent = refill?.hint ? uiText(refill.hint) : ''; void panel?.close(); field.focus(); } // 2026-11-22: a line that did not go out comes back with its hint
api?.onOpen(opened);
api?.onPanelOpen?.(() => { void panel?.show(); });
api?.onCallState(showCall);
// The button never takes the keyboard from the line (mouse down is not allowed to move focus; the line is focused again after the click).
callButton.addEventListener('mousedown', event => event.preventDefault());
callButton.addEventListener('click', () => { void toggleCall(); });
window.addEventListener('focus', () => { if (!panel?.isOpen) field.focus(); });
// Esc closes the panel first (focus back on the line), then the box.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !panel?.isOpen || event.defaultPrevented) return;
  event.preventDefault(); event.stopPropagation(); void panel.close().then(() => field.focus());
}, true);
let typedAt = -1e9; // 2026-11-23: tell the host a key went in (no text), at most every 300 ms: her kiss / hug gate reads "typing now" from it
field.addEventListener('input', () => { hint.textContent = ''; const now = performance.now(); if (now - typedAt >= 300) { typedAt = now; void api?.typed?.().catch(() => {}); } });
field.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void api?.cancel().catch(() => {}); return; }
  if (enterSends(event)) { event.preventDefault(); void send(); }
});

async function toggleCall(): Promise<void> {
  if (calling || !api) return;
  calling = true;
  try {
    const result = await api.call(!callOn);
    showCall(result?.on === true);
    hint.textContent = result?.ok ? '' : result?.hint ? uiText(result.hint) : '';
  } catch { hint.textContent = uiText('电话没打成，再试一次。'); }
  finally { calling = false; field.focus(); }
}

async function send(): Promise<void> {
  const text = field.value;
  if (sending || !text.trim() || !api) return;
  sending = true;
  hint.textContent = uiText('发送中…'); // 2026-11-23: a quiet "on its way" until the host says it went (or, never twice, that it did not)
  try {
    const result = await api.submit(text);
    if (result?.ok) { field.value = ''; hint.textContent = ''; }
    else hint.textContent = result?.hint ? uiText(result.hint) : ''; // the host's few fixed lines are keys of the English copy; anything else stays as it is
  } catch { hint.textContent = uiText('没能发出去，再试一次。'); }
  finally { sending = false; field.focus(); }
}
