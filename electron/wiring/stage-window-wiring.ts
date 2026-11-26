// 舞台's wiring, the companion window (split from electron/wiring/stage-wiring.ts, docs/claude/2026-11-17-split-stage-wiring.md; the lines moved
// from electron/main.ts in step 4g, docs/claude/2026-11-16-wiring-step-4g.md). The statements are the ones main.ts had.
// - Where she can be seen: onScreen (her senses keep running while she is out in Unbound), herOnScreen and replySurface (can a line of hers
//   be seen now, and where), each window's native visibility as it is told (nativeVisibility, syncWindowVisibility).
// - The companion window on every settings sync (syncPetWindow: size, place, topness, pointer settings with Unbound's override, never over the
//   taskbar strip), dragging and resizing and the drag's finish (a stale finish is not written: windowOperationRevision), showing and
//   hiding her (togglePet), R37's presentation notes (attachPetWindow), the taskbar and display listeners (startKeepInArea).
// - Its handlers (registerStageWindowHandlers, called by stage-wiring.ts's register in the old order, inside the agent channel's recorder):
//   only the companion window may change its own pointer input, drag itself or report its presentation; a third window cannot change topmost.
// The companion window's pointer input, presentation, drag and visibility records are made in stage-wiring.ts (wireStage, startStageWindows) and
// read here as live bindings, with `needs`. No module-level side effects: nothing here runs on import.
import { screen, type BrowserWindow } from 'electron';
import type { AppSettings, PetWindowOperation } from '../../shared/contracts';
import { applyPetWindowSettings, fittedPetScale, keepPetInWorkArea, petRecovery, petViewSettings, scaledPetBounds, sizedPetBounds } from '../stage';
import { WindowVisibility } from '../stage/window-visibility';
import { minimizedAway, herHere, windowPresenceFacts } from '../../shared/foundation/step-away';
import { publicSettings } from '../settings';
import type { ReplyProofSurface } from '../unbound';
import type { PartIpc } from './ipc-wiring';
import { windows } from './shell-wiring';
import { petHeld, unbound } from './unbound-wiring';
import { needs, petPointerInput, petPresentation, petWindowDrag, singleEmojiWindow, windowVisibility, type StageNeeds } from './stage-wiring';


let windowOperationRevision = 0;
let appliedPetScale: number | undefined;
let appliedPetSize = '';

// Unbound v1 step 1: her companion window hidden only because she is out in Unbound still counts as on screen for her senses (camera, microphone, screen, the computer's sound).
export const onScreen = (win: BrowserWindow) => { const { pet } = needs; /* read when called */ return !win.isDestroyed() && ((win.isVisible() && !win.isMinimized()) || (win === pet && petHeld())); };
/** Read-aloud (docs/claude/2026-11-15-unbound-read-aloud.md): exactly one display proof, the companion's reply window at home or her Unbound bubble while she is out; and whether either can show her a line now. */
export function replySurface(): ReplyProofSurface | null { const { petReply } = needs; /* read when called */ return unbound?.state === 'unbound' ? unbound.readAloud : petReply; }
/** I-174 item 2: she is here (shown, or only covered: her window minimized), not gone (shared/foundation/step-away.ts herHere). */
// no-pet-ok: pet is the companion window's existing field in needs
export function herHereNow(): boolean { const { pet } = needs; /* read when called */ return herHere(windowPresenceFacts(pet)) || !!unbound?.readAloud.isHere(); }
export function herOnScreen(): boolean { const { pet } = needs; /* read when called */ return (!!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()) || !!unbound?.readAloud.canShow(); }
export function nativeVisibility(win: BrowserWindow) {
  const { store } = needs; // read when called
  const visible = onScreen(win); // Unbound v1 step 1: her senses in the companion window keep running while she is out
  const requested = store.current.pet.visible;
  const minimized = !visible && minimizedAway(win); // I-171: not shown only because it is minimized: the page keeps the reply (shared/foundation/step-away.ts)
  let state = windowVisibility.get(win);
  if (!state) {
    state = new WindowVisibility(win.webContents.id, visible, requested, minimized);
    windowVisibility.set(win, state);
  }
  return state.observe(visible, requested, minimized);
}
function publishWindowVisibility(): void {
  for (const win of windows()) win.webContents.send("desk:visibility", nativeVisibility(win));
}
// 设置: sync fans a settings change out to every part, step by step in the order electron/main.ts gives (electron/wiring/
// settings-wiring.ts wireSettingsSync; the wiring golden pins it). The steps are the stage's old lines, unchanged.
/** Sync step (舞台): the companion window takes its size, place, topness and pointer settings. */
export function syncPetWindow(s: AppSettings): void {
  const { pet, petReply } = needs; // read when called
  if (pet && !pet.isDestroyed()) {
    if (!s.pet.visible && petWindowDrag?.active) { windowOperationRevision++; petWindowDrag.cancel(); }
    const scale = s.pet.scale ?? 1;
    const sizeKey = JSON.stringify(s.pet.size ?? null);
    if (!petWindowDrag?.active && (appliedPetScale !== scale || appliedPetSize !== sizeKey)) {
      const current = pet.getBounds();
      const area = screen.getDisplayMatching(current).workArea;
      const fitted = s.pet.size ? { scale, bounds: sizedPetBounds(current, s.pet.size, area) } : scaledPetBounds(
        current,
        scale,
        area,
      );
      if (
        Object.entries(fitted.bounds).some(
          ([key, value]) => current[key as keyof typeof current] !== value,
        )
      )
        pet.setBounds(fitted.bounds);
      appliedPetScale = fitted.scale;
      appliedPetSize = sizeKey;
    }
    applyPetWindowSettings(pet, unbound?.petSettings(s.pet) ?? s.pet, petPointerInput); // the same path at startup and on every change (electron/stage/pet-window-settings.ts)
    if (!petWindowDrag?.active) keepPetInWorkArea(pet, screen); // never over the taskbar strip
    petReply?.sync();
    singleEmojiWindow?.sync();
  }
}
/** Sync step (舞台): the windows learn their visibility. */
export function syncWindowVisibility(): void {
  publishWindowVisibility();
}
async function finishPetWindowOperation(): Promise<void> {
  const { pet, store, mutate, sync } = needs; // read when called
  const revision = windowOperationRevision;
  const result = petWindowDrag?.stop();
  if (!result || !pet || pet.isDestroyed()) return;
  const area = screen.getDisplayMatching(result.bounds).workArea;
  const scale = fittedPetScale(store.current.pet.scale ?? 1, area);
  let size = result.operation === 'move' ? store.current.pet.size : { width: result.bounds.width, height: result.bounds.height };
  if (result.operation === 'move' && size) {
    const fitted = sizedPetBounds(result.bounds, size, area);
    if (Object.entries(fitted).some(([key, value]) => result.bounds[key as keyof typeof fitted] !== value)) pet.setBounds(fitted);
    size = { width: fitted.width, height: fitted.height };
  }
  if (scale === (store.current.pet.scale ?? 1) && JSON.stringify(size) === JSON.stringify(store.current.pet.size)) return;
  await mutate(async () => {
    if (revision !== windowOperationRevision) return;
    await store.persist({ ...store.current, pet: { ...store.current.pet, scale, ...(size ? { size } : {}) } });
    if (revision === windowOperationRevision) sync();
  });
}
export async function togglePet(recoverClickThrough = false): Promise<void> {
  const { store, mutate, sync } = needs; // read when called
  if (unbound && unbound.state !== 'normal') { unbound.exit(); return; } // Unbound U1: 显示/隐藏桌宠 brings the normal companion back
  await mutate(() =>
    store.persist({
      ...store.current,
      pet: {
        ...store.current.pet,
        visible:
          recoverClickThrough && store.current.pet.clickThrough
            ? true
            : !store.current.pet.visible,
        clickThrough: false,
      },
    }),
  );
  sync();
}

// ---- ready-chain steps (electron/main.ts calls each where its lines ran; the wiring golden reads the body in place) ----
/** Ready-chain step, after Unbound starts: R37's presentation notes, the end of a contact on blur, a drag's finish, a closed companion ends a drag. */
export function attachPetWindow(pet: BrowserWindow): void {
      for (const name of ['show', 'hide', 'minimize', 'restore', 'close'] as const) pet.on(name as 'show', () => petPresentation.note(name));
      pet.on('blur', () => needs.companion.mood.cancelDirectContact());
      const finishWindowOperation = () => void finishPetWindowOperation().catch(console.error);
      pet.on('blur', finishWindowOperation); pet.on('hide', finishWindowOperation); pet.on('minimize', finishWindowOperation);
      pet.on('closed', () => petWindowDrag?.cancel());
}
/** Ready-chain step: a moved or resized taskbar, a DPI change or a removed display must not leave her over the taskbar strip. */
export function startKeepInArea(pet: BrowserWindow): void {
      const keepInArea = () => { if (pet && !pet.isDestroyed() && !petWindowDrag?.active) keepPetInWorkArea(pet, screen); };
      screen.on('display-metrics-changed', keepInArea); screen.on('display-removed', keepInArea); pet.on('closed', () => { screen.removeListener('display-metrics-changed', keepInArea); screen.removeListener('display-removed', keepInArea); });
}

/** The companion window's handlers; stage-wiring.ts's register calls this last (its old place), with the `mutate` it read from needs. */
export function registerStageWindowHandlers(host: PartIpc['host'], scopedHost: PartIpc['scopedHost'], mutate: StageNeeds['mutate']): void {
      scopedHost(
        "savePetView",
        (sender, view) =>
          mutate(async () => {
            const { store, fitSettingsScale, sync } = needs; // read when called
            const next = fitSettingsScale(petViewSettings(store.current, view));
            const saved = await store.persist(next);
            sync(sender);
            return saved;
          }),
        false,
      );
      scopedHost("getWindowVisibility", sender => {
        const win = windows().find(value => value.webContents.id === sender);
        if (!win) throw new Error("窗口尚未就绪。");
        return nativeVisibility(win);
      }, false);
      scopedHost("setPetAlwaysOnTop", (sender, enabled: unknown) => mutate(async () => {
        const { store, controls, pet, noteCompanionTopmostWrite, sync } = needs; // read when called
        if (typeof enabled !== "boolean") throw new Error("桌宠置顶开关不正确。");
        // Recheck the original sender when its queued intent actually runs.
        const caller = windows().find(win => win.webContents.id === sender);
        if (!caller || (caller !== controls && caller !== pet)) throw new Error("请求来源未授权。");
        const win = pet;
        if (!win || win.isDestroyed()) throw new Error("桌宠窗口尚未就绪，请稍后重试。");
        const previousTopmost = store.current.pet.alwaysOnTop;
        const saved = enabled === store.current.pet.alwaysOnTop ? publicSettings(store.current)
          : await store.persist({ ...store.current, pet: { ...store.current.pet, alwaysOnTop: enabled } });
        noteCompanionTopmostWrite(previousTopmost);
        if (win.isDestroyed()) throw new Error("桌宠窗口已关闭，请重新打开应用。");
        sync(sender);
        return saved;
      }), false);
      host("setPetVisible", (visible: unknown) => mutate(async () => {
        const { store, commitCompanionVisibility } = needs; // read when called
        if (typeof visible !== "boolean") throw new Error("桌宠显示开关不正确。");
        const result = await commitCompanionVisibility(visible);
        if (result.persistence === 'not-committed') throw new Error("桌宠窗口尚未就绪，请稍后重试。");
        if (result.persistence === 'unknown') throw new Error("无法确认桌宠显示设置是否保存，请查看当前设置。");
        if (result.presentation !== 'applied') throw new Error("显示设置已保存，但窗口显示结果未能确认。");
        if (visible) petPresentation.arm('show');
        return publicSettings(store.current);
      }));
      host("recoverPet", () => mutate(async () => {
        const { store, controls, pet, companionCommands, noteCompanionTopmostWrite, sync } = needs; // read when called
        companionCommands?.invalidate();
        unbound?.exit(); // Unbound U1
        petWindowDrag?.cancel(); windowOperationRevision++; // A stale drag finish must not resize the recovered companion.
        const window = pet;
        if (!window || window.isDestroyed()) throw new Error("桌宠窗口尚未就绪，请稍后重试。");
        const area = controls && !controls.isDestroyed()
          ? screen.getDisplayMatching(controls.getBounds()).workArea
          : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const recovered = petRecovery(store.current, area);
        // Explicit recovery already raises the native window; persist the same truth.
        recovered.settings.pet.alwaysOnTop = true;
        const previousTopmost = store.current.pet.alwaysOnTop;
        const saved = await store.persist(recovered.settings);
        noteCompanionTopmostWrite(previousTopmost);
        if (window.isDestroyed()) throw new Error("桌宠窗口已关闭，请重新打开应用。");
        sync();
        // sync may first resize around the previous display's anchor. Center last, then keep it presented.
        appliedPetScale = recovered.settings.pet.scale ?? 1;
        petPresentation.recover(window, recovered.bounds);
        window.webContents.send("desk:pet-recovered");
        return saved;
      }));
      host("getPetWindowDiagnostics", () => petPresentation.view());
      scopedHost("reportPetPresentation", (sender, sample: unknown) => { const { pet } = needs; /* read when called */ if (sender !== pet?.webContents.id) throw new Error("请求来源未授权。"); petPresentation.noteRenderer(sample); }, false);
      scopedHost('setPetWindowOperation', (sender, operation: unknown) => {
        const { pet, companion, noteVisionUserActivity } = needs; // read when called
        if (!pet || pet.isDestroyed() || sender !== pet.webContents.id) throw new Error('只有桌宠窗口可以调整自身窗口。');
        if (operation === null) return finishPetWindowOperation();
        if (typeof operation !== 'string' || !['move', 'nw', 'ne', 'sw', 'se'].includes(operation)) throw new Error('窗口操作不正确。');
        if (!pet.isVisible() || pet.isMinimized() || !pet.isFocused()) throw new Error('请先激活桌宠窗口。');
        companion.mood.cancelInteraction();
        noteVisionUserActivity();
        if (!petWindowDrag!.active) windowOperationRevision++;
        petWindowDrag!.start(operation as PetWindowOperation);
      }, false);
      scopedHost('setPetPointerInput', (sender, receive: unknown) => {
        const { pet } = needs; // read when called
        if (!pet || pet.isDestroyed() || sender !== pet.webContents.id) throw new Error('只有桌宠窗口可以调整自身的鼠标接收。');
        return petPointerInput.request(receive);
      }, false);
      host(
        "pointer",
        () => {
          const { store, pet } = needs; // read when called
          if (!store.current.pet.followMouse || !pet) return { x: 0, y: 0 };
          const point = screen.getCursorScreenPoint();
          const bounds = pet.getBounds();
          return {
            x: Math.max(
              -1,
              Math.min(
                1,
                (point.x - bounds.x - bounds.width / 2) / (bounds.width / 2),
              ),
            ),
            y: Math.max(
              -1,
              Math.min(
                1,
                -(point.y - bounds.y - bounds.height / 2) / (bounds.height / 2),
              ),
            ),
          };
        },
        false,
      );
}
