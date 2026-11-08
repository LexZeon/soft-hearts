/** The control window's top-level pages in sidebar order. tests/control-navigation-roots.test.ts keeps it equal to src/ui/control-navigation-state.ts. */
export const CONTROL_ROOTS = Object.freeze(['chat', 'characters', 'appearance', 'memory', 'providers', 'agent', 'privacy']);
const CONTROL_PAGES = new Set(CONTROL_ROOTS);

/**
 * Navigate through the real sidebar, opening disclosure parents before clicking
 * a leaf. This only changes pages; it never activates the leaf's target control.
 * Old reviewed packages can still be checked with their original six buttons.
 */
export async function navigateControlPage(page, pageId, { target, allowLegacy = true } = {}) {
  if (!CONTROL_PAGES.has(pageId)) throw new Error(`Unknown control page: ${pageId}`);
  if (target !== undefined && (typeof target !== 'string' || !/^[a-z][a-zA-Z0-9-]*$/.test(target))) {
    throw new Error('Control navigation target must be a fixed element ID');
  }
  await page.locator('#control-navigation, button[data-tab]').first().waitFor({ state: 'attached' });
  const directory = page.locator('#control-navigation');
  if (await directory.count()) {
    const selector = `button[data-nav-page="${pageId}"]${target === undefined ? '' : `[data-nav-target="${target}"]`}`;
    const leaves = directory.locator(selector);
    if (target !== undefined && await leaves.count() !== 1) throw new Error(`Unknown navigation leaf: ${pageId}/${target}`);
    const leaf = leaves.first();
    await leaf.waitFor({ state: 'attached' });
    const ancestors = await leaf.evaluate(button => {
      const navigation = button.closest('nav');
      const ids = [];
      for (let element = button.parentElement; element && element !== navigation; element = element.parentElement) {
        if (element.tagName === 'UL' && element.id) ids.push(element.id);
      }
      return ids.reverse();
    });
    for (const id of ancestors) {
      if (!/^control-nav-children-[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Unexpected navigation disclosure: ${id}`);
      const parent = directory.locator(`button[data-nav-group][aria-controls="${id}"]`);
      if (await parent.count() !== 1) throw new Error(`Missing navigation disclosure owner: ${id}`);
      if (await parent.getAttribute('aria-expanded') !== 'true') await parent.click();
    }
    await leaf.click();
  } else {
    if (!allowLegacy) throw new Error('This check requires the hierarchical control directory');
    await page.locator(`button[data-tab="${pageId}"]`).click();
  }
  await page.waitForFunction(id => document.getElementById(`tab-${id}`)?.classList.contains('active'), pageId);
}
