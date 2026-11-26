// I-117 the safety card, in the companion window and the control window: the app's own card outside her role (clearly not her speech
// bubble), shown only when the host saw a clear danger sign. One quiet sentence, the region's help line first and large, the other
// regions folded below, and two buttons: 「我现在安全」 (it stays away for the rest of the night) and 「关闭」. It never blocks the chat
// and is not modal. Everything shown is app text (shared/safety/crisis-lines.ts); nothing of the user's is in it.
// Also: the 「所在地区（求助信息用）」 select of 隐私与设置 (its "automatic" option names the region the time zone suggests).
import { CRISIS_REGION_NAMES, crisisCardModel, crisisRegionPreference, systemCrisisRegion, type CrisisCardEntry, type CrisisRegion, type CrisisRegionPreference } from '../../shared/safety/crisis-lines';
import { readSafetyCardView, type SafetyCardAnswer, type SafetyCardView } from '../../shared/safety/card';
import { currentUiLanguage, uiText } from '../foundation/ui-language';

export interface SafetyCardPorts {
  changed(callback: (view: SafetyCardView) => void): () => void;
  get(): Promise<SafetyCardView>;
  answer(answer: SafetyCardAnswer): Promise<SafetyCardView>;
}

const language = (): 'zh' | 'en' => currentUiLanguage() === 'en' ? 'en' : 'zh';

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function entryNode(doc: Document, entry: CrisisCardEntry, primary: boolean): HTMLElement {
  const box = el(doc, 'div', primary ? 'safety-card-line is-primary' : 'safety-card-line');
  box.append(el(doc, 'span', 'safety-card-region', entry.regionName));
  if (entry.number) {
    const head = el(doc, 'div', 'safety-card-head');
    head.append(el(doc, 'strong', 'safety-card-number', entry.number), el(doc, 'span', 'safety-card-name', entry.name ?? ''));
    box.append(head);
  } else box.append(el(doc, 'strong', 'safety-card-number is-generic', entry.emergency));
  box.append(el(doc, 'p', 'safety-card-how', entry.how));
  if (entry.number) box.append(el(doc, 'p', 'safety-card-emergency', entry.emergency));
  return box;
}

/** The card's content for a region (pure DOM; tests read it). */
export function renderSafetyCard(doc: Document, region: CrisisRegion, answer: (kind: 'safe' | 'close') => void): HTMLElement {
  const model = crisisCardModel(region, language());
  const root = el(doc, 'section', 'safety-card');
  root.dataset.safetyCard = region;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', model.title);
  root.append(el(doc, 'p', 'safety-card-title', model.title), el(doc, 'p', 'safety-card-sentence', model.sentence), entryNode(doc, model.primary, true));
  if (model.others.length) {
    const more = el(doc, 'details', 'safety-card-others');
    more.append(el(doc, 'summary', '', model.othersLabel), ...model.others.map(entry => entryNode(doc, entry, false)));
    root.append(more);
  }
  const actions = el(doc, 'div', 'safety-card-actions');
  const safe = el(doc, 'button', 'safety-card-safe', model.safe); safe.type = 'button'; safe.dataset.safetyCardAnswer = 'safe';
  const close = el(doc, 'button', 'safety-card-close subtle', model.close); close.type = 'button'; close.dataset.safetyCardAnswer = 'close';
  safe.onclick = () => answer('safe');
  close.onclick = () => answer('close');
  actions.append(safe, close);
  root.append(actions);
  return root;
}

export class SafetyCard {
  private node: HTMLElement | null = null;
  private view: SafetyCardView | null = null;
  private readonly off: (() => void) | null;

  constructor(private readonly doc: Document, private readonly ports: SafetyCardPorts, private readonly kind: 'pet' | 'controls') {
    let off: (() => void) | null = null;
    try { off = ports.changed(view => this.show(view)); } catch { off = null; }
    this.off = off;
    void ports.get().then(view => this.show(view), () => {});
  }

  dispose(): void { this.off?.(); this.node?.remove(); this.node = null; }

  private show(value: unknown): void {
    const view = readSafetyCardView(value);
    if (!view) return;
    // An older card closing never closes a newer one on screen.
    if (!view.open && this.view && view.id !== this.view.id) return;
    this.view = view;
    this.node?.remove(); this.node = null;
    if (!view.open) return;
    const id = view.id;
    const node = renderSafetyCard(this.doc, view.region, kind => {
      node.remove(); if (this.node === node) this.node = null;
      void this.ports.answer({ id, answer: kind }).catch(() => {});
    });
    node.classList.add(this.kind === 'pet' ? 'in-pet' : 'in-controls');
    this.doc.body.append(node);
    this.node = node;
  }
}

/** 隐私与设置 「所在地区（求助信息用）」: names the guessed region on the automatic option and saves a change. */
export function mountCrisisRegionSelect(select: HTMLSelectElement, ports: { set(value: CrisisRegionPreference): void; guess?: () => CrisisRegion }): void {
  const guess = (ports.guess ?? systemCrisisRegion)();
  const auto = [...select.options].find(option => option.value === 'auto');
  if (auto) auto.textContent = uiText('自动（按系统时区猜：{0}）', CRISIS_REGION_NAMES[guess][language()]);
  select.addEventListener('change', () => ports.set(crisisRegionPreference(select.value)));
}
