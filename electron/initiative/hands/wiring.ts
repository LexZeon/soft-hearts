/**
 * I-087 牵手、拉钩、击掌 for the app: the store, the host and the two companion-window operations. electron/main.ts supplies the closures;
 * nothing here reads a setting or a window on its own.
 *
 * IPC (shared/behaviors/hands/interface.ts): the companion window only — handsAnswer { id, outcome } and handsRequest { use: 'hold' }.
 */
import { HandsHost, type HandsHostOptions } from './host';
import { HandsStore } from './store';

type Register = (method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly?: boolean) => void;

export interface HandsWiring extends Omit<HandsHostOptions, 'store'> {
  directory(): string | null;
  petSender(): number | null;
}

export function createHands(wiring: HandsWiring) {
  const store = new HandsStore({ directory: wiring.directory });
  const host = new HandsHost({ ...wiring, store });
  const register = (scopedHost: Register) => {
    const fromPet = (sender: number) => sender === wiring.petSender();
    scopedHost('handsAnswer', (sender, value) => host.answer(fromPet(sender), value), false);
    scopedHost('handsRequest', (sender, value) => host.request(fromPet(sender), value), false);
  };
  return { host, store, register, dispose: () => host.dispose() };
}
