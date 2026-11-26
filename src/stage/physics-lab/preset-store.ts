/** The A/B comparison slots of the physics lab. They live as long as the window, through reloads (saving to the model reloads the lab), but not across a different model's rig. */
export interface PresetHolder { tuning: { rig: string } }

export function usablePresetSlots<T extends PresetHolder>(presets: Partial<Record<'A' | 'B', T>>, rig: string): ('A' | 'B')[] {
  return (['A', 'B'] as const).filter(slot => presets[slot]?.tuning.rig === rig);
}

/** Drop slots that belong to another model's rig (the model was switched). */
export function dropForeignPresets<T extends PresetHolder>(presets: Partial<Record<'A' | 'B', T>>, rig: string): void {
  for (const slot of ['A', 'B'] as const) if (presets[slot] && presets[slot]!.tuning.rig !== rig) delete presets[slot];
}
