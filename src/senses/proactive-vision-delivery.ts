export interface ProactiveVisionDelivery {
  /** Publish the exact streaming body to the host before asking for its receipt. */
  publish(): Promise<unknown>;
  /** The host confirms the actual reply presentation, not a hidden DOM proxy. */
  ack(): Promise<boolean>;
  current(): boolean;
  commit(): void;
  /** Must be scoped to this offer so a late failure cannot remove a newer one. */
  retract(): void;
}

/** Only a still-current, actually presented offer may enter history or speech. */
export async function prepareVisionDelivery(delivery: ProactiveVisionDelivery): Promise<boolean> {
  const current = () => {
    try { return delivery.current() === true; } catch { return false; }
  };
  const retract = () => {
    try { delivery.retract(); } catch { /* A missing old surface cannot revive the offer. */ }
  };
  if (!current()) return false;
  try {
    await delivery.publish();
    if (!current()) { retract(); return false; }
    const accepted = await delivery.ack();
    if (!accepted || !current()) { retract(); return false; }
    delivery.commit();
    return true;
  } catch {
    retract();
    return false;
  }
}
