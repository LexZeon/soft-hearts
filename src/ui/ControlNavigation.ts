import { uiText, uiHtml, uiMarkup, uiTemplate } from './ui-language';
import { icon } from "./icons";
import {
  CONTROL_NAVIGATION, ControlNavigationState, isNavigationGroup,
  type ControlNavigationNode, type ControlNavigationLocation, type ControlPage,
} from "./control-navigation-state";

export { CONTROL_PAGE_TITLES } from "./control-navigation-state";
export type { ControlNavigationLocation, ControlPage } from "./control-navigation-state";

const escape = (text: string) => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

export function renderControlNavigation(): string {
  const state = new ControlNavigationState();
  const render = (nodes: readonly ControlNavigationNode[], depth: number): string => nodes.map(node => {
    const id = escape(node.id); const label = escape(uiText(node.label));
    const isGroup = isNavigationGroup(node);
    const current = !isGroup && state.current.leafId === node.id;
    const rowClass = `nav-item control-nav-row control-nav-depth-${depth} ${isGroup ? "control-nav-group" : "control-nav-leaf"}${current ? " active" : ""}${isGroup && state.containsCurrent(node.id) ? " contains-current" : ""}`;
    const attributes = isGroup
      ? `data-nav-group aria-expanded="${state.isExpanded(node.id)}" aria-controls="control-nav-children-${id}"`
      : `data-nav-page="${node.page}" data-nav-target="${escape(node.target)}"${current ? ' aria-current="location"' : ""}`;
    return `<li class="control-nav-entry"><button type="button" class="${rowClass}" data-nav-node="${id}" ${attributes} title="${label}">${isGroup && node.glyph ? icon(node.glyph) : ""}<span class="control-nav-label">${label}</span>${isGroup ? '<svg class="control-nav-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>' : ""}</button>${isGroup ? `<ul id="control-nav-children-${id}" class="control-nav-children"${state.isExpanded(node.id) ? "" : " hidden"}>${render(node.children, depth + 1)}</ul>` : ""}</li>`;
  }).join("");
  return uiHtml`<nav id="control-navigation" class="control-navigation" aria-label="主导航"><ul class="control-nav-roots">${render(CONTROL_NAVIGATION, 0)}</ul></nav>`;
}

export interface ControlNavigationOptions {
  onNavigate(location: ControlNavigationLocation, previous: ControlNavigationLocation): void;
}

/** Owns sidebar disclosure only; page lifecycle and target positioning stay in the caller. */
export class ControlNavigation {
  private readonly state = new ControlNavigationState();
  private readonly buttons: HTMLButtonElement[];
  private readonly listeners = new Map<HTMLButtonElement, () => void>();
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly options: ControlNavigationOptions) {
    this.buttons = [...container.querySelectorAll<HTMLButtonElement>("button[data-nav-node]")];
    for (const button of this.buttons) {
      const listener = () => this.activate(button.dataset.navNode ?? "");
      this.listeners.set(button, listener);
      button.addEventListener("click", listener);
    }
    this.sync();
  }

  get current(): ControlNavigationLocation { return this.state.current; }

  navigate(page: ControlPage, target?: string): void {
    if (this.disposed) return;
    const previous = this.state.current;
    const location = this.state.navigate(page, target);
    if (!location) return;
    this.sync();
    this.options.onNavigate(location, previous);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [button, listener] of this.listeners) button.removeEventListener("click", listener);
    this.listeners.clear();
  }

  private activate(id: string): void {
    if (this.disposed) return;
    if (this.state.toggle(id)) { this.sync(); return; }
    const previous = this.state.current;
    const location = this.state.selectLeaf(id);
    if (!location) return;
    this.sync();
    this.options.onNavigate(location, previous);
  }

  private sync(): void {
    const current = this.state.current;
    for (const button of this.buttons) {
      const id = button.dataset.navNode ?? "";
      const group = button.hasAttribute("data-nav-group");
      const selected = !group && id === current.leafId;
      button.classList.toggle("active", selected);
      button.classList.toggle("contains-current", group && this.state.containsCurrent(id));
      if (selected) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
      if (group) {
        const expanded = this.state.isExpanded(id);
        button.setAttribute("aria-expanded", String(expanded));
        const children = this.container.querySelector<HTMLElement>(`#control-nav-children-${id}`);
        if (children) children.hidden = !expanded;
      }
    }
  }
}
