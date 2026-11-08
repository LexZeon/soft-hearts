/** Configuration and an explicit developer session remain accessible on startup.
 * A pet hidden by its saved preference stays hidden, but then the controls open so
 * startup never shows no window at all (R37 "启动不可见"). */
export function initialControlsVisible(modelReady:boolean,developerMode:boolean,petVisible=true):boolean{
  return !modelReady||developerMode||!petVisible;
}
