// Whether chat may offer to hand a request to a Claude task (R20). The host owns the switch;
// this only mirrors it so both windows offer tasks only while it is on. Fails closed: false
// until the host has answered. An offer never starts anything; it only opens the task panel.
export interface ClaudeTaskGateApi {
  claudeTasksEnabled(): Promise<boolean>;
  onClaudeTasks(callback: (state: { enabled: boolean }) => void): () => void;
}

let enabled = false;
let revision = 0;

export function claudeTasksOffered(): boolean { return enabled; }

export function watchClaudeTasks(api: ClaudeTaskGateApi): () => void {
  const start = ++revision;
  const unsubscribe = api.onClaudeTasks(state => { revision++; enabled = state?.enabled === true; });
  void api.claudeTasksEnabled().then(value => { if (revision === start) enabled = value === true; }, () => { if (revision === start) enabled = false; });
  return () => { unsubscribe(); revision++; enabled = false; };
}
