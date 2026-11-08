import test from "node:test";
import assert from "node:assert/strict";
import { ControlNavigation, renderControlNavigation } from "../src/ui/ControlNavigation";
import {
  CONTROL_NAVIGATION, CONTROL_PAGE_TITLES, ControlNavigationState, isNavigationGroup,
  type ControlNavigationNode, type ControlNavigationLeaf, type ControlNavigationLocation, type ControlPage,
} from "../src/ui/control-navigation-state";

function flatten(nodes: readonly ControlNavigationNode[]): ControlNavigationNode[] {
  return nodes.flatMap(node => [node, ...(isNavigationGroup(node) ? flatten(node.children) : [])]);
}
const nodes = flatten(CONTROL_NAVIGATION);
const leaves = nodes.filter((node): node is ControlNavigationLeaf => !isNavigationGroup(node));

// A button/list fixture parsed from production markup. It records disclosure and
// route callbacks without creating a browser, application API, stage or profile.
class Button {
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly listeners = new Set<() => void>();
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
  };
  constructor(attributes: string) {
    for (const match of attributes.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      this.attributes.set(match[1], match[2] ?? "");
      if (match[1].startsWith("data-")) {
        this.dataset[match[1].slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = match[2] ?? "";
      }
    }
    for (const name of (this.attributes.get("class") ?? "").split(" ")) this.classes.add(name);
  }
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(type: string, callback: () => void) { assert.equal(type, "click"); this.listeners.add(callback); }
  removeEventListener(type: string, callback: () => void) { assert.equal(type, "click"); this.listeners.delete(callback); }
  click() { for (const callback of this.listeners) callback(); }
}
function fixture() {
  const markup = renderControlNavigation();
  const buttons = [...markup.matchAll(/<button\s([^>]+)>/g)].map(match => new Button(match[1]));
  const lists = new Map([...markup.matchAll(/<ul id="([^"]+)"([^>]*)>/g)]
    .map(match => [match[1], { hidden: /\bhidden\b/.test(match[2]) }]));
  const container = {
    querySelectorAll(selector: string) { assert.equal(selector, "button[data-nav-node]"); return buttons; },
    querySelector(selector: string) { assert.ok(selector.startsWith("#control-nav-children-")); return lists.get(selector.slice(1)) ?? null; },
  };
  const routes: { location: ControlNavigationLocation; previous: ControlNavigationLocation }[] = [];
  const navigation = new ControlNavigation(container as unknown as HTMLElement, {
    onNavigate(location, previous) { routes.push({ location, previous }); },
  });
  const button = (id: string) => {
    const found = buttons.find(button => button.dataset.navNode === id);
    assert.ok(found, `navigation button ${id}`); return found;
  };
  return { navigation, routes, buttons, button, lists, markup };
}

test("the fixed directory keeps seven pages, unique routes and at most three levels", () => {
  assert.deepEqual(CONTROL_NAVIGATION.map(node => node.id), Object.keys(CONTROL_PAGE_TITLES));
  // C2: the character page is second, right below the chat.
  assert.deepEqual(CONTROL_NAVIGATION.slice(0, 2).map(node => node.id), ["chat", "characters"]);
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  const routes = leaves.map(node => `${node.page}/${node.target}`);
  assert.equal(new Set(routes).size, routes.length);
  const check = (items: readonly ControlNavigationNode[], depth: number) => {
    assert.ok(depth <= 2, "a fourth directory level crowds the narrow sidebar");
    for (const node of items) {
      assert.match(node.id, /^[a-z][a-z0-9-]*$/);
      if (isNavigationGroup(node)) { assert.ok(node.children.length); check(node.children, depth + 1); }
      else { assert.ok(CONTROL_PAGE_TITLES[node.page]); assert.match(node.target, /^[a-z][a-zA-Z0-9-]*$/); }
    }
  };
  check(CONTROL_NAVIGATION, 0);
});

test("initial disclosure exposes current chat only and uses native non-submitting buttons", () => {
  const f = fixture();
  assert.deepEqual(f.navigation.current, { page: "chat", target: "messages", leafId: "chat-messages" });
  assert.equal(f.routes.length, 0, "construction must not re-run page lifecycle");
  assert.equal(f.button("chat").attributes.get("aria-expanded"), "true");
  assert.equal(f.button("chat-session").attributes.get("aria-expanded"), "true");
  assert.equal(f.button("chat-compose").attributes.get("aria-expanded"), "false");
  assert.equal(f.button("providers").attributes.get("aria-expanded"), "false");
  assert.equal(f.button("chat-messages").attributes.get("aria-current"), "location");
  assert.ok(f.buttons.every(button => button.attributes.get("type") === "button"));
  assert.doesNotMatch(f.markup, /data-tab=|onclick=|href=/);
  f.navigation.dispose();
});

test("repeated parent toggles never route, change current content or discard nested disclosure", () => {
  const f = fixture(); const initial = f.navigation.current;
  f.button("chat").click();
  assert.equal(f.lists.get("control-nav-children-chat")?.hidden, true);
  assert.equal(f.button("chat-session").attributes.get("aria-expanded"), "true");
  assert.deepEqual(f.navigation.current, initial);
  f.button("chat").click();
  assert.equal(f.lists.get("control-nav-children-chat")?.hidden, false);
  for (let count = 0; count < 20; count++) f.button("providers-connection").click();
  assert.equal(f.button("providers-connection").attributes.get("aria-expanded"), "false");
  assert.equal(f.routes.length, 0);
  assert.deepEqual(f.navigation.current, initial);
  f.navigation.dispose();
});

test("leaf selection reports the previous page once and updates current ancestry without touching content", () => {
  const f = fixture();
  f.button("character-cards").click();
  assert.equal(f.routes.length, 1);
  assert.deepEqual(f.routes[0], {
    previous: { page: "chat", target: "messages", leafId: "chat-messages" },
    location: { page: "characters", target: "character-cards", leafId: "character-cards" },
  });
  assert.equal(f.button("characters").attributes.get("aria-expanded"), "true");
  assert.equal(f.button("characters-edit").attributes.get("aria-expanded"), "true");
  assert.ok(f.button("characters").classes.has("contains-current"));
  assert.equal(f.button("chat-messages").attributes.has("aria-current"), false);
  assert.equal(f.button("character-cards").attributes.get("aria-current"), "location");
  f.button("character-blush").click();
  assert.equal(f.routes[1].previous.page, "characters");
  assert.equal(f.routes[1].location.page, "characters", "caller can preserve lifecycle on same-page navigation");
  assert.equal(f.button("chat").attributes.get("aria-expanded"), "true", "unrelated expanded roots stay open");
  f.navigation.dispose();
});

test("programmatic navigation always reveals ancestors and rejects arbitrary targets or unknown pages", () => {
  const f = fixture();
  f.navigation.navigate("agent", "codex-task-approvals");
  f.button("agent").click(); f.button("agent-progress").click();
  assert.equal(f.button("agent").attributes.get("aria-expanded"), "false");
  assert.equal(f.button("agent-progress").attributes.get("aria-expanded"), "false");
  f.navigation.navigate("agent", "codex-task-approvals");
  assert.equal(f.button("agent").attributes.get("aria-expanded"), "true");
  assert.equal(f.button("agent-progress").attributes.get("aria-expanded"), "true");
  assert.equal(f.routes.at(-1)?.previous.page, "agent");
  assert.equal(f.routes.at(-1)?.location.target, "codex-task-approvals");
  f.navigation.navigate("privacy", '#quit-app[onclick="run"]');
  assert.equal(f.navigation.current.target, "runtime-voice", "invalid target falls back to a known leaf");
  const before = f.routes.length;
  f.navigation.navigate("foreign" as ControlPage, "quit-app");
  assert.equal(f.routes.length, before);
  f.navigation.dispose();
});

test("all leaf clicks emit only their fixed location and never the target element action", () => {
  const f = fixture();
  for (const leaf of leaves) {
    f.button(leaf.id).click();
    assert.deepEqual(f.routes.at(-1)?.location, { page: leaf.page, target: leaf.target, leafId: leaf.id });
  }
  assert.equal(f.routes.length, leaves.length);
  assert.equal(f.buttons.filter(button => button.attributes.has("aria-current")).length, 1);
  f.navigation.dispose();
});

test("disposal releases every click listener and prevents late programmatic routes", () => {
  const f = fixture();
  const current = f.navigation.current;
  assert.equal(f.buttons.reduce((sum, button) => sum + button.listeners.size, 0), f.buttons.length);
  f.navigation.dispose(); f.navigation.dispose();
  assert.equal(f.buttons.reduce((sum, button) => sum + button.listeners.size, 0), 0);
  f.button("character-cards").click(); f.navigation.navigate("memory");
  assert.equal(f.routes.length, 0); assert.deepEqual(f.navigation.current, current);
});

test("each new directory starts fresh without sharing another window's disclosure state", () => {
  const a = new ControlNavigationState();
  a.navigate("appearance", "physics-quality"); a.toggle("chat");
  const b = new ControlNavigationState();
  assert.equal(b.current.page, "chat"); assert.equal(b.isExpanded("appearance"), false);
  assert.equal(b.isExpanded("chat"), true); assert.equal(a.current.page, "appearance");
});
