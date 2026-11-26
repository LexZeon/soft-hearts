/**
 * R01 物理调参台: the lab window's API (`window.physicsLab`), built from a minimal IPC surface so a test can check it with a fake.
 * A whitelist: three requests and one event on fixed `physics-lab:` channels. No Node, no paths, no general invoke or send, and the
 * listener never sees the IPC event object.
 */
import { PHYSICS_LAB_EVENTS, PHYSICS_LAB_REQUESTS, type PhysicsLabApi, type PhysicsLabModel } from '../../shared/stage/physics-lab';
import type { ModelPhysicsTuning } from '../../shared/stage/physics-tuning';

export interface PhysicsLabIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

export function createPhysicsLabApi(ipc: PhysicsLabIpc): PhysicsLabApi {
  const api: PhysicsLabApi = {
    getModel: () => ipc.invoke(PHYSICS_LAB_REQUESTS.model) as Promise<PhysicsLabModel>,
    save: tuning => ipc.invoke(PHYSICS_LAB_REQUESTS.save, tuning) as Promise<ModelPhysicsTuning>,
    clear: () => ipc.invoke(PHYSICS_LAB_REQUESTS.clear) as Promise<boolean>,
    onChanged: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = () => callback();
      ipc.on(PHYSICS_LAB_EVENTS.changed, listener);
      return () => { ipc.removeListener(PHYSICS_LAB_EVENTS.changed, listener); };
    },
  };
  return Object.freeze(api);
}
